import type {
  CollectionType,
  DynamicJsonType,
  FunctionParameterType,
  FunctionType,
  ManifestFieldDefinition,
  ManifestFunctionDefinition,
  ManifestParameterDefinition,
  ManifestResourceDefinition,
  ManifestTypeSpec,
  NamedType,
  NamespaceType,
  ParserType,
  PrimitiveType,
  PrimitiveTypeName,
  ProviderManifest,
  StaticType,
  TypeMember,
} from "./model.ts";

export const BooleanType: PrimitiveType = { kind: "primitive", name: "boolean" };
export const NumberType: PrimitiveType = { kind: "primitive", name: "number" };
export const IntegerType: PrimitiveType = { kind: "primitive", name: "integer" };
export const StringType: PrimitiveType = { kind: "primitive", name: "string" };
export const GlobType: PrimitiveType = { kind: "primitive", name: "glob" };
export const nullType = { kind: "null" } as const;
export const JsonType: DynamicJsonType = { kind: "json" };
export const JsonParserType: ParserType = { kind: "parser", name: "json" };
export const errorType = { kind: "error" } as const;
export const unknownType = { kind: "unknown" } as const;

export function collectionOf(element: StaticType, set = false): CollectionType {
  return { kind: "collection", element, set };
}

export function functionType(
  parameters: readonly FunctionParameterType[],
  returns: StaticType,
  documentation?: string,
): FunctionType {
  const result: FunctionType = { kind: "function", parameters, returns };
  if (documentation !== undefined) result.documentation = documentation;
  return result;
}

export interface CoreEnvironment {
  types: Readonly<Record<"File" | "ChangeSet" | "Change" | "Check", NamedType>>;
  globals: readonly TypeMember[];
}

function member(
  name: string,
  kind: TypeMember["kind"],
  type: StaticType,
  documentation: string,
): TypeMember {
  return { name, kind, type, documentation };
}

function createCoreEnvironment(): CoreEnvironment {
  const fileMembers: TypeMember[] = [];
  const changeMembers: TypeMember[] = [];
  const changeSetMembers: TypeMember[] = [];
  const checkMembers: TypeMember[] = [];
  const File: NamedType = {
    kind: "named",
    name: "File",
    provider: "core",
    contractMajor: 0,
    members: fileMembers,
    documentation: "A file in the repository snapshot.",
  };
  const Change: NamedType = {
    kind: "named",
    name: "Change",
    provider: "core",
    contractMajor: 0,
    members: changeMembers,
    documentation: "A repository path change.",
  };
  const ChangeSet: NamedType = {
    kind: "named",
    name: "ChangeSet",
    provider: "core",
    contractMajor: 0,
    members: changeSetMembers,
    documentation: "A filterable collection of repository changes.",
  };
  const Check: NamedType = {
    kind: "named",
    name: "Check",
    provider: "core",
    contractMajor: 0,
    members: checkMembers,
    documentation: "A named CI check and its current result.",
  };

  fileMembers.push(
    member("path", "field", StringType, "Repository-relative path."),
    member("content", "field", StringType, "Text file content."),
    member(
      "as",
      "method",
      functionType([{ name: "format", type: JsonParserType, optional: false }], JsonType),
      "Parse the file using a core parser.",
    ),
  );
  changeMembers.push(
    member("path", "field", StringType, "Repository-relative changed path."),
    member("status", "field", StringType, "Change status."),
    member("previous_path", "field", StringType, "Repository-relative path before a rename."),
    member("before", "field", File, "The file before the change; unavailable when added."),
    member("after", "field", File, "The file after the change; unavailable when deleted."),
  );
  changeSetMembers.push(
    member("added", "field", ChangeSet, "Only added changes."),
    member("modified", "field", ChangeSet, "Only modified changes."),
    member("deleted", "field", ChangeSet, "Only deleted changes."),
    member("renamed", "field", ChangeSet, "Only renamed changes."),
    member(
      "files",
      "method",
      functionType([{ name: "pattern", type: GlobType, optional: true }], collectionOf(File)),
      "Materialized non-deleted files matching a path glob.",
    ),
  );
  checkMembers.push(
    member("name", "field", StringType, "Check name."),
    member("status", "field", StringType, "Check status."),
    member("conclusion", "field", StringType, "Check conclusion."),
  );

  return {
    types: { File, ChangeSet, Change, Check },
    globals: [
      member(
        "Files",
        "function",
        functionType([{ name: "pattern", type: GlobType, optional: false }], collectionOf(File)),
        "Select repository files matching a path glob.",
      ),
      member("json", "resource", JsonParserType, "The core JSON file parser."),
    ],
  };
}

