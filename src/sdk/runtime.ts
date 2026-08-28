// @ts-ignore ScriptC supplies the Node.js fallback declarations.
import { readFileSync } from "node:fs";

import type { PluginTransport } from "../plugin/manifest.js";
import {
  RUNTIME_PROTOCOL,
  validateHostMessage,
  validateRuntimeMessage,
  type CapabilityResultRequest,
  type HostMessage,
  type RuntimeError,
  type RuntimeLimits,
  type RuntimeMessage,
} from "../plugin/protocol.js";
import { canonicalStringify, type JsonValue } from "../plugin/json.js";
import { validateWireValue, wire, type WireValue } from "../plugin/wire.js";
import type { ParameterDefinition } from "../plugin/manifest.js";
import type { ParameterInput } from "./builders.js";
import type { DefinedPlugin, PluginDefinition } from "./define.js";

export const runtimeMissing = Object.freeze({ kind: "polici.runtime.missing" as const });

export class RuntimeEntity {
  constructor(
    readonly type: string,
    readonly identity: Readonly<{ namespace: string; value: string }>,
    readonly fields: Readonly<Record<string, RuntimeValue>>,
  ) {
    Object.freeze(this.identity);
    Object.freeze(this.fields);
    Object.freeze(this);
  }

  get(name: string): RuntimeValue | undefined {
    return this.fields[name];
  }
}

export type RuntimeValue =
  | typeof runtimeMissing
  | RuntimeEntity
  | WireValue
  | Uint8Array
  | ReadonlySet<RuntimeValue>
  | readonly RuntimeValue[]
  | { readonly [name: string]: RuntimeValue }
  | bigint
  | number
  | string
  | boolean
  | null;

export interface RuntimeCapabilityClient {
  call(
    operation: string,
    arguments_?: Readonly<Record<string, RuntimeValue>>,
    options?: { readonly deadlineUnixMs?: number },
  ): Promise<RuntimeValue>;
}

export interface RuntimeResolverContext {
  readonly plugin: Readonly<{ name: string; version: string }>;
  readonly host: Readonly<{ name: string; version: string }>;
  readonly limits: RuntimeLimits;
  readonly subject?: RuntimeValue;
  readonly core: typeof runtimeCore;
  readonly value: typeof runtimeValue;
  capability(name: string): RuntimeCapabilityClient;
}

export type RuntimeResolver<
  Arguments extends Readonly<Record<string, RuntimeValue>> = Readonly<Record<string, RuntimeValue>>,
> = (
  context: RuntimeResolverContext,
  arguments_: Arguments,
) => RuntimeValue | Promise<RuntimeValue>;

export interface RuntimeDefinitionInput {
  readonly name: string;
  readonly version: string;
  readonly transport?: PluginTransport;
  readonly capabilities?: readonly string[];
  readonly resolvers: Readonly<Record<string, RuntimeResolver>>;
}

type RuntimeType<Expression> = Expression extends { readonly kind: "string" | "glob" | "id" }
  ? string
  : Expression extends { readonly kind: "integer" | "number" }
    ? number
    : Expression extends { readonly kind: "boolean" }
      ? boolean
      : RuntimeValue;

type RuntimeParameter<Value> = Value extends ParameterInput
  ? RuntimeType<Value["type"]> | (Value["optional"] extends true ? typeof runtimeMissing : never)
  : RuntimeType<Value>;

type RuntimeArguments<Parameters> = Parameters extends readonly ParameterDefinition[]
  ? Readonly<Record<string, RuntimeValue>>
  : Parameters extends Readonly<Record<string, unknown>>
    ? { readonly [Name in keyof Parameters]: RuntimeParameter<Parameters[Name]> }
    : Readonly<Record<string, RuntimeValue>>;

