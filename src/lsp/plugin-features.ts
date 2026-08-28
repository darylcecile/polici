import { parse } from "../language/parser.ts";
import type { Diagnostic, SemanticToken, SourceSpan, Token } from "../language/model.ts";
import type { StaticExport, StaticPlugin } from "./metadata.ts";

interface ImportBinding {
  readonly alias: string;
  readonly aliasSpan: SourceSpan;
  readonly plugin: StaticPlugin;
}

function exported(plugin: StaticPlugin, name: string): StaticExport | undefined {
  return plugin.exports.find((item) => item.name === name);
}

export interface PluginCompletionItem {
  readonly label: string;
  readonly kind: "function" | "resource";
  readonly detail: string;
  readonly documentation: string;
  readonly insertText: string;
}

export interface PluginHover {
  readonly span: SourceSpan;
  readonly contents: string;
}

function bindings(source: string, plugins: readonly StaticPlugin[]): ImportBinding[] {
  const result: ImportBinding[] = [];
  for (const declaration of parse(source).ast.usings) {
    const coordinate = /^([^@\s]+)@([1-9][0-9]*)$/.exec(declaration.source);
    if (coordinate === null) continue;
    const plugin = plugins.find(
      (item) => item.name === coordinate[1] && item.contractMajor === Number(coordinate[2]),
    );
    if (plugin !== undefined)
      result.push({ alias: declaration.alias, aliasSpan: declaration.aliasSpan, plugin });
  }
  return result;
}

function wordStart(source: string, offset: number): number {
  let start = Math.max(0, Math.min(source.length, offset));
  while (start > 0) {
    const code = source.charCodeAt(start - 1);
    if (
      code !== 95 &&
      !(code >= 48 && code <= 57) &&
      !(code >= 65 && code <= 90) &&
      !(code >= 97 && code <= 122) &&
      code < 128
    )
      break;
    start--;
  }
  return start;
}

function identifierBefore(source: string, offset: number): string {
  let end = offset;
  while (end > 0 && /\s/.test(source.charAt(end - 1))) end--;
  let start = end;
  while (start > 0 && /[\w\u0080-\uffff]/.test(source.charAt(start - 1))) start--;
  return source.slice(start, end);
}

function signature(item: StaticExport): string {
  return `${item.name}(${item.parameters.map((parameter) => `${parameter.name}${parameter.optional ? "?" : ""}: ${parameter.type}`).join(", ")}): ${item.returns}`;
}

export function getPluginCompletions(
  source: string,
  offset: number,
  plugins: readonly StaticPlugin[],
): readonly PluginCompletionItem[] | undefined {
  if (plugins.length === 0) return undefined;
  const start = wordStart(source, offset);
  let dot = start - 1;
  while (dot >= 0 && /\s/.test(source.charAt(dot))) dot--;
  if (dot < 0 || source.charAt(dot) !== ".") return undefined;
  const receiver = identifierBefore(source, dot);
  const binding = bindings(source, plugins).find((item) => item.alias === receiver);
  if (binding === undefined) return undefined;
  const prefix = source.slice(start, offset).toLowerCase();
  const result: PluginCompletionItem[] = [];
  for (const item of binding.plugin.exports) {
    if (prefix !== "" && !item.name.toLowerCase().startsWith(prefix)) continue;
    if (item.kind === "function") {
      result.push({
        label: item.name,
        kind: "function",
        detail: signature(item),
        insertText: `${item.name}(`,
        documentation: item.documentation,
      });
    } else {
      result.push({
        label: item.name,
        kind: "resource",
        detail: item.returns,
        documentation: item.documentation,
        insertText: item.name,
      });
    }
  }
  return result.sort((left, right) =>
    left.label < right.label ? -1 : left.label > right.label ? 1 : 0,
  );
}

function significant(tokens: readonly Token[]): Token[] {
  return tokens.filter(
    (token) =>
      token.kind !== "Whitespace" &&
      token.kind !== "LineComment" &&
      token.kind !== "BlockComment" &&
      token.kind !== "EndOfFile",
  );
}

