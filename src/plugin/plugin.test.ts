// @ts-ignore This bare repository intentionally does not depend on @types/node.
import assert from "node:assert/strict";
// @ts-ignore This bare repository intentionally does not depend on @types/node.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
// @ts-ignore This bare repository intentionally does not depend on @types/node.
import { tmpdir } from "node:os";
// @ts-ignore This bare repository intentionally does not depend on @types/node.
import test from "node:test";
// @ts-ignore This bare repository intentionally does not depend on @types/node.
import { resolve } from "node:path";

import { File } from "../core/file.js";
import { parseStrictJson } from "../core/json.js";
import { RepositorySnapshot } from "../core/repository.js";
import { compilePolicy } from "../engine/compile.ts";
import { evaluatePolicy } from "../engine/evaluate.ts";
import { definePlugin, pluginManifestJson } from "../sdk/define.js";
import { type } from "../sdk/builders.js";
import { defineRuntime, handleRuntimeMessage, RuntimeResolverError } from "../sdk/runtime.js";
import {
  assertLockedPluginArtifact,
  canonicalPluginManifestSha256,
  createLockedPlugin,
  pluginLockfileJson,
  type PluginLockfile,
} from "./lockfile.js";
import { validatePluginManifest, type PluginManifest } from "./manifest.js";
import { canonicalStringify, validateJsonValue } from "./json.js";
import {
  decodeProtocolMessages,
  encodeProtocolMessages,
  TypeScriptProcessResolverHost,
  WasiProcessResolverHost,
} from "./process.js";
import { RUNTIME_PROTOCOL, type HostMessage, type RuntimeMessage } from "./protocol.js";
import {
  FunctionResolverHost,
  ResolverFault,
  validateResolverRequest,
  type CapabilityBroker,
} from "./resolver.js";
import { validateWireValue, wire } from "./wire.js";
import { validateWasiCommand } from "./wasm.js";

function provider(): Readonly<PluginManifest> {
  return definePlugin({
    name: "audit",
    version: "1.2.3",
    policiApi: 1,
    contractMajor: 9,
    types: {
      Subject: type.entity({
        identity: "id",
        fields: {
          id: type.id("audit:subject"),
          level: type.integer({ minimum: 1, maximum: 5 }),
        },
      }),
    },
    exports: {
      subject: type.function({
        parameters: [
          type.parameter("name", type.string({ pattern: "^[a-z]+$" })),
          type.parameter("level", type.integer({ minimum: 1, maximum: 5 }), { default: 3 }),
        ],
        returns: type.ref("Subject"),
        resolve: "subject",
      }),
    },
    runtime: { kind: "typescript", entrypoint: "./audit-runtime" },
  });
}

test("TypeScript authoring normalizes issue-style parameter objects and source entrypoints", () => {
  const manifest = definePlugin({
    name: "example",
    version: "1.0.0",
    policiApi: 1,
    contractMajor: 1,
    exports: {
      changes: type.function({
        parameters: { pattern: type.glob({ default: "**/*" }) },
        returns: type.boolean(),
        resolve: "changes",
      }),
    },
    runtime: { kind: "typescript", entrypoint: "./runtime.ts" },
  });
  assert.equal(manifest.runtime.entrypoint, "./runtime");
  assert.deepEqual(manifest.exports.changes, {
    kind: "function",
    parameters: [{ name: "pattern", type: { kind: "glob" }, default: "**/*" }],
    returns: { kind: "boolean" },
    resolve: "changes",
  });
});

