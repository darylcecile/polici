// @ts-ignore This bare repository intentionally does not depend on @types/node.
import assert from "node:assert/strict";
// @ts-ignore This bare repository intentionally does not depend on @types/node.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// @ts-ignore This bare repository intentionally does not depend on @types/node.
import { tmpdir } from "node:os";
// @ts-ignore This bare repository intentionally does not depend on @types/node.
import { join } from "node:path";
// @ts-ignore This bare repository intentionally does not depend on @types/node.
import test from "node:test";

import { canonicalPluginManifestSha256 } from "../plugin/lockfile.js";
import type { PluginManifest } from "../plugin/manifest.js";
import { encodeLspMessage, LspFramer } from "./framing.ts";
import { LanguageServerSession, offsetAt } from "./server.ts";

interface RpcMessage {
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

function frame(message: unknown): Uint8Array {
  return encodeLspMessage(message);
}

function concat(...values: readonly Uint8Array[]): Uint8Array {
  let size = 0;
  for (const value of values) size += value.length;
  const result = new Uint8Array(size);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function harness(): { session: LanguageServerSession; messages: RpcMessage[] } {
  const messages: RpcMessage[] = [];
  return {
    messages,
    session: new LanguageServerSession((message) => messages.push(message as RpcMessage)),
  };
}

function request(id: number, method: string, params?: unknown): Uint8Array {
  return frame({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
}

function notify(method: string, params?: unknown): Uint8Array {
  return frame({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
}

function initialize(session: LanguageServerSession, rootUri?: string): void {
  session.receive(
    request(1, "initialize", {
      processId: null,
      capabilities: {},
      ...(rootUri === undefined ? {} : { rootUri }),
    }),
  );
}

function open(session: LanguageServerSession, uri: string, text: string): void {
  session.receive(
    notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "polici", version: 1, text },
    }),
  );
}

function byId(messages: readonly RpcMessage[], id: number): RpcMessage {
  const found = messages.find((message) => message.id === id);
  assert.ok(found, `missing response ${id}`);
  return found!;
}

function diagnostics(messages: readonly RpcMessage[]): readonly Record<string, unknown>[] {
  const published = messages.filter(
    (message) => message.method === "textDocument/publishDiagnostics",
  );
  const value = published.at(-1)?.params?.diagnostics;
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

test("Content-Length framing handles partial and multiple UTF-8 frames with limits", () => {
  const first = frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { name: "😀" } });
  const second = frame({ jsonrpc: "2.0", method: "exit" });
  const parser = new LspFramer(1024);
  assert.deepEqual(parser.push(first.slice(0, 9)), []);
  const parsed = parser.push(concat(first.slice(9), second));
  assert.equal(parsed.length, 2);
  assert.match(parsed[0]?.body ?? "", /😀/);
  assert.match(parsed[1]?.body ?? "", /exit/);

  const bounded = new LspFramer(4);
  assert.deepEqual(bounded.push("Content-Length: 5\r\n\r\n12345"), [
    { error: "Content-Length exceeds the 4 byte limit." },
  ]);
});

test("initialize advertises full sync features without completion resolve", () => {
  const { session, messages } = harness();
  initialize(session);
  const response = byId(messages, 1).result as Record<string, unknown>;
  const capabilities = response.capabilities as Record<string, unknown>;
  assert.deepEqual(capabilities.textDocumentSync, { openClose: true, change: 1 });
  assert.deepEqual(capabilities.completionProvider, { triggerCharacters: ["."] });
  assert.equal(capabilities.hoverProvider, true);
  assert.ok(capabilities.signatureHelpProvider);
  assert.ok(capabilities.semanticTokensProvider);
  assert.equal(capabilities.positionEncoding, "utf-16");
});

test("didOpen publishes parser and type diagnostics and full changes replace text", () => {
  const { session, messages } = harness();
  initialize(session);
  const uri = "file:///tmp/open.pol";
  open(session, uri, 'policy "p" { rule "r" { require Files("**/*") } }');
  assert.ok(diagnostics(messages).some((item) => item.code === "TYPE_MISMATCH"));
  session.receive(
    notify("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: 'policy "p" { rule "r" { require true }' }],
    }),
  );
  assert.ok(diagnostics(messages).some((item) => item.code === "PARSE_EXPECTED_TOKEN"));
  session.receive(notify("textDocument/didClose", { textDocument: { uri } }));
  assert.deepEqual(diagnostics(messages), []);
});

test("GitHub strict manifest powers relation diagnostics and nested semantic features", () => {
  const { session, messages } = harness();
  initialize(session);
  const uri = "file:///tmp/github.pol";
  const text = `using "github@1" as Git
policy "p" {
  value = Git.changes("**/*")
  rule "relation" { require some Git.pull_request.approvers in Git.team("platform").members }
  rule "check" { require Git.check("ci", ) passed }
}`;
  open(session, uri, text);
  assert.deepEqual(diagnostics(messages), []);

  session.receive(
    request(2, "textDocument/completion", {
      textDocument: { uri },
      position: { line: 2, character: "  value = Git.".length },
    }),
  );
  const completion = byId(messages, 2).result as readonly Record<string, unknown>[];
  assert.ok(completion.some((item) => item.label === "changes"));
  assert.ok(completion.some((item) => item.label === "pull_request"));

  session.receive(
    request(3, "textDocument/hover", {
      textDocument: { uri },
      position: { line: 2, character: 15 },
    }),
  );
  assert.match(JSON.stringify(byId(messages, 3).result), /ChangeSet/);

  session.receive(
    request(4, "textDocument/signatureHelp", {
      textDocument: { uri },
      position: { line: 4, character: '  rule "check" { require Git.check("ci", '.length },
    }),
  );
  const signature = byId(messages, 4).result as Record<string, unknown>;
  assert.equal(signature.activeParameter, 1);
  assert.match(JSON.stringify(signature), /producer\?: string/);

  const relation = text.split("\n")[3]!;
  session.receive(
    request(5, "textDocument/completion", {
      textDocument: { uri },
      position: { line: 3, character: relation.indexOf("approvers") },
    }),
  );
  const pullRequestFields = byId(messages, 5).result as readonly Record<string, unknown>[];
  assert.ok(pullRequestFields.some((item) => item.label === "approvers"));

  session.receive(
    request(6, "textDocument/completion", {
      textDocument: { uri },
      position: { line: 3, character: relation.indexOf("members") },
    }),
  );
  const teamFields = byId(messages, 6).result as readonly Record<string, unknown>[];
  assert.ok(teamFields.some((item) => item.label === "members"));

  session.receive(
    request(7, "textDocument/hover", {
      textDocument: { uri },
      position: { line: 3, character: relation.indexOf("approvers") + 2 },
    }),
  );
  assert.match(JSON.stringify(byId(messages, 7).result), /Set<github\.User>/);

  session.receive(
    request(8, "textDocument/hover", {
      textDocument: { uri },
      position: { line: 3, character: relation.indexOf("members") + 2 },
    }),
  );
  assert.match(JSON.stringify(byId(messages, 8).result), /Set<github\.User>/);

  session.receive(
    request(9, "textDocument/signatureHelp", {
      textDocument: { uri },
      position: { line: 3, character: relation.indexOf('"platform"') + 1 },
    }),
  );
  assert.match(JSON.stringify(byId(messages, 9).result), /team\(slug: string\): github\.Team/);

  session.receive(request(10, "textDocument/semanticTokens/full", { textDocument: { uri } }));
  const semantic = byId(messages, 10).result as { data: number[] };
  assert.ok(semantic.data.length > 0);
  assert.equal(semantic.data.length % 5, 0);
  for (let index = 0; index < semantic.data.length; index += 5) {
    assert.ok(semantic.data[index]! >= 0);
    assert.ok(semantic.data[index + 1]! >= 0);
    assert.ok(semantic.data[index + 2]! > 0);
  }
});

test("UTF-16 positions handle astral characters in requests and semantic lengths", () => {
  assert.equal(offsetAt("😀x", { line: 0, character: 2 }), 2);
  const { session, messages } = harness();
  initialize(session);
  const uri = "file:///tmp/utf16.pol";
  const text = '// 😀\npolicy "p" { files = Files("😀") }';
  open(session, uri, text);
  session.receive(request(2, "textDocument/semanticTokens/full", { textDocument: { uri } }));
  const data = (byId(messages, 2).result as { data: number[] }).data;
  assert.deepEqual(data.slice(0, 5), [0, 0, 5, 0, 0]);
  assert.ok(data.some((value, index) => index % 5 === 2 && value === 4));
});

function fixtureManifest(): PluginManifest {
  return {
    schema: "polici.plugin/v2",
    schemaVersion: 2,
    name: "safe",
    version: "1.0.0",
    policiApi: 1,
    contractMajor: 1,
    types: {},
    exports: {
      lookup: {
        kind: "function",
        parameters: [{ name: "value", type: { kind: "string" }, default: "ok" }],
        returns: { kind: "boolean" },
        resolve: "lookup",
      },
    },
    permissions: [],
    runtime: {
      kind: "typescript",
      protocol: 1,
      entrypoint: "./runtime-do-not-run",
      transport: "jsonl",
      capabilities: [],
    },
  };
}

function lock(manifest: PluginManifest, digest: string): unknown {
  return {
    schema: "polici.lock/v2",
    schemaVersion: 2,
    plugins: [
      {
        name: manifest.name,
        version: manifest.version,
        contractMajor: manifest.contractMajor,
        source: { kind: "path", locator: ".polici/safe@1.0.0" },
        manifest: { algorithm: "sha256", value: digest },
        artifact: { algorithm: "sha256", value: "0".repeat(64) },
        runtime: manifest.runtime,
      },
    ],
  };
}

test("locked path manifests are static-only and never execute runtime artifacts", () => {
  const directory = mkdtempSync(join(tmpdir(), "polici-lsp-runtime-"));
  try {
    const pluginDirectory = join(directory, ".polici/safe");
    mkdirSync(pluginDirectory, { recursive: true });
    const manifest = fixtureManifest();
    writeFileSync(join(pluginDirectory, "manifest.json"), JSON.stringify(manifest));
    const sentinel = join(directory, "EXECUTED");
    writeFileSync(
      join(pluginDirectory, "runtime-do-not-run"),
      `#!/bin/sh\nprintf executed > ${JSON.stringify(sentinel)}\n`,
    );
    chmodSync(join(pluginDirectory, "runtime-do-not-run"), 0o755);
    writeFileSync(
      join(directory, "polici.lock"),
      JSON.stringify(lock(manifest, canonicalPluginManifestSha256(manifest).value)),
    );
    const uri = `file://${directory}/policy.pol`;
    const { session, messages } = harness();
    initialize(session, `file://${directory}`);
    open(session, uri, 'using "safe@1" as Safe\npolicy "p" { rule "r" { require Safe.lookup() } }');
    assert.deepEqual(diagnostics(messages), []);
    assert.throws(() => readFileSync(sentinel));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("default lock discovery prefers polici.lock and falls back to polici.lock.json", () => {
  const directory = mkdtempSync(join(tmpdir(), "polici-lsp-lock-name-"));
  try {
    const pluginDirectory = join(directory, ".polici/safe");
    mkdirSync(pluginDirectory, { recursive: true });
    const manifest = fixtureManifest();
    writeFileSync(join(pluginDirectory, "manifest.json"), JSON.stringify(manifest));
    const validLock = lock(manifest, canonicalPluginManifestSha256(manifest).value);
    writeFileSync(join(directory, "polici.lock"), JSON.stringify(validLock));
    writeFileSync(
      join(directory, "polici.lock.json"),
      JSON.stringify(lock(manifest, "f".repeat(64))),
    );

    const uri = `file://${directory}/policy.pol`;
    const { session, messages } = harness();
    initialize(session, `file://${directory}`);
    open(session, uri, 'using "safe@1" as Safe\npolicy "p" { rule "r" { require Safe.lookup() } }');
    assert.deepEqual(diagnostics(messages), []);

    rmSync(join(directory, "polici.lock"));
    const fallback = harness();
    initialize(fallback.session, `file://${directory}`);
    open(fallback.session, uri, 'using "safe@1" as Safe\npolicy "p" { rule "r" { require true } }');
    assert.deepEqual(
      diagnostics(fallback.messages).map((item) => item.code),
      ["LSP_MANIFEST_DIGEST_MISMATCH"],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("manifest digest mismatch is deterministic and degrades to syntax-only diagnostics", () => {
  const directory = mkdtempSync(join(tmpdir(), "polici-lsp-digest-"));
  try {
    const pluginDirectory = join(directory, ".polici/safe");
    mkdirSync(pluginDirectory, { recursive: true });
    const manifest = fixtureManifest();
    writeFileSync(join(pluginDirectory, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(
      join(directory, "polici.lock.json"),
      JSON.stringify(lock(manifest, "f".repeat(64))),
    );
    const { session, messages } = harness();
    initialize(session, `file://${directory}`);
    open(
      session,
      `file://${directory}/policy.pol`,
      'using "safe@1" as Safe\npolicy "p" { rule "r" { require Safe.lookup() } }',
    );
    const values = diagnostics(messages);
    assert.deepEqual(
      values.map((item) => item.code),
      ["LSP_MANIFEST_DIGEST_MISMATCH"],
    );
    assert.ok(!values.some((item) => item.code === "BIND_UNKNOWN_PROVIDER"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cancelled and unknown requests return deterministic protocol errors", () => {
  const { session, messages } = harness();
  initialize(session);
  session.receive("Content-Length: 1\r\n\r\n{");
  assert.equal(messages.at(-1)?.error?.code, -32700);
  session.receive(notify("$/cancelRequest", { id: 9 }));
  session.receive(request(9, "textDocument/hover", {}));
  assert.equal(byId(messages, 9).error?.code, -32800);
  session.receive(request(10, "polici/unknown"));
  assert.deepEqual(byId(messages, 10).error, {
    code: -32601,
    message: "Method not found: polici/unknown",
  });
  session.receive(request(11, "shutdown"));
  assert.equal(byId(messages, 11).result, null);
  session.receive(notify("exit"));
  assert.equal(session.exitCode, 0);
});