type ResolverMap<Definitions> =
  Definitions extends Readonly<Record<string, unknown>>
    ? {
        readonly [
          Name in keyof Definitions as Definitions[Name] extends {
            readonly resolve: infer Resolver extends string;
          }
            ? Resolver
            : never
        ]: Definitions[Name] extends { readonly parameters?: infer Parameters }
          ? RuntimeResolver<RuntimeArguments<Parameters & unknown>>
          : RuntimeResolver<Record<never, never>>;
      }
    : Record<never, never>;

type FieldResolverMap<Fields> =
  Fields extends Readonly<Record<string, unknown>>
    ? {
        readonly [
          Name in keyof Fields as Fields[Name] extends {
            readonly resolve: infer Resolver extends string;
          }
            ? Resolver
            : never
        ]: RuntimeResolver<Record<never, never>>;
      }
    : Record<never, never>;

type TypeResolverUnion<Types> =
  Types extends Readonly<Record<string, unknown>>
    ? {
        [Name in keyof Types]: Types[Name] extends {
          readonly fields?: infer Fields;
          readonly methods?: infer Methods;
        }
          ? FieldResolverMap<Fields> & ResolverMap<Methods>
          : Types[Name] extends { readonly fields?: infer Fields }
            ? FieldResolverMap<Fields>
            : Record<never, never>;
      }[keyof Types]
    : Record<never, never>;

type UnionToIntersection<Value> = (Value extends unknown ? (value: Value) => void : never) extends (
  value: infer Intersection,
) => void
  ? Intersection
  : never;

type RuntimeResolvers<Definition extends PluginDefinition> = ResolverMap<Definition["exports"]> &
  UnionToIntersection<TypeResolverUnion<Definition["types"]>>;

export interface BoundRuntimeDefinitionInput<Definition extends PluginDefinition> {
  readonly resolvers: RuntimeResolvers<Definition> & Readonly<Record<string, RuntimeResolver>>;
}

export interface RuntimeDefinition {
  readonly name: string;
  readonly version: string;
  readonly transport: PluginTransport;
  readonly capabilities: readonly string[];
  readonly resolvers: Readonly<Record<string, RuntimeResolver>>;
}

export class RuntimeResolverError extends Error {
  constructor(
    readonly code: string,
    readonly kind: RuntimeError["kind"],
    message: string,
    readonly options: {
      readonly retryable?: boolean;
      readonly details?: RuntimeValue;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RuntimeResolverError";
  }
}

export class RuntimeCapabilityError extends RuntimeResolverError {
  constructor(error: RuntimeError) {
    super(error.code, error.kind, error.message, {
      retryable: error.retryable,
      ...(error.details === undefined ? {} : { details: decodeRuntimeValue(error.details) }),
    });
    this.name = "RuntimeCapabilityError";
  }
}

interface ReplayResult {
  readonly capability: string;
  readonly operation: string;
  readonly arguments: Readonly<Record<string, WireValue>>;
  readonly result?: WireValue;
  readonly error?: RuntimeError;
}

interface PendingCapability {
  readonly capability: string;
  readonly operation: string;
  readonly arguments: Readonly<Record<string, WireValue>>;
  readonly requestId: string;
  readonly sequence: number;
  readonly deadlineUnixMs?: number;
}

interface StoredCall {
  readonly id: string;
  readonly resolver: string;
  readonly arguments: Readonly<Record<string, WireValue>>;
  readonly subject?: WireValue;
  readonly deadlineUnixMs: number;
  readonly replay: readonly ReplayResult[];
  readonly pending?: PendingCapability;
}

interface RuntimeState {
  readonly version: 1;
  readonly generation: number;
  readonly host: Readonly<{ name: string; version: string }>;
  readonly limits: RuntimeLimits;
  readonly activeCapabilities: readonly string[];
  readonly call?: StoredCall;
}

export function defineRuntime<const Definition extends PluginDefinition>(
  plugin: DefinedPlugin<Definition>,
  input: BoundRuntimeDefinitionInput<Definition>,
): Readonly<RuntimeDefinition>;
export function defineRuntime(input: RuntimeDefinitionInput): Readonly<RuntimeDefinition>;
export function defineRuntime(
  pluginOrInput: DefinedPlugin | RuntimeDefinitionInput,
  boundInput?: BoundRuntimeDefinitionInput<PluginDefinition>,
): Readonly<RuntimeDefinition> {
  const input: RuntimeDefinitionInput =
    boundInput === undefined
      ? (pluginOrInput as RuntimeDefinitionInput)
      : {
          name: (pluginOrInput as DefinedPlugin).name,
          version: (pluginOrInput as DefinedPlugin).version,
          transport: (pluginOrInput as DefinedPlugin).runtime.transport,
          capabilities: (pluginOrInput as DefinedPlugin).runtime.capabilities,
          resolvers: boundInput.resolvers,
        };
  if (!/^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/.test(input.name))
    throw new TypeError("Runtime name must be a lowercase plugin name");
  if (typeof input.version !== "string" || input.version.trim() === "")
    throw new TypeError("Runtime version must be non-empty");
  const resolvers = Object.freeze({ ...input.resolvers });
  if (Object.keys(resolvers).length === 0) throw new TypeError("Runtime requires a resolver");
  for (const [name, resolver] of Object.entries(resolvers)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(name))
      throw new TypeError(`Invalid resolver name ${JSON.stringify(name)}`);
    if (typeof resolver !== "function") throw new TypeError(`Resolver ${name} must be a function`);
  }
  return Object.freeze({
    name: input.name,
    version: input.version,
    transport: input.transport ?? "jsonl",
    capabilities: Object.freeze([...new Set(input.capabilities ?? [])].sort()),
    resolvers,
  });
}

