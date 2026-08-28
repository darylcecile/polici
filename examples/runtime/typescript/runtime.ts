// @ts-ignore This bare repository intentionally does not depend on @types/node.
import { readFileSync } from "node:fs";

const PROTOCOL = "polici.runtime/v1";

type Message = Record<string, unknown>;

interface State {
  generation: number;
  calls: number;
  pending: string;
  first: string;
}

const transport = process.argv.includes("--length-prefixed") ? "length-prefixed" : "jsonl";

function main(): void {
  const message = readMessage(readFileSync(0));
  if (message.protocol !== PROTOCOL) throw new Error("Unsupported protocol");
  switch (string(message.type, "type")) {
    case "initialize":
      initialize(message);
      return;
    case "call":
      call(message);
      return;
    case "capability-result":
      capabilityResult(message);
      return;
    case "shutdown":
      shutdown(message);
      return;
    default:
      throw new Error(`Unsupported message ${String(message.type)}`);
  }
}

function initialize(message: Message): void {
  const plugin = record(message.plugin, "plugin");
  const capabilities = array(message.capabilities, "capabilities");
  const activated: string[] = [];
  for (const item of capabilities) {
    const capability = record(item, "capability");
    if (capability.name === "example:data") activated.push("example:data");
  }
  writeMessage({
    protocol: PROTOCOL,
    type: "initialized",
    id: string(message.id, "id"),
    implementation: { name: plugin.name, version: plugin.version },
    capabilities: activated,
    continuation: encodeState({ generation: 1, calls: 0, pending: "", first: "" }),
  });
}

function call(message: Message): void {
  const state = decodeState(string(message.continuation, "continuation"));
  state.generation += 1;
  state.calls += 1;
  const resolver = string(message.resolver, "resolver");
  if (resolver === "success") {
    result(string(message.id, "id"), { tag: "string", value: "ok" }, state);
    return;
  }
  if (resolver === "missing") {
    result(string(message.id, "id"), { tag: "missing" }, state);
    return;
  }
  if (resolver === "lifecycle") {
    result(
      string(message.id, "id"),
      {
        tag: "map",
        entries: {
          initialized: { tag: "integer", value: "1" },
          calls: { tag: "integer", value: String(state.calls) },
        },
      },
      state,
    );
    return;
  }
  if (
    resolver === "capability" ||
    resolver === "multiple" ||
    resolver === "permission-denied" ||
    resolver === "invalid-result"
  ) {
    state.pending = resolver === "multiple" ? "multiple-first" : "single";
    capabilityCall(string(message.id, "id"), 1, "read", message.arguments, state);
    return;
  }
  if (resolver === "capability-timeout") {
    state.pending = "single";
    writeMessage({
      protocol: PROTOCOL,
      type: "capability-call",
      id: string(message.id, "id"),
      requestId: `${string(message.id, "id")}-capability-1`,
      sequence: 1,
      capability: "example:data",
      operation: "read",
      arguments: message.arguments,
      continuation: nextToken(state),
      deadlineUnixMs: 1,
    });
    return;
  }
  if (resolver === "runtime-timeout") {
    let spin = 0;
    while (spin < 1_000_000_000) spin += 1;
    result(string(message.id, "id"), { tag: "string", value: "late" }, state);
    return;
  }
  if (resolver === "large-output") {
    result(string(message.id, "id"), { tag: "string", value: "x".repeat(4096) }, state);
    return;
  }
  if (resolver === "large-log") {
    console.error("x".repeat(4096));
    result(string(message.id, "id"), { tag: "string", value: "logged" }, state);
    return;
  }
  if (resolver === "undeclared") {
    state.pending = "undeclared";
    writeMessage({
      protocol: PROTOCOL,
      type: "capability-call",
      id: string(message.id, "id"),
      requestId: `${string(message.id, "id")}-capability-1`,
      sequence: 1,
      capability: "example:undeclared",
      operation: "read",
      arguments: {},
      continuation: nextToken(state),
    });
    return;
  }
  if (resolver === "invalid-operation") {
    state.pending = "invalid-operation";
    capabilityCall(string(message.id, "id"), 1, "delete", {}, state);
    return;
  }
  runtimeError(
    string(message.id, "id"),
    "RESOLVER_NOT_FOUND",
    "resolver",
    `Unknown resolver ${resolver}`,
    state,
  );
}