test("default-exportable runtimes adapt ordinary resolvers to resumable protocol messages", async () => {
  const runtime = defineRuntime({
    name: "ownership",
    version: "1.0.1",
    resolvers: {
      approved(_context, { owner }) {
        return owner === "platform";
      },
      failure() {
        throw new RuntimeResolverError("OWNER_UNKNOWN", "resolver", "Unknown owner");
      },
    },
  });
  const limits = {
    maxFrameBytes: 1024,
    maxMessageBytes: 1024,
    maxOutputBytes: 4096,
    maxLogBytes: 1024,
    maxContinuationBytes: 4096,
    maxCapabilityCalls: 8,
  };
  const initialized = await handleRuntimeMessage(runtime, {
    protocol: RUNTIME_PROTOCOL,
    type: "initialize",
    id: "initialize-1",
    host: { name: "polici", version: "1" },
    plugin: { name: "ownership", version: "1.0.1" },
    capabilities: [],
    limits,
  });
  assert.equal(initialized.type, "initialized");
  if (initialized.type !== "initialized") return;
  const first = await handleRuntimeMessage(runtime, {
    protocol: RUNTIME_PROTOCOL,
    type: "call",
    id: "call-1",
    resolver: "approved",
    arguments: { owner: wire.string("platform") },
    continuation: initialized.continuation,
    deadlineUnixMs: Date.now() + 30_000,
  });
  assert.equal(first.type, "result");
  if (first.type !== "result") return;
  assert.deepEqual(first.value, wire.boolean(true));
  assert.notEqual(first.continuation, initialized.continuation);
  const failed = await handleRuntimeMessage(runtime, {
    protocol: RUNTIME_PROTOCOL,
    type: "call",
    id: "call-2",
    resolver: "failure",
    arguments: {},
    continuation: first.continuation,
    deadlineUnixMs: Date.now() + 30_000,
  });
  assert.equal(failed.type, "error");
  if (failed.type === "error") assert.equal(failed.error.code, "OWNER_UNKNOWN");
});

test("runtime capability helpers replay awaited calls across process exchanges", async () => {
  const runtime = defineRuntime({
    name: "example",
    version: "1.0.0",
    capabilities: ["example:data"],
    resolvers: {
      async lookup(context, { key }) {
        return context.capability("example:data").call("read", { key });
      },
    },
  });
  const limits = {
    maxFrameBytes: 4096,
    maxMessageBytes: 4096,
    maxOutputBytes: 8192,
    maxLogBytes: 1024,
    maxContinuationBytes: 8192,
    maxCapabilityCalls: 8,
  };
  const initialized = await handleRuntimeMessage(runtime, {
    protocol: RUNTIME_PROTOCOL,
    type: "initialize",
    id: "initialize",
    host: { name: "polici", version: "1" },
    plugin: { name: "example", version: "1.0.0" },
    capabilities: [{ name: "example:data", operations: ["read"] }],
    limits,
  });
  assert.equal(initialized.type, "initialized");
  if (initialized.type !== "initialized") return;
  const pending = await handleRuntimeMessage(runtime, {
    protocol: RUNTIME_PROTOCOL,
    type: "call",
    id: "call",
    resolver: "lookup",
    arguments: { key: wire.string("owner") },
    continuation: initialized.continuation,
    deadlineUnixMs: Date.now() + 30_000,
  });
  assert.equal(pending.type, "capability-call");
  if (pending.type !== "capability-call") return;
  assert.deepEqual(pending.arguments, { key: wire.string("owner") });
  const result = await handleRuntimeMessage(runtime, {
    protocol: RUNTIME_PROTOCOL,
    type: "capability-result",
    id: "call",
    requestId: pending.requestId,
    sequence: pending.sequence,
    continuation: pending.continuation,
    result: wire.string("platform"),
  });
  assert.equal(result.type, "result");
  if (result.type === "result") assert.deepEqual(result.value, wire.string("platform"));
});

test("locked compilation verifies exact source, manifest, artifact, and contract major", () => {
  const manifest = provider();
  const artifact = new TextEncoder().encode("artifact");
  const locked = createLockedPlugin({
    source: { kind: "registry", locator: "audit@1.2.3" },
    manifest,
    artifact,
  });
  const lockfile: PluginLockfile = {
    schema: "polici.lock/v2",
    schemaVersion: 2,
    plugins: [locked],
  };
  const source = 'using "audit@9" as Audit\npolicy "p" { rule "r" { require true } }';
  const compiled = compilePolicy(source, {
    lockfile,
    lockedPlugins: [{ lock: locked, manifest, artifact }],
  });
  assert.deepEqual(compiled.diagnostics, []);
  assert.equal(compiled.pluginBindings[0]?.source.locator, "audit@1.2.3");
  assert.match(pluginLockfileJson(lockfile), /audit@1\.2\.3/);
  assert.throws(() => assertLockedPluginArtifact(locked, new TextEncoder().encode("tampered")));

  const unlocked = compilePolicy(source, {
    trustedBuiltins: [],
  });
  assert.ok(unlocked.diagnostics.some((item) => item.code === "PROVIDER_LOCK_REQUIRED"));

  const forged = { ...compiled, pluginBindings: [] };
  return assert.rejects(
    () => evaluatePolicy(forged, { repository: new RepositorySnapshot() }),
    /compiler-produced IR/,
  );
});

