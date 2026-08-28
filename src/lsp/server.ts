import { compile } from "../language/checker.ts";
import { getCompletions, getHover, getSemanticTokens } from "../language/editor.ts";
import { parse } from "../language/parser.ts";
import type {
  Diagnostic,
  ProviderManifest,
  SemanticTokenType,
  SourcePosition,
  SourceSpan,
} from "../language/model.ts";
import { encodeLspMessage, LspFramer } from "./framing.ts";
import { fileUriToPath, StaticManifestResolver, type ManifestProblem } from "./manifests.ts";
import { getPluginCompletions, getPluginHover } from "./plugin-features.ts";
import { getSignatureHelp } from "./signature.ts";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const SERVER_NOT_INITIALIZED = -32002;
const REQUEST_CANCELLED = -32800;

const SEMANTIC_TOKEN_TYPES: readonly SemanticTokenType[] = [
  "comment",
  "string",
  "number",
  "keyword",
  "operator",
  "namespace",
  "function",
  "method",
  "property",
  "variable",
  "parameter",
];
const SEMANTIC_TOKEN_MODIFIERS = ["declaration", "readonly"] as const;

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

interface Position {
  readonly line: number;
  readonly character: number;
}

interface DocumentState {
  readonly uri: string;
  readonly languageId: string;
  readonly version: number;
  readonly text: string;
}

interface DocumentContext {
  readonly document: DocumentState;
  readonly manifests: readonly ProviderManifest[];
  readonly plugins: ReturnType<StaticManifestResolver["resolve"]>["plugins"];
  readonly complete: boolean;
  readonly problems: readonly ManifestProblem[];
}

export interface LanguageServerInput {
  read(buffer: Uint8Array): number;
}

export interface LanguageServerOutput {
  write(buffer: Uint8Array): number | void;
}

export interface LanguageServerOptions {
  readonly maxMessageBytes?: number;
  readonly readBufferBytes?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Math.floor(value) === value && value >= 0
  );
}

