import { canonicalStringify, type JsonValue } from "./json.js";
import type { RuntimeCapability, RuntimeError } from "./protocol.js";
import { validateWireValue, type WireValue } from "./wire.js";
import { assertValid, childPath, ValidationContext, type ValidationResult } from "./validation.js";

export interface CapabilityRequest {
  readonly id: string;
  readonly callId: string;
  readonly sequence: number;
  readonly capability: string;
  readonly operation: string;
  readonly arguments: Readonly<Record<string, WireValue>>;
  readonly grant: RuntimeCapability;
  readonly deadlineUnixMs: number;
  readonly signal: AbortSignal;
}

export type CapabilityResult =
  | { readonly ok: true; readonly value: WireValue }
  | { readonly ok: false; readonly error: RuntimeError };

/** Owns all credentials and privileged data used to service runtime requests. */
export type CapabilityBroker = (request: CapabilityRequest) => Promise<CapabilityResult>;

export interface ResolverRequest {
  readonly resolver: string;
  readonly arguments: Readonly<Record<string, WireValue>>;
  readonly subject?: WireValue;
}

export interface ResolverCallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface ResolverHost {
  readonly capabilities: readonly RuntimeCapability[];
  resolve(request: ResolverRequest, options?: ResolverCallOptions): Promise<WireValue>;
  dispose?(): void | Promise<void>;
}

const RESOLVER_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export function validateResolverRequest(value: unknown): ValidationResult<ResolverRequest> {
  const context = new ValidationContext();
  const path = "$request";
  if (!context.record(value, path)) return context.result(value as ResolverRequest);
  context.keys(value, path, ["resolver", "arguments", "subject"]);
  context.required(value, path, ["resolver", "arguments"]);
  context.string(value.resolver, childPath(path, "resolver"), RESOLVER_NAME);
  if (context.record(value.arguments, childPath(path, "arguments"))) {
    for (const [name, argument] of Object.entries(value.arguments)) {
      const result = validateWireValue(argument, childPath(childPath(path, "arguments"), name));
      if (!result.ok) context.issues.push(...result.issues);
    }
  }
  if (value.subject !== undefined) {
    const result = validateWireValue(value.subject, childPath(path, "subject"));
    if (!result.ok) context.issues.push(...result.issues);
  }
  return context.result(value as unknown as ResolverRequest);
}

export function assertValidResolverRequest(value: unknown): ResolverRequest {
  return assertValid("Resolver request", validateResolverRequest(value));
}

export type ResolverFunction = (
  request: ResolverRequest,
  options: ResolverCallOptions,
) => WireValue | Promise<WireValue>;

export class ResolverFault extends Error {
  readonly code: string;
  readonly kind:
    | "resolver"
    | "permission"
    | "capability"
    | "protocol"
    | "timeout"
    | "cancelled"
    | "process";
  readonly retryable: boolean;
  readonly details?: WireValue;

  constructor(
    code: string,
    kind: ResolverFault["kind"],
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly details?: WireValue;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "ResolverFault";
    this.code = code;
    this.kind = kind;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export class FunctionResolverHost implements ResolverHost {
  readonly capabilities: readonly RuntimeCapability[];
  readonly #resolvers: Readonly<Record<string, unknown>>;

  constructor(
    resolvers: Readonly<Record<string, ResolverFunction>>,
    capabilities: readonly RuntimeCapability[] = [],
  ) {
    this.#resolvers = resolvers as Readonly<Record<string, unknown>>;
    this.capabilities = capabilities;
  }

  async resolve(request: ResolverRequest, options: ResolverCallOptions = {}): Promise<WireValue> {
    request = assertValidResolverRequest(request);
    if (options.signal?.aborted) throw options.signal.reason;
    const resolver = (this.#resolvers as Readonly<Record<string, ResolverFunction>>)[
      request.resolver
    ];
    if (!resolver)
      throw new ResolverFault(
        "RESOLVER_NOT_FOUND",
        "resolver",
        `Unknown resolver ${request.resolver}`,
      );
    return resolver(request, options);
  }
}

export class LazyMemoizingResolverHost implements ResolverHost {
  readonly capabilities: readonly RuntimeCapability[];
  readonly #factory: () => ResolverHost | Promise<ResolverHost>;
  readonly #values = new Map<string, Promise<WireValue>>();
  #host?: Promise<ResolverHost>;

  constructor(
    factory: () => ResolverHost | Promise<ResolverHost>,
    capabilities: readonly RuntimeCapability[] = [],
  ) {
    this.#factory = factory;
    this.capabilities = capabilities;
  }

  resolve(request: ResolverRequest, options: ResolverCallOptions = {}): Promise<WireValue> {
    request = assertValidResolverRequest(request);
    if (options.signal || options.timeoutMs !== undefined)
      return this.#getHost().then((host) => host.resolve(request, options));
    const key = canonicalStringify(request as unknown as JsonValue);
    let result = this.#values.get(key);
    if (!result) {
      result = this.#getHost().then((host) => host.resolve(request, options));
      this.#values.set(key, result);
      void result.catch(() => {
        if (this.#values.get(key) === result) this.#values.delete(key);
      });
    }
    return result;
  }

  clear(): void {
    this.#values.clear();
  }

  async dispose(): Promise<void> {
    this.clear();
    if (this.#host) await (await this.#host).dispose?.();
  }

  #getHost(): Promise<ResolverHost> {
    if (!this.#host) {
      const host = Promise.resolve().then(this.#factory);
      this.#host = host;
      void host.catch(() => {
        if (this.#host === host) this.#host = undefined;
      });
    }
    return this.#host;
  }
}