test("compiled policy data is cloned, frozen, and structurally unforgeable", async () => {
  const manifest = provider() as PluginManifest;
  const artifact = new TextEncoder().encode("artifact");
  const locked = createLockedPlugin({
    source: { kind: "registry", locator: "audit@1.2.3" },
    manifest,
    artifact,
  });
  const compiled = compilePolicy(
    'using "audit@9" as Audit\npolicy "p" { rule "r" { require true } }',
    {
      lockfile: { schema: "polici.lock/v2", schemaVersion: 2, plugins: [locked] },
      lockedPlugins: [{ lock: locked, manifest, artifact }],
    },
  );
  assert.equal(Object.isFrozen(compiled), true);
  assert.equal(Object.isFrozen(compiled.manifests[0]), true);
  await assert.rejects(
    () => evaluatePolicy({ ...compiled }, { repository: new RepositorySnapshot() }),
    /compiler-produced IR/,
  );
});

test("ordered parameters and recursive defaults enforce manifest constraints", () => {
  const manifest = structuredClone(provider()) as PluginManifest;
  const function_ = manifest.exports.subject;
  assert.equal(function_?.kind, "function");
  if (function_?.kind !== "function") return;
  (function_.parameters as unknown as { default?: unknown }[])[1]!.default = 8;
  const invalid = validatePluginManifest(manifest);
  assert.ok(!invalid.ok);
  if (!invalid.ok) assert.ok(invalid.issues.some((issue) => issue.code === "default_constraint"));

  const wrongOrder = structuredClone(provider()) as PluginManifest;
  const ordered = wrongOrder.exports.subject;
  if (ordered?.kind !== "function") return;
  (ordered.parameters as unknown as { optional?: boolean }[])[0]!.optional = true;
  delete (ordered.parameters as unknown as { default?: unknown }[])[1]!.default;
  assert.ok(!validatePluginManifest(wrongOrder).ok);
});

test("wire bounds run before recursive validation and canonical sets use code-unit order", () => {
  const deep: { tag: "list"; items: unknown[] } = { tag: "list", items: [] };
  let current = deep;
  for (let index = 0; index < 20; index += 1) {
    const child: { tag: "list"; items: unknown[] } = { tag: "list", items: [] };
    current.items.push(child);
    current = child;
  }
  const bounded = validateWireValue(deep, "$value", { depth: 5 });
  assert.ok(!bounded.ok);
  if (!bounded.ok) assert.equal(bounded.issues[0]?.code, "limit");
  const set = wire.set([wire.string("ä"), wire.string("z")]);
  assert.equal(set.tag, "set");
  if (set.tag !== "set") return;
  assert.deepEqual(set.items, [wire.string("z"), wire.string("ä")]);
});

test("base64 validation enforces canonical trailing bits in builders and parsed wire values", () => {
  assert.deepEqual(wire.bytes("Zg=="), { tag: "bytes", encoding: "base64", value: "Zg==" });
  assert.equal(validateWireValue(wire.bytes("Zg==")).ok, true);
  assert.throws(() => wire.bytes("Zh=="), /base64/);
  assert.equal(validateWireValue({ tag: "bytes", encoding: "base64", value: "Zh==" }).ok, false);
  assert.equal(validateWireValue({ tag: "bytes", encoding: "base64", value: "Zm8=" }).ok, true);
  assert.equal(validateWireValue({ tag: "bytes", encoding: "base64", value: "Zm9=" }).ok, false);
});