function hasOwn(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

function idKey(id: JsonRpcId): string {
  return id === null ? "null:" : `${typeof id}:${String(id)}`;
}

function validId(value: unknown): value is JsonRpcId {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function validPosition(value: unknown): value is Position {
  return (
    isRecord(value) && isNonNegativeInteger(value.line) && isNonNegativeInteger(value.character)
  );
}

function lspPosition(position: SourcePosition): Position {
  return { line: position.line, character: position.column };
}

function lspRange(span: SourceSpan): { start: Position; end: Position } {
  return { start: lspPosition(span.start), end: lspPosition(span.end) };
}

/** Converts an LSP UTF-16 position to a JavaScript string offset, clamped to the line. */
export function offsetAt(text: string, position: Position): number {
  let offset = 0;
  let line = 0;
  while (offset < text.length && line < position.line) {
    const code = text.charCodeAt(offset);
    if (code === 13) {
      offset++;
      if (text.charCodeAt(offset) === 10) offset++;
      line++;
    } else if (code === 10 || code === 0x2028 || code === 0x2029) {
      offset++;
      line++;
    } else offset++;
  }
  if (line < position.line) return text.length;
  const lineStart = offset;
  while (offset < text.length) {
    const code = text.charCodeAt(offset);
    if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) break;
    offset++;
  }
  return Math.min(offset, lineStart + position.character);
}

function completionKind(kind: string): number {
  switch (kind) {
    case "method":
      return 2;
    case "function":
      return 3;
    case "field":
      return 5;
    case "variable":
      return 6;
    case "module":
      return 9;
    case "value":
      return 12;
    case "keyword":
      return 14;
    case "resource":
      return 21;
    default:
      return 1;
  }
}

function diagnosticSeverity(value: Diagnostic["severity"]): number {
  if (value === "error") return 1;
  if (value === "warning") return 2;
  return 3;
}

function documentUri(params: unknown): string | undefined {
  if (!isRecord(params) || !isRecord(params.textDocument)) return undefined;
  return typeof params.textDocument.uri === "string" ? params.textDocument.uri : undefined;
}

function workspacePaths(params: Record<string, unknown>): string[] {
  const result: string[] = [];
  if (Array.isArray(params.workspaceFolders)) {
    for (const folder of params.workspaceFolders) {
      if (!isRecord(folder) || typeof folder.uri !== "string") continue;
      const path = fileUriToPath(folder.uri);
      if (path !== undefined) result.push(path);
    }
  }
  if (result.length === 0 && typeof params.rootUri === "string") {
    const path = fileUriToPath(params.rootUri);
    if (path !== undefined) result.push(path);
  }
  if (result.length === 0 && typeof params.rootPath === "string") result.push(params.rootPath);
  return result;
}

function manifestDiagnostic(problem: ManifestProblem): Diagnostic {
  return {
    code: problem.code,
    message: problem.message,
    severity: "error",
    source: "binder",
    span: problem.span,
  };
}

function writeAll(output: LanguageServerOutput, message: unknown): void {
  const bytes = encodeLspMessage(message);
  let offset = 0;
  while (offset < bytes.length) {
    const written = output.write(bytes.slice(offset));
    if (written === undefined) return;
    if (!Number.isSafeInteger(written) || written <= 0)
      throw new Error("LSP output made no progress");
    offset += written;
  }
}

/** Stateful protocol session. `receive` may be called with any chunk boundaries. */
export class LanguageServerSession {
  private readonly framer: LspFramer;
  private readonly documents = new Map<string, DocumentState>();
  private readonly cancelled = new Set<string>();
  private readonly manifestResolver = new StaticManifestResolver();
  private initialized = false;
  private shutdown = false;
  private supportsConfiguration = false;
  private roots: string[] = [];
  private configurationRequest = 0;
  private exitedCode: number | undefined;

  constructor(
    private readonly send: (message: unknown) => void,
    options: LanguageServerOptions = {},
  ) {
    this.framer = new LspFramer(options.maxMessageBytes);
  }

  get exitCode(): number | undefined {
    return this.exitedCode;
  }

  receive(chunk: Uint8Array | string): void {
    if (this.exitedCode !== undefined) return;
    for (const frame of this.framer.push(chunk)) {
      if (frame.error !== undefined) this.error(null, PARSE_ERROR, frame.error);
      else if (frame.body !== undefined) this.receiveBody(frame.body);
      if (this.exitedCode !== undefined) break;
    }
  }

  end(): void {
    if (this.exitedCode !== undefined) return;
    for (const frame of this.framer.finish())
      if (frame.error !== undefined) this.error(null, PARSE_ERROR, frame.error);
  }

  private receiveBody(body: string): void {
    let value: unknown;
    try {
      value = JSON.parse(body) as unknown;
    } catch {
      this.error(null, PARSE_ERROR, "Invalid JSON.");
      return;
    }
    if (!isRecord(value)) {
      this.error(null, INVALID_REQUEST, "JSON-RPC message must be an object.");
      return;
    }
    if (!hasOwn(value, "method")) {
      this.receiveResponse(value);
      return;
    }
    const rawId = hasOwn(value, "id") ? value.id : undefined;
    const id = validId(rawId) ? rawId : null;
    if (
      value.jsonrpc !== "2.0" ||
      typeof value.method !== "string" ||
      (rawId !== undefined && !validId(rawId))
    ) {
      this.error(id, INVALID_REQUEST, "Invalid JSON-RPC 2.0 request.");
      return;
    }
    this.dispatch({
      jsonrpc: "2.0",
      id: rawId === undefined ? undefined : id,
      method: value.method,
      params: hasOwn(value, "params") ? value.params : undefined,
    });
  }

  private receiveResponse(value: Record<string, unknown>): void {
    if (value.jsonrpc !== "2.0" || !validId(value.id)) return;
    if (value.id !== `polici/configuration/${this.configurationRequest}`) return;
    if (Array.isArray(value.result)) this.manifestResolver.configure(value.result.at(0));
    else this.manifestResolver.configure(value.result);
    this.publishAllDiagnostics();
  }

  private dispatch(request: JsonRpcRequest): void {
    const notification = request.id === undefined;
    if (request.method === "$/cancelRequest") {
      if (isRecord(request.params) && validId(request.params.id)) {
        if (this.cancelled.size >= 4096) this.cancelled.clear();
        this.cancelled.add(idKey(request.params.id));
      }
      return;
    }
    if (request.method === "exit") {
      this.exitedCode = this.shutdown ? 0 : 1;
      return;
    }
    if (request.method === "initialize") {
      if (notification) return;
      this.initialize(request.id!, request.params);
      return;
    }
    if (!this.initialized) {
      if (!notification)
        this.error(request.id!, SERVER_NOT_INITIALIZED, "Server has not been initialized.");
      return;
    }
    if (request.method === "initialized") {
      if (this.supportsConfiguration) this.requestConfiguration();
      return;
    }
    if (request.method === "shutdown") {
      if (!notification) {
        this.shutdown = true;
        this.result(request.id!, null);
      }
      return;
    }
    if (this.shutdown) {
      if (!notification) this.error(request.id!, INVALID_REQUEST, "Server has shut down.");
      return;
    }
    if (!notification && this.cancelled.delete(idKey(request.id!))) {
      this.error(request.id!, REQUEST_CANCELLED, "Request was cancelled.");
      return;
    }
    try {
      switch (request.method) {
        case "textDocument/didOpen":
          this.didOpen(request.params);
          return;
        case "textDocument/didChange":
          this.didChange(request.params);
          return;
        case "textDocument/didClose":
          this.didClose(request.params);
          return;
        case "workspace/didChangeConfiguration":
          this.didChangeConfiguration(request.params);
          return;
        case "workspace/didChangeWorkspaceFolders":
          this.didChangeWorkspaceFolders(request.params);
          return;
        case "workspace/didChangeWatchedFiles":
          this.publishAllDiagnostics();
          return;
        case "textDocument/completion":
          this.completion(request.id, request.params);
          return;
        case "textDocument/hover":
          this.hover(request.id, request.params);
          return;
        case "textDocument/signatureHelp":
          this.signatureHelp(request.id, request.params);
          return;
        case "textDocument/semanticTokens/full":
          this.semanticTokens(request.id, request.params);
          return;
        case "$/setTrace":
        case "window/workDoneProgress/cancel":
          return;
        default:
          if (!notification)
            this.error(request.id!, METHOD_NOT_FOUND, `Method not found: ${request.method}`);
      }
    } catch (error) {
      if (!notification)
        this.error(
          request.id!,
          INTERNAL_ERROR,
          error instanceof Error ? error.message : "Internal server error.",
        );
    }
  }

  private initialize(id: JsonRpcId, params: unknown): void {
    if (this.initialized) {
      this.error(id, INVALID_REQUEST, "Server is already initialized.");
      return;
    }
    if (!isRecord(params)) {
      this.error(id, INVALID_PARAMS, "initialize params must be an object.");
      return;
    }
    this.initialized = true;
    const capabilities = isRecord(params.capabilities) ? params.capabilities : undefined;
    const workspace =
      capabilities !== undefined && isRecord(capabilities.workspace)
        ? capabilities.workspace
        : undefined;
    this.supportsConfiguration = workspace !== undefined && workspace.configuration === true;
    this.roots = workspacePaths(params);
    this.manifestResolver.setWorkspaceRoots(this.roots);
    this.manifestResolver.configure(params.initializationOptions);
    this.result(id, {
      capabilities: {
        positionEncoding: "utf-16",
        textDocumentSync: { openClose: true, change: 1 },
        completionProvider: { triggerCharacters: ["."] },
        hoverProvider: true,
        signatureHelpProvider: { triggerCharacters: ["(", ","], retriggerCharacters: [","] },
        semanticTokensProvider: {
          legend: {
            tokenTypes: SEMANTIC_TOKEN_TYPES,
            tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
          },
          full: true,
        },
        workspace: {
          workspaceFolders: { supported: true, changeNotifications: true },
        },
      },
      serverInfo: { name: "polici", version: "1.0.1" },
    });
  }

  private requestConfiguration(): void {
    this.configurationRequest++;
    this.send({
      jsonrpc: "2.0",
      id: `polici/configuration/${this.configurationRequest}`,
      method: "workspace/configuration",
      params: { items: [{ section: "polici" }] },
    });
  }

  private didOpen(params: unknown): void {
    if (!isRecord(params) || !isRecord(params.textDocument)) return;
    const item = params.textDocument;
    if (
      typeof item.uri !== "string" ||
      typeof item.languageId !== "string" ||
      !isNonNegativeInteger(item.version) ||
      typeof item.text !== "string"
    )
      return;
    const document: DocumentState = {
      uri: item.uri,
      languageId: item.languageId,
      version: item.version as number,
      text: item.text,
    };
    this.documents.set(document.uri, document);
    this.publishDiagnostics(document);
  }

  private didChange(params: unknown): void {
    const uri = documentUri(params);
    if (uri === undefined || !isRecord(params)) return;
    const previous = this.documents.get(uri);
    if (previous === undefined || !isRecord(params.textDocument)) return;
    const version = params.textDocument.version;
    if (!isNonNegativeInteger(version) || !Array.isArray(params.contentChanges)) return;
    let text = previous.text;
    for (const change of params.contentChanges) {
      if (!isRecord(change) || typeof change.text !== "string") return;
      if (change.range !== undefined) return;
      text = change.text;
    }
    const document: DocumentState = { ...previous, version: version as number, text };
    this.documents.set(uri, document);
    this.publishDiagnostics(document);
  }

  private didClose(params: unknown): void {
    const uri = documentUri(params);
    if (uri === undefined) return;
    this.documents.delete(uri);
    this.send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri, diagnostics: [] },
    });
  }

  private didChangeConfiguration(params: unknown): void {
    if (!isRecord(params)) return;
    this.manifestResolver.configure(params.settings);
    this.publishAllDiagnostics();
  }

  private didChangeWorkspaceFolders(params: unknown): void {
    if (!isRecord(params) || !isRecord(params.event)) return;
    const removed = new Set<string>();
    if (Array.isArray(params.event.removed)) {
      for (const folder of params.event.removed) {
        if (!isRecord(folder) || typeof folder.uri !== "string") continue;
        const path = fileUriToPath(folder.uri);
        if (path !== undefined) removed.add(path);
      }
    }
    this.roots = this.roots.filter((root) => !removed.has(root));
    if (Array.isArray(params.event.added)) {
      for (const folder of params.event.added) {
        if (!isRecord(folder) || typeof folder.uri !== "string") continue;
        const path = fileUriToPath(folder.uri);
        if (path !== undefined && !this.roots.includes(path)) this.roots.push(path);
      }
    }
    this.manifestResolver.setWorkspaceRoots(this.roots);
    this.publishAllDiagnostics();
  }

  private context(params: unknown): DocumentContext | undefined {
    const uri = documentUri(params);
    if (uri === undefined) return undefined;
    const document = this.documents.get(uri);
    if (document === undefined) return undefined;
    const parsed = parse(document.text);
    const resolved = this.manifestResolver.resolve(uri, parsed.ast.usings);
    return {
      document,
      manifests: resolved.language,
      plugins: resolved.plugins,
      complete: resolved.complete,
      problems: resolved.problems,
    };
  }

  private requestContext(
    id: JsonRpcId | undefined,
    params: unknown,
  ): { context: DocumentContext; position: Position; offset: number } | undefined {
    if (id === undefined) return undefined;
    const context = this.context(params);
    if (!isRecord(params) || context === undefined || !validPosition(params.position)) {
      this.error(id, INVALID_PARAMS, "Request requires an open text document and UTF-16 position.");
      return undefined;
    }
    const position = params.position;
    return { context, position, offset: offsetAt(context.document.text, position) };
  }

  private completion(id: JsonRpcId | undefined, params: unknown): void {
    const request = this.requestContext(id, params);
    if (request === undefined) return;
    const pluginItems = request.context.complete
      ? getPluginCompletions(request.context.document.text, request.offset, request.context.plugins)
      : undefined;
    const completion = getCompletions(
      request.context.document.text,
      request.offset,
      request.context.manifests,
    );
    const pluginByLabel = new Map(pluginItems?.map((item) => [item.label, item]) ?? []);
    this.result(
      id!,
      completion.items.map((item) => {
        const plugin = pluginByLabel.get(item.label);
        const insertText = plugin?.insertText ?? item.insertText ?? item.label;
        return {
          label: item.label,
          kind: completionKind(item.kind),
          detail: plugin?.detail ?? item.detail ?? "",
          documentation: {
            kind: "markdown",
            value: plugin?.documentation || item.documentation || "",
          },
          insertText,
          textEdit: { range: lspRange(completion.replaceSpan), newText: insertText },
        };
      }),
    );
  }

  private hover(id: JsonRpcId | undefined, params: unknown): void {
    const request = this.requestContext(id, params);
    if (request === undefined) return;
    const languageHover = getHover(
      request.context.document.text,
      request.offset,
      request.context.manifests,
    );
    const pluginHover = request.context.complete
      ? getPluginHover(request.context.document.text, request.offset, request.context.plugins)
      : undefined;
    const pluginDocumentation = pluginHover?.contents.split("\n\n").slice(1).join("\n\n");
    const hover =
      languageHover === undefined
        ? undefined
        : pluginDocumentation && !languageHover.contents.includes(pluginDocumentation)
          ? {
              ...languageHover,
              contents: `${languageHover.contents}\n\n${pluginDocumentation}`,
            }
          : languageHover;
    this.result(
      id!,
      hover === undefined
        ? null
        : {
            contents: { kind: "markdown", value: hover.contents },
            range: lspRange(hover.span),
          },
    );
  }

  private signatureHelp(id: JsonRpcId | undefined, params: unknown): void {
    const request = this.requestContext(id, params);
    if (request === undefined) return;
    if (!request.context.complete) {
      this.result(id!, null);
      return;
    }
    this.result(
      id!,
      getSignatureHelp(
        request.context.document.text,
        request.offset,
        request.context.manifests,
        request.context.plugins,
      ) ?? null,
    );
  }

  private semanticTokens(id: JsonRpcId | undefined, params: unknown): void {
    if (id === undefined) return;
    const context = this.context(params);
    if (context === undefined) {
      this.error(id, INVALID_PARAMS, "Request requires an open text document.");
      return;
    }
    const tokens = getSemanticTokens(context.document.text, context.manifests);
    const data: number[] = [];
    let previousLine = 0;
    let previousCharacter = 0;
    for (const token of tokens) {
      const deltaLine = token.line - previousLine;
      const deltaStart =
        deltaLine === 0 ? token.startCharacter - previousCharacter : token.startCharacter;
      let modifiers = 0;
      for (const modifier of token.modifiers) {
        if (modifier === "declaration") modifiers += 1;
        else if (modifier === "readonly") modifiers += 2;
      }
      data.push(
        deltaLine,
        deltaStart,
        token.length,
        SEMANTIC_TOKEN_TYPES.indexOf(token.tokenType),
        modifiers,
      );
      previousLine = token.line;
      previousCharacter = token.startCharacter;
    }
    this.result(id, { data });
  }

  private publishAllDiagnostics(): void {
    for (const document of this.documents.values()) this.publishDiagnostics(document);
  }

  private publishDiagnostics(document: DocumentState): void {
    const parsed = parse(document.text);
    const resolved = this.manifestResolver.resolve(document.uri, parsed.ast.usings);
    const diagnostics: Diagnostic[] = [];
    if (resolved.complete) {
      for (const item of compile(document.text, resolved.language).diagnostics)
        diagnostics.push(item);
    } else {
      for (const item of parsed.diagnostics) diagnostics.push(item);
      for (const problem of resolved.problems) diagnostics.push(manifestDiagnostic(problem));
    }
    this.send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: document.uri,
        version: document.version,
        diagnostics: diagnostics.map((diagnostic) => ({
          range: lspRange(diagnostic.span),
          severity: diagnosticSeverity(diagnostic.severity),
          code: diagnostic.code,
          source: `polici-${diagnostic.source}`,
          message: diagnostic.message,
          ...(diagnostic.related === undefined
            ? {}
            : {
                relatedInformation: diagnostic.related.map((related) => ({
                  location: { uri: document.uri, range: lspRange(related.span) },
                  message: related.message,
                })),
              }),
        })),
      },
    });
  }

  private result(id: JsonRpcId, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  private error(id: JsonRpcId, code: number, message: string): void {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }
}