export default defineRuntime;

export function runtimeEntrypointSource(runtimeImport: string): string {
  if (!/^\.\.?\/[A-Za-z0-9._/-]+\.(?:ts|tsx|mts|cts)$/.test(runtimeImport))
    throw new TypeError("Runtime import must be a relative TypeScript module path");
  return [
    `import runtime from ${JSON.stringify(runtimeImport)};`,
    'import { runRuntime } from "polici/runtime-sdk";',
    "",
    "await runRuntime(runtime);",
    "",
  ].join("\n");
}

/** Executes one host exchange. A generated ScriptC entrypoint calls this with the default export. */
export async function runRuntime(definition: RuntimeDefinition): Promise<void> {
  try {
    const request = decodeHostMessage(new Uint8Array(readFileSync(0)), definition.transport);
    const response = await handleRuntimeMessage(definition, request);
    process.stdout.write(encodeRuntimeMessage(response, definition.transport));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}

/** ScriptC build boundary: transports one complete framed exchange as base64. */
export async function runRuntimeExchange(
  definition: RuntimeDefinition,
  inputBase64: string,
): Promise<string> {
  const input = new Uint8Array(Buffer.from(inputBase64, "base64"));
  const request = decodeHostMessage(input, definition.transport);
  const response = await handleRuntimeMessage(definition, request);
  return Buffer.from(encodeRuntimeMessage(response, definition.transport)).toString("base64");
}

export async function handleRuntimeMessage(
  definition: RuntimeDefinition,
  request: HostMessage,
): Promise<RuntimeMessage> {
  assertHostMessage(request);
  if (request.type === "initialize") return initialize(definition, request);
  const state = decodeState(request.continuation);
  if (request.type === "shutdown")
    return checked({ protocol: RUNTIME_PROTOCOL, type: "stopped", id: request.id });
  if (request.type === "call") {
    if (state.call !== undefined)
      return errorResponse(
        request.id,
        state,
        "INVALID_CONTINUATION",
        "invalid-request",
        "A resolver call is already active.",
      );
    return executeCall(definition, request, {
      ...state,
      call: {
        id: request.id,
        resolver: request.resolver,
        arguments: request.arguments,
        ...(request.subject === undefined ? {} : { subject: request.subject }),
        deadlineUnixMs: request.deadlineUnixMs,
        replay: [],
      },
    });
  }
  return resumeCapability(definition, request, state);
}

function initialize(
  definition: RuntimeDefinition,
  request: Extract<HostMessage, { type: "initialize" }>,
): RuntimeMessage {
  if (request.plugin.name !== definition.name || request.plugin.version !== definition.version)
    return checked({
      protocol: RUNTIME_PROTOCOL,
      type: "error",
      id: request.id,
      error: makeRuntimeError(
        "RUNTIME_IMPLEMENTATION_MISMATCH",
        "invalid-request",
        `Host requested ${request.plugin.name}@${request.plugin.version}, runtime is ${definition.name}@${definition.version}.`,
      ),
    });
  const offered = new Set(request.capabilities.map(({ name }) => name));
  const activeCapabilities = definition.capabilities.filter((name) => offered.has(name));
  const state: RuntimeState = {
    version: 1,
    generation: 1,
    host: request.host,
    limits: request.limits,
    activeCapabilities,
  };
  return checked({
    protocol: RUNTIME_PROTOCOL,
    type: "initialized",
    id: request.id,
    implementation: { name: definition.name, version: definition.version },
    capabilities: activeCapabilities,
    continuation: encodeState(state),
  });
}

async function resumeCapability(
  definition: RuntimeDefinition,
  request: CapabilityResultRequest,
  state: RuntimeState,
): Promise<RuntimeMessage> {
  const call = state.call;
  const pending = call?.pending;
  if (
    call === undefined ||
    pending === undefined ||
    call.id !== request.id ||
    pending.requestId !== request.requestId ||
    pending.sequence !== request.sequence
  )
    return errorResponse(
      request.id,
      state,
      "INVALID_CONTINUATION",
      "invalid-request",
      "Capability result does not match the pending call.",
    );
  const replay: ReplayResult = {
    capability: pending.capability,
    operation: pending.operation,
    arguments: pending.arguments,
    ...(request.result === undefined ? {} : { result: request.result }),
    ...(request.error === undefined ? {} : { error: request.error }),
  };
  return executeCall(
    definition,
    {
      protocol: RUNTIME_PROTOCOL,
      type: "call",
      id: call.id,
      resolver: call.resolver,
      arguments: call.arguments,
      ...(call.subject === undefined ? {} : { subject: call.subject }),
      continuation: request.continuation,
      deadlineUnixMs: call.deadlineUnixMs,
    },
    {
      ...state,
      call: { ...call, replay: [...call.replay, replay], pending: undefined },
    },
  );
}

async function executeCall(
  definition: RuntimeDefinition,
  request: Extract<HostMessage, { type: "call" }>,
  state: RuntimeState,
): Promise<RuntimeMessage> {
  const resolver = definition.resolvers[request.resolver];
  if (resolver === undefined)
    return errorResponse(
      request.id,
      state,
      "RESOLVER_NOT_FOUND",
      "resolver",
      `Unknown resolver ${request.resolver}.`,
    );
  const call = state.call!;
  let replayIndex = 0;
  let pending: PendingCapability | undefined;
  let markPending: (() => void) | undefined;
  const pendingSignal = new Promise<"pending">(
    (resolve) => (markPending = () => resolve("pending")),
  );
  const context: RuntimeResolverContext = Object.freeze({
    plugin: Object.freeze({ name: definition.name, version: definition.version }),
    host: state.host,
    limits: state.limits,
    ...(request.subject === undefined ? {} : { subject: decodeRuntimeValue(request.subject) }),
    core: runtimeCore,
    value: runtimeValue,
    capability(name: string): RuntimeCapabilityClient {
      if (!state.activeCapabilities.includes(name))
        throw new RuntimeResolverError(
          "CAPABILITY_UNAVAILABLE",
          "capability",
          `Capability ${name} is not active.`,
        );
      return {
        call(operation, arguments_ = {}, options = {}) {
          const encoded = encodeArguments(arguments_);
          const replay = call.replay[replayIndex];
          if (replay !== undefined) {
            replayIndex += 1;
            if (
              replay.capability !== name ||
              replay.operation !== operation ||
              canonical(replay.arguments) !== canonical(encoded)
            )
              return Promise.reject(
                new RuntimeResolverError(
                  "CAPABILITY_REPLAY_MISMATCH",
                  "invalid-request",
                  "Resolver capability calls changed during replay.",
                ),
              );
            return replay.error === undefined
              ? Promise.resolve(decodeRuntimeValue(replay.result!))
              : Promise.reject(new RuntimeCapabilityError(replay.error));
          }
          if (pending !== undefined)
            return Promise.reject(
              new RuntimeResolverError(
                "CAPABILITY_CONCURRENT",
                "invalid-request",
                "Await each capability call before starting another.",
              ),
            );
          const sequence = replayIndex + 1;
          pending = {
            capability: name,
            operation,
            arguments: encoded,
            requestId: `${request.id}-capability-${sequence}`,
            sequence,
            ...(options.deadlineUnixMs === undefined
              ? {}
              : { deadlineUnixMs: options.deadlineUnixMs }),
          };
          markPending!();
          return new Promise<RuntimeValue>(() => undefined);
        },
      };
    },
  });
  const execution = Promise.resolve()
    .then(() => resolver(context, decodeArguments(request.arguments)))
    .then(
      (value) => ({ type: "result" as const, value }),
      (error) => ({ type: "error" as const, error }),
    );
  const outcome = await Promise.race([execution, pendingSignal]);
  if (outcome === "pending") {
    const next = incrementState(state, { ...call, pending });
    return checked({
      protocol: RUNTIME_PROTOCOL,
      type: "capability-call",
      id: request.id,
      requestId: pending!.requestId,
      sequence: pending!.sequence,
      capability: pending!.capability,
      operation: pending!.operation,
      arguments: pending!.arguments,
      continuation: encodeState(next),
      ...(pending!.deadlineUnixMs === undefined ? {} : { deadlineUnixMs: pending!.deadlineUnixMs }),
    });
  }
  if (replayIndex !== call.replay.length)
    return errorResponse(
      request.id,
      state,
      "CAPABILITY_REPLAY_MISMATCH",
      "invalid-request",
      "Resolver did not replay all capability calls.",
    );
  if (outcome.type === "error") return thrownError(request.id, state, outcome.error);
  return checked({
    protocol: RUNTIME_PROTOCOL,
    type: "result",
    id: request.id,
    value: encodeRuntimeValue(outcome.value),
    continuation: encodeState(incrementState(state)),
  });
}

function thrownError(id: string, state: RuntimeState, error: unknown): RuntimeMessage {
  if (error instanceof RuntimeResolverError)
    return errorResponse(id, state, error.code, error.kind, error.message, {
      retryable: error.options.retryable,
      ...(error.options.details === undefined
        ? {}
        : { details: encodeRuntimeValue(error.options.details) }),
    });
  return errorResponse(
    id,
    state,
    "RESOLVER_INTERNAL",
    "internal",
    error instanceof Error ? error.message : "Resolver failed.",
  );
}

function errorResponse(
  id: string,
  state: RuntimeState,
  code: string,
  kind: RuntimeError["kind"],
  message: string,
  options: { readonly retryable?: boolean; readonly details?: WireValue } = {},
): RuntimeMessage {
  return checked({
    protocol: RUNTIME_PROTOCOL,
    type: "error",
    id,
    error: makeRuntimeError(code, kind, message, options),
    continuation: encodeState(incrementState(state)),
  });
}

function makeRuntimeError(
  code: string,
  kind: RuntimeError["kind"],
  message: string,
  options: { readonly retryable?: boolean; readonly details?: WireValue } = {},
): RuntimeError {
  return {
    code,
    kind,
    message,
    retryable: options.retryable ?? false,
    ...(options.details === undefined ? {} : { details: options.details }),
  };
}

function incrementState(state: RuntimeState, call?: StoredCall): RuntimeState {
  return {
    ...state,
    generation: state.generation + 1,
    ...(call === undefined ? { call: undefined } : { call }),
  };
}

function encodeState(state: RuntimeState): string {
  const token = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  if (token.length > state.limits.maxContinuationBytes)
    throw new RuntimeResolverError(
      "PROTOCOL_CONTINUATION_LIMIT",
      "internal",
      `Continuation exceeds ${state.limits.maxContinuationBytes} bytes.`,
    );
  return token;
}

function decodeState(token: string): RuntimeState {
  try {
    const value = JSON.parse(
      Buffer.from(token, "base64url").toString("utf8"),
    ) as Partial<RuntimeState>;
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.generation) ||
      value.limits === undefined ||
      value.host === undefined ||
      !Array.isArray(value.activeCapabilities)
    )
      throw new Error("unsupported state");
    return value as RuntimeState;
  } catch (error) {
    throw new RuntimeResolverError(
      "INVALID_CONTINUATION",
      "invalid-request",
      "Continuation is not valid runtime state.",
      { cause: error },
    );
  }
}

