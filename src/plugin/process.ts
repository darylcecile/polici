// @ts-ignore This bare repository intentionally does not depend on @types/node.
import { spawn } from "node:child_process";
// @ts-ignore This bare repository intentionally does not depend on @types/node.
import {
  accessSync,
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
// @ts-ignore This bare repository intentionally does not depend on @types/node.
import { tmpdir } from "node:os";
// @ts-ignore This bare repository intentionally does not depend on @types/node.
import { delimiter, isAbsolute, resolve } from "node:path";

import { canonicalStringify, type JsonValue } from "./json.js";
import type { PluginTransport } from "./manifest.js";
import {
  RUNTIME_PROTOCOL,
  parseRuntimeMessage,
  validateHostMessage,
  type CapabilityCallResponse,
  type CapabilityResultRequest,
  type HostMessage,
  type RuntimeCapability,
  type RuntimeError,
  type RuntimeLimits,
  type RuntimeMessage,
} from "./protocol.js";
import {
  ResolverFault,
  assertValidResolverRequest,
  type CapabilityBroker,
  type CapabilityResult,
  type ResolverCallOptions,
  type ResolverHost,
  type ResolverRequest,
} from "./resolver.js";
import { validateWireValue, type WireValue } from "./wire.js";
import { validateWasiCommandFile } from "./wasm.js";

export interface ProcessRuntimeOptions {
  readonly entrypoint: string;
  readonly cwd: string;
  /** Total wall-clock deadline for one resolver call, including broker work and resumptions. */
  readonly timeoutMs?: number;
  readonly transport?: PluginTransport;
  readonly maxFrameBytes?: number;
  readonly maxMessageBytes?: number;
  /** Cumulative stdout bytes across every exchange in one logical operation. */
  readonly maxOutputBytes?: number;
  /** Cumulative stderr bytes across every exchange in one logical operation. */
  readonly maxLogBytes?: number;
  readonly maxContinuationBytes?: number;
  readonly maxCapabilityCalls?: number;
  /** Bounds logical session state; one exchange is reserved for shutdown. */
  readonly maxSessionExchanges?: number;
  /** Declared, host-granted capability operations and their non-secret scopes. */
  readonly capabilities?: readonly RuntimeCapability[];
  readonly capabilityBroker?: CapabilityBroker;
  readonly host?: { readonly name: string; readonly version: string };
  readonly plugin: { readonly name: string; readonly version: string };
}

export interface HardenedRuntimeSandbox {
  /** Sandbox launcher executable. It is resolved before the child environment is stripped. */
  readonly launcher: string;
  /** Arguments passed before the provider executable and its arguments. */
  readonly arguments?: readonly string[];
  readonly denyNetwork: true;
  readonly denyFilesystem: true;
  readonly denyEnvironment: true;
  readonly denyChildProcess: true;
}

export interface TypeScriptRuntimeOptions extends ProcessRuntimeOptions {
  /** Required for host-implemented, fully trusted runtimes; all others need a hardened launcher. */
  readonly trustedRuntime?: boolean;
  readonly sandbox?: HardenedRuntimeSandbox;
  readonly arguments?: readonly string[];
}

export interface WasiRuntimeOptions extends ProcessRuntimeOptions {
  readonly command?: string;
  /** Runner-only arguments before the module path. Capability-granting arguments are rejected. */
  readonly commandArguments?: readonly string[];
  /** Arguments visible to the WASI command after the module path. */
  readonly arguments?: readonly string[];
  /** Test/embedder override for a validated module executed by another command adapter. */
  readonly omitEntrypointArgument?: boolean;
}

export interface ProtocolDecodeLimits {
  readonly maxFrameBytes?: number;
  readonly maxMessageBytes?: number;
  readonly maxMessages?: number;
}

interface ProcessInvocation {
  readonly command: string;
  readonly arguments: readonly string[];
}

interface NormalizedProcessOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env: Readonly<Record<string, string>>;
  readonly transport: PluginTransport;
  readonly limits: RuntimeLimits;
  readonly maxSessionExchanges: number;
  readonly capabilities: readonly RuntimeCapability[];
  readonly capabilityBroker?: CapabilityBroker;
  readonly host: { readonly name: string; readonly version: string };
  readonly plugin: { readonly name: string; readonly version: string };
}

interface OperationBudget {
  outputBytes: number;
  logBytes: number;
}

const DEFAULT_LIMITS: RuntimeLimits = {
  maxFrameBytes: 1024 * 1024,
  maxMessageBytes: 1024 * 1024,
  maxOutputBytes: 4 * 1024 * 1024,
  maxLogBytes: 256 * 1024,
  maxContinuationBytes: 16 * 1024,
  maxCapabilityCalls: 64,
};

const DEFAULT_MAX_SESSION_EXCHANGES = 4_096;

