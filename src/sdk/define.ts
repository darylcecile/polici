import {
  PLUGIN_MANIFEST_SCHEMA,
  PLUGIN_MANIFEST_VERSION,
  PLUGIN_RUNTIME_PROTOCOL_VERSION,
  POLICI_PLUGIN_API_MAJOR,
  validatePluginManifest,
  type Documentation,
  type NamedTypeDefinition,
  type PluginExport,
  type PluginManifest,
  type PluginRuntimeKind,
  type PluginTransport,
} from "../plugin/manifest.js";
import { assertValid } from "../plugin/validation.js";
import {
  canonicalizeJson,
  canonicalStringify,
  deepFreezeJson,
  validateJsonValue,
  type JsonValue,
} from "../plugin/json.js";

export interface PluginDefinition {
  readonly name: string;
  readonly version: string;
  readonly policiApi: typeof POLICI_PLUGIN_API_MAJOR;
  readonly contractMajor: number;
  readonly types?: Readonly<Record<string, NamedTypeDefinition>>;
  readonly exports?: Readonly<Record<string, PluginExport>>;
  readonly permissions?: readonly string[];
  readonly runtime: {
    readonly kind: PluginRuntimeKind;
    readonly entrypoint: string;
    readonly protocol?: typeof PLUGIN_RUNTIME_PROTOCOL_VERSION;
    readonly transport?: PluginTransport;
    readonly capabilities?: readonly string[];
  };
  readonly documentation?: Documentation;
}

declare const pluginDefinitionType: unique symbol;

export type DefinedPlugin<Definition extends PluginDefinition = PluginDefinition> =
  Readonly<PluginManifest> & {
    readonly [pluginDefinitionType]?: Definition;
  };

export function definePlugin<const Definition extends PluginDefinition>(
  definition: Definition,
): DefinedPlugin<Definition> {
  assertValid("Plugin definition", validateJsonValue(definition, "$definition"));
  const permissions = sortedUnique(definition.permissions ?? []);
  const manifest: PluginManifest = {
    schema: PLUGIN_MANIFEST_SCHEMA,
    schemaVersion: PLUGIN_MANIFEST_VERSION,
    name: definition.name,
    version: definition.version,
    policiApi: definition.policiApi,
    contractMajor: definition.contractMajor,
    types: definition.types ?? {},
    exports: definition.exports ?? {},
    permissions,
    runtime: {
      kind: definition.runtime.kind,
      protocol: definition.runtime.protocol ?? PLUGIN_RUNTIME_PROTOCOL_VERSION,
      entrypoint: compiledEntrypoint(definition.runtime.kind, definition.runtime.entrypoint),
      transport: definition.runtime.transport ?? "jsonl",
      capabilities: sortedUnique(definition.runtime.capabilities ?? permissions),
    },
    ...(definition.documentation === undefined ? {} : { documentation: definition.documentation }),
  };
  assertValid("Plugin manifest", validatePluginManifest(manifest));
  const canonical = canonicalizeJson(manifest as unknown as JsonValue) as unknown as PluginManifest;
  return deepFreezeJson(canonical as unknown as JsonValue) as unknown as DefinedPlugin<Definition>;
}

export default definePlugin;

export function pluginManifestJson(manifest: PluginManifest): string {
  assertValid("Plugin manifest", validatePluginManifest(manifest));
  return `${canonicalStringify(manifest)}\n`;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function compiledEntrypoint(kind: PluginRuntimeKind, entrypoint: string): string {
  if (kind !== "typescript") return entrypoint;
  return entrypoint.replace(/\.(?:ts|tsx|mts|cts)$/, "");
}
