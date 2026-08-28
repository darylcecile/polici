import { TypeScriptProcessResolverHost } from "../../src/plugin/process.ts";
import type { RuntimeCapability } from "../../src/plugin/protocol.ts";
import type { CapabilityBroker, CapabilityRequest } from "../../src/plugin/resolver.ts";

const executable = process.argv[2];
if (executable === undefined) throw new Error("Expected the native runtime executable path");

const calls: string[] = [];
const grant: RuntimeCapability = {
  name: "example:data",
  operations: ["read"],
  scope: { tag: "string", value: "public" },
  maxCalls: 4,
};
const broker: CapabilityBroker = async (request: CapabilityRequest) => {
  calls.push(`${request.callId}:${request.sequence}:${request.operation}`);
  return { ok: true, value: { tag: "string", value: `native-${request.sequence}` } };
};

const host = new TypeScriptProcessResolverHost({
  cwd: "/",
  entrypoint: executable,
  plugin: { name: "example", version: "1.0.0" },
  capabilities: [grant],
  capabilityBroker: broker,
  trustedRuntime: true,
});

const first = await host.resolve({ resolver: "success", arguments: {} });
const second = await host.resolve({ resolver: "multiple", arguments: {} });
const lifecycle = await host.resolve({ resolver: "lifecycle", arguments: {} });
await host.dispose();

if (first.tag !== "string" || first.value !== "ok") throw new Error("success mismatch");
if (second.tag !== "list" || second.items.length !== 2) throw new Error("multiple mismatch");
if (lifecycle.tag !== "map") throw new Error("lifecycle mismatch");
const initialized = lifecycle.entries.initialized;
const resolverCalls = lifecycle.entries.calls;
if (initialized?.tag !== "integer" || initialized.value !== "1")
  throw new Error("runtime initialized more than once");
if (resolverCalls?.tag !== "integer" || resolverCalls.value !== "3")
  throw new Error("resolver lifecycle count mismatch");
if (calls.length !== 2 || calls[0] !== "call-3:1:read" || calls[1] !== "call-3:2:read")
  throw new Error("capability transcript mismatch");

console.log("native runtime conformance passed");