export class TypeScriptProcessResolverHost implements ResolverHost {
  readonly capabilities: readonly RuntimeCapability[];
  readonly #adapter: ResumableProcessResolverHost;

  constructor(options: TypeScriptRuntimeOptions) {
    assertRuntimeSandbox(options);
    const executable = resolve(options.cwd, options.entrypoint);
    const invocation = sandboxedInvocation(
      { command: resolveExecutable(executable, options.cwd), arguments: options.arguments ?? [] },
      options,
    );
    this.#adapter = new ResumableProcessResolverHost(invocation, options);
    this.capabilities = this.#adapter.capabilities;
  }

  resolve(request: ResolverRequest, options?: ResolverCallOptions): Promise<WireValue> {
    return this.#adapter.resolve(request, options);
  }

  dispose(): Promise<void> {
    return this.#adapter.dispose();
  }
}

export class WasiProcessResolverHost implements ResolverHost {
  readonly capabilities: readonly RuntimeCapability[];
  readonly #adapter: ResumableProcessResolverHost;

  constructor(options: WasiRuntimeOptions) {
    const commandArguments = validateWasiArguments(options.commandArguments ?? []);
    validateWasiCommandFile(resolve(options.cwd, options.entrypoint));
    this.#adapter = new ResumableProcessResolverHost(
      {
        command: resolveExecutable(options.command ?? "wasmtime", options.cwd),
        arguments: [
          ...commandArguments,
          ...defaultWasiRunnerArguments(options.command),
          ...(options.omitEntrypointArgument === true
            ? []
            : [resolve(options.cwd, options.entrypoint)]),
          ...(options.arguments ?? []),
        ],
      },
      options,
    );
    this.capabilities = this.#adapter.capabilities;
  }

  resolve(request: ResolverRequest, options?: ResolverCallOptions): Promise<WireValue> {
    return this.#adapter.resolve(request, options);
  }

  dispose(): Promise<void> {
    return this.#adapter.dispose();
  }
}

export class WasmWasiProcessResolverHost extends WasiProcessResolverHost {}

function defaultWasiRunnerArguments(command: string | undefined): readonly string[] {
  const name = (command ?? "wasmtime").split(/[\\/]/).at(-1)?.toLowerCase();
  return name === "wasmtime"
    ? [
        "-W",
        "fuel=100000000",
        "-W",
        "max-memory-size=67108864",
        "-W",
        "max-wasm-stack=1048576",
        "-W",
        "max-table-elements=100000",
        "-W",
        "max-instances=1",
        "-W",
        "max-tables=1",
        "-W",
        "max-memories=1",
        "-W",
        "nan-canonicalization=y",
        "-W",
        "relaxed-simd-deterministic=y",
      ]
    : [];
}

export function encodeProtocolMessages(
  messages: readonly (HostMessage | RuntimeMessage)[],
  transport: PluginTransport,
): Uint8Array {
  const encoder = new TextEncoder();
  const encoded = messages.map((message) =>
    encoder.encode(canonicalStringify(message as unknown as JsonValue)),
  );
  if (transport === "jsonl") {
    const size = encoded.reduce((total, message) => total + message.length + 1, 0);
    const output = new Uint8Array(size);
    let offset = 0;
    for (const message of encoded) {
      output.set(message, offset);
      offset += message.length;
      output[offset] = 0x0a;
      offset += 1;
    }
    return output;
  }
  const size = encoded.reduce((total, message) => total + 4 + message.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const message of encoded) {
    new DataView(output.buffer).setUint32(offset, message.length, false);
    offset += 4;
    output.set(message, offset);
    offset += message.length;
  }
  return output;
}

