import { childPath, ValidationContext, type ValidationResult } from "./validation.js";
import { compareCodeUnits } from "./json.js";

export type WireValue =
  | { readonly tag: "null" }
  | { readonly tag: "missing" }
  | { readonly tag: "boolean"; readonly value: boolean }
  | { readonly tag: "string"; readonly value: string }
  | { readonly tag: "number"; readonly value: number }
  | { readonly tag: "integer"; readonly value: string }
  | { readonly tag: "bytes"; readonly encoding: "base64"; readonly value: string }
  | { readonly tag: "id"; readonly namespace: string; readonly value: string }
  | { readonly tag: "list"; readonly items: readonly WireValue[] }
  | { readonly tag: "set"; readonly items: readonly WireValue[] }
  | { readonly tag: "map"; readonly entries: Readonly<Record<string, WireValue>> }
  | {
      readonly tag: "entity";
      readonly type: string;
      readonly identity: { readonly namespace: string; readonly value: string };
      readonly fields: Readonly<Record<string, WireValue>>;
    };

const NAMESPACE = /^[a-z][a-z0-9]*(?::[a-z][a-z0-9-]*)+$/;
const TYPE_NAME = /^(?:[a-z][a-z0-9-]*:)?[A-Za-z_][A-Za-z0-9_]*$/;
const INTEGER = /^(?:0|-?[1-9]\d*)$/;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/;

export interface WireValueLimits {
  readonly depth?: number;
  readonly nodes?: number;
  readonly collectionItems?: number;
  readonly mapEntries?: number;
  readonly stringCodeUnits?: number;
  readonly bytes?: number;
}

interface NormalizedWireValueLimits {
  readonly depth: number;
  readonly nodes: number;
  readonly collectionItems: number;
  readonly mapEntries: number;
  readonly stringCodeUnits: number;
  readonly bytes: number;
}

const DEFAULT_WIRE_LIMITS: NormalizedWireValueLimits = {
  depth: 64,
  nodes: 100_000,
  collectionItems: 10_000,
  mapEntries: 10_000,
  stringCodeUnits: 1_048_576,
  bytes: 16 * 1024 * 1024,
};

export const wire = {
  null: (): WireValue => ({ tag: "null" }),
  missing: (): WireValue => ({ tag: "missing" }),
  boolean: (value: boolean): WireValue => ({ tag: "boolean", value }),
  string: (value: string): WireValue => ({ tag: "string", value }),
  number: (value: number): WireValue => {
    if (!Number.isFinite(value)) throw new TypeError("Wire numbers must be finite");
    return { tag: "number", value: Object.is(value, -0) ? 0 : value };
  },
  integer: (value: number | string): WireValue => {
    const encoded = String(value);
    if (!INTEGER.test(encoded))
      throw new TypeError(`Invalid wire integer ${JSON.stringify(encoded)}`);
    if (typeof value === "number" && !Number.isSafeInteger(value))
      throw new TypeError("Number integer inputs must be safe; pass a bigint or decimal string");
    return { tag: "integer", value: encoded };
  },
  bytes: (base64: string): WireValue => {
    if (!BASE64.test(base64)) throw new TypeError("Invalid base64 wire value");
    return { tag: "bytes", encoding: "base64", value: base64 };
  },
  id: (namespace: string, value: string): WireValue => ({ tag: "id", namespace, value }),
  list: (items: readonly WireValue[]): WireValue => ({ tag: "list", items }),
  set: (items: readonly WireValue[]): WireValue => {
    const encoded = items
      .map((item) => ({
        item,
        canonical: canonicalWireValue(item),
        identity: identityKey(item),
      }))
      .sort((left, right) => compareCodeUnits(left.canonical, right.canonical));
    const identities = new Set<string>();
    for (const item of encoded) {
      if (item.identity && identities.has(item.identity))
        throw new TypeError("Wire sets cannot contain the same entity identity more than once");
      if (item.identity) identities.add(item.identity);
    }
    for (let index = 1; index < encoded.length; index += 1) {
      if (encoded[index - 1]!.canonical === encoded[index]!.canonical)
        throw new TypeError("Wire sets cannot contain duplicate values");
    }
    return { tag: "set", items: encoded.map(({ item }) => item) };
  },
  map: (entries: Readonly<Record<string, WireValue>>): WireValue => ({ tag: "map", entries }),
  entity: (
    type: string,
    namespace: string,
    identity: string,
    fields: Readonly<Record<string, WireValue>>,
  ): WireValue => ({ tag: "entity", type, identity: { namespace, value: identity }, fields }),
} as const;

