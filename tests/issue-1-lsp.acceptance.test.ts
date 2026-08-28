import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "node:test";

import { encodeLspMessage, LspFramer } from "../src/lsp/index.ts";
import {
  createStaticPluginRepository,
  removeTemporaryDirectory,
  runPolici,
  temporaryDirectory,
} from "./helpers.ts";

interface RpcMessage {
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

function request(id: number, method: string, params?: unknown): Uint8Array {
  return encodeLspMessage({
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });
}

function notify(method: string, params?: unknown): Uint8Array {
  return encodeLspMessage({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
}

function concatenate(messages: readonly Uint8Array[]): Uint8Array {
  const size = messages.reduce((total, message) => total + message.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const message of messages) {
    result.set(message, offset);
    offset += message.length;
  }
  return result;
}

function decodeMessages(stdout: string): RpcMessage[] {
  const framer = new LspFramer(4 * 1024 * 1024);
  const frames = [...framer.push(new TextEncoder().encode(stdout)), ...framer.finish()];
  return frames.map((frame) => {
    assert.equal(frame.error, undefined, frame.error);
    assert.notEqual(frame.body, undefined);
    return JSON.parse(frame.body!) as RpcMessage;
  });
}

function response(messages: readonly RpcMessage[], id: number): RpcMessage {
  const found = messages.find((message) => message.id === id);
  assert.ok(found, `missing LSP response ${id}`);
  assert.equal(found.error, undefined, found.error?.message);
  return found!;
}

function stdioSession(input: readonly Uint8Array[], cwd?: string): RpcMessage[] {
  const result = runPolici(["lsp", "--stdio"], {
    cwd,
    input: concatenate(input),
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, "");
  return decodeMessages(result.stdout);
}

describe("Issue #1 compiled LSP acceptance", () => {
  test("GitHub metadata drives completion, hover, signature help, and semantic tokens over stdio", () => {
    const uri = "file:///tmp/issue-1-github.pol";
    const text = `using "github@1" as Git
policy "p" {
  changes = Git.changes("**/*")
  rule "r" { require Git.check("ci", ) passed }
}`;
    const messages = stdioSession([
      request(1, "initialize", { processId: null, capabilities: {} }),
      notify("initialized"),
      notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "polici", version: 1, text },
      }),
      request(2, "textDocument/completion", {
        textDocument: { uri },
        position: { line: 2, character: "  changes = Git.".length },
      }),
      request(3, "textDocument/hover", {
        textDocument: { uri },
        position: { line: 2, character: "  changes = Git.chang".length },
      }),
      request(4, "textDocument/signatureHelp", {
        textDocument: { uri },
        position: { line: 3, character: '  rule "r" { require Git.check("ci", '.length },
      }),
      request(5, "textDocument/semanticTokens/full", { textDocument: { uri } }),
      request(6, "shutdown"),
      notify("exit"),
    ]);

    const initialization = response(messages, 1).result as {
      capabilities: Record<string, unknown>;
    };
    assert.equal(initialization.capabilities.positionEncoding, "utf-16");
    assert.ok(initialization.capabilities.signatureHelpProvider);

    const completion = response(messages, 2).result as readonly {
      label: string;
      detail?: string;
    }[];
    assert.ok(
      completion.some((item) => item.label === "changes" && /ChangeSet/.test(item.detail ?? "")),
    );
    assert.ok(completion.some((item) => item.label === "check" && /Check/.test(item.detail ?? "")));
    assert.ok(completion.some((item) => item.label === "pull_request"));
    assert.ok(completion.some((item) => item.label === "team"));

    assert.match(JSON.stringify(response(messages, 3).result), /ChangeSet/);
    const signature = response(messages, 4).result as {
      activeParameter: number;
      signatures: readonly { label: string }[];
    };
    assert.equal(signature.activeParameter, 1);
    assert.match(signature.signatures[0]?.label ?? "", /producer\?: string/);

    const semantic = response(messages, 5).result as { data: number[] };
    assert.ok(semantic.data.length > 0);
    assert.equal(semantic.data.length % 5, 0);
    const tokenTypes = (
      initialization.capabilities.semanticTokensProvider as {
        legend: { tokenTypes: string[] };
      }
    ).legend.tokenTypes;
    const emittedTypes = new Set<string>();
    for (let index = 0; index < semantic.data.length; index += 5) {
      assert.ok(semantic.data[index]! >= 0);
      assert.ok(semantic.data[index + 1]! >= 0);
      assert.ok(semantic.data[index + 2]! > 0);
      emittedTypes.add(tokenTypes[semantic.data[index + 3]!]!);
    }
    assert.ok(emittedTypes.has("namespace"), "Git alias was not tokenized as a namespace");
    assert.ok(emittedTypes.has("function"), "Git functions were not tokenized as functions");
    assert.equal(response(messages, 6).result, null);
  });

  test("LSP validation and features load a locked manifest without executing its runtime", () => {
    const root = temporaryDirectory("polici-lsp-static-");
    try {
      const sentinel = createStaticPluginRepository(root, "polici.lock.json");
      const policy = 'using "safe@1" as Safe\npolicy "p" { rule "r" { require Safe.lookup() } }\n';
      writeFileSync(resolve(root, "policy.pol"), policy);
      const uri = `file://${resolve(root, "policy.pol")}`;
      const messages = stdioSession(
        [
          request(1, "initialize", {
            processId: null,
            rootUri: `file://${root}`,
            capabilities: {},
          }),
          notify("initialized"),
          notify("textDocument/didOpen", {
            textDocument: { uri, languageId: "polici", version: 1, text: policy },
          }),
          request(2, "textDocument/hover", {
            textDocument: { uri },
            position: { line: 1, character: 'policy "p" { rule "r" { require Safe.look'.length },
          }),
          request(3, "shutdown"),
          notify("exit"),
        ],
        root,
      );
      const diagnostics = messages.find(
        (message) => message.method === "textDocument/publishDiagnostics",
      )?.params?.diagnostics;
      assert.deepEqual(diagnostics, []);
      assert.match(JSON.stringify(response(messages, 2).result), /safe lookup/i);
      assert.equal(existsSync(sentinel), false, "LSP executed the plugin runtime");
    } finally {
      removeTemporaryDirectory(root);
    }
  });
});