export function decodeProtocolMessages(
  input: Uint8Array,
  transport: PluginTransport,
  limits: ProtocolDecodeLimits = {},
): RuntimeMessage[] {
  const maxFrameBytes = positiveLimit(
    limits.maxFrameBytes,
    DEFAULT_LIMITS.maxFrameBytes,
    "maxFrameBytes",
  );
  const maxMessageBytes = positiveLimit(
    limits.maxMessageBytes,
    DEFAULT_LIMITS.maxMessageBytes,
    "maxMessageBytes",
  );
  const maxMessages = positiveLimit(limits.maxMessages, 1_000, "maxMessages");
  const messages: RuntimeMessage[] = [];
  const append = (frame: Uint8Array): void => {
    if (frame.length === 0)
      throw new ResolverFault("PROTOCOL_FRAME", "protocol", "Empty protocol frame");
    if (frame.length > maxFrameBytes)
      throw new ResolverFault("PROTOCOL_FRAME_LIMIT", "protocol", "Protocol frame limit exceeded");
    if (frame.length > maxMessageBytes)
      throw new ResolverFault(
        "PROTOCOL_MESSAGE_LIMIT",
        "protocol",
        "Protocol message limit exceeded",
      );
    if (messages.length >= maxMessages)
      throw new ResolverFault(
        "PROTOCOL_MESSAGE_LIMIT",
        "protocol",
        "Protocol message count exceeded",
      );
    messages.push(parseRuntimeMessage(decodeUtf8(frame)));
  };

  if (transport === "jsonl") {
    let start = 0;
    for (let index = 0; index < input.length; index += 1) {
      if (input[index] !== 0x0a) continue;
      const frame = trimAsciiWhitespace(input.subarray(start, index));
      if (frame.length > 0) append(frame);
      start = index + 1;
    }
    if (trimAsciiWhitespace(input.subarray(start)).length > 0)
      throw new ResolverFault(
        "PROTOCOL_FRAME",
        "protocol",
        "JSONL protocol message is missing its newline delimiter",
      );
    return messages;
  }

  let offset = 0;
  while (offset < input.length) {
    if (input.length - offset < 4)
      throw new ResolverFault("PROTOCOL_FRAME", "protocol", "Truncated frame header");
    const length = new DataView(input.buffer, input.byteOffset, input.byteLength).getUint32(
      offset,
      false,
    );
    offset += 4;
    if (length > maxFrameBytes)
      throw new ResolverFault("PROTOCOL_FRAME_LIMIT", "protocol", "Protocol frame limit exceeded");
    if (input.length - offset < length)
      throw new ResolverFault("PROTOCOL_FRAME", "protocol", "Truncated protocol frame");
    append(input.subarray(offset, offset + length));
    offset += length;
  }
  return messages;
}

class ResumableProcessResolverHost implements ResolverHost {
  readonly capabilities: readonly RuntimeCapability[];
  readonly #invocation: ProcessInvocation;
  readonly #options: NormalizedProcessOptions;
  readonly #grants = new Map<string, RuntimeCapability>();
  readonly #grantCalls = new Map<string, number>();
  readonly #seenContinuations = new Set<string>();
  readonly #requestIds = new Set<string>();
  #activeCapabilities = new Set<string>();
  #continuation?: string;
  #sequence = 0;
  #sessionExchanges = 0;
  #queue: Promise<void> = Promise.resolve();
  #disposePromise?: Promise<void>;
  #disposeRequested = false;
  #failed = false;

  constructor(invocation: ProcessInvocation, options: ProcessRuntimeOptions) {
    this.#invocation = invocation;
    this.#options = normalizeOptions(options);
    this.capabilities = this.#options.capabilities;
    for (const grant of this.capabilities) this.#grants.set(grant.name, grant);
  }