function tokenAt(tokens: readonly Token[], offset: number): number {
  for (let index = 0; index < tokens.length; index++) {
    const span = tokens[index]!.span;
    if (offset >= span.start.offset && offset <= span.end.offset) return index;
  }
  return -1;
}

export function getPluginHover(
  source: string,
  offset: number,
  plugins: readonly StaticPlugin[],
): PluginHover | undefined {
  if (plugins.length === 0) return undefined;
  const parsed = parse(source);
  const tokens = significant(parsed.tokens);
  const index = tokenAt(tokens, offset);
  if (index < 0) return undefined;
  const token = tokens[index]!;
  const imports = bindings(source, plugins);
  const binding = imports.find((item) => item.alias === token.text);
  if (binding !== undefined) {
    return {
      span: token.span,
      contents:
        binding.plugin.documentation === ""
          ? `${binding.alias}: provider ${binding.plugin.name}`
          : `${binding.alias}: provider ${binding.plugin.name}\n\n${binding.plugin.documentation}`,
    };
  }
  if (tokens[index - 1]?.kind !== "Dot") return undefined;
  const receiver = tokens[index - 2];
  const imported =
    receiver === undefined ? undefined : imports.find((item) => item.alias === receiver.text);
  if (imported === undefined) return undefined;
  const item = exported(imported.plugin, token.text);
  if (item === undefined) return undefined;
  const type = item.kind === "function" ? signature(item) : item.returns;
  return {
    span: token.span,
    contents: item.documentation === "" ? type : `${type}\n\n${item.documentation}`,
  };
}

export function getPluginSemanticTokens(
  source: string,
  plugins: readonly StaticPlugin[],
): readonly SemanticToken[] {
  if (plugins.length === 0) return [];
  const tokens = significant(parse(source).tokens);
  const imports = bindings(source, plugins);
  const result: SemanticToken[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.kind !== "Identifier") continue;
    const declaration = imports.find(
      (item) =>
        item.aliasSpan.start.offset === token.span.start.offset &&
        item.aliasSpan.end.offset === token.span.end.offset,
    );
    const imported = imports.find((item) => item.alias === token.text);
    if (declaration !== undefined || imported !== undefined) {
      result.push({
        line: token.span.start.line,
        startCharacter: token.span.start.column,
        length: token.span.end.offset - token.span.start.offset,
        tokenType: "namespace",
        modifiers: declaration === undefined ? ["readonly"] : ["declaration", "readonly"],
      });
      continue;
    }
    if (tokens[index - 1]?.kind !== "Dot") continue;
    const receiver = tokens[index - 2];
    const owner =
      receiver === undefined ? undefined : imports.find((item) => item.alias === receiver.text);
    const item = owner === undefined ? undefined : exported(owner.plugin, token.text);
    if (item === undefined) continue;
    result.push({
      line: token.span.start.line,
      startCharacter: token.span.start.column,
      length: token.span.end.offset - token.span.start.offset,
      tokenType: item.kind === "function" ? "function" : "property",
      modifiers: ["readonly"],
    });
  }
  return result;
}

