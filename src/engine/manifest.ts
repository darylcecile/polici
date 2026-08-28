import type {
  Documentation,
  ParameterDefinition,
  PluginManifest,
  TypeExpression,
} from "../plugin/manifest.js";
import type {
  ManifestFieldDefinition,
  ManifestFunctionDefinition,
  ManifestParameterDefinition,
  ManifestResourceDefinition,
  ManifestTypeDefinition,
  ManifestTypeSpec,
  ProviderManifest,
} from "../language/model.ts";

function documentation(value: Documentation | undefined): string | undefined {
  if (value === undefined) return undefined;
  const paragraphs: string[] = [];
  if (value.summary) paragraphs.push(value.summary);
  if (value.description) paragraphs.push(value.description);
  if (value.deprecated) paragraphs.push(`Deprecated: ${value.deprecated}`);
  if (value.examples?.length) paragraphs.push(`Examples: ${value.examples.join(", ")}`);
  return paragraphs.length === 0 ? undefined : paragraphs.join("\n\n");
}

function adaptType(expression: TypeExpression): ManifestTypeSpec {
  switch (expression.kind) {
    case "string":
    case "id":
      return "string";
    case "integer":
      return "integer";
    case "boolean":
      return "boolean";
    case "glob":
      return "glob";
    case "ref":
      return { kind: "ref", name: expression.type };
    case "core":
      return `core.${expression.type}`;
    case "list":
      return { kind: "collection", element: adaptType(expression.items) };
    case "set":
      return { kind: "set", element: adaptType(expression.items) };
    case "optional":
      return adaptType(expression.value);
    case "object":
      return { kind: "json" };
  }
}

function adaptParameter(parameter: ParameterDefinition): ManifestParameterDefinition {
  const result: {
    type: ManifestTypeSpec;
    optional?: boolean;
    default?: string | number | boolean | null;
    documentation?: string;
  } = { type: adaptType(parameter.type) };
  if (parameter.optional === true || parameter.default !== undefined) result.optional = true;
  if (
    parameter.default === null ||
    typeof parameter.default === "string" ||
    typeof parameter.default === "number" ||
    typeof parameter.default === "boolean"
  ) {
    result.default = parameter.default;
  }
  const docs = documentation(parameter);
  if (docs !== undefined) result.documentation = docs;
  return result;
}

/** Converts a strict plugin contract into language-only metadata without loading its runtime. */
export function adaptPluginManifest(manifest: PluginManifest): ProviderManifest {
  const types: Record<string, ManifestTypeDefinition> = {};
  for (const [name, definition] of Object.entries(manifest.types)) {
    const fields: Record<string, ManifestFieldDefinition> = {};
    for (const [fieldName, field] of Object.entries(definition.fields)) {
      const docs = documentation(field);
      fields[fieldName] = {
        type: adaptType(field),
        ...(docs === undefined ? {} : { documentation: docs }),
      };
    }
    const docs = documentation(definition);
    types[name] = {
      kind: definition.kind,
      ...(definition.kind === "entity" ? { identity: definition.identity } : {}),
      fields,
      ...(definition.kind === "entity" && definition.methods !== undefined
        ? {
            methods: Object.fromEntries(
              Object.entries(definition.methods).map(([methodName, method]) => {
                const methodDocs = documentation(method);
                return [
                  methodName,
                  {
                    parameters: method.parameters.map((parameter) => {
                      const adapted = adaptParameter(parameter);
                      return { ...adapted, name: parameter.name };
                    }),
                    returns: adaptType(method.returns),
                    resolve: method.resolve,
                    ...(methodDocs === undefined ? {} : { documentation: methodDocs }),
                  },
                ];
              }),
            ),
          }
        : {}),
      ...(docs === undefined ? {} : { documentation: docs }),
    };
  }

  const exports: Record<string, ManifestResourceDefinition | ManifestFunctionDefinition> = {};
  for (const [name, definition] of Object.entries(manifest.exports)) {
    const docs = documentation(definition);
    if (definition.kind === "resource") {
      exports[name] = {
        kind: "resource",
        type: adaptType(definition.type),
        resolve: definition.resolve,
        ...(docs === undefined ? {} : { documentation: docs }),
      };
    } else {
      exports[name] = {
        kind: "function",
        parameters: definition.parameters.map((parameter) => {
          const adapted = adaptParameter(parameter);
          return { ...adapted, name: parameter.name };
        }),
        returns: adaptType(definition.returns),
        resolve: definition.resolve,
        ...(docs === undefined ? {} : { documentation: docs }),
      };
    }
  }

  const docs = documentation(manifest.documentation);
  return {
    name: manifest.name,
    version: manifest.version,
    policiApi: manifest.policiApi,
    apiVersion: manifest.contractMajor,
    types,
    exports,
    permissions: manifest.permissions,
    ...(docs === undefined ? {} : { documentation: docs }),
  };
}
