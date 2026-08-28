import type { JsonValue } from "./json.js";
import { assertValid, childPath, ValidationContext, type ValidationResult } from "./validation.js";
import { PoliciGlob } from "../core/glob.js";

export const PLUGIN_MANIFEST_SCHEMA = "polici.plugin/v2" as const;
export const PLUGIN_MANIFEST_VERSION = 2 as const;
/** Version of the Polici manifest shape understood by the compiler. */
export const POLICI_PLUGIN_API_MAJOR = 1 as const;
/** Current default provider-facing contract major. Providers may declare another positive major. */
export const PLUGIN_CONTRACT_MAJOR = 1 as const;
/** Version of the host/runtime message protocol, independent of either API major. */
export const PLUGIN_RUNTIME_PROTOCOL_VERSION = 1 as const;

export type PluginRuntimeKind = "typescript" | "wasm";
export type PluginTransport = "jsonl" | "length-prefixed";

export interface Documentation {
  readonly summary?: string;
  readonly description?: string;
  readonly deprecated?: string;
  readonly examples?: readonly string[];
}

export interface StringType extends Documentation {
  readonly kind: "string";
  readonly enum?: readonly string[];
  readonly pattern?: string;
}

export interface IntegerType extends Documentation {
  readonly kind: "integer";
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface BooleanType extends Documentation {
  readonly kind: "boolean";
}

export interface GlobType extends Documentation {
  readonly kind: "glob";
  readonly default?: string;
}

export interface IdType extends Documentation {
  readonly kind: "id";
  readonly namespace: string;
}

export interface ReferenceType extends Documentation {
  readonly kind: "ref";
  readonly type: string;
}

export interface CoreTypeReference extends Documentation {
  readonly kind: "core";
  readonly type: "File" | "Change" | "ChangeSet" | "Check";
}

export interface ListType extends Documentation {
  readonly kind: "list";
  readonly items: TypeExpression;
}

export interface SetType extends Documentation {
  readonly kind: "set";
  readonly items: TypeExpression;
  readonly resolve?: string;
}

export interface OptionalType extends Documentation {
  readonly kind: "optional";
  readonly value: TypeExpression;
}

export interface ObjectType extends Documentation {
  readonly kind: "object";
  readonly fields: Readonly<Record<string, TypeExpression>>;
}

export type TypeExpression =
  | StringType
  | IntegerType
  | BooleanType
  | GlobType
  | IdType
  | ReferenceType
  | CoreTypeReference
  | ListType
  | SetType
  | OptionalType
  | ObjectType;

export interface EntityTypeDefinition extends Documentation {
  readonly kind: "entity";
  readonly identity: string;
  readonly fields: Readonly<Record<string, TypeExpression>>;
  readonly methods?: Readonly<Record<string, MethodDefinition>>;
}

export interface ValueTypeDefinition extends Documentation {
  readonly kind: "value";
  readonly fields: Readonly<Record<string, TypeExpression>>;
}

export type NamedTypeDefinition = EntityTypeDefinition | ValueTypeDefinition;

export interface ParameterDefinition extends Documentation {
  readonly name: string;
  readonly type: TypeExpression;
  readonly optional?: boolean;
  readonly default?: JsonValue;
}

export interface ResourceExport extends Documentation {
  readonly kind: "resource";
  readonly type: TypeExpression;
  readonly context?: string;
  readonly resolve: string;
}

export interface FunctionExport extends Documentation {
  readonly kind: "function";
  readonly parameters: readonly ParameterDefinition[];
  readonly returns: TypeExpression;
  readonly resolve: string;
}

export interface MethodDefinition extends Documentation {
  readonly parameters: readonly ParameterDefinition[];
  readonly returns: TypeExpression;
  readonly resolve: string;
}

export type PluginExport = ResourceExport | FunctionExport;

export interface PluginRuntimeManifest {
  readonly kind: PluginRuntimeKind;
  readonly protocol: typeof PLUGIN_RUNTIME_PROTOCOL_VERSION;
  readonly entrypoint: string;
  readonly transport: PluginTransport;
  readonly capabilities: readonly string[];
}

export interface PluginManifest {
  readonly schema: typeof PLUGIN_MANIFEST_SCHEMA;
  readonly schemaVersion: typeof PLUGIN_MANIFEST_VERSION;
  readonly name: string;
  readonly version: string;
  readonly policiApi: typeof POLICI_PLUGIN_API_MAJOR;
  readonly contractMajor: number;
  readonly types: Readonly<Record<string, NamedTypeDefinition>>;
  readonly exports: Readonly<Record<string, PluginExport>>;
  readonly permissions: readonly string[];
  readonly runtime: PluginRuntimeManifest;
  readonly documentation?: Documentation;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLUGIN_NAME = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const RESOLVER = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const CONTEXT = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const CAPABILITY = /^[a-z][a-z0-9]*(?::[a-z][a-z0-9-]*)+$/;

export interface PluginManifestLimits {
  readonly depth?: number;
  readonly nodes?: number;
  readonly collectionItems?: number;
  readonly objectEntries?: number;
  readonly stringCodeUnits?: number;
}

interface NormalizedManifestLimits {
  readonly depth: number;
  readonly nodes: number;
  readonly collectionItems: number;
  readonly objectEntries: number;
  readonly stringCodeUnits: number;
}

const DEFAULT_MANIFEST_LIMITS: NormalizedManifestLimits = {
  depth: 64,
  nodes: 100_000,
  collectionItems: 10_000,
  objectEntries: 10_000,
  stringCodeUnits: 1_048_576,
};

export function validatePluginManifest(
  value: unknown,
  limits: PluginManifestLimits = {},
): ValidationResult<PluginManifest> {
  const context = new ValidationContext();
  if (validateManifestBounds(value, "$manifest", context, normalizeManifestLimits(limits))) {
    validateManifest(value, "$manifest", context);
  }
  return context.result(value as PluginManifest);
}

export function parsePluginManifest(text: string): PluginManifest {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new SyntaxError(`Plugin manifest is not valid JSON: ${errorMessage(error)}`);
  }
  return assertValid("Plugin manifest", validatePluginManifest(value));
}

function validateManifest(value: unknown, path: string, context: ValidationContext): void {
  if (!context.record(value, path)) return;
  const keys = [
    "schema",
    "schemaVersion",
    "name",
    "version",
    "policiApi",
    "contractMajor",
    "types",
    "exports",
    "permissions",
    "runtime",
    "documentation",
  ];
  context.keys(value, path, keys);
  context.required(value, path, keys.slice(0, 10));
  literal(value.schema, childPath(path, "schema"), PLUGIN_MANIFEST_SCHEMA, context);
  literal(value.schemaVersion, childPath(path, "schemaVersion"), PLUGIN_MANIFEST_VERSION, context);
  context.string(value.name, childPath(path, "name"), PLUGIN_NAME);
  context.string(value.version, childPath(path, "version"), SEMVER);
  literal(value.policiApi, childPath(path, "policiApi"), POLICI_PLUGIN_API_MAJOR, context);
  context.integer(value.contractMajor, childPath(path, "contractMajor"), 1);
  validateNamedTypes(value.types, childPath(path, "types"), context);
  validateExports(value.exports, childPath(path, "exports"), context);
  validateUniqueStrings(value.permissions, childPath(path, "permissions"), context, CAPABILITY);
  validateRuntime(value.runtime, childPath(path, "runtime"), context);
  if (value.documentation !== undefined)
    validateDocumentation(value.documentation, childPath(path, "documentation"), context);
  validateReferences(value, path, context);
  validateCapabilitiesMatchPermissions(value, path, context);
}

function validateNamedTypes(value: unknown, path: string, context: ValidationContext): void {
  if (!context.record(value, path)) return;
  for (const [name, definition] of Object.entries(value)) {
    const itemPath = childPath(path, name);
    if (!IDENTIFIER.test(name)) context.issue(itemPath, "identifier", "invalid type name");
    if (!context.record(definition, itemPath)) continue;
    const kind = definition.kind;
    context.keys(
      definition,
      itemPath,
      ["kind", "identity", "fields"].concat(
        kind === "entity" ? ["methods"] : [],
        documentationKeys,
      ),
    );
    context.required(
      definition,
      itemPath,
      kind === "entity" ? ["kind", "identity", "fields"] : ["kind", "fields"],
    );
    if (kind !== "entity" && kind !== "value") {
      context.issue(childPath(itemPath, "kind"), "enum", 'expected "entity" or "value"');
    }
    validateFields(definition.fields, childPath(itemPath, "fields"), context, kind === "entity");
    if (kind === "entity") {
      if (context.string(definition.identity, childPath(itemPath, "identity"), IDENTIFIER)) {
        const fields = definition.fields;
        if (context.record(fields, childPath(itemPath, "fields"))) {
          const identity = fields[definition.identity];
          if (!identity || !isIdentityType(identity)) {
            context.issue(
              childPath(itemPath, "identity"),
              "identity",
              "identity must name an id field",
            );
          }
        }
      }
      if (definition.methods !== undefined)
        validateMethods(definition.methods, childPath(itemPath, "methods"), context);
      if (
        context.record(definition.methods ?? {}, childPath(itemPath, "methods")) &&
        context.record(definition.fields, childPath(itemPath, "fields"))
      ) {
        for (const methodName of Object.keys(definition.methods ?? {})) {
          if (Object.hasOwn(definition.fields, methodName))
            context.issue(
              childPath(childPath(itemPath, "methods"), methodName),
              "duplicate",
              "an entity field and method cannot have the same name",
            );
        }
      }
    } else if (definition.identity !== undefined) {
      context.issue(
        childPath(itemPath, "identity"),
        "forbidden",
        "value types do not have identity",
      );
    }
    validateDocumentationFields(definition, itemPath, context);
  }
}

function validateFields(
  value: unknown,
  path: string,
  context: ValidationContext,
  allowLazyResolve = false,
): void {
  if (!context.record(value, path)) return;
  for (const [name, expression] of Object.entries(value)) {
    if (!IDENTIFIER.test(name))
      context.issue(childPath(path, name), "identifier", "invalid field name");
    validateTypeExpression(expression, childPath(path, name), context, allowLazyResolve);
  }
}

function validateTypeExpression(
  value: unknown,
  path: string,
  context: ValidationContext,
  allowLazyResolve = false,
): void {
  if (!context.record(value, path)) return;
  const kind = value.kind;
  if (typeof kind !== "string") {
    context.issue(childPath(path, "kind"), "type", "expected a type kind");
    return;
  }
  const base = ["kind"].concat(documentationKeys);
  switch (kind) {
    case "string":
      context.keys(value, path, [...base, "enum", "pattern"]);
      if (value.enum !== undefined)
        validateUniqueStrings(value.enum, childPath(path, "enum"), context);
      if (value.pattern !== undefined) {
        if (context.string(value.pattern, childPath(path, "pattern"))) {
          try {
            parseSafePattern(value.pattern);
          } catch (error) {
            context.issue(
              childPath(path, "pattern"),
              "regexp",
              error instanceof Error ? error.message : "invalid safe pattern",
            );
          }
        }
      }
      break;
    case "integer":
      context.keys(value, path, [...base, "minimum", "maximum"]);
      if (value.minimum !== undefined) context.integer(value.minimum, childPath(path, "minimum"));
      if (value.maximum !== undefined) context.integer(value.maximum, childPath(path, "maximum"));
      if (
        typeof value.minimum === "number" &&
        typeof value.maximum === "number" &&
        value.minimum > value.maximum
      ) {
        context.issue(path, "range", "minimum cannot exceed maximum");
      }
      break;
    case "boolean":
      context.keys(value, path, base);
      break;
    case "glob":
      context.keys(value, path, [...base, "default"]);
      if (value.default !== undefined && context.string(value.default, childPath(path, "default")))
        validateGlob(value.default, childPath(path, "default"), context);
      break;
    case "id":
      context.keys(value, path, [...base, "namespace"]);
      context.required(value, path, ["namespace"]);
      context.string(value.namespace, childPath(path, "namespace"), CAPABILITY);
      break;
    case "ref":
      context.keys(value, path, [...base, "type"]);
      context.required(value, path, ["type"]);
      context.string(value.type, childPath(path, "type"), IDENTIFIER);
      break;
    case "core":
      context.keys(value, path, [...base, "type"]);
      context.required(value, path, ["type"]);
      if (!["File", "Change", "ChangeSet", "Check"].includes(value.type as string))
        context.issue(childPath(path, "type"), "enum", "unknown core type");
      break;
    case "list":
    case "set":
      context.keys(value, path, [...base, "items", "resolve"]);
      context.required(value, path, ["items"]);
      validateTypeExpression(value.items, childPath(path, "items"), context);
      if (value.resolve !== undefined) {
        if (kind !== "set" || !allowLazyResolve)
          context.issue(
            childPath(path, "resolve"),
            "forbidden",
            "only a direct set field of an entity may resolve lazily",
          );
        context.string(value.resolve, childPath(path, "resolve"), RESOLVER);
      }
      break;
    case "optional":
      context.keys(value, path, [...base, "value"]);
      context.required(value, path, ["value"]);
      validateTypeExpression(value.value, childPath(path, "value"), context);
      break;
    case "object":
      context.keys(value, path, [...base, "fields"]);
      context.required(value, path, ["fields"]);
      validateFields(value.fields, childPath(path, "fields"), context);
      break;
    default:
      context.issue(childPath(path, "kind"), "enum", `unknown type kind ${JSON.stringify(kind)}`);
  }
  validateDocumentationFields(value, path, context);
}

function validateMethods(value: unknown, path: string, context: ValidationContext): void {
  if (!context.record(value, path)) return;
  for (const [name, method] of Object.entries(value)) {
    const itemPath = childPath(path, name);
    if (!IDENTIFIER.test(name)) context.issue(itemPath, "identifier", "invalid method name");
    if (!context.record(method, itemPath)) continue;
    context.keys(method, itemPath, ["parameters", "returns", "resolve"].concat(documentationKeys));
    context.required(method, itemPath, ["parameters", "returns", "resolve"]);
    validateParameters(method.parameters, childPath(itemPath, "parameters"), context);
    validateTypeExpression(method.returns, childPath(itemPath, "returns"), context);
    context.string(method.resolve, childPath(itemPath, "resolve"), RESOLVER);
    validateDocumentationFields(method, itemPath, context);
  }
}

function validateExports(value: unknown, path: string, context: ValidationContext): void {
  if (!context.record(value, path)) return;
  for (const [name, item] of Object.entries(value)) {
    const itemPath = childPath(path, name);
    if (!IDENTIFIER.test(name)) context.issue(itemPath, "identifier", "invalid export name");
    if (!context.record(item, itemPath)) continue;
    const kind = item.kind;
    if (kind === "resource") {
      context.keys(
        item,
        itemPath,
        ["kind", "type", "context", "resolve"].concat(documentationKeys),
      );
      context.required(item, itemPath, ["kind", "type", "resolve"]);
      validateTypeExpression(item.type, childPath(itemPath, "type"), context);
      if (item.context !== undefined)
        context.string(item.context, childPath(itemPath, "context"), CONTEXT);
      context.string(item.resolve, childPath(itemPath, "resolve"), RESOLVER);
    } else if (kind === "function") {
      context.keys(
        item,
        itemPath,
        ["kind", "parameters", "returns", "resolve"].concat(documentationKeys),
      );
      context.required(item, itemPath, ["kind", "parameters", "returns", "resolve"]);
      validateParameters(item.parameters, childPath(itemPath, "parameters"), context);
      validateTypeExpression(item.returns, childPath(itemPath, "returns"), context);
      context.string(item.resolve, childPath(itemPath, "resolve"), RESOLVER);
    } else {
      context.issue(childPath(itemPath, "kind"), "enum", 'expected "resource" or "function"');
    }
    validateDocumentationFields(item, itemPath, context);
  }
}

function validateParameters(value: unknown, path: string, context: ValidationContext): void {
  if (!context.array(value, path)) return;
  const names = new Set<string>();
  let optionalSeen = false;
  for (let index = 0; index < value.length; index += 1) {
    const parameter = value[index];
    const itemPath = childPath(path, index);
    if (!context.record(parameter, itemPath)) continue;
    context.keys(
      parameter,
      itemPath,
      ["name", "type", "optional", "default"].concat(documentationKeys),
    );
    context.required(parameter, itemPath, ["name", "type"]);
    if (context.string(parameter.name, childPath(itemPath, "name"), IDENTIFIER)) {
      if (names.has(parameter.name))
        context.issue(childPath(itemPath, "name"), "duplicate", "duplicate parameter name");
      names.add(parameter.name);
    }
    validateTypeExpression(parameter.type, childPath(itemPath, "type"), context);
    if (parameter.optional !== undefined)
      context.boolean(parameter.optional, childPath(itemPath, "optional"));
    if (parameter.default !== undefined) {
      validateJson(parameter.default, childPath(itemPath, "default"), context);
      validateDefaultValue(
        parameter.default,
        parameter.type,
        childPath(itemPath, "default"),
        context,
      );
    }
    const optional = parameter.optional === true || parameter.default !== undefined;
    if (optional) optionalSeen = true;
    else if (optionalSeen)
      context.issue(itemPath, "order", "required parameters cannot follow optional parameters");
    validateDocumentationFields(parameter, itemPath, context);
  }
}

function validateRuntime(value: unknown, path: string, context: ValidationContext): void {
  if (!context.record(value, path)) return;
  context.keys(value, path, ["kind", "protocol", "entrypoint", "transport", "capabilities"]);
  context.required(value, path, ["kind", "protocol", "entrypoint", "transport", "capabilities"]);
  if (value.kind !== "typescript" && value.kind !== "wasm")
    context.issue(childPath(path, "kind"), "enum", 'expected "typescript" or "wasm"');
  literal(value.protocol, childPath(path, "protocol"), PLUGIN_RUNTIME_PROTOCOL_VERSION, context);
  if (context.string(value.entrypoint, childPath(path, "entrypoint"))) {
    if (!isSafeEntrypoint(value.entrypoint))
      context.issue(
        childPath(path, "entrypoint"),
        "path",
        "entrypoint must be a package-relative ./ path without traversal",
      );
    if (value.kind === "wasm" && !value.entrypoint.endsWith(".wasm"))
      context.issue(childPath(path, "entrypoint"), "path", "WASM entrypoint must end in .wasm");
    if (value.kind === "typescript" && /\.(?:[cm]?ts|tsx|[cm]?js)$/i.test(value.entrypoint))
      context.issue(
        childPath(path, "entrypoint"),
        "path",
        "TypeScript-authored runtime entrypoint must be a precompiled executable",
      );
  }
  if (value.transport !== "jsonl" && value.transport !== "length-prefixed")
    context.issue(childPath(path, "transport"), "enum", 'expected "jsonl" or "length-prefixed"');
  validateUniqueStrings(value.capabilities, childPath(path, "capabilities"), context, CAPABILITY);
}

function isSafeEntrypoint(value: string): boolean {
  if (!value.startsWith("./") || value.includes("\\") || value.includes("\0")) return false;
  const segments = value.slice(2).split("/");
  return (
    segments.length > 0 &&
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function validateDocumentation(value: unknown, path: string, context: ValidationContext): void {
  if (!context.record(value, path)) return;
  context.keys(value, path, documentationKeys);
  validateDocumentationFields(value, path, context);
}

const documentationKeys: readonly string[] = ["summary", "description", "deprecated", "examples"];

function validateDocumentationFields(
  value: Record<string, unknown>,
  path: string,
  context: ValidationContext,
): void {
  for (const key of ["summary", "description", "deprecated"]) {
    if (value[key] !== undefined) context.string(value[key], childPath(path, key));
  }
  if (value.examples !== undefined)
    validateUniqueStrings(value.examples, childPath(path, "examples"), context);
}

function validateUniqueStrings(
  value: unknown,
  path: string,
  context: ValidationContext,
  pattern?: RegExp,
): void {
  if (!context.array(value, path)) return;
  const found = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const itemPath = childPath(path, index);
    const item = value[index];
    if (!context.string(item, itemPath, pattern)) continue;
    if (found.has(item)) context.issue(itemPath, "duplicate", "duplicate value");
    found.add(item);
  }
}

function validateReferences(
  manifest: Record<string, unknown>,
  path: string,
  context: ValidationContext,
): void {
  const types = manifest.types;
  if (!types || typeof types !== "object" || Array.isArray(types)) return;
  walk(manifest, path, (value, valuePath) => {
    if (
      value.kind === "ref" &&
      typeof value.type === "string" &&
      !Object.keys(types).includes(value.type)
    ) {
      context.issue(
        childPath(valuePath, "type"),
        "reference",
        `unknown type ${JSON.stringify(value.type)}`,
      );
    }
  });
}

function validateCapabilitiesMatchPermissions(
  manifest: Record<string, unknown>,
  path: string,
  context: ValidationContext,
): void {
  if (
    !Array.isArray(manifest.permissions) ||
    !manifest.runtime ||
    typeof manifest.runtime !== "object"
  )
    return;
  const permissions = manifest.permissions as unknown[];
  const capabilities = (manifest.runtime as Record<string, unknown>).capabilities;
  if (!Array.isArray(capabilities)) return;
  capabilities.forEach((capability, index) => {
    if (typeof capability === "string" && !permissions.includes(capability))
      context.issue(
        childPath(childPath(childPath(path, "runtime"), "capabilities"), index),
        "permission",
        "runtime capability must also be declared as a plugin permission",
      );
  });
  permissions.forEach((permission, index) => {
    if (typeof permission === "string" && !capabilities.includes(permission))
      context.issue(
        childPath(childPath(path, "permissions"), index),
        "capability",
        "plugin permission must also be declared as a runtime capability",
      );
  });
}

function walk(
  value: unknown,
  path: string,
  visit: (value: Record<string, unknown>, path: string) => void,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, childPath(path, index), visit));
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    visit(record, path);
    for (const [key, item] of Object.entries(record)) walk(item, childPath(path, key), visit);
  }
}

