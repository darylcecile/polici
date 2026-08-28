import { childPath, ValidationContext, type ValidationResult } from "./validation.js";
import { canonicalJson, compareCodeUnits } from "../core/serializable.js";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export { compareCodeUnits };

export function validateJsonValue(value: unknown, path = "$json"): ValidationResult<JsonValue> {
  const context = new ValidationContext();
  validateJson(value, path, context, []);
  return context.result(value as JsonValue);
}

function validateJson(
  value: unknown,
  path: string,
  context: ValidationContext,
  ancestors: object[],
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) context.issue(path, "finite", "JSON numbers must be finite");
    return;
  }
  if (typeof value !== "object") {
    context.issue(path, "type", "expected a JSON-compatible value");
    return;
  }
  if (ancestors.includes(value)) {
    context.issue(path, "cycle", "JSON values cannot contain cycles");
    return;
  }
  ancestors.push(value);
  if (Array.isArray(value)) {
    if (!context.array(value, path)) {
      ancestors.pop();
      return;
    }
    for (let index = 0; index < value.length; index += 1) {
      validateJson(value[index], childPath(path, index), context, ancestors);
    }
  } else {
    if (!context.record(value, path)) {
      ancestors.pop();
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      validateJson(item, childPath(path, key), context, ancestors);
    }
  }
  ancestors.pop();
}

export function canonicalizeJson<T extends JsonValue>(value: T): T {
  const validation = validateJsonValue(value);
  if (!validation.ok) {
    throw new TypeError(
      validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"),
    );
  }
  return canonicalize(value) as T;
}

function canonicalize(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") {
    return typeof value === "number" && Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort(compareCodeUnits))
    result[key] = canonicalize(value[key]!);
  return result;
}

export function canonicalStringify(value: JsonValue): string;
export function canonicalStringify(value: unknown): string;
export function canonicalStringify(value: unknown): string {
  const validation = validateJsonValue(value);
  if (!validation.ok) {
    throw new TypeError(
      validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"),
    );
  }
  return canonicalJson(value);
}

export function deepFreezeJson<T extends JsonValue>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const item of Array.isArray(value) ? value : Object.values(value)) deepFreezeJson(item);
    Object.freeze(value);
  }
  return value;
}