/** Runs a blocking stdio LSP loop, or the same loop over supplied synchronous byte I/O. */
export function runLanguageServer(
  input: LanguageServerInput,
  output: LanguageServerOutput,
  options: LanguageServerOptions = {},
): number {
  const size = options.readBufferBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(size) || size <= 0)
    throw new RangeError("readBufferBytes must be positive");
  const session = new LanguageServerSession((message) => writeAll(output, message), options);
  const buffer = new Uint8Array(size);
  while (session.exitCode === undefined) {
    const read = input.read(buffer);
    if (!Number.isSafeInteger(read) || read < 0 || read > buffer.length)
      throw new Error("LSP input returned an invalid byte count");
    if (read === 0) {
      session.end();
      break;
    }
    session.receive(buffer.slice(0, read));
  }
  return session.exitCode ?? 0;
}

export function runLanguageServerBytes(input: Uint8Array): Uint8Array {
  let offset = 0;
  const chunks: Uint8Array[] = [];
  runLanguageServer(
    {
      read(buffer): number {
        const size = Math.min(buffer.length, input.length - offset);
        if (size <= 0) return 0;
        buffer.set(input.subarray(offset, offset + size));
        offset += size;
        return size;
      },
    },
    {
      write(buffer): number {
        chunks.push(new Uint8Array(buffer));
        return buffer.length;
      },
    },
  );
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(size);
  let outputOffset = 0;
  for (const chunk of chunks) {
    output.set(chunk, outputOffset);
    outputOffset += chunk.length;
  }
  return output;
}