test("programmatic JSON and manifests reject non-data objects and cumulative string excess", () => {
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, "value", {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return "executed";
    },
  });
  const hazards: unknown[] = [
    { value: undefined },
    { [Symbol("key")]: "value" },
    new Date(0),
    Object.create({ inherited: true }),
    accessor,
    Object.assign(new (class Custom {})(), { value: true }),
    Object.assign(Array(2), { 1: "sparse" }),
  ];
  for (const value of hazards) {
    assert.equal(validateJsonValue(value).ok, false);
    assert.throws(() => canonicalStringify(value));
  }
  assert.equal(getterCalls, 0);
  const nullPrototype = Object.assign(Object.create(null), { value: "ok" });
  assert.equal(validateJsonValue(nullPrototype).ok, true);
  assert.equal(canonicalStringify(nullPrototype), '{"value":"ok"}');

  const manifest = structuredClone(provider()) as PluginManifest;
  const strings = validatePluginManifest(manifest, { stringCodeUnits: 10 });
  assert.equal(strings.ok, false);
  if (!strings.ok) assert.ok(strings.issues.some((issue) => issue.code === "limit"));
  assert.throws(() =>
    pluginManifestJson({ ...manifest, documentation: { summary: undefined } } as never),
  );
  assert.throws(() =>
    canonicalPluginManifestSha256({
      ...manifest,
      documentation: { summary: undefined },
    } as never),
  );
});

test("manifest patterns use the anchored linear subset and lazy resolvers only exist on entity sets", () => {
  const unsafe = structuredClone(provider()) as PluginManifest;
  const function_ = unsafe.exports.subject;
  if (function_?.kind !== "function") return;
  (function_.parameters[0]!.type as { pattern?: string }).pattern = "^(a+)+$";
  assert.equal(validatePluginManifest(unsafe).ok, false);

  const placements = [
    (manifest: PluginManifest) => {
      const exported = manifest.exports.subject;
      if (exported?.kind === "function")
        (exported.parameters[0]!.type as { resolve?: string }).resolve = "bad";
    },
    (manifest: PluginManifest) => {
      (manifest.types.Subject!.fields.level as { resolve?: string }).resolve = "bad";
    },
    (manifest: PluginManifest) => {
      (manifest.types.Subject!.fields.level as unknown as {
        kind: string;
        items: unknown;
        resolve: string;
      }) = {
        kind: "list",
        items: { kind: "string" },
        resolve: "bad",
      };
    },
  ];
  for (const place of placements) {
    const manifest = structuredClone(provider()) as PluginManifest;
    place(manifest);
    assert.equal(validatePluginManifest(manifest).ok, false);
  }

  const capabilityGap = structuredClone(provider()) as PluginManifest;
  capabilityGap.permissions = ["audit:read"];
  assert.equal(validatePluginManifest(capabilityGap).ok, false);

  const unknownMethodReference = structuredClone(provider()) as PluginManifest;
  unknownMethodReference.types.Subject!.methods = {
    related: {
      parameters: [],
      returns: { kind: "ref", type: "Missing" },
      resolve: "subject.related",
    },
  };
  assert.equal(validatePluginManifest(unknownMethodReference).ok, false);
});

test("resolver hosts validate closed requests before invoking in-process functions", async () => {
  let invoked = false;
  const host = new FunctionResolverHost({
    subject: () => {
      invoked = true;
      return wire.string("unreachable");
    },
  });
  assert.equal(
    validateResolverRequest({
      resolver: "subject",
      arguments: { value: { tag: "boolean", value: "not-boolean" } },
    }).ok,
    false,
  );
  await assert.rejects(() =>
    host.resolve({
      resolver: "subject",
      arguments: { value: { tag: "boolean", value: "not-boolean" } as never },
    }),
  );
  assert.equal(invoked, false);
});

test("evaluator rejects entity identity headers that disagree with the declared id field", async () => {
  const manifest = provider();
  const runtime = new FunctionResolverHost({
    subject: () =>
      wire.entity("audit:Subject", "audit:subject", "header", {
        id: wire.id("audit:subject", "field"),
        level: wire.integer(3),
      }),
  });
  const compiled = compilePolicy(
    'using "audit@9" as Audit\npolicy "p" { rule "r" { require Audit.subject("x").level == 3 } }',
    {
      trustedBuiltins: [{ manifest, source: { kind: "builtin", locator: "builtin:audit" } }],
    },
  );
  const result = await evaluatePolicy(compiled, {
    repository: new RepositorySnapshot(),
    resolvers: { Audit: runtime },
  });
  assert.equal(result.diagnostics.at(-1)?.code, "PROVIDER_ENTITY_IDENTITY");
});