function importedAliasAt(
  source: string,
  span: SourceSpan,
  plugins: readonly StaticPlugin[],
): boolean {
  if (plugins.length === 0) return false;
  const imports = bindings(source, plugins);
  const selected = source.slice(span.start.offset, span.end.offset);
  if (imports.some((item) => selected === item.alias || selected.startsWith(`${item.alias}.`)))
    return true;
  const before = source.slice(0, span.start.offset);
  const match = /([A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)\s*\.\s*$/.exec(before);
  if (match !== null) return imports.some((item) => item.alias === match[1]);
  return imports.some(
    (item) =>
      item.aliasSpan.start.offset === span.start.offset ||
      source.slice(span.start.offset, span.end.offset) === item.alias,
  );
}

export function isPluginDiagnostic(
  source: string,
  diagnostic: Diagnostic,
  plugins: readonly StaticPlugin[],
): boolean {
  if (diagnostic.code === "BIND_UNKNOWN_PROVIDER")
    return bindings(source, plugins).some((item) =>
      parse(source).ast.usings.some(
        (declaration) =>
          declaration.alias === item.alias &&
          declaration.sourceSpan.start.offset === diagnostic.span.start.offset,
      ),
    );
  if (
    diagnostic.code === "BIND_UNKNOWN_NAME" ||
    diagnostic.code === "TYPE_UNKNOWN_MEMBER" ||
    diagnostic.code === "TYPE_NOT_CALLABLE"
  )
    return importedAliasAt(source, diagnostic.span, plugins);
  return false;
}

function report(output: Diagnostic[], code: string, message: string, span: SourceSpan): void {
  output.push({ code, message, severity: "error", source: "type", span });
}

export function getPluginDiagnostics(
  source: string,
  plugins: readonly StaticPlugin[],
): readonly Diagnostic[] {
  if (plugins.length === 0) return [];
  const tokens = significant(parse(source).tokens);
  const imports = bindings(source, plugins);
  const diagnostics: Diagnostic[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const alias = tokens.at(index);
    const dot = tokens.at(index + 1);
    const member = tokens.at(index + 2);
    if (alias?.kind !== "Identifier" || dot?.kind !== "Dot" || member === undefined) continue;
    const imported = imports.find((item) => item.alias === alias.text);
    if (imported === undefined) continue;
    const item = exported(imported.plugin, member.text);
    if (item === undefined && /^[\w\u0080-\uffff]+$/.test(member.text))
      report(
        diagnostics,
        "TYPE_UNKNOWN_MEMBER",
        `Provider ${imported.plugin.name} has no member '${member.text}'.`,
        member.span,
      );
    if (
      item === undefined ||
      item.kind !== "function" ||
      tokens.at(index + 3)?.kind !== "LeftParen"
    )
      continue;
    let depth = 0;
    let arguments_ = 0;
    let hasContent = false;
    let end = tokens.at(index + 3)!.span;
    for (let cursor = index + 3; cursor < tokens.length; cursor++) {
      const token = tokens[cursor]!;
      if (token.kind === "LeftParen") depth++;
      else if (token.kind === "RightParen") {
        depth--;
        if (depth === 0) {
          end = token.span;
          break;
        }
      } else if (depth === 1 && token.kind === "Comma") arguments_++;
      else if (depth === 1) hasContent = true;
    }
    if (hasContent) arguments_++;
    const required = item.parameters.filter((parameter) => !parameter.optional).length;
    if (arguments_ < required || arguments_ > item.parameters.length)
      report(
        diagnostics,
        "TYPE_ARGUMENT_COUNT",
        `Expected ${required}-${item.parameters.length} arguments, but received ${arguments_}.`,
        { start: alias.span.start, end: end.end },
      );
  }
  return diagnostics;
}

export function findPluginFunction(
  source: string,
  calleeStart: number,
  calleeEnd: number,
  plugins: readonly StaticPlugin[],
): { readonly plugin: StaticPlugin; readonly item: StaticExport } | undefined {
  if (plugins.length === 0) return undefined;
  const text = source.slice(calleeStart, calleeEnd);
  const match =
    /^([A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)\.([A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)$/.exec(
      text,
    );
  if (match === null) return undefined;
  const binding = bindings(source, plugins).find((item) => item.alias === match[1]);
  const item = binding === undefined ? undefined : exported(binding.plugin, match[2]!);
  return binding !== undefined && item !== undefined && item.kind === "function"
    ? { plugin: binding.plugin, item }
    : undefined;
}

export function pluginFunctionSignature(item: StaticExport): {
  readonly label: string;
  readonly documentation?: string;
  readonly parameters: readonly { readonly label: string; readonly documentation?: string }[];
} {
  const parameters = item.parameters.map((parameter) => {
    const label = `${parameter.name}${parameter.optional ? "?" : ""}: ${parameter.type}${parameter.hasDefault ? ` = ${parameter.defaultText}` : ""}`;
    return {
      label,
      ...(parameter.documentation === "" ? {} : { documentation: parameter.documentation }),
    };
  });
  return {
    label: `${item.name}(${parameters.map((parameter) => parameter.label).join(", ")}): ${item.returns}`,
    parameters,
    ...(item.documentation === "" ? {} : { documentation: item.documentation }),
  };
}