  resolve(request: ResolverRequest, options: ResolverCallOptions = {}): Promise<WireValue> {
    if (this.#disposeRequested)
      return Promise.reject(
        new ResolverFault("RUNTIME_DISPOSED", "process", "Runtime host is disposed"),
      );
    return this.#enqueue(() => this.#resolve(request, options));
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposeRequested = true;
    this.#disposePromise = this.#enqueue(async () => {
      if (this.#continuation === undefined || this.#failed) return;
      const id = `shutdown-${++this.#sequence}`;
      const deadline = Date.now() + this.#options.timeoutMs;
      const response = await this.#exchange(
        {
          protocol: RUNTIME_PROTOCOL,
          type: "shutdown",
          id,
          continuation: this.#continuation,
        },
        deadline,
        undefined,
        { outputBytes: 0, logBytes: 0 },
      );
      if (response.id !== id)
        throw protocolFault("PROTOCOL_MESSAGE", `Unexpected shutdown response ${response.id}`);
      if (response.type === "error") throw runtimeErrorFault(response);
      if (response.type !== "stopped")
        throw protocolFault("PROTOCOL_LIFECYCLE", `Expected stopped, received ${response.type}`);
      this.#continuation = undefined;
    });
    return this.#disposePromise;
  }

  async #resolve(request: ResolverRequest, options: ResolverCallOptions): Promise<WireValue> {
    request = assertValidResolverRequest(request);
    assertNotAborted(options.signal);
    const timeout = options.timeoutMs ?? this.#options.timeoutMs;
    if (!Number.isSafeInteger(timeout) || timeout <= 0)
      throw new TypeError("Resolver timeout must be a positive safe integer");
    if (this.#failed)
      throw new ResolverFault("RUNTIME_SESSION_FAILED", "process", "Runtime session has failed");
    const deadline = Date.now() + timeout;
    const budget: OperationBudget = { outputBytes: 0, logBytes: 0 };
    try {
      await this.#initialize(deadline, options.signal, budget);
      const callId = `call-${++this.#sequence}`;
      let response = await this.#exchange(
        {
          protocol: RUNTIME_PROTOCOL,
          type: "call",
          id: callId,
          resolver: request.resolver,
          arguments: request.arguments,
          ...(request.subject === undefined ? {} : { subject: request.subject }),
          continuation: this.#continuation!,
          deadlineUnixMs: deadline,
        },
        deadline,
        options.signal,
        budget,
      );
      let capabilitySequence = 0;
      let capabilityCalls = 0;
      while (response.type === "capability-call") {
        this.#validateCapabilityCall(response, callId, capabilitySequence + 1);
        capabilitySequence += 1;
        capabilityCalls += 1;
        if (capabilityCalls > this.#options.limits.maxCapabilityCalls)
          throw new ResolverFault(
            "CAPABILITY_QUOTA",
            "capability",
            `Capability call limit ${this.#options.limits.maxCapabilityCalls} exceeded`,
          );
        this.#acceptContinuation(response.continuation);
        const result = await this.#invokeCapability(response, callId, deadline, options.signal);
        const message: CapabilityResultRequest = {
          protocol: RUNTIME_PROTOCOL,
          type: "capability-result",
          id: callId,
          requestId: response.requestId,
          sequence: response.sequence,
          continuation: this.#continuation!,
          ...(result.ok ? { result: result.value } : { error: result.error }),
        };
        response = await this.#exchange(message, deadline, options.signal, budget);
      }
      if (response.id !== callId)
        throw protocolFault("PROTOCOL_MESSAGE", `Unexpected call response ${response.id}`);
      if (response.type === "error") {
        if (response.continuation === undefined)
          throw protocolFault("PROTOCOL_LIFECYCLE", "Call error omitted its continuation");
        this.#acceptContinuation(response.continuation);
        throw runtimeErrorFault(response);
      }
      if (response.type !== "result")
        throw protocolFault("PROTOCOL_RESULT", `Expected result, received ${response.type}`);
      this.#acceptContinuation(response.continuation);
      return response.value;
    } catch (error) {
      if (!(error instanceof ResolverFault) || error.code.startsWith("PROTOCOL_"))
        this.#failed = true;
      throw error;
    }
  }

  async #initialize(
    deadline: number,
    signal: AbortSignal | undefined,
    budget: OperationBudget,
  ): Promise<void> {
    if (this.#continuation !== undefined) return;
    const id = `initialize-${++this.#sequence}`;
    const response = await this.#exchange(
      {
        protocol: RUNTIME_PROTOCOL,
        type: "initialize",
        id,
        host: this.#options.host,
        plugin: this.#options.plugin,
        capabilities: this.capabilities,
        limits: this.#options.limits,
      },
      deadline,
      signal,
      budget,
    );
    if (response.id !== id)
      throw protocolFault("PROTOCOL_MESSAGE", `Unexpected initialization response ${response.id}`);
    if (response.type === "error") throw runtimeErrorFault(response);
    if (response.type !== "initialized")
      throw protocolFault("PROTOCOL_LIFECYCLE", `Expected initialized, received ${response.type}`);
    if (
      response.implementation.name !== this.#options.plugin.name ||
      response.implementation.version !== this.#options.plugin.version
    ) {
      throw protocolFault(
        "PROTOCOL_IMPLEMENTATION",
        `Runtime identified itself as ${response.implementation.name}@${response.implementation.version}, expected ${this.#options.plugin.name}@${this.#options.plugin.version}`,
      );
    }
    for (const capability of response.capabilities) {
      if (!this.#grants.has(capability))
        throw new ResolverFault(
          "PROTOCOL_CAPABILITY",
          "capability",
          `Runtime activated undeclared or ungranted capability ${capability}`,
        );
    }
    this.#activeCapabilities = new Set(response.capabilities);
    this.#acceptContinuation(response.continuation);
  }

  async #exchange(
    message: HostMessage,
    deadline: number,
    signal: AbortSignal | undefined,
    budget: OperationBudget,
  ): Promise<RuntimeMessage> {
    assertNotAborted(signal);
    const reserve = message.type === "shutdown" ? 0 : 1;
    if (this.#sessionExchanges >= this.#options.maxSessionExchanges - reserve)
      throw new ResolverFault(
        "RUNTIME_EXCHANGE_QUOTA",
        "process",
        `Runtime session exchange limit ${this.#options.maxSessionExchanges} exceeded`,
      );
    this.#sessionExchanges += 1;
    const validated = validateHostMessage(message);
    if (!validated.ok)
      throw new TypeError(
        `Invalid host protocol message: ${validated.issues.map((issue) => issue.message).join("; ")}`,
      );
    const input = encodeProtocolMessages([message], this.#options.transport);
    const framingBytes = this.#options.transport === "jsonl" ? 1 : 4;
    const payloadBytes = input.length - framingBytes;
    if (payloadBytes > this.#options.limits.maxFrameBytes)
      throw protocolFault("PROTOCOL_FRAME_LIMIT", "Host protocol frame limit exceeded");
    if (payloadBytes > this.#options.limits.maxMessageBytes)
      throw protocolFault("PROTOCOL_MESSAGE_LIMIT", "Host protocol message limit exceeded");
    const output = await runProcessExchange(
      this.#invocation,
      this.#options,
      input,
      deadline,
      signal,
      budget,
    );
    let responses: RuntimeMessage[];
    try {
      responses = decodeProtocolMessages(output, this.#options.transport, {
        maxFrameBytes: this.#options.limits.maxFrameBytes,
        maxMessageBytes: this.#options.limits.maxMessageBytes,
        maxMessages: 2,
      });
    } catch (error) {
      if (error instanceof ResolverFault) throw error;
      throw protocolFault("PROTOCOL_INVALID", "Runtime emitted an invalid protocol message", error);
    }
    if (responses.length !== 1)
      throw protocolFault(
        "PROTOCOL_MESSAGE",
        `Runtime exchange emitted ${responses.length} messages; expected exactly one`,
      );
    return responses[0]!;
  }

  #validateCapabilityCall(
    response: CapabilityCallResponse,
    callId: string,
    expectedSequence: number,
  ): void {
    if (response.id !== callId)
      throw protocolFault("PROTOCOL_MESSAGE", `Capability call used unexpected id ${response.id}`);
    if (response.sequence !== expectedSequence)
      throw protocolFault(
        "PROTOCOL_MESSAGE",
        `Capability sequence ${response.sequence} is out of order; expected ${expectedSequence}`,
      );
    if (this.#requestIds.has(response.requestId))
      throw protocolFault(
        "PROTOCOL_MESSAGE",
        `Capability request id ${response.requestId} was reused`,
      );
    this.#requestIds.add(response.requestId);
    const grant = this.#grants.get(response.capability);
    if (!grant || !this.#activeCapabilities.has(response.capability))
      throw new ResolverFault(
        "CAPABILITY_UNDECLARED",
        "capability",
        `Runtime called undeclared or ungranted capability ${response.capability}`,
      );
    if (!grant.operations.includes(response.operation))
      throw new ResolverFault(
        "CAPABILITY_OPERATION_UNDECLARED",
        "capability",
        `Runtime called undeclared operation ${response.capability}.${response.operation}`,
      );
  }

  async #invokeCapability(
    response: CapabilityCallResponse,
    callId: string,
    callDeadline: number,
    parentSignal: AbortSignal | undefined,
  ): Promise<CapabilityResult> {
    const grant = this.#grants.get(response.capability)!;
    const used = this.#grantCalls.get(grant.name) ?? 0;
    if (grant.maxCalls !== undefined && used >= grant.maxCalls) {
      return capabilityFailure(
        "CAPABILITY_QUOTA",
        "capability",
        `Capability grant ${grant.name} exhausted its ${grant.maxCalls} call quota`,
      );
    }
    this.#grantCalls.set(grant.name, used + 1);
    const broker = this.#options.capabilityBroker;
    if (!broker)
      return capabilityFailure(
        "CAPABILITY_UNAVAILABLE",
        "unavailable",
        `No broker is configured for ${grant.name}`,
      );
    const deadline = Math.min(callDeadline, response.deadlineUnixMs ?? callDeadline);
    if (deadline <= Date.now())
      return capabilityFailure(
        "CAPABILITY_TIMEOUT",
        "timeout",
        `Capability request ${response.requestId} reached its deadline`,
      );
    const controller = new AbortController();
    const abort = (): void => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("Capability deadline exceeded")),
      Math.max(1, deadline - Date.now()),
    );
    try {
      const result = await Promise.race([
        Promise.resolve(
          broker({
            id: response.requestId,
            callId,
            sequence: response.sequence,
            capability: response.capability,
            operation: response.operation,
            arguments: response.arguments,
            grant,
            deadlineUnixMs: deadline,
            signal: controller.signal,
          }),
        ),
        aborted(controller.signal),
      ]);
      if (parentSignal?.aborted)
        throw new ResolverFault("RUNTIME_CANCELLED", "cancelled", "Resolver call was cancelled");
      if (controller.signal.aborted)
        return capabilityFailure(
          "CAPABILITY_TIMEOUT",
          "timeout",
          `Capability request ${response.requestId} reached its deadline`,
        );
      return normalizeCapabilityResult(result);
    } catch (error) {
      if (parentSignal?.aborted)
        throw new ResolverFault("RUNTIME_CANCELLED", "cancelled", "Resolver call was cancelled", {
          cause: error,
        });
      if (controller.signal.aborted)
        return capabilityFailure(
          "CAPABILITY_TIMEOUT",
          "timeout",
          `Capability request ${response.requestId} reached its deadline`,
        );
      return capabilityFailure(
        "CAPABILITY_INTERNAL",
        "internal",
        error instanceof Error ? error.message : "Capability broker failed",
      );
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abort);
    }
  }

  #acceptContinuation(continuation: string): void {
    const bytes = new TextEncoder().encode(continuation).length;
    if (bytes > this.#options.limits.maxContinuationBytes)
      throw protocolFault(
        "PROTOCOL_CONTINUATION_LIMIT",
        `Continuation exceeds ${this.#options.limits.maxContinuationBytes} bytes`,
      );
    if (this.#seenContinuations.has(continuation))
      throw protocolFault("PROTOCOL_LIFECYCLE", "Runtime replayed a continuation token");
    this.#seenContinuations.add(continuation);
    this.#continuation = continuation;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function normalizeOptions(options: ProcessRuntimeOptions): NormalizedProcessOptions {
  if (options.cwd.length === 0) throw new TypeError("Process runtime cwd is required");
  const timeoutMs = positiveLimit(options.timeoutMs, 30_000, "timeoutMs");
  const limits: RuntimeLimits = {
    maxFrameBytes: positiveLimit(
      options.maxFrameBytes,
      DEFAULT_LIMITS.maxFrameBytes,
      "maxFrameBytes",
    ),
    maxMessageBytes: positiveLimit(
      options.maxMessageBytes,
      DEFAULT_LIMITS.maxMessageBytes,
      "maxMessageBytes",
    ),
    maxOutputBytes: positiveLimit(
      options.maxOutputBytes,
      DEFAULT_LIMITS.maxOutputBytes,
      "maxOutputBytes",
    ),
    maxLogBytes: positiveLimit(options.maxLogBytes, DEFAULT_LIMITS.maxLogBytes, "maxLogBytes"),
    maxContinuationBytes: positiveLimit(
      options.maxContinuationBytes,
      DEFAULT_LIMITS.maxContinuationBytes,
      "maxContinuationBytes",
    ),
    maxCapabilityCalls: positiveLimit(
      options.maxCapabilityCalls,
      DEFAULT_LIMITS.maxCapabilityCalls,
      "maxCapabilityCalls",
    ),
  };
  if (limits.maxMessageBytes > limits.maxFrameBytes)
    throw new TypeError("maxMessageBytes cannot exceed maxFrameBytes");
  if (limits.maxContinuationBytes > 16_384)
    throw new TypeError("maxContinuationBytes cannot exceed the 16384-byte protocol hard limit");
  const capabilities = validateCapabilityGrants(options.capabilities ?? []);
  if (capabilities.length > 0 && options.capabilityBroker === undefined)
    throw new TypeError("A capabilityBroker is required when capabilities are granted");
  const maxSessionExchanges = positiveLimit(
    options.maxSessionExchanges,
    DEFAULT_MAX_SESSION_EXCHANGES,
    "maxSessionExchanges",
  );
  if (maxSessionExchanges < 2)
    throw new TypeError("maxSessionExchanges must allow initialization and shutdown");
  return {
    cwd: options.cwd,
    timeoutMs,
    env: {},
    transport: options.transport ?? "jsonl",
    limits,
    maxSessionExchanges,
    capabilities,
    ...(options.capabilityBroker === undefined
      ? {}
      : { capabilityBroker: options.capabilityBroker }),
    host: options.host ?? { name: "polici", version: "1" },
    plugin: options.plugin,
  };
}

function validateCapabilityGrants(
  capabilities: readonly RuntimeCapability[],
): readonly RuntimeCapability[] {
  const validation = validateHostMessage({
    protocol: RUNTIME_PROTOCOL,
    type: "initialize",
    id: "validation",
    host: { name: "polici", version: "1" },
    plugin: { name: "plugin", version: "1" },
    capabilities,
    limits: DEFAULT_LIMITS,
  });
  if (!validation.ok)
    throw new TypeError(
      `Invalid capability grants: ${validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
    );
  for (const capability of capabilities) {
    if (capability.operations.length === 0)
      throw new TypeError(`Capability ${capability.name} must grant at least one operation`);
  }
  return [...capabilities];
}

function runProcessExchange(
  invocation: ProcessInvocation,
  options: NormalizedProcessOptions,
  input: Uint8Array,
  deadline: number,
  signal: AbortSignal | undefined,
  budget: OperationBudget,
): Promise<Uint8Array> {
  const remaining = deadline - Date.now();
  if (remaining <= 0)
    return Promise.reject(
      new ResolverFault("RUNTIME_TIMEOUT", "timeout", "Runtime deadline exceeded"),
    );
  const directory = mkdtempSync(resolve(tmpdir(), "polici-runtime-"));
  const inputPath = resolve(directory, "stdin");
  writeFileSync(inputPath, input);
  const inputFd = openSync(inputPath, "r");
  return new Promise<Uint8Array>((resolvePromise, rejectPromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(invocation.command, [...invocation.arguments], {
        cwd: options.cwd,
        env: { ...options.env },
        stdio: [inputFd, "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      closeSync(inputFd);
      rmSync(directory, { recursive: true, force: true });
      rejectPromise(
        new ResolverFault(
          "RUNTIME_SPAWN",
          "process",
          error instanceof Error ? error.message : String(error),
          { cause: error },
        ),
      );
      return;
    }
    closeSync(inputFd);
    const chunks: Uint8Array[] = [];
    const logs: Uint8Array[] = [];
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;
    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let settled = false;
    let pendingFailure: ResolverFault | undefined;
    const fail = (fault: ResolverFault): void => {
      if (pendingFailure === undefined) pendingFailure = fault;
      child.kill("SIGKILL");
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      rmSync(directory, { recursive: true, force: true });
    };
    const finish = (): void => {
      if (settled || !stdoutEnded || !stderrEnded || !exited) return;
      settled = true;
      cleanup();
      if (pendingFailure) {
        rejectPromise(pendingFailure);
        return;
      }
      if (exitCode !== 0) {
        const stderr = new TextDecoder().decode(joinBytes(logs)).trim();
        rejectPromise(
          new ResolverFault(
            "RUNTIME_EXIT",
            "process",
            `Runtime exited with ${exitCode ?? exitSignal ?? "an unknown status"}${stderr ? `: ${stderr}` : ""}`,
          ),
        );
        return;
      }
      resolvePromise(joinBytes(chunks));
    };
    const cancel = (): void =>
      fail(new ResolverFault("RUNTIME_CANCELLED", "cancelled", "Resolver call was cancelled"));
    const timer = setTimeout(
      () => fail(new ResolverFault("RUNTIME_TIMEOUT", "timeout", "Runtime deadline exceeded")),
      Math.max(1, remaining),
    );
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout?.on("data", (chunk: Uint8Array) => {
      budget.outputBytes += chunk.length;
      if (budget.outputBytes > options.limits.maxOutputBytes) {
        fail(
          new ResolverFault(
            "RUNTIME_OUTPUT_LIMIT",
            "process",
            `Runtime output exceeded ${options.limits.maxOutputBytes} bytes`,
          ),
        );
        return;
      }
      chunks.push(Uint8Array.from(chunk));
    });
    child.stdout?.on("end", () => {
      stdoutEnded = true;
      finish();
    });
    child.stderr?.on("data", (chunk: Uint8Array) => {
      budget.logBytes += chunk.length;
      if (budget.logBytes > options.limits.maxLogBytes) {
        fail(
          new ResolverFault(
            "RUNTIME_LOG_LIMIT",
            "process",
            `Runtime logs exceeded ${options.limits.maxLogBytes} bytes`,
          ),
        );
        return;
      }
      logs.push(Uint8Array.from(chunk));
    });
    child.stderr?.on("end", () => {
      stderrEnded = true;
      finish();
    });
    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(new ResolverFault("RUNTIME_SPAWN", "process", error.message, { cause: error }));
    });
    child.on("exit", (code: number | null, signalName: string | null) => {
      exitCode = code;
      exitSignal = signalName;
      exited = true;
      finish();
    });
  });
}

function normalizeCapabilityResult(value: unknown): CapabilityResult {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return invalidCapabilityResult("Capability broker returned a non-object result");
  const result = value as Partial<CapabilityResult>;
  if (result.ok === true) {
    const validation = validateWireValue(result.value);
    return validation.ok
      ? { ok: true, value: validation.value }
      : invalidCapabilityResult(
          `Capability broker returned an invalid wire value: ${validation.issues[0]?.message ?? "invalid value"}`,
        );
  }
  if (result.ok === false && result.error !== undefined) {
    const message: CapabilityResultRequest = {
      protocol: RUNTIME_PROTOCOL,
      type: "capability-result",
      id: "validation",
      requestId: "validation-request",
      sequence: 1,
      continuation: "validation-token",
      error: result.error,
    };
    if (validateHostMessage(message).ok) return { ok: false, error: result.error };
  }
  return invalidCapabilityResult("Capability broker returned an invalid result envelope");
}

function invalidCapabilityResult(message: string): CapabilityResult {
  return capabilityFailure("CAPABILITY_INVALID_RESULT", "internal", message);
}

function capabilityFailure(
  code: string,
  kind: RuntimeError["kind"],
  message: string,
): CapabilityResult {
  return { ok: false, error: { code, kind, message, retryable: false } };
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new ResolverFault("RUNTIME_CANCELLED", "cancelled", "Resolver call was cancelled", {
    cause: signal.reason,
  });
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0)
    throw new TypeError(`${name} must be a positive safe integer`);
  return normalized;
}

function trimAsciiWhitespace(input: Uint8Array): Uint8Array {
  let start = 0;
  let end = input.length;
  while (start < end && isAsciiWhitespace(input[start]!)) start += 1;
  while (end > start && isAsciiWhitespace(input[end - 1]!)) end -= 1;
  return input.subarray(start, end);
}

function decodeUtf8(input: Uint8Array): string {
  if (!isValidUtf8(input))
    throw new ResolverFault("PROTOCOL_INVALID", "protocol", "Protocol message is not valid UTF-8");
  return new TextDecoder("utf-8").decode(input);
}

function isValidUtf8(input: Uint8Array): boolean {
  let index = 0;
  while (index < input.length) {
    const first = input[index++]!;
    if (first <= 0x7f) continue;
    const second = input[index++];
    if (second === undefined) return false;
    if (first >= 0xc2 && first <= 0xdf) {
      if (!isContinuationByte(second)) return false;
      continue;
    }
    const third = input[index++];
    if (third === undefined || !isContinuationByte(third)) return false;
    if (first === 0xe0) {
      if (second < 0xa0 || second > 0xbf) return false;
      continue;
    }
    if (first >= 0xe1 && first <= 0xec) {
      if (!isContinuationByte(second)) return false;
      continue;
    }
    if (first === 0xed) {
      if (second < 0x80 || second > 0x9f) return false;
      continue;
    }
    if (first >= 0xee && first <= 0xef) {
      if (!isContinuationByte(second)) return false;
      continue;
    }
    const fourth = input[index++];
    if (fourth === undefined || !isContinuationByte(fourth)) return false;
    if (first === 0xf0) {
      if (second < 0x90 || second > 0xbf) return false;
      continue;
    }
    if (first >= 0xf1 && first <= 0xf3) {
      if (!isContinuationByte(second)) return false;
      continue;
    }
    if (first === 0xf4 && second >= 0x80 && second <= 0x8f) continue;
    return false;
  }
  return true;
}

function isContinuationByte(byte: number): boolean {
  return byte >= 0x80 && byte <= 0xbf;
}

function isAsciiWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0d;
}

function joinBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function resolveExecutable(command: string, cwd: string): string {
  const candidates: string[] = [];
  if (isAbsolute(command)) candidates.push(command);
  else if (command.includes("/") || command.includes("\\")) candidates.push(resolve(cwd, command));
  else {
    // @ts-ignore This bare repository intentionally does not depend on @types/node.
    const path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    for (const directory of path.split(delimiter)) {
      if (directory.length > 0) candidates.push(resolve(directory, command));
    }
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new ResolverFault(
    "RUNTIME_EXECUTABLE",
    "process",
    `Runtime executable ${JSON.stringify(command)} is unavailable or not executable`,
  );
}

function sandboxedInvocation(
  invocation: ProcessInvocation,
  options: TypeScriptRuntimeOptions,
): ProcessInvocation {
  if (options.trustedRuntime === true) return invocation;
  const sandbox = options.sandbox!;
  return {
    command: resolveExecutable(sandbox.launcher, options.cwd),
    arguments: [...(sandbox.arguments ?? []), invocation.command, ...invocation.arguments],
  };
}

function assertRuntimeSandbox(options: TypeScriptRuntimeOptions): void {
  if (options.trustedRuntime === true) return;
  const sandbox = options.sandbox;
  if (
    sandbox === undefined ||
    sandbox.denyNetwork !== true ||
    sandbox.denyFilesystem !== true ||
    sandbox.denyEnvironment !== true ||
    sandbox.denyChildProcess !== true
  ) {
    throw new ResolverFault(
      "RUNTIME_SANDBOX_REQUIRED",
      "permission",
      "External native runtimes require a hardened OS sandbox denying network, arbitrary filesystem, environment, and child processes",
    );
  }
}

function validateWasiArguments(arguments_: readonly string[]): readonly string[] {
  if (arguments_.length === 0) return [];
  throw new ResolverFault(
    "RUNTIME_WASI_CAPABILITY",
    "permission",
    `WASI runner arguments are forbidden because arbitrary runner options can grant host capabilities: ${JSON.stringify(arguments_[0])}`,
  );
}

function protocolFault(code: string, message: string, cause?: unknown): ResolverFault {
  return new ResolverFault(code, "protocol", message, cause === undefined ? {} : { cause });
}

function runtimeErrorFault(
  response: Extract<RuntimeMessage, { readonly type: "error" }>,
): ResolverFault {
  const kind =
    response.error.kind === "permission"
      ? "permission"
      : response.error.kind === "capability"
        ? "capability"
        : response.error.kind === "timeout"
          ? "timeout"
          : response.error.kind === "cancelled"
            ? "cancelled"
            : "resolver";
  return new ResolverFault(response.error.code, kind, response.error.message, {
    retryable: response.error.retryable,
    details: response.error.details,
  });
}