test("external native runtimes fail closed without a hardened sandbox", () => {
  assert.throws(
    () =>
      new TypeScriptProcessResolverHost({
        cwd: "/",
        entrypoint: "./bin/true",
        plugin: { name: "audit", version: "1.2.3" },
      }),
    (error: unknown) => error instanceof ResolverFault && error.code === "RUNTIME_SANDBOX_REQUIRED",
  );
  assert.throws(
    () =>
      new WasiProcessResolverHost({
        cwd: "/",
        entrypoint: "./runtime.wasm",
        command: "/bin/true",
        commandArguments: ["--dir=/"],
        plugin: { name: "audit", version: "1.2.3" },
      }),
    (error: unknown) => error instanceof ResolverFault && error.code === "RUNTIME_WASI_CAPABILITY",
  );
});

const runtimeSource = resolve("examples/runtime/typescript/runtime.ts");

function runtimeHost(
  broker: CapabilityBroker,
  options: {
    readonly transport?: "jsonl" | "length-prefixed";
    readonly maxCapabilityCalls?: number;
    readonly maxCalls?: number;
    readonly maxOutputBytes?: number;
    readonly maxLogBytes?: number;
    readonly maxContinuationBytes?: number;
    readonly maxSessionExchanges?: number;
  } = {},
): TypeScriptProcessResolverHost {
  return new TypeScriptProcessResolverHost({
    cwd: "/",
    // @ts-ignore This bare repository intentionally does not depend on @types/node.
    entrypoint: process.execPath,
    plugin: { name: "example", version: "1.0.0" },
    transport: options.transport,
    arguments:
      options.transport === "length-prefixed"
        ? [runtimeSource, "--length-prefixed"]
        : [runtimeSource],
    trustedRuntime: true,
    capabilities: [
      {
        name: "example:data",
        operations: ["read"],
        scope: wire.string("public"),
        ...(options.maxCalls === undefined ? {} : { maxCalls: options.maxCalls }),
      },
    ],
    capabilityBroker: broker,
    maxCapabilityCalls: options.maxCapabilityCalls,
    maxOutputBytes: options.maxOutputBytes,
    maxLogBytes: options.maxLogBytes,
    maxContinuationBytes: options.maxContinuationBytes,
    maxSessionExchanges: options.maxSessionExchanges,
  });
}

test("process runtime initializes once, resolves lazily, brokers multiple calls, and disposes", async () => {
  const requests: string[] = [];
  const broker: CapabilityBroker = async (request) => {
    requests.push(`${request.callId}:${request.sequence}:${request.operation}`);
    assert.deepEqual(request.grant.scope, wire.string("public"));
    return { ok: true, value: wire.string(`value-${request.sequence}`) };
  };
  const host = runtimeHost(broker);
  assert.deepEqual(await host.resolve({ resolver: "success", arguments: {} }), wire.string("ok"));
  assert.deepEqual(await host.resolve({ resolver: "missing", arguments: {} }), wire.missing());
  assert.deepEqual(
    await host.resolve({ resolver: "multiple", arguments: {} }),
    wire.list([wire.string("value-1"), wire.string("value-2")]),
  );
  const lifecycle = await host.resolve({ resolver: "lifecycle", arguments: {} });
  assert.equal(lifecycle.tag, "map");
  if (lifecycle.tag === "map") {
    assert.deepEqual(lifecycle.entries.initialized, wire.integer(1));
    assert.deepEqual(lifecycle.entries.calls, wire.integer(4));
  }
  assert.deepEqual(requests, ["call-4:1:read", "call-4:2:read"]);
  await host.dispose();
  await assert.rejects(() => host.resolve({ resolver: "success", arguments: {} }), {
    code: "RUNTIME_DISPOSED",
  });
});