export function encodeRuntimeValue(value: RuntimeValue | undefined): WireValue {
  if (value === undefined || value === runtimeMissing) return wire.missing();
  if (value === null) return wire.null();
  if (typeof value === "boolean") return wire.boolean(value);
  if (typeof value === "string") return wire.string(value);
  if (typeof value === "bigint") return wire.integer(value.toString());
  if (typeof value === "number")
    return Number.isInteger(value) ? wire.integer(value) : wire.number(value);
  if (value instanceof Uint8Array) return wire.bytes(Buffer.from(value).toString("base64"));
  if (value instanceof RuntimeEntity)
    return wire.entity(
      value.type,
      value.identity.namespace,
      value.identity.value,
      encodeArguments(value.fields),
    );
  if (Array.isArray(value)) return wire.list(value.map(encodeRuntimeValue));
  if (value instanceof Set) return wire.set([...value].map(encodeRuntimeValue));
  const validated = validateWireValue(value);
  if (validated.ok) return validated.value;
  return wire.map(encodeArguments(value as Readonly<Record<string, RuntimeValue>>));
}

export function decodeRuntimeValue(value: WireValue): RuntimeValue {
  switch (value.tag) {
    case "missing":
      return runtimeMissing;
    case "null":
      return null;
    case "boolean":
    case "string":
    case "number":
      return value.value;
    case "integer": {
      const number = Number(value.value);
      return Number.isSafeInteger(number) ? number : BigInt(value.value);
    }
    case "bytes":
      return new Uint8Array(Buffer.from(value.value, "base64"));
    case "id":
      return Object.freeze({ namespace: value.namespace, value: value.value });
    case "list":
      return Object.freeze(value.items.map(decodeRuntimeValue));
    case "set":
      return new Set(value.items.map(decodeRuntimeValue));
    case "map":
      return Object.freeze(
        Object.fromEntries(
          Object.entries(value.entries).map(([name, item]) => [name, decodeRuntimeValue(item)]),
        ),
      );
    case "entity":
      return new RuntimeEntity(
        value.type,
        value.identity,
        Object.fromEntries(
          Object.entries(value.fields).map(([name, item]) => [name, decodeRuntimeValue(item)]),
        ),
      );
  }
}

