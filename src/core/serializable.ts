import { sha256 } from "./hash.js";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;
export type JsonArray = readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface JsonSerializable {
  toJSON(): JsonValue;
}

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class CanonicalJsonError extends TypeError {
  readonly path: string;

  constructor(message: string, path = "$") {
    super(`${message} at ${path}`);
    this.name = "CanonicalJsonError";
    this.path = path;
  }
}

function quoted(value: string): string {
  const result = JSON.stringify(value);
  if (result === undefined) throw new CanonicalJsonError("Could not serialize string");
  return result;
}

function childPath(parent: string, key: string): string {
  return `${parent}[${quoted(key)}]`;
}

function serializeCanonical(value: unknown, path: string, ancestors: object[]): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return quoted(value);
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError("Non-finite numbers are not JSON values", path);
      }
      if (Object.is(value, -0)) return "0";
      const result = JSON.stringify(value);
      if (result === undefined) throw new CanonicalJsonError("Could not serialize number", path);
      return result;
    }
    case "undefined":
    case "bigint":
    case "function":
    case "symbol":
      throw new CanonicalJsonError(`Unsupported ${typeof value} value`, path);
    case "object":
      break;
  }

  const object = value as object;
  if (ancestors.includes(object)) throw new CanonicalJsonError("Circular value", path);
  ancestors.push(object);

  try {
    if (Array.isArray(value)) {
      const values = value as unknown[];
      const parts: string[] = [];
      for (let index = 0; index < values.length; index += 1) {
        if (!(index in values))
          throw new CanonicalJsonError("Sparse arrays are not JSON values", `${path}[${index}]`);
        parts.push(serializeCanonical(values[index], `${path}[${index}]`, ancestors));
      }
      return `[${parts.join(",")}]`;
    }

    const keys = Object.keys(value as Record<string, unknown>).sort(compareCodeUnits);
    const parts: string[] = [];
    for (const key of keys) {
      const propertyPath = childPath(path, key);
      const property = (value as Record<string, unknown>)[key];
      if (property === undefined) continue;
      parts.push(`${quoted(key)}:${serializeCanonical(property, propertyPath, ancestors)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    ancestors.pop();
  }
}

/** Stable JSON with recursively sorted object keys and strict JSON values. */
export function canonicalJson(value: unknown): string {
  return serializeCanonical(value, "$", []);
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

export function canonicalSha256(value: unknown): string {
  return sha256(canonicalJson(value));
}
