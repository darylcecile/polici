// @ts-ignore This bare repository intentionally uses ScriptC's Node built-ins.
import { delimiter, isAbsolute, resolve } from "node:path";

import { canonicalStringify, type JsonValue } from "../plugin/json.js";
import type { PluginTransport } from "../plugin/manifest.js";
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
} from "../plugin/protocol.js";
import {
  ResolverFault,
  type CapabilityBroker,
  type CapabilityResult,
  type ResolverCallOptions,
  type ResolverHost,
  type ResolverRequest,
} from "../plugin/resolver.js";
import { validateWireValue, type WireValue } from "../plugin/wire.js";
import { validateWasiCommandFile } from "../plugin/wasm.js";
import type { CliProcessResult, CliProcessRunner } from "./process.js";

export interface CliHardenedRuntimeSandbox {
  readonly launcher: string;
  readonly arguments?: readonly string[];
  readonly denyNetwork: true;
  readonly denyFilesystem: true;
  readonly denyEnvironment: true;
  readonly denyChildProcess: true;
}

interface CommonRuntimeOptions {
  readonly entrypoint: string;
  readonly cwd: string;
  readonly plugin: { readonly name: string; readonly version: string };
  readonly transport: PluginTransport;
  readonly capabilities: readonly RuntimeCapability[];
  readonly capabilityBroker?: CapabilityBroker;
  readonly timeoutMs?: number;
  readonly maxFrameBytes?: number;
  readonly maxMessageBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxLogBytes?: number;
  readonly maxContinuationBytes?: number;
  readonly maxCapabilityCalls?: number;
  readonly maxSessionExchanges?: number;
  readonly runProcess: CliProcessRunner;
}

interface NativeRuntimeOptions extends CommonRuntimeOptions {
  readonly trustedRuntime: boolean;
  readonly sandbox?: CliHardenedRuntimeSandbox;
}

interface WasiRuntimeOptions extends CommonRuntimeOptions {
  readonly command?: string;
  readonly commandArguments: readonly string[];
}

interface Invocation {
  readonly command: string;
  readonly arguments: readonly string[];
}

interface NormalizedRuntimeOptions {
  readonly cwd: string;
  readonly plugin: { readonly name: string; readonly version: string };
  readonly transport: PluginTransport;
  readonly capabilities: readonly RuntimeCapability[];
  readonly capabilityBroker?: CapabilityBroker;
  readonly timeoutMs: number;
  readonly limits: RuntimeLimits;
  readonly maxSessionExchanges: number;
  readonly runProcess: CliProcessRunner;
}

interface OperationBudget {
  outputBytes: number;
  logBytes: number;
}

interface ProtocolDecodeLimits {
  readonly maxFrameBytes: number;
  readonly maxMessageBytes: number;
  readonly maxMessages: number;
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

export class CliTypeScriptProcessResolverHost implements ResolverHost {
  readonly capabilities: readonly RuntimeCapability[];
  readonly #host: ResumableProcessHost;

  constructor(options: NativeRuntimeOptions) {
    const executable = resolveExecutable(resolve(options.cwd, options.entrypoint), options.cwd);
    const invocation = options.trustedRuntime
      ? { command: executable, arguments: [] }
      : sandboxInvocation(executable, options);
    this.#host = new ResumableProcessHost(invocation, options);
    this.capabilities = this.#host.capabilities;
  }

  resolve(request: ResolverRequest, options?: ResolverCallOptions): Promise<WireValue> {
    return this.#host.resolve(request, options);
  }

  dispose(): Promise<void> {
    return this.#host.dispose();
  }
}

export class CliWasiProcessResolverHost implements ResolverHost {
  readonly capabilities: readonly RuntimeCapability[];
  readonly #host: ResumableProcessHost;

  constructor(options: WasiRuntimeOptions) {
    const runnerArguments = validateWasiArguments(options.commandArguments);
    validateWasiCommandFile(resolve(options.cwd, options.entrypoint));
    this.#host = new ResumableProcessHost(
      {
        command: resolveExecutable(options.command ?? "wasmtime", options.cwd),
        arguments: [
          ...runnerArguments,
          ...defaultWasiRunnerArguments(options.command),
          resolve(options.cwd, options.entrypoint),
        ],
      },
      options,
    );
    this.capabilities = this.#host.capabilities;
  }

  resolve(request: ResolverRequest, options?: ResolverCallOptions): Promise<WireValue> {
    return this.#host.resolve(request, options);
  }

