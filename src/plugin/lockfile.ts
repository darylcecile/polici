import { assertValid, childPath, ValidationContext, type ValidationResult } from "./validation.js";
import {
  validatePluginManifest,
  type PluginManifest,
  type PluginRuntimeKind,
  type PluginTransport,
} from "./manifest.js";
import { canonicalStringify, compareCodeUnits } from "./json.js";
import { sha256, sha256Bytes } from "../core/hash.js";

export const PLUGIN_LOCK_SCHEMA = "polici.lock/v2" as const;
export const PLUGIN_LOCK_VERSION = 2 as const;

export interface Sha256Digest {
  readonly algorithm: "sha256";
  readonly value: string;
}

export interface LockedRuntime {
  readonly kind: PluginRuntimeKind;
  readonly protocol: number;
  readonly entrypoint: string;
  readonly transport: PluginTransport;
  readonly capabilities: readonly string[];
}

export interface PluginSourceCoordinate {
  readonly kind: "registry" | "url" | "path" | "builtin";
  /** Exact immutable locator, such as a registry package coordinate or content-addressed URL. */
  readonly locator: string;
}

export interface LockedPlugin {
  readonly name: string;
  readonly version: string;
  readonly contractMajor: number;
  readonly source: PluginSourceCoordinate;
  readonly manifest: Sha256Digest;
  readonly artifact: Sha256Digest;
  readonly runtime: LockedRuntime;
}

export interface PluginLockfile {
  readonly schema: typeof PLUGIN_LOCK_SCHEMA;
  readonly schemaVersion: typeof PLUGIN_LOCK_VERSION;
  readonly plugins: readonly LockedPlugin[];
}

const PLUGIN_NAME = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CAPABILITY = /^[a-z][a-z0-9]*(?::[a-z][a-z0-9-]*)+$/;

export function validatePluginLockfile(value: unknown): ValidationResult<PluginLockfile> {
  const context = new ValidationContext();
  const path = "$lockfile";
  if (!context.record(value, path)) return context.result(value as unknown as PluginLockfile);
  context.keys(value, path, ["schema", "schemaVersion", "plugins"]);
  context.required(value, path, ["schema", "schemaVersion", "plugins"]);
  if (value.schema !== PLUGIN_LOCK_SCHEMA)
    context.issue(`${path}.schema`, "const", `expected ${JSON.stringify(PLUGIN_LOCK_SCHEMA)}`);
  if (value.schemaVersion !== PLUGIN_LOCK_VERSION)
    context.issue(`${path}.schemaVersion`, "const", `expected ${PLUGIN_LOCK_VERSION}`);
  if (!context.array(value.plugins, `${path}.plugins`))
    return context.result(value as unknown as PluginLockfile);
  const imports = new Set<string>();
  for (let index = 0; index < value.plugins.length; index += 1) {
    const pluginPath = childPath(`${path}.plugins`, index);
    const plugin = value.plugins[index];
    validateLockedPlugin(plugin, pluginPath, context);
    if (plugin && typeof plugin === "object" && !Array.isArray(plugin)) {
      const record = plugin as Record<string, unknown>;
      const name = record.name;
      const contractMajor = record.contractMajor;
      if (typeof name === "string" && typeof contractMajor === "number") {
        const key = `${name}@${contractMajor}`;
        if (imports.has(key))
          context.issue(
            `${pluginPath}.contractMajor`,
            "duplicate",
            "plugin name and contract major must be unique",
          );
        imports.add(key);
      }
    }
  }
  return context.result(value as unknown as PluginLockfile);
}