function canonicalWireValue(value: WireValue): string {
  switch (value.tag) {
    case "null":
    case "missing":
      return `{"tag":${JSON.stringify(value.tag)}}`;
    case "boolean":
      return `{"tag":"boolean","value":${JSON.stringify(value.value)}}`;
    case "number":
      return `{"tag":"number","value":${JSON.stringify(value.value)}}`;
    case "string":
      return `{"tag":"string","value":${JSON.stringify(value.value)}}`;
    case "integer":
      return `{"tag":${JSON.stringify(value.tag)},"value":${JSON.stringify(value.value)}}`;
    case "bytes":
      return `{"encoding":"base64","tag":"bytes","value":${JSON.stringify(value.value)}}`;
    case "id":
      return `{"namespace":${JSON.stringify(value.namespace)},"tag":"id","value":${JSON.stringify(value.value)}}`;
    case "list":
      return `{"items":[${value.items.map(canonicalWireValue).join(",")}],"tag":"list"}`;
    case "set":
      return `{"items":[${value.items.map(canonicalWireValue).join(",")}],"tag":"set"}`;
    case "map":
      return `{"entries":${canonicalWireMap(value.entries)},"tag":"map"}`;
    case "entity":
      return `{"fields":${canonicalWireMap(value.fields)},"identity":{"namespace":${JSON.stringify(value.identity.namespace)},"value":${JSON.stringify(value.identity.value)}},"tag":"entity","type":${JSON.stringify(value.type)}}`;
  }
}

function canonicalWireMap(value: Readonly<Record<string, WireValue>>): string {
  const parts: string[] = [];
  for (const key of Object.keys(value).sort(compareCodeUnits)) {
    parts.push(`${JSON.stringify(key)}:${canonicalWireValue(value[key]!)}`);
  }
  return `{${parts.join(",")}}`;
}

export function validateWireValue(
  value: unknown,
  path = "$value",
  limits: WireValueLimits = {},
): ValidationResult<WireValue> {
  const context = new ValidationContext();
  const normalized = normalizeWireLimits(limits);
  if (validateWireBounds(value, path, context, normalized)) {
    validateWire(value, path, context, []);
  }
  return context.result(value as WireValue);
}

function wireLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${name} must be a non-negative safe integer`);
  return value;
}

function normalizeWireLimits(limits: WireValueLimits): NormalizedWireValueLimits {
  return {
    depth: wireLimit(limits.depth, DEFAULT_WIRE_LIMITS.depth, "limits.depth"),
    nodes: wireLimit(limits.nodes, DEFAULT_WIRE_LIMITS.nodes, "limits.nodes"),
    collectionItems: wireLimit(
      limits.collectionItems,
      DEFAULT_WIRE_LIMITS.collectionItems,
      "limits.collectionItems",
    ),
    mapEntries: wireLimit(limits.mapEntries, DEFAULT_WIRE_LIMITS.mapEntries, "limits.mapEntries"),
    stringCodeUnits: wireLimit(
      limits.stringCodeUnits,
      DEFAULT_WIRE_LIMITS.stringCodeUnits,
      "limits.stringCodeUnits",
    ),
    bytes: wireLimit(limits.bytes, DEFAULT_WIRE_LIMITS.bytes, "limits.bytes"),
  };
}

function validateWireBounds(
  value: unknown,
  path: string,
  context: ValidationContext,
  limits: NormalizedWireValueLimits,
): boolean {
  const pending: {
    readonly value: unknown;
    readonly path: string;
    readonly depth: number;
  }[] = [{ value, path, depth: 0 }];
  const seen: object[] = [];
  let nodes = 0;
  let stringCodeUnits = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > limits.nodes) {
      context.issue(path, "limit", `wire value exceeds the ${limits.nodes} node limit`);
      return false;
    }
    if (current.depth > limits.depth) {
      context.issue(current.path, "limit", `wire value exceeds the ${limits.depth} depth limit`);
      return false;
    }
    if (typeof current.value === "string") {
      stringCodeUnits += current.value.length;
      if (stringCodeUnits > limits.stringCodeUnits) {
        context.issue(
          path,
          "limit",
          `wire strings exceed the ${limits.stringCodeUnits} code-unit limit`,
        );
        return false;
      }
    }
    if (current.value === null || typeof current.value !== "object") continue;
    if (seen.includes(current.value)) {
      context.issue(
        current.path,
        "cycle",
        "wire values cannot contain cycles or shared references",
      );
      return false;
    }
    seen.push(current.value);
    if (Array.isArray(current.value)) {
      if (!context.array(current.value, current.path)) return false;
      if (current.value.length > limits.collectionItems) {
        context.issue(
          current.path,
          "limit",
          `wire collection exceeds the ${limits.collectionItems} item limit`,
        );
        return false;
      }
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pending.push({
          value: current.value[index],
          path: childPath(current.path, index),
          depth: current.depth + 1,
        });
      }
    } else {
      if (!context.record(current.value, current.path)) return false;
      const record = current.value;
      if (
        record.tag === "bytes" &&
        typeof record.value === "string" &&
        decodedBase64Length(record.value) > limits.bytes
      ) {
        context.issue(
          childPath(current.path, "value"),
          "limit",
          `wire bytes exceed the ${limits.bytes} byte limit`,
        );
        return false;
      }
      const keys = Object.keys(current.value);
      if (keys.length > limits.mapEntries) {
        context.issue(
          current.path,
          "limit",
          `wire object exceeds the ${limits.mapEntries} entry limit`,
        );
        return false;
      }
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index]!;
        stringCodeUnits += key.length;
        if (stringCodeUnits > limits.stringCodeUnits) {
          context.issue(
            path,
            "limit",
            `wire strings exceed the ${limits.stringCodeUnits} code-unit limit`,
          );
          return false;
        }
        pending.push({
          value: record[key],
          path: childPath(current.path, key),
          depth: current.depth + 1,
        });
      }
    }
  }
  return true;
}

function decodedBase64Length(value: string): number {
  if (value.length === 0) return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor(value.length / 4) * 3 - padding;
}

function validateWire(
  value: unknown,
  path: string,
  context: ValidationContext,
  ancestors: object[],
): void {
  if (!context.record(value, path)) return;
  if (ancestors.includes(value)) {
    context.issue(path, "cycle", "wire values cannot contain cycles");
    return;
  }
  ancestors.push(value);
  const tag = typeof value.tag === "string" ? value.tag : "";
  switch (tag) {
    case "null":
    case "missing":
      context.keys(value, path, ["tag"]);
      break;
    case "boolean":
      context.keys(value, path, ["tag", "value"]);
      context.required(value, path, ["value"]);
      context.boolean(value.value, childPath(path, "value"));
      break;
    case "string":
      context.keys(value, path, ["tag", "value"]);
      context.required(value, path, ["value"]);
      context.string(value.value, childPath(path, "value"));
      break;
    case "number":
      context.keys(value, path, ["tag", "value"]);
      context.required(value, path, ["value"]);
      if (typeof value.value !== "number" || !Number.isFinite(value.value))
        context.issue(childPath(path, "value"), "finite", "expected a finite number");
      break;
    case "integer":
      context.keys(value, path, ["tag", "value"]);
      context.required(value, path, ["value"]);
      context.string(value.value, childPath(path, "value"), INTEGER);
      break;
    case "bytes":
      context.keys(value, path, ["tag", "encoding", "value"]);
      context.required(value, path, ["encoding", "value"]);
      if (value.encoding !== "base64")
        context.issue(childPath(path, "encoding"), "const", 'expected "base64"');
      context.string(value.value, childPath(path, "value"), BASE64);
      break;
    case "id":
      context.keys(value, path, ["tag", "namespace", "value"]);
      context.required(value, path, ["namespace", "value"]);
      context.string(value.namespace, childPath(path, "namespace"), NAMESPACE);
      context.string(value.value, childPath(path, "value"));
      break;
    case "list":
    case "set":
      context.keys(value, path, ["tag", "items"]);
      context.required(value, path, ["items"]);
      if (context.array(value.items, childPath(path, "items"))) {
        value.items.forEach((item, index) =>
          validateWire(item, childPath(childPath(path, "items"), index), context, ancestors),
        );
        if (tag === "set") validateSetOrder(value.items, childPath(path, "items"), context);
      }
      break;
    case "map":
      context.keys(value, path, ["tag", "entries"]);
      context.required(value, path, ["entries"]);
      validateWireMap(value.entries, childPath(path, "entries"), context, ancestors);
      break;
    case "entity":
      context.keys(value, path, ["tag", "type", "identity", "fields"]);
      context.required(value, path, ["type", "identity", "fields"]);
      context.string(value.type, childPath(path, "type"), TYPE_NAME);
      validateIdentity(value.identity, childPath(path, "identity"), context);
      validateWireMap(value.fields, childPath(path, "fields"), context, ancestors);
      break;
    default:
      context.issue(childPath(path, "tag"), "enum", `unknown wire tag ${JSON.stringify(tag)}`);
  }
  ancestors.pop();
}

function validateSetOrder(
  items: readonly unknown[],
  path: string,
  context: ValidationContext,
): void {
  let previous: string | undefined;
  const identities = new Set<string>();
  items.forEach((item, index) => {
    let canonical: string;
    try {
      canonical = canonicalWireValue(item as WireValue);
    } catch {
      return;
    }
    if (previous !== undefined && canonical <= previous)
      context.issue(
        childPath(path, index),
        canonical === previous ? "duplicate" : "canonical_order",
        canonical === previous ? "duplicate set value" : "set values must be in canonical order",
      );
    const identity = identityKey(item as WireValue);
    if (identity && identities.has(identity))
      context.issue(
        childPath(path, index),
        "duplicate_identity",
        "duplicate entity identity in set",
      );
    if (identity) identities.add(identity);
    previous = canonical;
  });
}

function identityKey(value: WireValue): string | undefined {
  return value.tag === "entity"
    ? `${value.type}\u0000${value.identity.namespace}\u0000${value.identity.value}`
    : undefined;
}

function validateIdentity(value: unknown, path: string, context: ValidationContext): void {
  if (!context.record(value, path)) return;
  context.keys(value, path, ["namespace", "value"]);
  context.required(value, path, ["namespace", "value"]);
  context.string(value.namespace, childPath(path, "namespace"), NAMESPACE);
  context.string(value.value, childPath(path, "value"));
}

function validateWireMap(
  value: unknown,
  path: string,
  context: ValidationContext,
  ancestors: object[],
): void {
  if (!context.record(value, path)) return;
  for (const [key, item] of Object.entries(value))
    validateWire(item, childPath(path, key), context, ancestors);
}
