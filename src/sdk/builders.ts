import type {
  BooleanType,
  CoreTypeReference,
  Documentation,
  EntityTypeDefinition,
  FunctionExport,
  GlobType,
  IdType,
  IntegerType,
  ListType,
  MethodDefinition,
  ObjectType,
  OptionalType,
  ParameterDefinition,
  PluginExport,
  ReferenceType,
  ResourceExport,
  SetType,
  StringType,
  TypeExpression,
  ValueTypeDefinition,
} from "../plugin/manifest.js";
import type { JsonValue } from "../plugin/json.js";

type Options<T> = Omit<T, "kind">;

export interface ResourceOptions extends Documentation {
  readonly context?: string;
  readonly resolve: string;
}

export interface FunctionOptions extends Documentation {
  readonly parameters?:
    | readonly ParameterDefinition[]
    | Readonly<Record<string, TypeExpression | ParameterInput>>;
  readonly returns: TypeExpression;
  readonly resolve: string;
}

export type MethodOptions = FunctionOptions;

export interface ParameterInput extends Documentation {
  readonly type: TypeExpression;
  readonly optional?: boolean;
  readonly default?: JsonValue;
}

class TypeBuilders {
  string(options?: Omit<Options<StringType>, keyof Documentation> & Documentation): StringType {
    return options === undefined ? { kind: "string" } : { ...options, kind: "string" };
  }
  integer(options?: Omit<Options<IntegerType>, keyof Documentation> & Documentation): IntegerType {
    return options === undefined ? { kind: "integer" } : { ...options, kind: "integer" };
  }
  boolean(options?: Documentation): BooleanType {
    return options === undefined ? { kind: "boolean" } : { ...options, kind: "boolean" };
  }
  glob(options?: Omit<Options<GlobType>, keyof Documentation> & Documentation): GlobType {
    return options === undefined ? { kind: "glob" } : { ...options, kind: "glob" };
  }
  id(namespace: string, documentation?: Documentation): IdType {
    return documentation === undefined
      ? { kind: "id", namespace }
      : { ...documentation, kind: "id", namespace };
  }
  ref(name: string, documentation?: Documentation): ReferenceType {
    return documentation === undefined
      ? { kind: "ref", type: name }
      : { ...documentation, kind: "ref", type: name };
  }
  list(items: TypeExpression, documentation?: Documentation): ListType {
    return documentation === undefined
      ? { kind: "list", items }
      : { ...documentation, kind: "list", items };
  }
  set(items: TypeExpression, options?: Documentation & { readonly resolve?: string }): SetType {
    return options === undefined ? { kind: "set", items } : { ...options, kind: "set", items };
  }
  optional(value: TypeExpression, documentation?: Documentation): OptionalType {
    return documentation === undefined
      ? { kind: "optional", value }
      : { ...documentation, kind: "optional", value };
  }
  object(
    fields: Readonly<Record<string, TypeExpression>>,
    documentation?: Documentation,
  ): ObjectType {
    return documentation === undefined
      ? { kind: "object", fields }
      : { ...documentation, kind: "object", fields };
  }
  entity(
    options: Omit<Options<EntityTypeDefinition>, keyof Documentation> & Documentation,
  ): EntityTypeDefinition {
    return { ...options, kind: "entity" };
  }
  value(
    options: Omit<Options<ValueTypeDefinition>, keyof Documentation> & Documentation,
  ): ValueTypeDefinition {
    return { ...options, kind: "value" };
  }
  parameter(
    name: string,
    parameterType: TypeExpression,
    options?: Documentation & { readonly optional?: boolean; readonly default?: JsonValue },
  ): ParameterDefinition {
    return options === undefined
      ? { name, type: parameterType }
      : { ...options, name, type: parameterType };
  }
  resource(resourceType: TypeExpression, options: ResourceOptions): ResourceExport {
    return { ...options, kind: "resource", type: resourceType };
  }
  function(options: FunctionOptions): FunctionExport {
    return { ...options, kind: "function", parameters: normalizeParameters(options.parameters) };
  }
  method(options: MethodOptions): MethodDefinition {
    return { ...options, parameters: normalizeParameters(options.parameters) };
  }
}

function normalizeParameters(
  parameters: FunctionOptions["parameters"],
): readonly ParameterDefinition[] {
  if (parameters === undefined) return [];
  if (Array.isArray(parameters)) return [...parameters];
  return Object.entries(parameters).map(([name, value]) => {
    if (!("kind" in value)) return { ...value, name };
    const type = value as TypeExpression;
    const defaultValue = type.kind === "glob" ? type.default : undefined;
    let parameterType: TypeExpression = type;
    if (type.kind === "glob" && type.default !== undefined) {
      const { default: _default, ...withoutDefault } = type;
      parameterType = withoutDefault;
    }
    return {
      name,
      type: parameterType,
      ...(defaultValue === undefined ? {} : { default: defaultValue }),
    };
  });
}

export const type = new TypeBuilders();

function coreType(name: CoreTypeReference["type"]): CoreTypeReference {
  return { kind: "core", type: name };
}

export const core = {
  File: coreType("File"),
  Change: coreType("Change"),
  ChangeSet: coreType("ChangeSet"),
  Check: coreType("Check"),
} as const;

export type TypeBuilder = TypeBuilders;
export type CoreTypes = typeof core;
export type ExportDefinition = PluginExport;