test("runtime capability denials, timeout, invalid results, declarations, and quotas fail closed", async () => {
  const denied = runtimeHost(async () => ({
    ok: false,
    error: {
      code: "DATA_DENIED",
      kind: "permission",
      message: "scope denied",
      retryable: false,
    },
  }));
  await assert.rejects(
    () => denied.resolve({ resolver: "permission-denied", arguments: {} }),
    (error: unknown) =>
      error instanceof ResolverFault && error.code === "DATA_DENIED" && error.kind === "permission",
  );
  await denied.dispose();

  const invalid = runtimeHost(async () => ({ ok: true, value: { tag: "not-wire" } as never }));
  await assert.rejects(() => invalid.resolve({ resolver: "invalid-result", arguments: {} }), {
    code: "CAPABILITY_INVALID_RESULT",
  });
  await invalid.dispose();

  const timeout = runtimeHost(async () => ({ ok: true, value: wire.string("late") }));
  await assert.rejects(() => timeout.resolve({ resolver: "capability-timeout", arguments: {} }), {
    code: "CAPABILITY_TIMEOUT",
  });
  await timeout.dispose();

  const undeclared = runtimeHost(async () => ({ ok: true, value: wire.string("secret") }));
  await assert.rejects(() => undeclared.resolve({ resolver: "undeclared", arguments: {} }), {
    code: "CAPABILITY_UNDECLARED",
  });
  await undeclared.dispose();

  const operation = runtimeHost(async () => ({ ok: true, value: wire.string("deleted") }));
  await assert.rejects(() => operation.resolve({ resolver: "invalid-operation", arguments: {} }), {
    code: "CAPABILITY_OPERATION_UNDECLARED",
  });
  await operation.dispose();

  const quota = runtimeHost(async () => ({ ok: true, value: wire.string("value") }), {
    maxCapabilityCalls: 1,
  });
  await assert.rejects(() => quota.resolve({ resolver: "multiple", arguments: {} }), {
    code: "CAPABILITY_QUOTA",
  });
  await quota.dispose();
});

test("JSONL and length-prefixed runtime transports have equivalent protocol values", async () => {
  const broker: CapabilityBroker = async (request) => ({
    ok: true,
    value: wire.string(`wire-${request.sequence}`),
  });
  const jsonl = runtimeHost(broker);
  const lengthPrefixed = runtimeHost(broker, { transport: "length-prefixed" });
  const request = { resolver: "multiple", arguments: {} };
  assert.deepEqual(await jsonl.resolve(request), await lengthPrefixed.resolve(request));
  await Promise.all([jsonl.dispose(), lengthPrefixed.dispose()]);

  const messages: HostMessage[] = [
    {
      protocol: RUNTIME_PROTOCOL,
      type: "shutdown",
      id: "shutdown-1",
      continuation: "opaque-token",
    },
  ];
  const runtimeMessages: RuntimeMessage[] = [
    {
      protocol: RUNTIME_PROTOCOL,
      type: "result",
      id: "call-1",
      value: wire.string("equivalent"),
      continuation: "opaque-token-2",
    },
  ];
  for (const transport of ["jsonl", "length-prefixed"] as const) {
    assert.ok(encodeProtocolMessages(messages, transport).length > 0);
    assert.deepEqual(
      decodeProtocolMessages(encodeProtocolMessages(runtimeMessages, transport), transport),
      runtimeMessages,
    );
  }
});