function validateJson(value: unknown, path: string, context: ValidationContext): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) context.issue(path, "finite", "JSON numbers must be finite");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateJson(item, childPath(path, index), context));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value))
      validateJson(item, childPath(path, key), context);
    return;
  }
  context.issue(path, "type", "expected a JSON-compatible value");
}

function isIdentityType(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { kind?: string }).kind === "id";
}

function manifestLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${name} must be a non-negative safe integer`);
  return value;
}

function normalizeManifestLimits(limits: PluginManifestLimits): NormalizedManifestLimits {
  return {
    depth: manifestLimit(limits.depth, DEFAULT_MANIFEST_LIMITS.depth, "limits.depth"),
    nodes: manifestLimit(limits.nodes, DEFAULT_MANIFEST_LIMITS.nodes, "limits.nodes"),
    collectionItems: manifestLimit(
      limits.collectionItems,
      DEFAULT_MANIFEST_LIMITS.collectionItems,
      "limits.collectionItems",
    ),
    objectEntries: manifestLimit(
      limits.objectEntries,
      DEFAULT_MANIFEST_LIMITS.objectEntries,
      "limits.objectEntries",
    ),
    stringCodeUnits: manifestLimit(
      limits.stringCodeUnits,
      DEFAULT_MANIFEST_LIMITS.stringCodeUnits,
      "limits.stringCodeUnits",
    ),
  };
}

function validateManifestBounds(
  value: unknown,
  path: string,
  context: ValidationContext,
  limits: NormalizedManifestLimits,
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
      context.issue(path, "limit", `manifest exceeds the ${limits.nodes} node limit`);
      return false;
    }
    if (current.depth > limits.depth) {
      context.issue(current.path, "limit", `manifest exceeds the ${limits.depth} depth limit`);
      return false;
    }
    if (typeof current.value === "string") {
      stringCodeUnits += current.value.length;
      if (stringCodeUnits > limits.stringCodeUnits) {
        context.issue(
          path,
          "limit",
          `manifest strings exceed the ${limits.stringCodeUnits} code-unit limit`,
        );
        return false;
      }
    }
    if (current.value === null) continue;
    if (typeof current.value !== "object") {
      if (
        typeof current.value === "undefined" ||
        typeof current.value === "bigint" ||
        typeof current.value === "function" ||
        typeof current.value === "symbol"
      ) {
        context.issue(current.path, "type", "manifest values must be JSON-compatible data");
        return false;
      }
      if (typeof current.value === "number" && !Number.isFinite(current.value)) {
        context.issue(current.path, "finite", "manifest numbers must be finite");
        return false;
      }
      continue;
    }
    if (seen.includes(current.value)) {
      context.issue(current.path, "cycle", "manifest cannot contain cycles or shared references");
      return false;
    }
    seen.push(current.value);
    if (Array.isArray(current.value)) {
      if (!context.array(current.value, current.path)) return false;
      const values = current.value;
      if (values.length > limits.collectionItems) {
        context.issue(
          current.path,
          "limit",
          `array exceeds the ${limits.collectionItems} item limit`,
        );
        return false;
      }
      for (let index = values.length - 1; index >= 0; index -= 1) {
        pending.push({
          value: values[index],
          path: childPath(current.path, index),
          depth: current.depth + 1,
        });
      }
    } else {
      if (!context.record(current.value, current.path)) return false;
      const keys = Object.keys(current.value);
      if (keys.length > limits.objectEntries) {
        context.issue(
          current.path,
          "limit",
          `object exceeds the ${limits.objectEntries} entry limit`,
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
            `manifest strings exceed the ${limits.stringCodeUnits} code-unit limit`,
          );
          return false;
        }
        if (key === "__proto__" || key === "prototype" || key === "constructor") {
          context.issue(childPath(current.path, key), "key", "unsafe object key");
          return false;
        }
        pending.push({
          value: current.value[key],
          path: childPath(current.path, key),
          depth: current.depth + 1,
        });
      }
    }
  }
  return true;
}

function validateDefaultValue(
  value: unknown,
  expression: unknown,
  path: string,
  context: ValidationContext,
): void {
  if (!expression || typeof expression !== "object" || Array.isArray(expression)) return;
  const type = expression as Record<string, unknown>;
  const kind = typeof type.kind === "string" ? type.kind : "";
  switch (kind) {
    case "optional":
      if (value !== null) validateDefaultValue(value, type.value, path, context);
      return;
    case "string":
    case "id":
      if (typeof value !== "string") {
        context.issue(path, "default_type", `default must be a ${String(type.kind)}`);
        return;
      }
      if (kind === "string" && Array.isArray(type.enum) && !type.enum.includes(value))
        context.issue(path, "default_constraint", "default is not one of the allowed values");
      if (kind === "string" && typeof type.pattern === "string") {
        try {
          if (!matchesSafePattern(type.pattern, value))
            context.issue(path, "default_constraint", "default does not match the pattern");
        } catch {}
      }
      return;
    case "glob":
      if (typeof value !== "string") {
        context.issue(path, "default_type", "default must be a glob");
        return;
      }
      validateGlob(value, path, context);
      return;
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        context.issue(path, "default_type", "default must be a safe integer");
        return;
      }
      if (typeof type.minimum === "number" && (value as number) < type.minimum)
        context.issue(path, "default_constraint", "default is below the minimum");
      if (typeof type.maximum === "number" && (value as number) > type.maximum)
        context.issue(path, "default_constraint", "default is above the maximum");
      return;
    case "boolean":
      if (typeof value !== "boolean")
        context.issue(path, "default_type", "default must be boolean");
      return;
    case "list":
    case "set":
      if (!Array.isArray(value)) {
        context.issue(path, "default_type", "default must be an array");
        return;
      }
      value.forEach((item, index) =>
        validateDefaultValue(item, type.items, childPath(path, index), context),
      );
      if (kind === "set") {
        const canonical = value.map((item) => JSON.stringify(item));
        if (new Set(canonical).size !== canonical.length)
          context.issue(path, "default_constraint", "set default cannot contain duplicates");
      }
      return;
    case "object":
      validateDefaultFields(value, type.fields, path, context);
      return;
    case "ref":
    case "core":
      context.issue(path, "default_type", `${String(type.kind)} defaults are not supported`);
  }
}

function validateDefaultFields(
  value: unknown,
  fields: unknown,
  path: string,
  context: ValidationContext,
): void {
  if (
    !context.record(value, path) ||
    !fields ||
    typeof fields !== "object" ||
    Array.isArray(fields)
  )
    return;
  const fieldMap = fields as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!Object.keys(fieldMap).includes(key))
      context.issue(childPath(path, key), "default_field", "unknown default field");
  }
  for (const [name, field] of Object.entries(fieldMap)) {
    const present = Object.keys(value).includes(name);
    const optional =
      !!field &&
      typeof field === "object" &&
      !Array.isArray(field) &&
      (field as Record<string, unknown>).kind === "optional";
    if (!present && !optional)
      context.issue(childPath(path, name), "default_field", "required default field is missing");
    else if (present) validateDefaultValue(value[name], field, childPath(path, name), context);
  }
}

function validateGlob(value: string, path: string, context: ValidationContext): void {
  try {
    new PoliciGlob(value);
  } catch (error) {
    context.issue(path, "glob", error instanceof Error ? error.message : "invalid glob");
  }
}

function literal(
  value: unknown,
  path: string,
  expected: string | number,
  context: ValidationContext,
): void {
  const matches =
    typeof expected === "string"
      ? value === expected
      : typeof value === "number" && value === expected;
  if (!matches) context.issue(path, "const", `expected ${JSON.stringify(expected)}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SafePatternAtom {
  readonly matches: (value: string) => boolean;
  readonly quantifier: "" | "?" | "*" | "+";
}

