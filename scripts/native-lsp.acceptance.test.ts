import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

import { encodeLspMessage, LspFramer } from "../src/lsp/index.ts";

const executable = resolve("dist/polici");

test("compiled LSP responds to initialize before stdin closes and preserves orderly exit", async () => {
  const child = spawn(executable, ["lsp", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
  const stderr: Uint8Array[] = [];
  child.stderr.on("data", (chunk: Uint8Array) => stderr.push(Uint8Array.from(chunk)));
  try {
    child.stdin.write(
      encodeLspMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { processId: null, capabilities: {} },
      }),
    );
    const initialized = await nextMessage(child, 5_000);
    assert.equal(initialized.id, 1);
    assert.ok(initialized.result, "initialize did not return capabilities");
    assert.equal(child.stdin.destroyed, false, "stdin closed before the initialize response");

    child.stdin.write(encodeLspMessage({ jsonrpc: "2.0", id: 2, method: "shutdown" }));
    const shutdown = await nextMessage(child, 5_000);
    assert.equal(shutdown.id, 2);
    assert.equal(shutdown.result, null);
    child.stdin.end(encodeLspMessage({ jsonrpc: "2.0", method: "exit" }));
    const result = await exited(child, 5_000);
    assert.equal(result.code, 0, new TextDecoder().decode(join(stderr)));
    assert.equal(result.signal, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("compiled LSP returns 1 for exit before shutdown", async () => {
  const child = spawn(executable, ["lsp"], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(encodeLspMessage({ jsonrpc: "2.0", method: "exit" }));
  const result = await exited(child, 5_000);
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
});

function nextMessage(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ readonly id?: number; readonly result?: unknown }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const framer = new LspFramer();
    const timer = setTimeout(
      () => rejectPromise(new Error("Timed out waiting for LSP response.")),
      timeoutMs,
    );
    const data = (chunk: Uint8Array): void => {
      for (const frame of framer.push(chunk)) {
        if (frame.error !== undefined) {
          cleanup();
          rejectPromise(new Error(frame.error));
          return;
        }
        if (frame.body !== undefined) {
          cleanup();
          resolvePromise(JSON.parse(frame.body));
          return;
        }
      }
    };
    const exit = (code: number | null): void => {
      cleanup();
      rejectPromise(new Error(`LSP exited with ${String(code)} before responding.`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout.off("data", data);
      child.off("exit", exit);
    };
    child.stdout.on("data", data);
    child.on("exit", exit);
  });
}

function exited(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ readonly code: number | null; readonly signal: string | null }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error("Timed out waiting for process exit.")),
      timeoutMs,
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
  });
}

function join(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