function encodeArguments(
  values: Readonly<Record<string, RuntimeValue>>,
): Readonly<Record<string, WireValue>> {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, encodeRuntimeValue(value)]),
  );
}

function decodeArguments(
  values: Readonly<Record<string, WireValue>>,
): Readonly<Record<string, RuntimeValue>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(values).map(([name, value]) => [name, decodeRuntimeValue(value)]),
    ),
  );
}

export const runtimeValue = Object.freeze({
  id: wire.id,
  entity(
    type: string,
    identity: Readonly<{ namespace: string; value: string }>,
    fields: Readonly<Record<string, RuntimeValue>>,
  ): WireValue {
    return wire.entity(type, identity.namespace, identity.value, encodeArguments(fields));
  },
  list(values: readonly RuntimeValue[]): WireValue {
    return wire.list(values.map(encodeRuntimeValue));
  },
  set(values: readonly RuntimeValue[]): WireValue {
    return wire.set(values.map(encodeRuntimeValue));
  },
});

export const runtimeCore = Object.freeze({
  check(
    name: string,
    status: "missing" | "pending" | "passed" | "failed" | "cancelled",
    options: { summary?: string; url?: string; identity?: string } = {},
  ): WireValue {
    return wire.entity("core:Check", "polici:check", options.identity ?? `${name}:${status}`, {
      name: wire.string(name),
      status: wire.string(status),
      ...(options.summary === undefined ? {} : { summary: wire.string(options.summary) }),
      ...(options.url === undefined ? {} : { url: wire.string(options.url) }),
    });
  },
  file(path: string, content: string | Uint8Array): WireValue {
    return wire.entity("core:File", "polici:file", path, {
      path: wire.string(path),
      content:
        typeof content === "string"
          ? wire.string(content)
          : wire.bytes(Buffer.from(content).toString("base64")),
    });
  },
  changeSet(changes: readonly WireValue[], identity = "runtime"): WireValue {
    return wire.entity("core:ChangeSet", "polici:change-set", identity, {
      changes: wire.list(changes),
    });
  },
});