export function parsePluginLockfile(text: string): PluginLockfile {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new SyntaxError(
      `Plugin lockfile is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return assertValid("Plugin lockfile", validatePluginLockfile(value));
}

export function canonicalPluginLockfile(lockfile: PluginLockfile): Readonly<PluginLockfile> {
  assertValid("Plugin lockfile", validatePluginLockfile(lockfile));
  const ordered: PluginLockfile = {
    schema: PLUGIN_LOCK_SCHEMA,
    schemaVersion: PLUGIN_LOCK_VERSION,
    plugins: [...lockfile.plugins]
      .sort((left, right) => {
        const name = compareCodeUnits(left.name, right.name);
        if (name !== 0) return name;
        if (left.contractMajor !== right.contractMajor)
          return left.contractMajor - right.contractMajor;
        return compareCodeUnits(left.source.locator, right.source.locator);
      })
      .map((plugin) => ({
        ...plugin,
        source: { ...plugin.source },
        runtime: {
          ...plugin.runtime,
          capabilities: [...plugin.runtime.capabilities].sort(compareCodeUnits),
        },
      })),
  };
  return ordered;
}

export function pluginLockfileJson(lockfile: PluginLockfile): string {
  return `${canonicalStringify(canonicalPluginLockfile(lockfile))}\n`;
}

export function canonicalPluginManifestSha256(manifest: PluginManifest): Sha256Digest {
  assertValid("Plugin manifest", validatePluginManifest(manifest));
  return { algorithm: "sha256", value: sha256(canonicalStringify(manifest)) };
}

export function pluginArtifactSha256(artifact: Uint8Array): Sha256Digest {
  return { algorithm: "sha256", value: sha256Bytes(artifact) };
}

export interface CreateLockedPluginOptions {
  readonly source: PluginSourceCoordinate;
  readonly manifest: PluginManifest;
  readonly artifact: Uint8Array;
}

export function createLockedPlugin(options: CreateLockedPluginOptions): Readonly<LockedPlugin> {
  const manifest = options.manifest;
  const locked: LockedPlugin = {
    name: manifest.name,
    version: manifest.version,
    contractMajor: manifest.contractMajor,
    source: { ...options.source },
    manifest: canonicalPluginManifestSha256(manifest),
    artifact: pluginArtifactSha256(options.artifact),
    runtime: {
      kind: manifest.runtime.kind,
      protocol: manifest.runtime.protocol,
      entrypoint: manifest.runtime.entrypoint,
      transport: manifest.runtime.transport,
      capabilities: [...manifest.runtime.capabilities],
    },
  };
  const context = new ValidationContext();
  validateLockedPlugin(locked, "$lockedPlugin", context);
  return assertValid("Locked plugin", context.result(locked));
}

export function validateLockedPluginAgainstManifest(
  locked: LockedPlugin,
  manifest: PluginManifest,
): ValidationResult<LockedPlugin> {
  const context = new ValidationContext();
  const path = "$lockedPlugin";
  validateLockedPlugin(locked, path, context);
  if (locked.name !== manifest.name)
    context.issue(
      `${path}.name`,
      "manifest",
      `expected manifest name ${JSON.stringify(manifest.name)}`,
    );
  if (locked.version !== manifest.version)
    context.issue(
      `${path}.version`,
      "manifest",
      `expected manifest version ${JSON.stringify(manifest.version)}`,
    );
  if (locked.contractMajor !== manifest.contractMajor)
    context.issue(
      `${path}.contractMajor`,
      "manifest",
      `expected provider contract major ${manifest.contractMajor}`,
    );
  if (locked.runtime.kind !== manifest.runtime.kind)
    context.issue(`${path}.runtime.kind`, "manifest", `expected ${manifest.runtime.kind}`);
  if (locked.runtime.protocol !== manifest.runtime.protocol)
    context.issue(`${path}.runtime.protocol`, "manifest", `expected ${manifest.runtime.protocol}`);
  if (locked.runtime.entrypoint !== manifest.runtime.entrypoint)
    context.issue(
      `${path}.runtime.entrypoint`,
      "manifest",
      `expected ${JSON.stringify(manifest.runtime.entrypoint)}`,
    );
  if (locked.runtime.transport !== manifest.runtime.transport)
    context.issue(
      `${path}.runtime.transport`,
      "manifest",
      `expected ${manifest.runtime.transport}`,
    );
  if (!sameStrings(locked.runtime.capabilities, manifest.runtime.capabilities))
    context.issue(
      `${path}.runtime.capabilities`,
      "manifest",
      "capabilities do not match the manifest",
    );
  const digest = canonicalPluginManifestSha256(manifest);
  if (locked.manifest.algorithm !== digest.algorithm || locked.manifest.value !== digest.value)
    context.issue(`${path}.manifest`, "integrity", "canonical manifest SHA-256 does not match");
  return context.result(locked);
}

export function assertLockedPluginAgainstManifest(
  locked: LockedPlugin,
  manifest: PluginManifest,
): LockedPlugin {
  return assertValid("Locked plugin", validateLockedPluginAgainstManifest(locked, manifest));
}

export function validateLockedPluginArtifact(
  locked: LockedPlugin,
  artifact: Uint8Array,
): ValidationResult<LockedPlugin> {
  const context = new ValidationContext();
  validateLockedPlugin(locked, "$lockedPlugin", context);
  const digest = pluginArtifactSha256(artifact);
  if (locked.artifact.algorithm !== digest.algorithm || locked.artifact.value !== digest.value)
    context.issue("$lockedPlugin.artifact", "integrity", "artifact SHA-256 does not match");
  return context.result(locked);
}

export function assertLockedPluginArtifact(
  locked: LockedPlugin,
  artifact: Uint8Array,
): LockedPlugin {
  return assertValid("Locked plugin artifact", validateLockedPluginArtifact(locked, artifact));
}

export function assertLockedPluginIntegrity(
  locked: LockedPlugin,
  manifest: PluginManifest,
  artifact: Uint8Array,
): LockedPlugin {
  assertLockedPluginAgainstManifest(locked, manifest);
  return assertLockedPluginArtifact(locked, artifact);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort(compareCodeUnits);
  const sortedRight = [...right].sort(compareCodeUnits);
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

function validateLockedPlugin(value: unknown, path: string, context: ValidationContext): void {
  if (!context.record(value, path)) return;
  context.keys(value, path, [
    "name",
    "version",
    "contractMajor",
    "source",
    "manifest",
    "artifact",
    "runtime",
  ]);
  context.required(value, path, [
    "name",
    "version",
    "contractMajor",
    "source",
    "manifest",
    "artifact",
    "runtime",
  ]);
  context.string(value.name, `${path}.name`, PLUGIN_NAME);
  context.string(value.version, `${path}.version`, SEMVER);
  context.integer(value.contractMajor, `${path}.contractMajor`, 1);
  validateSource(value.source, `${path}.source`, context);
  validateDigest(value.manifest, `${path}.manifest`, context);
  validateDigest(value.artifact, `${path}.artifact`, context);
  validateRuntime(value.runtime, `${path}.runtime`, context);
}

function validateSource(value: unknown, path: string, context: ValidationContext): void {
  if (!context.record(value, path)) return;
  context.keys(value, path, ["kind", "locator"]);
  context.required(value, path, ["kind", "locator"]);
  if (!["registry", "url", "path", "builtin"].includes(value.kind as string))
    context.issue(`${path}.kind`, "enum", "unknown plugin source kind");
  if (context.string(value.locator, `${path}.locator`)) {
    if (value.locator.length === 0 || hasControlCodeUnit(value.locator))
      context.issue(`${path}.locator`, "format", "source locator must be non-empty and printable");
  }
}

function hasControlCodeUnit(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function validateDigest(value: unknown, path: string, context: ValidationContext): void {
  if (!context.record(value, path)) return;
  context.keys(value, path, ["algorithm", "value"]);
  context.required(value, path, ["algorithm", "value"]);
  if (value.algorithm !== "sha256")
    context.issue(`${path}.algorithm`, "const", 'expected "sha256"');
  context.string(value.value, `${path}.value`, SHA256);
}

function validateRuntime(value: unknown, path: string, context: ValidationContext): void {
  if (!context.record(value, path)) return;
  context.keys(value, path, ["kind", "protocol", "entrypoint", "transport", "capabilities"]);
  context.required(value, path, ["kind", "protocol", "entrypoint", "transport", "capabilities"]);
  if (value.kind !== "typescript" && value.kind !== "wasm")
    context.issue(`${path}.kind`, "enum", 'expected "typescript" or "wasm"');
  context.integer(value.protocol, `${path}.protocol`, 1);
  if (context.string(value.entrypoint, `${path}.entrypoint`)) {
    if (!isSafeEntrypoint(value.entrypoint))
      context.issue(
        `${path}.entrypoint`,
        "path",
        "entrypoint must be a package-relative ./ path without traversal",
      );
    if (value.kind === "wasm" && !value.entrypoint.endsWith(".wasm"))
      context.issue(`${path}.entrypoint`, "path", "WASM entrypoint must end in .wasm");
  }
  if (value.transport !== "jsonl" && value.transport !== "length-prefixed")
    context.issue(`${path}.transport`, "enum", 'expected "jsonl" or "length-prefixed"');
  if (!context.array(value.capabilities, `${path}.capabilities`)) return;
  const capabilities = new Set<string>();
  for (let index = 0; index < value.capabilities.length; index += 1) {
    const capability = value.capabilities[index];
    if (!context.string(capability, `${path}.capabilities[${index}]`, CAPABILITY)) continue;
    if (capabilities.has(capability))
      context.issue(`${path}.capabilities[${index}]`, "duplicate", "duplicate capability");
    capabilities.add(capability);
  }
}

function isSafeEntrypoint(value: string): boolean {
  if (!value.startsWith("./") || value.includes("\\") || value.includes("\0")) return false;
  const segments = value.slice(2).split("/");
  return (
    segments.length > 0 &&
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}