export const core: CoreEnvironment = createCoreEnvironment();
export const CoreTypes = core.types;
export const CoreGlobals = core.globals;

export interface ResolvedProvider {
  manifest: ProviderManifest;
  types: Readonly<Record<string, NamedType>>;
  namespace: NamespaceType;
  errors: readonly string[];
}

function primitive(name: string): PrimitiveType | undefined {
  const normalized = name.toLowerCase();
  const names: Readonly<Record<string, PrimitiveType>> = {
    boolean: BooleanType,
    number: NumberType,
    integer: IntegerType,
    string: StringType,
    glob: GlobType,
  };
  return names[normalized];
}

function parseGeneric(spec: string): { set: boolean; inner: string } | undefined {
  const match = /^(Set|Collection|List)<(.+)>$/.exec(spec.trim());
  return match ? { set: match[1] === "Set", inner: match[2]!.trim() } : undefined;
}

function providerMajor(manifest: ProviderManifest): number {
  if (manifest.apiVersion !== undefined) return manifest.apiVersion;
  return manifest.policiApi;
}

function coreType(name: string): NamedType | undefined {
  if (name === "File") return core.types.File;
  if (name === "ChangeSet") return core.types.ChangeSet;
  if (name === "Change") return core.types.Change;
  if (name === "Check") return core.types.Check;
  return undefined;
}

export function getProviderApiVersion(manifest: ProviderManifest): number {
  return providerMajor(manifest);
}