function decodeHostMessage(input: Uint8Array, transport: PluginTransport): HostMessage {
  let payload = input;
  if (transport === "length-prefixed") {
    if (input.length < 4) throw new SyntaxError("Missing frame header");
    const length = input[0]! * 16_777_216 + input[1]! * 65_536 + input[2]! * 256 + input[3]!;
    if (length !== input.length - 4) throw new SyntaxError("Invalid frame length");
    payload = input.subarray(4);
  } else if (input[input.length - 1] === 0x0a) payload = input.subarray(0, input.length - 1);
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as unknown;
  const validated = validateHostMessage(parsed);
  if (!validated.ok)
    throw new TypeError(
      `Invalid host message: ${validated.issues.map(({ message }) => message).join("; ")}`,
    );
  return validated.value;
}

function encodeRuntimeMessage(message: RuntimeMessage, transport: PluginTransport): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  if (transport === "jsonl") {
    const result = new Uint8Array(payload.length + 1);
    result.set(payload);
    result[payload.length] = 0x0a;
    return result;
  }
  const result = new Uint8Array(payload.length + 4);
  const length = payload.length;
  result[0] = Math.floor(length / 16_777_216) % 256;
  result[1] = Math.floor(length / 65_536) % 256;
  result[2] = Math.floor(length / 256) % 256;
  result[3] = length % 256;
  result.set(payload, 4);
  return result;
}

function assertHostMessage(message: HostMessage): void {
  const result = validateHostMessage(message);
  if (!result.ok)
    throw new TypeError(
      `Invalid host message: ${result.issues.map(({ message }) => message).join("; ")}`,
    );
}

function checked(message: RuntimeMessage): RuntimeMessage {
  const result = validateRuntimeMessage(message);
  if (!result.ok)
    throw new TypeError(
      `Invalid runtime message: ${result.issues.map(({ message }) => message).join("; ")}`,
    );
  return result.value;
}

function canonical(value: Readonly<Record<string, WireValue>>): string {
  return canonicalStringify(value as unknown as JsonValue);
}
