import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "node:test";

import {
  TypeScriptProcessResolverHost,
  WasiProcessResolverHost,
  wire,
  type CapabilityBroker,
  type ResolverHost,
} from "../src/plugin/index.ts";
import { workspaceRoot } from "./helpers.ts";

const runtimeSource = resolve(workspaceRoot, "examples/runtime/typescript/runtime.ts");
const wasmArtifact = resolve(workspaceRoot, "examples/runtime/wasm/runtime.wasm");
const wasmtime = process.env.WASMTIME ?? executable("wasmtime");

function executable(command: string): string | undefined {
  try {
    return (
      execFileSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

function broker(transcript: string[]): CapabilityBroker {
  return async (request) => {
    transcript.push(
      `${request.callId}:${request.sequence}:${request.capability}:${request.operation}`,
    );
    return { ok: true, value: wire.string(`page-${request.sequence}`) };
  };
}

async function assertTranscript(host: ResolverHost, transcript: string[]): Promise<void> {
  assert.deepEqual(await host.resolve({ resolver: "success", arguments: {} }), wire.string("ok"));
  assert.deepEqual(
    await host.resolve({ resolver: "multiple", arguments: {} }),
    wire.list([wire.string("page-1"), wire.string("page-2")]),
  );
  const lifecycle = await host.resolve({ resolver: "lifecycle", arguments: {} });
  assert.equal(lifecycle.tag, "map");
  if (lifecycle.tag === "map") {
    assert.deepEqual(lifecycle.entries.initialized, wire.integer(1));
    assert.deepEqual(lifecycle.entries.calls, wire.integer(3));
  }
  assert.deepEqual(transcript, ["call-3:1:example:data:read", "call-3:2:example:data:read"]);
  await host.dispose?.();
}

describe("Issue #1 external runtime acceptance", () => {
  test("the local TypeScript runtime conforms to initialize/call/capability/shutdown transcripts", async () => {
    assert.equal(existsSync(runtimeSource), true);
    const transcript: string[] = [];
    const host = new TypeScriptProcessResolverHost({
      cwd: "/",
      entrypoint: process.execPath,
      arguments: [runtimeSource],
      trustedRuntime: true,
      plugin: { name: "example", version: "1.0.0" },
      capabilities: [{ name: "example:data", operations: ["read"] }],
      capabilityBroker: broker(transcript),
    });
    await assertTranscript(host, transcript);
  });

  test("the local WASI artifact produces the same normalized transcript", async () => {
    assert.equal(existsSync(wasmArtifact), true, "WASI conformance artifact is missing");
    assert.notEqual(wasmtime, undefined, "wasmtime is required for WASI conformance");
    const transcript: string[] = [];
    if (wasmtime === undefined) throw new Error("wasmtime is required for WASI conformance");
    const host = new WasiProcessResolverHost({
      cwd: "/",
      command: wasmtime,
      entrypoint: wasmArtifact,
      plugin: { name: "example", version: "1.0.0" },
      capabilities: [{ name: "example:data", operations: ["read"] }],
      capabilityBroker: broker(transcript),
    });
    await assertTranscript(host, transcript);
  });
});