const SAFE_PATTERN_LIMIT = 256;

function parseSafePattern(pattern: string): readonly SafePatternAtom[] {
  if (pattern.length > SAFE_PATTERN_LIMIT)
    throw new SyntaxError(`safe pattern exceeds ${SAFE_PATTERN_LIMIT} code units`);
  if (!pattern.startsWith("^") || !pattern.endsWith("$") || pattern.length < 2)
    throw new SyntaxError("safe patterns must be anchored with ^ and $");
  const atoms: SafePatternAtom[] = [];
  let index = 1;
  const end = pattern.length - 1;
  while (index < end) {
    let matches: (value: string) => boolean;
    const character = pattern.charAt(index);
    if (character === ".") {
      matches = () => true;
      index += 1;
    } else if (character === "\\") {
      if (index + 1 >= end) throw new SyntaxError("safe pattern has a trailing escape");
      const literal = pattern.charAt(index + 1);
      matches = (value) => value === literal;
      index += 2;
    } else if (character === "[") {
      const parsed = parseSafeCharacterClass(pattern, index + 1, end);
      matches = parsed.matches;
      index = parsed.next;
    } else {
      if ("^$(){}|*+?]".includes(character))
        throw new SyntaxError(`safe pattern does not allow ${JSON.stringify(character)} here`);
      matches = (value) => value === character;
      index += 1;
    }
    const quantifier =
      index < end && "?*+".includes(pattern.charAt(index))
        ? (pattern.charAt(index++) as "?" | "*" | "+")
        : "";
    atoms.push({ matches, quantifier });
  }
  return atoms;
}