/** Resolves a provider's JSON-shaped static contract without executing provider code. */
export function resolveProviderManifest(manifest: ProviderManifest): ResolvedProvider {
  const errors: string[] = [];
  const mutableTypes: Record<string, NamedType> = {};
  for (const name of Object.keys(manifest.types ?? {})) {
    const definition = manifest.types![name]!;
    mutableTypes[name] = {
      kind: "named",
      name,
      provider: manifest.name,
      contractMajor: providerMajor(manifest),
      members: [],
      ...(definition.identity === undefined ? {} : { identity: definition.identity }),
      ...(definition.documentation === undefined
        ? {}
        : { documentation: definition.documentation }),
    };
  }

  const resolveSpec = (spec: ManifestTypeSpec, context: string): StaticType => {
    if (typeof spec !== "string") {
      const structured = spec as Exclude<ManifestTypeSpec, string>;
      if (structured.kind === "json") return JsonType;
      if (structured.kind === "collection" || structured.kind === "set")
        return collectionOf(resolveSpec(structured.element, context), structured.kind === "set");
      return resolveSpec(structured.name, context);
    }
    const primitiveType = primitive(spec);
    if (primitiveType) return primitiveType;
    if (spec.toLowerCase() === "json") return JsonType;
    const generic = parseGeneric(spec);
    if (generic) return collectionOf(resolveSpec(generic.inner, context), generic.set);
    const coreName = spec.startsWith("core.") ? spec.slice(5) : spec;
    const resolvedCore = coreType(coreName);
    if (resolvedCore !== undefined) return resolvedCore;
    const localName = spec.startsWith(`${manifest.name}.`)
      ? spec.slice(manifest.name.length + 1)
      : spec;
    if (localName in mutableTypes) return mutableTypes[localName]!;
    errors.push(`${context}: unknown type '${spec}'.`);
    return errorType;
  };

  const resolveParameters = (
    definition: ManifestFunctionDefinition,
    context: string,
  ): FunctionParameterType[] => {
    const parameters: FunctionParameterType[] = [];
    const rawParameters = definition.parameters;
    if (Array.isArray(rawParameters)) {
      for (const parameter of rawParameters) {
        parameters.push({
          name: parameter.name,
          type: resolveSpec(parameter.type, `${context} parameter '${parameter.name}'`),
          optional: parameter.optional === true || parameter.default !== undefined,
          ...(parameter.documentation === undefined
            ? {}
            : { documentation: parameter.documentation }),
        });
      }
    } else {
      const parameterMap = rawParameters as
        | Readonly<Record<string, ManifestTypeSpec | ManifestParameterDefinition>>
        | undefined;
      for (const name of Object.keys(parameterMap ?? {})) {
        const raw = parameterMap![name]!;
        const wrapped = raw as ManifestParameterDefinition;
        const parameter: ManifestParameterDefinition =
          typeof raw === "string" || wrapped.type === undefined
            ? { type: raw as ManifestTypeSpec }
            : wrapped;
        parameters.push({
          name,
          type: resolveSpec(parameter.type, `${context} parameter '${name}'`),
          optional: parameter.optional === true || parameter.default !== undefined,
          ...(parameter.documentation === undefined
            ? {}
            : { documentation: parameter.documentation }),
        });
      }
    }
    let sawOptional = false;
    for (const parameter of parameters) {
      if (parameter.optional) sawOptional = true;
      else if (sawOptional)
        errors.push(
          `${context}: required parameter '${parameter.name}' cannot follow an optional parameter.`,
        );
    }
    return parameters;
  };

  const resolveFunction = (definition: ManifestFunctionDefinition, context: string): FunctionType =>
    functionType(
      resolveParameters(definition, context),
      resolveSpec(definition.returns, `${context} return`),
      definition.documentation,
    );

  for (const name of Object.keys(manifest.types ?? {})) {
    const definition = manifest.types![name]!;
    const members = mutableTypes[name]!.members as TypeMember[];
    for (const fieldName of Object.keys(definition.fields ?? {})) {
      const raw = definition.fields![fieldName]!;
      const wrapped = raw as ManifestFieldDefinition;
      const field =
        typeof raw === "string" || wrapped.type === undefined
          ? { type: raw as ManifestTypeSpec }
          : wrapped;
      members.push({
        name: fieldName,
        kind: "field",
        type: resolveSpec(field.type, `${manifest.name}.${name}.${fieldName}`),
        ...(field.documentation === undefined ? {} : { documentation: field.documentation }),
      });
    }
    for (const methodName of Object.keys(definition.methods ?? {})) {
      const raw = definition.methods![methodName]!;
      const method: ManifestFunctionDefinition = {
        kind: "function",
        returns: raw.returns,
        ...(raw.parameters === undefined ? {} : { parameters: raw.parameters }),
        ...(raw.documentation === undefined ? {} : { documentation: raw.documentation }),
        ...(raw.resolve === undefined ? {} : { resolve: raw.resolve }),
      };
      members.push({
        name: methodName,
        kind: "method",
        type: resolveFunction(method, `${manifest.name}.${name}.${methodName}`),
        ...(method.documentation === undefined ? {} : { documentation: method.documentation }),
      });
    }
  }

  const namespaceMembers: TypeMember[] = [];
  for (const name of Object.keys(manifest.exports ?? {})) {
    const definition = manifest.exports![name]!;
    const resource = definition as ManifestResourceDefinition;
    if (resource.kind === "resource") {
      namespaceMembers.push({
        name,
        kind: "resource",
        type: resolveSpec(resource.type, `${manifest.name}.${name}`),
        ...(resource.documentation === undefined ? {} : { documentation: resource.documentation }),
      });
    } else {
      const callable = definition as ManifestFunctionDefinition;
      namespaceMembers.push({
        name,
        kind: "function",
        type: resolveFunction(callable, `${manifest.name}.${name}`),
        ...(callable.documentation === undefined ? {} : { documentation: callable.documentation }),
      });
    }
  }

  return {
    manifest,
    types: mutableTypes,
    namespace: {
      kind: "namespace",
      name: manifest.name,
      members: namespaceMembers,
      ...(manifest.documentation === undefined ? {} : { documentation: manifest.documentation }),
    },
    errors,
  };
}

