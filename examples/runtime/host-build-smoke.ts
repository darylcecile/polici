import {
  TypeScriptProcessResolverHost,
  WasiProcessResolverHost,
} from "../../src/plugin/process.ts";
import { RUNTIME_PROTOCOL, type RuntimeCapability } from "../../src/plugin/protocol.ts";
import type { CapabilityBroker, CapabilityRequest } from "../../src/plugin/resolver.ts";

const grant: RuntimeCapability = {
  name: "example:data",
  operations: ["read"],
  scope: { tag: "string", value: "public" },
};
const broker: CapabilityBroker = async (request: CapabilityRequest) => ({
  ok: true,
  value: { tag: "string", value: `${request.operation}:${request.grant.name}` },
});

const native = new TypeScriptProcessResolverHost({
  cwd: "/",
  entrypoint: "/usr/bin/true",
  plugin: { name: "example", version: "1.0.0" },
  capabilities: [grant],
  capabilityBroker: broker,
  trustedRuntime: true,
});
const wasi = new WasiProcessResolverHost({
  cwd: "/",
  command: "/usr/bin/true",
  entrypoint: "/runtime.wasm",
  plugin: { name: "example", version: "1.0.0" },
  capabilities: [grant],
  capabilityBroker: broker,
});

console.log(RUNTIME_PROTOCOL, native.capabilities.length, wasi.capabilities.length);