function parseSafeCharacterClass(
  pattern: string,
  start: number,
  end: number,
): { readonly matches: (value: string) => boolean; readonly next: number } {
  let index = start;
  const negated = pattern.charAt(index) === "^";
  if (negated) index += 1;
  const ranges: [number, number][] = [];
  const readCharacter = (): string => {
    if (index >= end || pattern.charAt(index) === "]")
      throw new SyntaxError("safe pattern has an empty or unterminated character class");
    if (pattern.charAt(index) !== "\\") return pattern.charAt(index++);
    if (index + 1 >= end) throw new SyntaxError("safe pattern has a trailing class escape");
    index += 1;
    return pattern.charAt(index++);
  };
  while (index < end && pattern.charAt(index) !== "]") {
    const first = readCharacter().charCodeAt(0);
    if (pattern.charAt(index) === "-" && index + 1 < end && pattern.charAt(index + 1) !== "]") {
      index += 1;
      const last = readCharacter().charCodeAt(0);
      if (first > last) throw new SyntaxError("safe pattern character class range is reversed");
      ranges.push([first, last]);
    } else {
      ranges.push([first, first]);
    }
  }
  if (ranges.length === 0 || pattern.charAt(index) !== "]")
    throw new SyntaxError("safe pattern has an empty or unterminated character class");
  index += 1;
  return {
    matches: (value) => {
      const code = value.charCodeAt(0);
      const included = ranges.some(([first, last]) => code >= first && code <= last);
      return negated ? !included : included;
    },
    next: index,
  };
}

/** Matches the documented anchored, non-backtracking manifest pattern subset. */
export function matchesSafePattern(pattern: string, value: string): boolean {
  const atoms = parseSafePattern(pattern);
  let states = new Set<number>([0]);
  const close = (input: Set<number>): Set<number> => {
    const result = new Set<number>();
    for (const position of input) result.add(position);
    for (let position = 0; position < atoms.length; position += 1) {
      if (
        result.has(position) &&
        (atoms[position]!.quantifier === "?" || atoms[position]!.quantifier === "*")
      ) {
        result.add(position + 1);
      }
    }
    return result;
  };
  states = close(states);
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    const next = new Set<number>();
    for (const position of states) {
      const atom = atoms[position];
      if (atom === undefined || !atom.matches(character)) continue;
      if (atom.quantifier === "*" || atom.quantifier === "+") next.add(position);
      if (atom.quantifier !== "*") next.add(position + 1);
    }
    states = close(next);
    if (states.size === 0) return false;
  }
  return close(states).has(atoms.length);
}