  dispose(): Promise<void> {
    return this.#host.dispose();
  }
}

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

class ResumableProcessHost implements ResolverHost {
  readonly capabilities: readonly RuntimeCapability[];
  readonly #invocation: Invocation;
  readonly #options: NormalizedRuntimeOptions;
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

  constructor(invocation: Invocation, options: CommonRuntimeOptions) {
    this.#invocation = invocation;
    this.#options = normalizeOptions(options);
    this.capabilities = this.#options.capabilities;
    for (const grant of this.capabilities) this.#grants.set(grant.name, grant);
  }

  resolve(request: ResolverRequest, options: ResolverCallOptions = {}): Promise<WireValue> {
    if (this.#disposeRequested)
      return Promise.reject(
        new ResolverFault("RUNTIME_DISPOSED", "process", "Runtime host is disposed."),
      );
    return this.#enqueue(() => this.#resolve(request, options));
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;
    this.#disposeRequested = true;
    this.#disposePromise = this.#enqueue(async () => {
      if (this.#continuation === undefined || this.#failed) return;
      const id = `shutdown-${++this.#sequence}`;
      const response = await this.#exchange(
        {
          protocol: RUNTIME_PROTOCOL,
          type: "shutdown",
          id,
          continuation: this.#continuation,
        },
        Date.now() + this.#options.timeoutMs,
        undefined,
        { outputBytes: 0, logBytes: 0 },
      );
      if (response.id !== id)
        throw protocolFault("PROTOCOL_MESSAGE", `Unexpected shutdown response ${response.id}.`);
      if (response.type === "error") throw runtimeFault(response);
      if (response.type !== "stopped")
        throw protocolFault("PROTOCOL_LIFECYCLE", `Expected stopped, received ${response.type}.`);
      this.#continuation = undefined;
    });
    return this.#disposePromise;
  }

  async #resolve(request: ResolverRequest, options: ResolverCallOptions): Promise<WireValue> {
    assertNotAborted(options.signal);
    const timeout = options.timeoutMs ?? this.#options.timeoutMs;
    if (!Number.isSafeInteger(timeout) || timeout <= 0)
      throw new TypeError("Resolver timeout must be a positive safe integer.");
    if (this.#failed)
      throw new ResolverFault("RUNTIME_SESSION_FAILED", "process", "Runtime session has failed.");
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
            `Capability call limit ${this.#options.limits.maxCapabilityCalls} exceeded.`,
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
        throw protocolFault("PROTOCOL_MESSAGE", `Unexpected call response ${response.id}.`);
      if (response.type === "error") {
        if (response.continuation === undefined)
          throw protocolFault("PROTOCOL_LIFECYCLE", "Call error omitted its continuation.");
        this.#acceptContinuation(response.continuation);
        throw runtimeFault(response);
      }
      if (response.type !== "result")
        throw protocolFault("PROTOCOL_RESULT", `Expected result, received ${response.type}.`);
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
        host: { name: "polici", version: "1" },
        plugin: this.#options.plugin,
        capabilities: this.capabilities,
        limits: this.#options.limits,
      },
      deadline,
      signal,
      budget,
    );
    if (response.id !== id)
      throw protocolFault("PROTOCOL_MESSAGE", `Unexpected initialization response ${response.id}.`);
    if (response.type === "error") throw runtimeFault(response);
    if (response.type !== "initialized")
      throw protocolFault("PROTOCOL_LIFECYCLE", `Expected initialized, received ${response.type}.`);
    if (
      response.implementation.name !== this.#options.plugin.name ||
      response.implementation.version !== this.#options.plugin.version
    )
      throw protocolFault(
        "PROTOCOL_IMPLEMENTATION",
        `Runtime identified itself as ${response.implementation.name}@${response.implementation.version}, expected ${this.#options.plugin.name}@${this.#options.plugin.version}.`,
      );
    for (const capability of response.capabilities) {
      if (!this.#grants.has(capability))
        throw new ResolverFault(
          "PROTOCOL_CAPABILITY",
          "capability",
          `Runtime activated undeclared or ungranted capability ${capability}.`,
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
        `Runtime session exchange limit ${this.#options.maxSessionExchanges} exceeded.`,
      );
    this.#sessionExchanges += 1;
    const validated = validateHostMessage(message);
    if (!validated.ok)
      throw new TypeError(
        `Invalid host protocol message: ${validated.issues.map((issue) => issue.message).join("; ")}`,
      );
    const input = encodeProtocolMessage(message, this.#options.transport);
    const payloadBytes = input.length - (this.#options.transport === "jsonl" ? 1 : 4);
    if (payloadBytes > this.#options.limits.maxFrameBytes)
      throw protocolFault("PROTOCOL_FRAME_LIMIT", "Host protocol frame limit exceeded.");
    if (payloadBytes > this.#options.limits.maxMessageBytes)
      throw protocolFault("PROTOCOL_MESSAGE_LIMIT", "Host protocol message limit exceeded.");
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new ResolverFault("RUNTIME_TIMEOUT", "timeout", "Runtime deadline exceeded.");
    const remainingOutput = this.#options.limits.maxOutputBytes - budget.outputBytes;
    if (remainingOutput <= 0)
      throw new ResolverFault(
        "RUNTIME_OUTPUT_LIMIT",
        "process",
        `Runtime output exceeded ${this.#options.limits.maxOutputBytes} bytes.`,
      );
    const remainingLogs = this.#options.limits.maxLogBytes - budget.logBytes;
    if (remainingLogs <= 0)
      throw new ResolverFault(
        "RUNTIME_LOG_LIMIT",
        "process",
        `Runtime logs exceeded ${this.#options.limits.maxLogBytes} bytes.`,
      );
    let result: CliProcessResult;
    try {
      const encoded = this.#options.runProcess(
        this.#invocation.command,
        this.#invocation.arguments,
        this.#options.cwd,
        {},
        encodeBase64(input),
        remaining,
        remainingOutput,
        remainingLogs,
      );
      result = parseProcessResult(encoded);
    } catch (error) {
      throw processFault(error);
    }
    const output = decodeBase64(result.stdoutBase64);
    const logs = decodeBase64(result.stderrBase64);
    budget.outputBytes += output.length;
    if (
      budget.outputBytes > this.#options.limits.maxOutputBytes ||
      (output.length >= remainingOutput &&
        (result.status !== 0 || result.signal !== null || result.error !== undefined))
    )
      throw new ResolverFault(
        "RUNTIME_OUTPUT_LIMIT",
        "process",
        `Runtime output exceeded ${this.#options.limits.maxOutputBytes} bytes.`,
      );
    budget.logBytes += logs.length;
    if (
      budget.logBytes > this.#options.limits.maxLogBytes ||
      (logs.length >= remainingLogs &&
        (result.status !== 0 || result.signal !== null || result.error !== undefined))
    )
      throw new ResolverFault(
        "RUNTIME_LOG_LIMIT",
        "process",
        `Runtime logs exceeded ${this.#options.limits.maxLogBytes} bytes.`,
      );
    if (result.timedOut)
      throw new ResolverFault(
        "RUNTIME_TIMEOUT",
        "timeout",
        result.error?.message ?? "Runtime deadline exceeded.",
      );
    if (result.status !== 0 || result.signal !== null) {
      const detail = decodeUtf8ForError(logs).trim();
      const status = result.status ?? result.signal ?? result.error?.code ?? "an unknown status";
      throw new ResolverFault(
        result.status === null && result.signal === null ? "RUNTIME_SPAWN" : "RUNTIME_EXIT",
        "process",
        `Runtime exited with ${status}${detail ? `: ${detail}` : ""}.`,
      );
    }
    if (result.error !== undefined)
      throw new ResolverFault("RUNTIME_SPAWN", "process", result.error.message);
    let responses: RuntimeMessage[];
    try {
      responses = decodeProtocolMessages(output, this.#options.transport, {
        maxFrameBytes: this.#options.limits.maxFrameBytes,
        maxMessageBytes: this.#options.limits.maxMessageBytes,
        maxMessages: 2,
      });
    } catch (error) {
      if (error instanceof ResolverFault) throw error;
      throw protocolFault(
        "PROTOCOL_INVALID",
        "Runtime emitted an invalid protocol message.",
        error,
      );
    }
    if (responses.length !== 1)
      throw protocolFault(
        "PROTOCOL_MESSAGE",
        `Runtime exchange emitted ${responses.length} messages; expected exactly one.`,
      );
    return responses[0]!;
  }

  #validateCapabilityCall(
    response: CapabilityCallResponse,
    callId: string,
    expectedSequence: number,
  ): void {
    if (response.id !== callId)
      throw protocolFault("PROTOCOL_MESSAGE", `Capability call used unexpected id ${response.id}.`);
    if (response.sequence !== expectedSequence)
      throw protocolFault(
        "PROTOCOL_MESSAGE",
        `Capability sequence ${response.sequence} is out of order; expected ${expectedSequence}.`,
      );
    if (this.#requestIds.has(response.requestId))
      throw protocolFault(
        "PROTOCOL_MESSAGE",
        `Capability request id ${response.requestId} was reused.`,
      );
    this.#requestIds.add(response.requestId);
    const grant = this.#grants.get(response.capability);
    if (grant === undefined || !this.#activeCapabilities.has(response.capability))
      throw new ResolverFault(
        "CAPABILITY_UNDECLARED",
        "capability",
        `Runtime called undeclared or ungranted capability ${response.capability}.`,
      );
    if (!grant.operations.includes(response.operation))
      throw new ResolverFault(
        "CAPABILITY_OPERATION_UNDECLARED",
        "capability",
        `Runtime called undeclared operation ${response.capability}.${response.operation}.`,
      );
  }

  async #invokeCapability(
    response: CapabilityCallResponse,
    callId: string,
    callDeadline: number,
    signal: AbortSignal | undefined,
  ): Promise<CapabilityResult> {
    const grant = this.#grants.get(response.capability)!;
    const used = this.#grantCalls.get(grant.name) ?? 0;
    if (grant.maxCalls !== undefined && used >= grant.maxCalls)
      return capabilityFailure(
        "CAPABILITY_QUOTA",
        "capability",
        `Capability grant ${grant.name} exhausted its ${grant.maxCalls} call quota.`,
      );
    this.#grantCalls.set(grant.name, used + 1);
    const broker = this.#options.capabilityBroker;
    if (broker === undefined)
      return capabilityFailure(
        "CAPABILITY_NOT_CONFIGURED",
        "capability",
        `No host capability broker is configured for ${grant.name}.`,
      );
    const deadline = Math.min(callDeadline, response.deadlineUnixMs ?? callDeadline);
    if (deadline <= Date.now())
      return capabilityFailure(
        "CAPABILITY_TIMEOUT",
        "timeout",
        `Capability request ${response.requestId} reached its deadline.`,
      );
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("Capability deadline exceeded.")),
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
      if (signal?.aborted)
        throw new ResolverFault("RUNTIME_CANCELLED", "cancelled", "Resolver call was cancelled.");
      if (controller.signal.aborted)
        return capabilityFailure(
          "CAPABILITY_TIMEOUT",
          "timeout",
          `Capability request ${response.requestId} reached its deadline.`,
        );
      return normalizeCapabilityResult(result);
    } catch (error) {
      if (signal?.aborted)
        throw new ResolverFault("RUNTIME_CANCELLED", "cancelled", "Resolver call was cancelled.", {
          cause: error,
        });
      if (controller.signal.aborted)
        return capabilityFailure(
          "CAPABILITY_TIMEOUT",
          "timeout",
          `Capability request ${response.requestId} reached its deadline.`,
        );
      return capabilityFailure(
        "CAPABILITY_INTERNAL",
        "internal",
        error instanceof Error ? error.message : "Capability broker failed.",
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  #acceptContinuation(continuation: string): void {
    const bytes = new TextEncoder().encode(continuation).length;
    if (bytes > this.#options.limits.maxContinuationBytes)
      throw protocolFault(
        "PROTOCOL_CONTINUATION_LIMIT",
        `Continuation exceeds ${this.#options.limits.maxContinuationBytes} bytes.`,
      );
    if (this.#seenContinuations.has(continuation))
      throw protocolFault("PROTOCOL_LIFECYCLE", "Runtime replayed a continuation token.");
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

function normalizeOptions(options: CommonRuntimeOptions): NormalizedRuntimeOptions {
  if (options.cwd.length === 0) throw new TypeError("Process runtime cwd is required.");
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
    throw new TypeError("maxMessageBytes cannot exceed maxFrameBytes.");
  if (limits.maxContinuationBytes > 16_384)
    throw new TypeError("maxContinuationBytes cannot exceed the 16384-byte protocol hard limit.");
  const capabilities = validateCapabilityGrants(options.capabilities);
  if (capabilities.length > 0 && options.capabilityBroker === undefined)
    throw new TypeError("A capabilityBroker is required when capabilities are granted.");
  const maxSessionExchanges = positiveLimit(
    options.maxSessionExchanges,
    DEFAULT_MAX_SESSION_EXCHANGES,
    "maxSessionExchanges",
  );
  if (maxSessionExchanges < 2)
    throw new TypeError("maxSessionExchanges must allow initialization and shutdown.");
  return {
    cwd: options.cwd,
    plugin: options.plugin,
    transport: options.transport,
    capabilities,
    ...(options.capabilityBroker === undefined
      ? {}
      : { capabilityBroker: options.capabilityBroker }),
    timeoutMs: positiveLimit(options.timeoutMs, 30_000, "timeoutMs"),
    limits,
    maxSessionExchanges,
    runProcess: options.runProcess,
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
      throw new TypeError(`Capability ${capability.name} must grant at least one operation.`);
  }
  return [...capabilities];
}

function encodeProtocolMessage(message: HostMessage, transport: PluginTransport): Uint8Array {
  const payload = new TextEncoder().encode(canonicalStringify(message as unknown as JsonValue));
  if (transport === "jsonl") {
    const output = new Uint8Array(payload.length + 1);
    output.set(payload);
    output[payload.length] = 0x0a;
    return output;
  }
  const output = new Uint8Array(payload.length + 4);
  new DataView(output.buffer).setUint32(0, payload.length, false);
  output.set(payload, 4);
  return output;
}

function decodeProtocolMessages(
  input: Uint8Array,
  transport: PluginTransport,
  limits: ProtocolDecodeLimits,
): RuntimeMessage[] {
  const messages: RuntimeMessage[] = [];
  const append = (frame: Uint8Array): void => {
    if (frame.length === 0) throw protocolFault("PROTOCOL_FRAME", "Empty protocol frame.");
    if (frame.length > limits.maxFrameBytes)
      throw protocolFault("PROTOCOL_FRAME_LIMIT", "Protocol frame limit exceeded.");
    if (frame.length > limits.maxMessageBytes)
      throw protocolFault("PROTOCOL_MESSAGE_LIMIT", "Protocol message limit exceeded.");
    if (messages.length >= limits.maxMessages)
      throw protocolFault("PROTOCOL_MESSAGE_LIMIT", "Protocol message count exceeded.");
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
      throw protocolFault(
        "PROTOCOL_FRAME",
        "JSONL protocol message is missing its newline delimiter.",
      );
    return messages;
  }
  let offset = 0;
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  while (offset < input.length) {
    if (input.length - offset < 4) throw protocolFault("PROTOCOL_FRAME", "Truncated frame header.");
    const length = view.getUint32(offset, false);
    offset += 4;
    if (length > limits.maxFrameBytes)
      throw protocolFault("PROTOCOL_FRAME_LIMIT", "Protocol frame limit exceeded.");
    if (input.length - offset < length)
      throw protocolFault("PROTOCOL_FRAME", "Truncated protocol frame.");
    append(input.subarray(offset, offset + length));
    offset += length;
  }
  return messages;
}

function normalizeCapabilityResult(value: unknown): CapabilityResult {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return invalidCapabilityResult("Capability broker returned a non-object result.");
  const result = value as Partial<CapabilityResult>;
  if (result.ok === true) {
    const validation = validateWireValue(result.value);
    return validation.ok
      ? { ok: true, value: validation.value }
      : invalidCapabilityResult(
          `Capability broker returned an invalid wire value: ${validation.issues[0]?.message ?? "invalid value"}.`,
        );
  }
  if (result.ok === false && result.error !== undefined) {
    const validation = validateHostMessage({
      protocol: RUNTIME_PROTOCOL,
      type: "capability-result",
      id: "validation",
      requestId: "validation-request",
      sequence: 1,
      continuation: "validation-token",
      error: result.error,
    });
    if (validation.ok) return { ok: false, error: result.error };
  }
  return invalidCapabilityResult("Capability broker returned an invalid result envelope.");
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

function sandboxInvocation(executable: string, options: NativeRuntimeOptions): Invocation {
  const sandbox = options.sandbox;
  if (
    sandbox === undefined ||
    !sandbox.denyNetwork ||
    !sandbox.denyFilesystem ||
    !sandbox.denyEnvironment ||
    !sandbox.denyChildProcess
  )
    throw new ResolverFault(
      "RUNTIME_SANDBOX_REQUIRED",
      "permission",
      "External native runtimes require a hardened OS sandbox denying network, arbitrary filesystem, environment, and child processes.",
    );
  return {
    command: resolveExecutable(sandbox.launcher, options.cwd),
    arguments: [...(sandbox.arguments ?? []), executable],
  };
}

function resolveExecutable(command: string, cwd: string): string {
  const candidates: string[] = [];
  if (isAbsolute(command)) candidates.push(command);
  else if (command.includes("/") || command.includes("\\")) candidates.push(resolve(cwd, command));
  else {
    // PATH resolves only a host-selected launcher and is never passed to the plugin.
    // @ts-ignore The local plugin shim deliberately declares only process.env.
    for (const directory of (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(delimiter))
      if (directory.length > 0) candidates.push(resolve(directory, command));
  }
  if (candidates.length > 0) return candidates[0]!;
  throw new ResolverFault(
    "RUNTIME_EXECUTABLE",
    "process",
    `Runtime executable ${JSON.stringify(command)} is unavailable or not executable.`,
  );
}

function validateWasiArguments(arguments_: readonly string[]): readonly string[] {
  if (arguments_.length === 0) return [];
  throw new ResolverFault(
    "RUNTIME_WASI_CAPABILITY",
    "permission",
    `WASI runner arguments are forbidden because arbitrary runner options can grant host capabilities: ${JSON.stringify(arguments_[0])}.`,
  );
}

function processFault(error: unknown): ResolverFault {
  const failure = error as Error & {
    readonly code?: string;
    readonly status?: number | null;
    readonly signal?: string | null;
    readonly stderr?: string | Uint8Array;
  };
  if (failure.code === "ETIMEDOUT")
    return new ResolverFault("RUNTIME_TIMEOUT", "timeout", failure.message, { cause: error });
  if (failure.status === null && failure.signal === null && failure.code !== undefined)
    return new ResolverFault("RUNTIME_SPAWN", "process", failure.message, { cause: error });
  const stderr =
    typeof failure.stderr === "string"
      ? failure.stderr.trim()
      : failure.stderr instanceof Uint8Array
        ? new TextDecoder().decode(failure.stderr).trim()
        : "";
  return new ResolverFault(
    "RUNTIME_EXIT",
    "process",
    `Runtime exited with ${failure.status ?? failure.signal ?? failure.code ?? "an unknown status"}${stderr ? `: ${stderr}` : ""}.`,
    { cause: error },
  );
}

function parseProcessResult(value: string): CliProcessResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new TypeError("Process runner returned invalid JSON.", { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new TypeError("Process runner returned a non-object result envelope.");
  const result = parsed as Partial<CliProcessResult>;
  if (
    typeof result.stdoutBase64 !== "string" ||
    typeof result.stderrBase64 !== "string" ||
    (result.status !== null && !Number.isSafeInteger(result.status)) ||
    (result.signal !== null && typeof result.signal !== "string") ||
    (result.timedOut !== undefined && result.timedOut !== true) ||
    (result.error !== undefined &&
      (typeof result.error !== "object" ||
        result.error === null ||
        typeof result.error.message !== "string" ||
        (result.error.code !== undefined && typeof result.error.code !== "string")))
  )
    throw new TypeError("Process runner returned an invalid result envelope.");
  return result as CliProcessResult;
}

function decodeUtf8ForError(input: Uint8Array): string {
  return isValidUtf8(input) ? new TextDecoder("utf-8").decode(input) : "";
}

function runtimeFault(
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

function protocolFault(code: string, message: string, cause?: unknown): ResolverFault {
  return new ResolverFault(code, "protocol", message, cause === undefined ? {} : { cause });
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new ResolverFault("RUNTIME_CANCELLED", "cancelled", "Resolver call was cancelled.", {
    cause: signal.reason,
  });
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

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0)
    throw new TypeError(`${name} must be a positive safe integer.`);
  return normalized;
}

function trimAsciiWhitespace(input: Uint8Array): Uint8Array {
  let start = 0;
  let end = input.length;
  while (start < end && isAsciiWhitespace(input[start]!)) start += 1;
  while (end > start && isAsciiWhitespace(input[end - 1]!)) end -= 1;
  return input.subarray(start, end);
}

function isAsciiWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0d;
}

function decodeUtf8(input: Uint8Array): string {
  if (!isValidUtf8(input))
    throw protocolFault("PROTOCOL_INVALID", "Protocol message is not valid UTF-8.");
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

function encodeBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}
