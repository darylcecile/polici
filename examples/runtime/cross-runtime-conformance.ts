// @ts-ignore This bare repository intentionally does not depend on @types/node.
import { spawnSync } from "node:child_process";

const native = process.argv[2];
const wasmtime = process.argv[3];
const wasm = process.argv[4];
if (native === undefined || wasmtime === undefined || wasm === undefined)
  throw new Error("Expected native-runtime, wasmtime, and wasm-runtime paths");

type Message = Record<string, unknown>;
const protocol = "polici.runtime/v1";
const initialize: Message = {
  protocol,
  type: "initialize",
  id: "initialize-1",
  host: { name: "polici", version: "1" },
  plugin: { name: "example", version: "1.0.0" },
  capabilities: [{ name: "example:data", operations: ["read"] }],
  limits: {
    maxFrameBytes: 1_048_576,
    maxMessageBytes: 1_048_576,
    maxOutputBytes: 4_194_304,
    maxLogBytes: 262_144,
    maxContinuationBytes: 16_384,
    maxCapabilityCalls: 64,
  },
};

function transcript(command: string, arguments_: string[]): Message[] {
  const messages: Message[] = [];
  let response = exchange(command, arguments_, initialize);
  messages.push(response);
  response = exchange(command, arguments_, {
    protocol,
    type: "call",
    id: "call-2",
    resolver: "multiple",
    arguments: {},
    continuation: response.continuation,
    deadlineUnixMs: Date.now() + 30_000,
  });
  messages.push(response);
  response = resume(command, arguments_, response, "one");
  messages.push(response);
  response = resume(command, arguments_, response, "two");
  messages.push(response);
  response = exchange(command, arguments_, {
    protocol,
    type: "shutdown",
    id: "shutdown-3",
    continuation: response.continuation,
  });
  messages.push(response);
  return messages;
}

function resume(command: string, arguments_: string[], call: Message, value: string): Message {
  return exchange(command, arguments_, {
    protocol,
    type: "capability-result",
    id: call.id,
    requestId: call.requestId,
    sequence: call.sequence,
    continuation: call.continuation,
    result: { tag: "string", value },
  });
}

function exchange(command: string, arguments_: string[], message: Message): Message {
  const result = spawnSync(command, arguments_, {
    env: {},
    input: `${JSON.stringify(message)}\n`,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(result.stderr || `Runtime exited ${result.status}`);
  return JSON.parse(result.stdout) as Message;
}

const nativeTranscript = transcript(native, []);
const wasiTranscript = transcript(wasmtime, [wasm]);
if (JSON.stringify(normalize(nativeTranscript)) !== JSON.stringify(normalize(wasiTranscript)))
  throw new Error("Native and WASI protocol transcripts differ");
console.log("native/WASI equivalent protocol transcripts passed");

function normalize(messages: Message[]): Message[] {
  return messages.map(({ continuation: _continuation, ...message }) => message);
}
