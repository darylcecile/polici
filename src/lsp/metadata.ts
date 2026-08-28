export interface StaticParameter {
  readonly name: string;
  readonly type: string;
  readonly optional: boolean;
  readonly hasDefault: boolean;
  readonly defaultText: string;
  readonly documentation: string;
}

/** Fixed-shape record: native code never retains optional or union-shaped manifest slots. */
export interface StaticExport {
  readonly kind: "function" | "resource";
  readonly name: string;
  readonly parameters: readonly StaticParameter[];
  readonly returns: string;
  readonly resultTypeName: string;
  readonly documentation: string;
}

export interface StaticField {
  readonly name: string;
  readonly type: string;
  readonly typeName: string;
  readonly documentation: string;
}

export interface StaticNamedType {
  readonly name: string;
  readonly fields: readonly StaticField[];
  readonly documentation: string;
}

export interface StaticPlugin {
  readonly name: string;
  readonly version: string;
  readonly contractMajor: number;
  readonly documentation: string;
  readonly types: readonly StaticNamedType[];
  readonly exports: readonly StaticExport[];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function documentation(value: unknown): string {
  const source = record(value);
  const parts: string[] = [];
  if (text(source.summary) !== "") parts.push(text(source.summary));
  if (text(source.description) !== "") parts.push(text(source.description));
  if (text(source.deprecated) !== "") parts.push(`Deprecated: ${text(source.deprecated)}`);
  if (Array.isArray(source.examples) && source.examples.length > 0)
    parts.push(`Examples: ${source.examples.join(", ")}`);
  return parts.join("\n\n");
}

function typeName(value: unknown): string {
  const type = record(value);
  if (type.kind === "ref") return text(type.type);
  if (type.kind === "optional") return typeName(type.value);
  return "";
}

function typeText(value: unknown, pluginName: string): string {
  const type = record(value);
  const kind = text(type.kind);
  if (kind === "string" || kind === "integer" || kind === "boolean" || kind === "glob") return kind;
  if (kind === "id") return "string";
  if (kind === "ref") return `${pluginName}.${text(type.type)}`;
  if (kind === "core") return text(type.type);
  if (kind === "list") return `Collection<${typeText(type.items, pluginName)}>`;
  if (kind === "set") return `Set<${typeText(type.items, pluginName)}>`;
  if (kind === "optional") return typeText(type.value, pluginName);
  if (kind === "object") return "Json";
  return "unknown";
}

function defaultText(value: unknown): string {
  const result = JSON.stringify(value);
  return result === undefined ? "" : result;
}

/** Normalizes already-validated v2 JSON before it is retained by the language server. */
export function normalizePluginManifest(value: unknown): StaticPlugin {
  const manifest = record(value);
  const pluginName = text(manifest.name);
  const types: StaticNamedType[] = [];
  for (const [name, rawDefinition] of Object.entries(record(manifest.types))) {
    const definition = record(rawDefinition);
    const fields: StaticField[] = [];
    for (const [fieldName, field] of Object.entries(record(definition.fields))) {
      fields.push({
        name: fieldName,
        type: typeText(field, pluginName),
        typeName: typeName(field),
        documentation: documentation(field),
      });
    }
    types.push({ name, fields, documentation: documentation(definition) });
  }

  const exports: StaticExport[] = [];
  for (const [name, rawItem] of Object.entries(record(manifest.exports))) {
    const item = record(rawItem);
    if (item.kind === "function") {
      const parameters: StaticParameter[] = [];
      const rawParameters = Array.isArray(item.parameters) ? (item.parameters as unknown[]) : [];
      for (const rawParameter of rawParameters) {
        const parameter = record(rawParameter);
        const hasDefault = parameter.default !== undefined;
        parameters.push({
          name: text(parameter.name),
          type: typeText(parameter.type, pluginName),
          optional: parameter.optional === true || hasDefault,
          hasDefault,
          defaultText: hasDefault ? defaultText(parameter.default) : "",
          documentation: documentation(parameter),
        });
      }
      exports.push({
        kind: "function",
        name,
        parameters,
        returns: typeText(item.returns, pluginName),
        resultTypeName: typeName(item.returns),
        documentation: documentation(item),
      });
    } else {
      exports.push({
        kind: "resource",
        name,
        parameters: [],
        returns: typeText(item.type, pluginName),
        resultTypeName: typeName(item.type),
        documentation: documentation(item),
      });
    }
  }
  return {
    name: pluginName,
    version: text(manifest.version),
    contractMajor: typeof manifest.contractMajor === "number" ? manifest.contractMajor : 0,
    documentation: documentation(manifest.documentation),
    types,
    exports,
  };
}