function capabilityResult(message: Message): void {
  const state = decodeState(string(message.continuation, "continuation"));
  state.generation += 1;
  const sequence = number(message.sequence, "sequence");
  if (message.error !== undefined) {
    const error = record(message.error, "error");
    runtimeError(
      string(message.id, "id"),
      string(error.code, "error.code"),
      string(error.kind, "error.kind"),
      string(error.message, "error.message"),
      state,
      error.details,
    );
    return;
  }
  const value = record(message.result, "result");
  if (state.pending === "single") {
    state.pending = "";
    result(string(message.id, "id"), value, state);
    return;
  }
  if (state.pending === "multiple-first" && sequence === 1) {
    state.pending = "multiple-second";
    state.first = JSON.stringify(value);
    capabilityCall(
      string(message.id, "id"),
      2,
      "read",
      { page: { tag: "integer", value: "2" } },
      state,
    );
    return;
  }
  if (state.pending === "multiple-second" && sequence === 2) {
    state.pending = "";
    result(
      string(message.id, "id"),
      { tag: "list", items: [JSON.parse(state.first), value] },
      state,
    );
    return;
  }
  runtimeError(
    string(message.id, "id"),
    "INVALID_CONTINUATION",
    "invalid-request",
    "Unexpected capability result",
    state,
  );
}

function shutdown(message: Message): void {
  decodeState(string(message.continuation, "continuation"));
  writeMessage({ protocol: PROTOCOL, type: "stopped", id: string(message.id, "id") });
}

function capabilityCall(
  callId: string,
  sequence: number,
  operation: string,
  arguments_: unknown,
  state: State,
): void {
  writeMessage({
    protocol: PROTOCOL,
    type: "capability-call",
    id: callId,
    requestId: `${callId}-capability-${sequence}`,
    sequence,
    capability: "example:data",
    operation,
    arguments: arguments_,
    continuation: nextToken(state),
  });
}

function result(id: string, value: unknown, state: State): void {
  writeMessage({
    protocol: PROTOCOL,
    type: "result",
    id,
    value,
    continuation: nextToken(state),
  });
}

function runtimeError(
  id: string,
  code: string,
  kind: string,
  message: string,
  state: State,
  details?: unknown,
): void {
  if (details !== undefined) {
    writeMessage({
      protocol: PROTOCOL,
      type: "error",
      id,
      error: { code, kind, message, retryable: false, details },
      continuation: nextToken(state),
    });
    return;
  }
  writeMessage({
    protocol: PROTOCOL,
    type: "error",
    id,
    error: { code, kind, message, retryable: false },
    continuation: nextToken(state),
  });
}

function nextToken(state: State): string {
  return encodeState(state);
}

function encodeState(state: State): string {
  return Buffer.from(
    JSON.stringify({
      generation: state.generation,
      calls: state.calls,
      pending: state.pending,
      first: state.first,
    }),
    "utf8",
  ).toString("base64url");
}

function decodeState(token: string): State {
  const value = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as unknown;
  const state = record(value, "continuation state");
  return {
    generation: number(state.generation, "state.generation"),
    calls: number(state.calls, "state.calls"),
    pending: string(state.pending, "state.pending"),
    first: string(state.first, "state.first"),
  };
}

function readMessage(input: Uint8Array): Message {
  if (transport === "jsonl") {
    const text = new TextDecoder().decode(input);
    if (!text.endsWith("\n") || text.slice(0, -1).includes("\n"))
      throw new Error("Expected exactly one JSONL message");
    return record(JSON.parse(text), "message");
  }
  if (input.length < 4) throw new Error("Truncated frame header");
  const length = new DataView(input.buffer, input.byteOffset, input.byteLength).getUint32(0, false);
  if (length === 0 || input.length !== length + 4) throw new Error("Invalid frame length");
  return record(JSON.parse(new TextDecoder().decode(input.subarray(4))), "message");
}

function writeMessage(message: unknown): void {
  const encoded = new TextEncoder().encode(JSON.stringify(message));
  if (transport === "jsonl") {
    process.stdout.write(encoded);
    process.stdout.write("\n");
    return;
  }
  const output = new Uint8Array(encoded.length + 4);
  new DataView(output.buffer).setUint32(0, encoded.length, false);
  output.set(encoded, 4);
  process.stdout.write(output);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function number(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(`${name} must be an integer`);
  return value;
}

main();