test("runtime process deadlines, cancellation, output, and log quotas terminate exchanges", async () => {
  const broker: CapabilityBroker = async () => ({ ok: true, value: wire.string("unused") });
  const timeout = runtimeHost(broker);
  await assert.rejects(
    () => timeout.resolve({ resolver: "runtime-timeout", arguments: {} }, { timeoutMs: 50 }),
    { code: "RUNTIME_TIMEOUT" },
  );

  const cancelled = runtimeHost(broker);
  const controller = new AbortController();
  const pending = cancelled.resolve(
    { resolver: "runtime-timeout", arguments: {} },
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(() => pending, { code: "RUNTIME_CANCELLED" });

  const output = runtimeHost(broker, { maxOutputBytes: 512 });
  await assert.rejects(() => output.resolve({ resolver: "large-output", arguments: {} }), {
    code: "RUNTIME_OUTPUT_LIMIT",
  });

  const logs = runtimeHost(broker, { maxLogBytes: 512 });
  await assert.rejects(() => logs.resolve({ resolver: "large-log", arguments: {} }), {
    code: "RUNTIME_LOG_LIMIT",
  });

  const continuation = runtimeHost(broker, { maxContinuationBytes: 8 });
  await assert.rejects(() => continuation.resolve({ resolver: "success", arguments: {} }), {
    code: "PROTOCOL_CONTINUATION_LIMIT",
  });

  const exchanges = runtimeHost(broker, { maxSessionExchanges: 2 });
  await assert.rejects(() => exchanges.resolve({ resolver: "success", arguments: {} }), {
    code: "RUNTIME_EXCHANGE_QUOTA",
  });
  await exchanges.dispose();

  const framed: RuntimeMessage[] = [
    {
      protocol: RUNTIME_PROTOCOL,
      type: "result",
      id: "call-limit",
      value: wire.string("frame limit"),
      continuation: "frame-token",
    },
  ];
  const encoded = encodeProtocolMessages(framed, "length-prefixed");
  assert.throws(
    () =>
      decodeProtocolMessages(encoded, "length-prefixed", {
        maxFrameBytes: 8,
        maxMessageBytes: 8,
      }),
    { code: "PROTOCOL_FRAME_LIMIT" },
  );
  assert.throws(
    () =>
      decodeProtocolMessages(encoded, "length-prefixed", {
        maxFrameBytes: 1024,
        maxMessageBytes: 8,
      }),
    { code: "PROTOCOL_MESSAGE_LIMIT" },
  );
});

test("WASI and native hosts use the same command protocol transcript", async () => {
  const broker: CapabilityBroker = async (request) => ({
    ok: true,
    value: wire.string(`lane-${request.sequence}`),
  });
  const native = runtimeHost(broker);
  const directory = mkdtempSync(resolve(tmpdir(), "polici-wasi-validation-"));
  const wasmArtifact = resolve(directory, "runtime.wasm");
  writeFileSync(wasmArtifact, wasmModule("fd_read"));
  const wasi = new WasiProcessResolverHost({
    cwd: "/",
    // @ts-ignore This bare repository intentionally does not depend on @types/node.
    command: process.execPath,
    entrypoint: wasmArtifact,
    arguments: [runtimeSource],
    omitEntrypointArgument: true,
    plugin: { name: "example", version: "1.0.0" },
    capabilities: [{ name: "example:data", operations: ["read"] }],
    capabilityBroker: broker,
  });
  try {
    const request = { resolver: "multiple", arguments: {} };
    assert.deepEqual(await native.resolve(request), await wasi.resolve(request));
    await Promise.all([native.dispose(), wasi.dispose()]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("JSON evidence positions are zero-based and exact snapshot constructors are immutable", () => {
  const document = parseStrictJson('{\n  "value": true\n}');
  assert.deepEqual(document.valueSpan("/value")?.start, { offset: 13, line: 1, column: 11 });
  const entries = [{ path: "a.txt", content: "one" }];
  const snapshot = RepositorySnapshot.fromEntries(entries);
  entries[0]!.content = "two";
  assert.equal(snapshot.get("a.txt")?.text(), "one");
  assert.equal(snapshot.equals(RepositorySnapshot.fromFiles([new File("a.txt", "one")])), true);
});

test("WASI validation rejects nondeterministic and undeclared imports before execution", () => {
  assert.doesNotThrow(() => validateWasiCommand(wasmModule("fd_read")));
  assert.throws(() => validateWasiCommand(wasmModule("clock_time_get")), /not permitted/);
  assert.throws(() => validateWasiCommand(wasmModule("random_get")), /not permitted/);
  assert.throws(() => validateWasiCommand(wasmModule("sock_accept")), /not permitted/);
});

function wasmModule(importName: string): Uint8Array {
  const module = new TextEncoder().encode("wasi_snapshot_preview1");
  const name = new TextEncoder().encode(importName);
  const imports = Uint8Array.from([1, module.length, ...module, name.length, ...name, 0, 0]);
  const exportName = new TextEncoder().encode("_start");
  const exports = Uint8Array.from([1, exportName.length, ...exportName, 0, 1]);
  return Uint8Array.from([
    0,
    0x61,
    0x73,
    0x6d,
    1,
    0,
    0,
    0,
    1,
    4,
    1,
    0x60,
    0,
    0,
    2,
    imports.length,
    ...imports,
    3,
    2,
    1,
    0,
    7,
    exports.length,
    ...exports,
  ]);
}
