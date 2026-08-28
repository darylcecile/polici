import { assertValid, childPath, ValidationContext, type ValidationResult } from "./validation.js";
import { validateWireValue, type WireValue } from "./wire.js";

export const RUNTIME_PROTOCOL = "polici.runtime/v1" as const;
export const RUNTIME_PROTOCOL_VERSION = 1 as const;

export interface RuntimeCapability {
  readonly name: string;
  readonly operations: readonly string[];
  readonly description?: string;
  /** Non-secret host policy describing the resources covered by this grant. */
  readonly scope?: WireValue;
  readonly maxCalls?: number;
}

export interface RuntimeLimits {
  readonly maxFrameBytes: number;
  readonly maxMessageBytes: number;
  readonly maxOutputBytes: number;
  readonly maxLogBytes: number;
  readonly maxContinuationBytes: number;
  readonly maxCapabilityCalls: number;
}

export interface RuntimeError {
  readonly code: string;
  readonly kind:
    | "resolver"
    | "permission"
    | "capability"
    | "invalid-request"
    | "unavailable"
    | "timeout"
    | "cancelled"
    | "internal";
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: WireValue;
}

export interface InitializeRequest {
  readonly protocol: typeof RUNTIME_PROTOCOL;
  readonly type: "initialize";
  readonly id: string;
  readonly host: { readonly name: string; readonly version: string };
  readonly plugin: { readonly name: string; readonly version: string };
  readonly capabilities: readonly RuntimeCapability[];
  readonly limits: RuntimeLimits;
}

export interface CallRequest {
  readonly protocol: typeof RUNTIME_PROTOCOL;
  readonly type: "call";
  readonly id: string;
  readonly resolver: string;
  readonly arguments: Readonly<Record<string, WireValue>>;
  readonly subject?: WireValue;
  readonly continuation: string;
  readonly deadlineUnixMs: number;
}

export interface ShutdownRequest {
  readonly protocol: typeof RUNTIME_PROTOCOL;
  readonly type: "shutdown";
  readonly id: string;
  readonly continuation: string;
}

export interface CapabilityResultRequest {
  readonly protocol: typeof RUNTIME_PROTOCOL;
  readonly type: "capability-result";
  readonly id: string;
  readonly requestId: string;
  readonly sequence: number;
  readonly continuation: string;
  readonly result?: WireValue;
  readonly error?: RuntimeError;
}

export type HostMessage =
  | InitializeRequest
  | CallRequest
  | ShutdownRequest
  | CapabilityResultRequest;

export interface InitializedResponse {
  readonly protocol: typeof RUNTIME_PROTOCOL;
  readonly type: "initialized";
  readonly id: string;
  readonly implementation: { readonly name: string; readonly version: string };
  readonly capabilities: readonly string[];
  readonly continuation: string;
}

export interface ResultResponse {
  readonly protocol: typeof RUNTIME_PROTOCOL;
  readonly type: "result";
  readonly id: string;
  readonly value: WireValue;
  readonly continuation: string;
}

export interface ErrorResponse {
  readonly protocol: typeof RUNTIME_PROTOCOL;
  readonly type: "error";
  readonly id: string;
  readonly error: RuntimeError;
  readonly continuation?: string;
}

export interface CapabilityCallResponse {
  readonly protocol: typeof RUNTIME_PROTOCOL;
  readonly type: "capability-call";
  readonly id: string;
  readonly requestId: string;
  readonly sequence: number;
  readonly capability: string;
  readonly operation: string;
  readonly arguments: Readonly<Record<string, WireValue>>;
  readonly continuation: string;
  readonly deadlineUnixMs?: number;
}

export interface StoppedResponse {
  readonly protocol: typeof RUNTIME_PROTOCOL;
  readonly type: "stopped";
  readonly id: string;
}

export type RuntimeMessage =
  | InitializedResponse
  | ResultResponse
  | ErrorResponse
  | CapabilityCallResponse
  | StoppedResponse;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const CAPABILITY = /^[a-z][a-z0-9]*(?::[a-z][a-z0-9-]*)+$/;
const CONTINUATION = /^[A-Za-z0-9._~+/=-]+$/;

export function validateHostMessage(value: unknown): ValidationResult<HostMessage> {
  return validateMessage<HostMessage>(value, "host");
}

export function validateRuntimeMessage(value: unknown): ValidationResult<RuntimeMessage> {
  return validateMessage<RuntimeMessage>(value, "runtime");
}