export function typeToString(type: StaticType): string {
  switch (type.kind) {
    case "primitive":
      return type.name;
    case "null":
      return "null";
    case "json":
      return "Json";
    case "parser":
      return `Parser<${type.name}>`;
    case "error":
      return "<error>";
    case "unknown":
      return "unknown";
    case "collection":
      return `${type.set ? "Set" : "Collection"}<${typeToString(type.element)}>`;
    case "function":
      return `(${type.parameters.map((parameter) => `${parameter.name}${parameter.optional ? "?" : ""}: ${typeToString(parameter.type)}`).join(", ")}) => ${typeToString(type.returns)}`;
    case "named":
      return type.provider === "core" ? type.name : `${type.provider}.${type.name}`;
    case "namespace":
      return `provider ${type.name}`;
  }
}

export function getTypeMember(type: StaticType, name: string): TypeMember | undefined {
  if (type.kind === "named") return type.members.find((candidate) => candidate.name === name);
  if (type.kind === "namespace") return type.members.find((candidate) => candidate.name === name);
  if (
    type.kind === "collection" &&
    type.element.kind === "named" &&
    type.element.provider === "core" &&
    type.element.name === "File" &&
    name === "as"
  ) {
    return member(
      "as",
      "method",
      functionType(
        [{ name: "format", type: JsonParserType, optional: false }],
        collectionOf(JsonType),
      ),
      "Parse every file in the collection using a core parser.",
    );
  }
  return undefined;
}

export function getTypeMembers(type: StaticType): readonly TypeMember[] {
  if (type.kind === "named") return type.members;
  if (type.kind === "namespace") return type.members;
  const asMember = getTypeMember(type, "as");
  return asMember ? [asMember] : [];
}

export function iterableElement(type: StaticType): StaticType | undefined {
  if (type.kind === "collection") return type.element;
  if (type.kind === "named" && type.provider === "core" && type.name === "ChangeSet")
    return core.types.Change;
  return undefined;
}

export function isTypeAssignable(actual: StaticType, expected: StaticType): boolean {
  if (
    actual.kind === "error" ||
    expected.kind === "error" ||
    actual.kind === "unknown" ||
    expected.kind === "unknown"
  )
    return true;
  if (actual.kind === "json" || expected.kind === "json") return true;
  if (actual.kind === "null" || expected.kind === "null") return actual.kind === expected.kind;
  if (actual.kind === "primitive" && expected.kind === "primitive") {
    if (actual.name === expected.name) return true;
    if (actual.name === "integer" && expected.name === "number") return true;
    return (
      (actual.name === "string" && expected.name === "glob") ||
      (actual.name === "glob" && expected.name === "string")
    );
  }
  if (actual.kind === "parser" && expected.kind === "parser") return actual.name === expected.name;
  if (actual.kind === "named" && expected.kind === "named")
    return (
      actual.provider === expected.provider &&
      actual.contractMajor === expected.contractMajor &&
      actual.name === expected.name
    );
  if (actual.kind === "collection" && expected.kind === "collection")
    return isTypeAssignable(actual.element, expected.element);
  if (actual.kind === "function" && expected.kind === "function") {
    if (actual.parameters.length !== expected.parameters.length) return false;
    for (let index = 0; index < actual.parameters.length; index++) {
      const actualParameter = actual.parameters[index]!;
      const expectedParameter = expected.parameters[index]!;
      if (
        actualParameter.name !== expectedParameter.name ||
        actualParameter.optional !== expectedParameter.optional ||
        !isTypeAssignable(actualParameter.type, expectedParameter.type) ||
        !isTypeAssignable(expectedParameter.type, actualParameter.type)
      )
        return false;
    }
    return (
      isTypeAssignable(actual.returns, expected.returns) &&
      isTypeAssignable(expected.returns, actual.returns)
    );
  }
  if (actual.kind === "namespace" && expected.kind === "namespace")
    return actual.name === expected.name;
  return false;
}

export function areTypesComparable(left: StaticType, right: StaticType): boolean {
  return isTypeAssignable(left, right) || isTypeAssignable(right, left);
}

export function primitiveType(name: PrimitiveTypeName): PrimitiveType {
  return {
    boolean: BooleanType,
    number: NumberType,
    integer: IntegerType,
    string: StringType,
    glob: GlobType,
  }[name];
}