export function parseRuntimeMessage(text: string): RuntimeMessage {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new SyntaxError(
      `Runtime message is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return assertValid("Runtime message", validateRuntimeMessage(value));
}

function validateMessage<T extends HostMessage | RuntimeMessage>(
  value: unknown,
  direction: "host" | "runtime",
): ValidationResult<T> {
  const context = new ValidationContext();
  const path = "$message";
  if (!context.record(value, path)) return context.result(value as T);
  if (value.protocol !== RUNTIME_PROTOCOL)
    context.issue(`${path}.protocol`, "const", `expected ${JSON.stringify(RUNTIME_PROTOCOL)}`);
  context.string(value.id, `${path}.id`, ID);
  const base = ["protocol", "type", "id"];
  const type = typeof value.type === "string" ? value.type : "";
  if (direction === "host") {
    switch (type) {
      case "initialize":
        context.keys(value, path, [...base, "host", "plugin", "capabilities", "limits"]);
        context.required(value, path, [...base, "host", "plugin", "capabilities", "limits"]);
        validateImplementation(value.host, `${path}.host`, context);
        validateImplementation(value.plugin, `${path}.plugin`, context);
        validateCapabilities(value.capabilities, `${path}.capabilities`, context);
        validateLimits(value.limits, `${path}.limits`, context);
        break;
      case "call":
        context.keys(value, path, [
          ...base,
          "resolver",
          "arguments",
          "subject",
          "continuation",
          "deadlineUnixMs",
        ]);
        context.required(value, path, [
          ...base,
          "resolver",
          "arguments",
          "continuation",
          "deadlineUnixMs",
        ]);
        context.string(value.resolver, `${path}.resolver`, NAME);
        validateWireMap(value.arguments, `${path}.arguments`, context);
        if (value.subject !== undefined)
          mergeWireValidation(value.subject, `${path}.subject`, context);
        validateContinuation(value.continuation, `${path}.continuation`, context);
        context.integer(value.deadlineUnixMs, `${path}.deadlineUnixMs`, 1);
        break;
      case "shutdown":
        context.keys(value, path, [...base, "continuation"]);
        context.required(value, path, [...base, "continuation"]);
        validateContinuation(value.continuation, `${path}.continuation`, context);
        break;
      case "capability-result":
        context.keys(value, path, [
          ...base,
          "requestId",
          "sequence",
          "continuation",
          "result",
          "error",
        ]);
        context.required(value, path, [...base, "requestId", "sequence", "continuation"]);
        context.string(value.requestId, `${path}.requestId`, ID);
        context.integer(value.sequence, `${path}.sequence`, 1);
        validateContinuation(value.continuation, `${path}.continuation`, context);
        if ((value.result === undefined) === (value.error === undefined))
          context.issue(path, "union", "exactly one of result or error is required");
        if (value.result !== undefined)
          mergeWireValidation(value.result, `${path}.result`, context);
        if (value.error !== undefined) validateRuntimeError(value.error, `${path}.error`, context);
        break;
      default:
        context.issue(`${path}.type`, "enum", `unknown host message type ${JSON.stringify(type)}`);
    }
  } else {
    switch (type) {
      case "initialized":
        context.keys(value, path, [...base, "implementation", "capabilities", "continuation"]);
        context.required(value, path, [...base, "implementation", "capabilities", "continuation"]);
        validateImplementation(value.implementation, `${path}.implementation`, context);
        validateStringArray(value.capabilities, `${path}.capabilities`, context, CAPABILITY);
        validateContinuation(value.continuation, `${path}.continuation`, context);
        break;
      case "result":
        context.keys(value, path, [...base, "value", "continuation"]);
        context.required(value, path, [...base, "value", "continuation"]);
        mergeWireValidation(value.value, `${path}.value`, context);
        validateContinuation(value.continuation, `${path}.continuation`, context);
        break;
      case "error":
        context.keys(value, path, [...base, "error", "continuation"]);
        context.required(value, path, [...base, "error"]);
        validateRuntimeError(value.error, `${path}.error`, context);
        if (value.continuation !== undefined)
          validateContinuation(value.continuation, `${path}.continuation`, context);
        break;
      case "capability-call":
        context.keys(value, path, [
          ...base,
          "requestId",
          "sequence",
          "capability",
          "operation",
          "arguments",
          "continuation",
          "deadlineUnixMs",
        ]);
        context.required(value, path, [
          ...base,
          "requestId",
          "sequence",
          "capability",
          "operation",
          "arguments",
          "continuation",
        ]);
        context.string(value.requestId, `${path}.requestId`, ID);
        context.integer(value.sequence, `${path}.sequence`, 1);
        context.string(value.capability, `${path}.capability`, CAPABILITY);
        context.string(value.operation, `${path}.operation`, NAME);
        validateWireMap(value.arguments, `${path}.arguments`, context);
        validateContinuation(value.continuation, `${path}.continuation`, context);
        if (value.deadlineUnixMs !== undefined)
          context.integer(value.deadlineUnixMs, `${path}.deadlineUnixMs`, 1);
        break;
      case "stopped":
        context.keys(value, path, base);
        context.required(value, path, base);
        break;
      default:
        context.issue(
          `${path}.type`,
          "enum",
          `unknown runtime message type ${JSON.stringify(type)}`,
        );
    }
  }
  return context.result(value as unknown as T);
}

function validateImplementation(value: unknown, path: string, context: ValidationContext): void {
  if (!context.record(value, path)) return;
  context.keys(value, path, ["name", "version"]);
  context.required(value, path, ["name", "version"]);
  context.string(value.name, `${path}.name`, NAME);
  context.string(value.version, `${path}.version`);
}

function validateCapabilities(value: unknown, path: string, context: ValidationContext): void {
  if (!context.array(value, path)) return;
  const names = new Set<string>();
  value.forEach((item, index) => {
    const itemPath = childPath(path, index);
    if (!context.record(item, itemPath)) return;
    context.keys(item, itemPath, ["name", "operations", "description", "scope", "maxCalls"]);
    context.required(item, itemPath, ["name", "operations"]);
    if (context.string(item.name, `${itemPath}.name`, CAPABILITY)) {
      if (names.has(item.name))
        context.issue(`${itemPath}.name`, "duplicate", "duplicate capability");
      names.add(item.name);
    }
    validateStringArray(item.operations, `${itemPath}.operations`, context, NAME);
    if (item.description !== undefined) context.string(item.description, `${itemPath}.description`);
    if (item.scope !== undefined) mergeWireValidation(item.scope, `${itemPath}.scope`, context);
    if (item.maxCalls !== undefined) context.integer(item.maxCalls, `${itemPath}.maxCalls`, 1);
  });
}

function validateLimits(value: unknown, path: string, context: ValidationContext): void {
  if (!context.record(value, path)) return;
  const keys = [
    "maxFrameBytes",
    "maxMessageBytes",
    "maxOutputBytes",
    "maxLogBytes",
    "maxContinuationBytes",
    "maxCapabilityCalls",
  ];
  context.keys(value, path, keys);
  context.required(value, path, keys);
  for (const key of keys) context.integer(value[key], `${path}.${key}`, 1);
}

function validateRuntimeError(value: unknown, path: string, context: ValidationContext): void {
  if (!context.record(value, path)) return;
  context.keys(value, path, ["code", "kind", "message", "retryable", "details"]);
  context.required(value, path, ["code", "kind", "message", "retryable"]);
  context.string(value.code, `${path}.code`, /^[A-Z][A-Z0-9_]*$/);
  if (
    ![
      "resolver",
      "permission",
      "capability",
      "invalid-request",
      "unavailable",
      "timeout",
      "cancelled",
      "internal",
    ].includes(value.kind as string)
  )
    context.issue(`${path}.kind`, "enum", "unknown runtime error kind");
  context.string(value.message, `${path}.message`);
  context.boolean(value.retryable, `${path}.retryable`);
  if (value.details !== undefined) mergeWireValidation(value.details, `${path}.details`, context);
}

function validateContinuation(value: unknown, path: string, context: ValidationContext): void {
  if (context.string(value, path, CONTINUATION) && value.length > 16_384)
    context.issue(path, "limit", "continuation exceeds the protocol hard limit");
}

function validateWireMap(value: unknown, path: string, context: ValidationContext): void {
  if (!context.record(value, path)) return;
  for (const [key, item] of Object.entries(value))
    mergeWireValidation(item, childPath(path, key), context);
}

function mergeWireValidation(value: unknown, path: string, context: ValidationContext): void {
  const result = validateWireValue(value, path);
  if (!result.ok) context.issues.push(...result.issues);
}

function validateStringArray(
  value: unknown,
  path: string,
  context: ValidationContext,
  pattern: RegExp,
): void {
  if (!context.array(value, path)) return;
  const found = new Set<string>();
  value.forEach((item, index) => {
    if (!context.string(item, childPath(path, index), pattern)) return;
    if (found.has(item)) context.issue(childPath(path, index), "duplicate", "duplicate value");
    found.add(item);
  });
}
