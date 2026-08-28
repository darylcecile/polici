// @ts-ignore This bare repository intentionally uses ScriptC's Node built-ins.
import * as fs from "node:fs";
// @ts-ignore This bare repository intentionally uses ScriptC's Node built-ins.
import * as os from "node:os";
// @ts-ignore This bare repository intentionally uses ScriptC's Node built-ins.
import * as path from "node:path";

import type { CompiledPolicy, LockedPluginInput } from "../engine/types.js";
import {
  assertLockedPluginIntegrity,
  createLockedPlugin,
  parsePluginLockfile,
  pluginLockfileJson,
  type LockedPlugin,
  type PluginLockfile,
} from "../plugin/lockfile.js";
import { parsePluginManifest, type PluginManifest } from "../plugin/manifest.js";
import type { RuntimeCapability } from "../plugin/protocol.js";
import type { CapabilityBroker, ResolverHost } from "../plugin/resolver.js";
import { githubCapabilities, githubManifest } from "../../providers/github/index.js";
import type { CliArguments } from "./arguments.js";
import {
  MAX_ARTIFACT_BYTES,
  MAX_SOURCE_BYTES,
  decodeUtf8,
  exists,
  joinRepositoryPath,
  relativeLocator,
  secureReadFile,
  validatePathLocator,
} from "./files.js";
import { readGitFile, type GitEnvironment } from "./git.js";
import { GITHUB_BUILTIN_ARTIFACT } from "./github-artifact.generated.js";
import type { CliProcessRunner } from "./process.js";
import {
  CliTypeScriptProcessResolverHost,
  CliWasiProcessResolverHost,
  type CliHardenedRuntimeSandbox,
} from "./runtime.js";

export const GITHUB_BUILTIN_LOCATOR = "polici:provider:github@1.0.0";

export interface PolicyImport {
  readonly source: string;
  readonly name: string;
  readonly contractMajor: number;
  readonly alias: string;
}

export interface TrustedFiles {
  readonly repositoryRoot: string;
  readonly revision?: string;
  readonly environment: GitEnvironment;
  read(repositoryPath: string, maximumBytes: number, label: string): Uint8Array;
}

export interface LoadedPlugins {
  readonly lockfile: PluginLockfile;
  readonly lockedPlugins: readonly LockedPluginInput[];
}

export interface RuntimeSet {
  readonly resolvers: Readonly<Record<string, ResolverHost>>;
  dispose(): Promise<void>;
}

export function localTrustedFiles(
  repositoryRoot: string,
  environment: GitEnvironment,
): TrustedFiles {
  return {
    repositoryRoot,
    environment,
    read(repositoryPath, maximumBytes, label) {
      return secureReadFile(path.resolve(repositoryRoot, repositoryPath), maximumBytes, label);
    },
  };
}

export function gitTrustedFiles(
  repositoryRoot: string,
  revision: string,
  environment: GitEnvironment,
  runProcess: CliProcessRunner,
): TrustedFiles {
  return {
    repositoryRoot,
    revision,
    environment,
    read(repositoryPath, maximumBytes) {
      return readGitFile(
        repositoryRoot,
        revision,
        repositoryPath,
        environment,
        runProcess,
        maximumBytes,
      );
    },
  };
}

export function githubLockedPlugin(): LockedPluginInput {
  const lock = createLockedPlugin({
    source: { kind: "builtin", locator: GITHUB_BUILTIN_LOCATOR },
    manifest: githubManifest,
    artifact: GITHUB_BUILTIN_ARTIFACT,
  });
  return { lock, manifest: githubManifest, artifact: new Uint8Array(GITHUB_BUILTIN_ARTIFACT) };
}

export function buildLockfile(
  imports: readonly PolicyImport[],
  pluginManifestPaths: readonly string[],
  repositoryRoot: string,
  lockfileAbsolutePath: string,
): LoadedPlugins {
  const available = new Map<string, LockedPluginInput>();
  const github = githubLockedPlugin();
  available.set(pluginKey(github.manifest.name, github.manifest.contractMajor), github);

  for (const manifestInput of pluginManifestPaths) {
    const manifestAbsolutePath = path.resolve(repositoryRoot, manifestInput);
    const locator = relativeLocator(lockfileAbsolutePath, manifestAbsolutePath);
    const manifestBytes = secureReadFile(manifestAbsolutePath, MAX_SOURCE_BYTES, "Plugin manifest");
    const manifest = parsePluginManifest(decodeUtf8(manifestBytes, "Plugin manifest"));
    if (manifest.name === "github" && manifest.contractMajor === 1)
      throw new TypeError("github@1 is provided only by the built-in host implementation.");
    const artifactPath = artifactAbsolutePath(manifestAbsolutePath, manifest);
    const artifact = secureReadFile(artifactPath, MAX_ARTIFACT_BYTES, "Plugin artifact");
    const input: LockedPluginInput = {
      lock: createLockedPlugin({ source: { kind: "path", locator }, manifest, artifact }),
      manifest,
      artifact,
    };
    const key = pluginKey(manifest.name, manifest.contractMajor);
    if (available.has(key))
      throw new TypeError(`Plugin source for ${key} was specified more than once.`);
    available.set(key, input);
  }

  const selected: LockedPluginInput[] = [];
  const seen = new Set<string>();
  for (const imported of imports) {
    const key = pluginKey(imported.name, imported.contractMajor);
    if (seen.has(key)) continue;
    seen.add(key);
    const plugin = available.get(key);
    if (plugin === undefined)
      throw new TypeError(
        `No --plugin manifest resolves policy import ${JSON.stringify(imported.source)}.`,
      );
    selected.push(plugin);
  }
  const lockfile: PluginLockfile = {
    schema: "polici.lock/v2",
    schemaVersion: 2,
    plugins: selected.map((plugin) => plugin.lock),
  };
  // Serialization performs final canonical validation and rejects ambiguity.
  parsePluginLockfile(pluginLockfileJson(lockfile));
  return { lockfile, lockedPlugins: selected };
}

export function loadLockedPlugins(
  lockfileText: string,
  lockfileRepositoryPath: string,
  imports: readonly PolicyImport[],
  files: TrustedFiles,
): LoadedPlugins {
  const lockfile = parsePluginLockfile(lockfileText);
  const expected = new Map<string, PolicyImport>();
  for (const imported of imports)
    expected.set(pluginKey(imported.name, imported.contractMajor), imported);
  if (lockfile.plugins.length !== expected.size)
    throw new TypeError("Lockfile entries must exactly match policy imports; run 'polici lock'.");

  const loaded: LockedPluginInput[] = [];
  for (const lock of lockfile.plugins) {
    const key = pluginKey(lock.name, lock.contractMajor);
    if (!expected.has(key)) throw new TypeError(`Lockfile contains stale plugin ${key}.`);
    if (lock.source.kind === "builtin") {
      if (
        lock.name !== "github" ||
        lock.contractMajor !== 1 ||
        lock.source.locator !== GITHUB_BUILTIN_LOCATOR
      )
        throw new TypeError(
          `Unknown built-in provider source ${JSON.stringify(lock.source.locator)}.`,
        );
      const input = githubLockedPlugin();
      assertSameLockedSource(lock, input.lock);
      assertLockedPluginIntegrity(lock, input.manifest, input.artifact);
      loaded.push({ lock, manifest: input.manifest, artifact: input.artifact });
      continue;
    }
    if (lock.source.kind !== "path")
      throw new TypeError(
        `CLI cannot resolve ${lock.source.kind} source ${JSON.stringify(lock.source.locator)}.`,
      );
    const locator = validatePathLocator(lock.source.locator);
    const lockDirectory = repositoryDirectory(lockfileRepositoryPath);
    const manifestPath = joinRepositoryPath(lockDirectory, locator);
    const manifest = parsePluginManifest(
      decodeUtf8(files.read(manifestPath, MAX_SOURCE_BYTES, "Plugin manifest"), "Plugin manifest"),
    );
    const entrypoint = lock.runtime.entrypoint.slice(2);
    const artifactPath = joinRepositoryPath(repositoryDirectory(manifestPath), entrypoint);
    const artifact = files.read(artifactPath, MAX_ARTIFACT_BYTES, "Plugin artifact");
    assertLockedPluginIntegrity(lock, manifest, artifact);
    loaded.push({ lock, manifest, artifact });
  }
  return { lockfile, lockedPlugins: loaded };
}

export function preflightPlugins(
  compiled: CompiledPolicy,
  plugins: LoadedPlugins,
  arguments_: CliArguments,
): void {
  const bindings = new Map(
    compiled.pluginBindings.map((binding) => [
      pluginKey(binding.name, binding.contractMajor),
      binding,
    ]),
  );
  for (const plugin of plugins.lockedPlugins) {
    const key = pluginKey(plugin.manifest.name, plugin.manifest.contractMajor);
    if (!bindings.has(key))
      throw new TypeError(`Verified plugin ${key} was not selected by compilation.`);
    const granted =
      key === "github@1"
        ? githubCapabilities.map((capability) => capability.name)
        : plugin.manifest.runtime.capabilities;
    const denied = plugin.manifest.permissions.filter(
      (permission) => !granted.includes(permission),
    );
    if (denied.length > 0)
      throw new TypeError(`Plugin ${key} requires ungranted capabilities: ${denied.join(", ")}.`);
    if (arguments_.offline && key === "github@1")
      throw new TypeError(
        "github@1 is unavailable in --offline mode because it requires GitHub API access.",
      );
    if (arguments_.offline && arguments_.trustedPlugins.includes(key))
      throw new TypeError(`Trusted native plugin ${key} is unavailable in --offline mode.`);
  }
  for (const trusted of arguments_.trustedPlugins) {
    if (!/^[a-z][a-z0-9.-]*@[1-9][0-9]*$/.test(trusted))
      throw new TypeError(
        `Trusted plugin selector ${JSON.stringify(trusted)} must have name@major form.`,
      );
    const input = plugins.lockedPlugins.find(
      (plugin) => pluginKey(plugin.manifest.name, plugin.manifest.contractMajor) === trusted,
    );
    if (input === undefined)
      throw new TypeError(`Trusted plugin selector ${trusted} is not locked.`);
    if (input.manifest.runtime.kind !== "typescript")
      throw new TypeError(`--trust-plugin applies only to native TypeScript-authored runtimes.`);
  }
}

export async function createRuntimeSet(
  compiled: CompiledPolicy,
  plugins: LoadedPlugins,
  arguments_: CliArguments,
  createGitHub: (repositoryAlias: string) => ResolverHost,
  runProcess: CliProcessRunner,
): Promise<RuntimeSet> {
  const resolvers: Record<string, ResolverHost> = {};
  const cacheDirectories: string[] = [];
  const hosts: ResolverHost[] = [];
  try {
    for (const imported of compiled.ir.imports) {
      const key = pluginKey(imported.provider, imported.apiVersion);
      const plugin = plugins.lockedPlugins.find(
        (candidate) => pluginKey(candidate.manifest.name, candidate.manifest.contractMajor) === key,
      );
      if (plugin === undefined) throw new TypeError(`No verified runtime exists for ${key}.`);
      if (key === "github@1") {
        const host = createGitHub(imported.alias);
        resolvers[imported.alias] = host;
        hosts.push(host);
        continue;
      }
      const materialized = materializeArtifact(plugin);
      cacheDirectories.push(materialized.directory);
      const capabilities = runtimeCapabilities(plugin.manifest);
      let host: ResolverHost;
      if (plugin.manifest.runtime.kind === "typescript") {
        const trustedRuntime = arguments_.trustedPlugins.includes(key);
        const sandbox: CliHardenedRuntimeSandbox | undefined =
          trustedRuntime || arguments_.sandboxLauncher === undefined
            ? undefined
            : {
                launcher: arguments_.sandboxLauncher,
                arguments: arguments_.sandboxArguments,
                denyNetwork: true,
                denyFilesystem: true,
                denyEnvironment: true,
                denyChildProcess: true,
              };
        host = new CliTypeScriptProcessResolverHost({
          cwd: materialized.directory,
          entrypoint: materialized.entrypoint,
          plugin: { name: plugin.manifest.name, version: plugin.manifest.version },
          transport: plugin.manifest.runtime.transport,
          capabilities,
          capabilityBroker: unavailableCapabilityBroker(key),
          runProcess,
          trustedRuntime,
          ...(sandbox === undefined ? {} : { sandbox }),
        });
      } else {
        host = new CliWasiProcessResolverHost({
          cwd: materialized.directory,
          entrypoint: materialized.entrypoint,
          plugin: { name: plugin.manifest.name, version: plugin.manifest.version },
          transport: plugin.manifest.runtime.transport,
          capabilities,
          capabilityBroker: unavailableCapabilityBroker(key),
          runProcess,
          ...(arguments_.wasiCommand === undefined ? {} : { command: arguments_.wasiCommand }),
          commandArguments: arguments_.wasiArguments,
        });
      }
      resolvers[imported.alias] = host;
      hosts.push(host);
    }
  } catch (error) {
    await disposeRuntimeResources(hosts, cacheDirectories);
    throw error;
  }
  return {
    resolvers,
    async dispose() {
      await disposeRuntimeResources(hosts, cacheDirectories);
    },
  };
}

function artifactAbsolutePath(manifestPath: string, manifest: PluginManifest): string {
  const entrypoint = manifest.runtime.entrypoint.slice(2);
  const absolute = path.resolve(path.dirname(manifestPath), entrypoint);
  const relative = path.relative(path.dirname(manifestPath), absolute).replace(/\\/g, "/");
  if (relative !== entrypoint) throw new TypeError("Plugin entrypoint is not canonical.");
  return absolute;
}

function materializeArtifact(plugin: LockedPluginInput): {
  readonly directory: string;
  readonly entrypoint: string;
} {
  // @ts-ignore ScriptC and Node both support private temporary directories.
  const directory = fs.mkdtempSync(path.resolve(os.tmpdir(), "polici-runtime-")) as string;
  try {
    // @ts-ignore Newly created cache directories can be restricted on both runtimes.
    fs.chmodSync(directory, 0o700);
    const entrypoint = plugin.manifest.runtime.entrypoint;
    const target = path.resolve(directory, entrypoint.slice(2));
    const parent = path.dirname(target);
    // @ts-ignore Recursive directory creation is supported by Node and ScriptC.
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    // @ts-ignore Exact verified bytes are materialized without text conversion.
    fs.writeFileSync(target, plugin.artifact);
    fs.chmodSync(target, plugin.manifest.runtime.kind === "typescript" ? 0o700 : 0o600);
    return { directory, entrypoint };
  } catch (error) {
    // @ts-ignore Recursive removal is supported by Node and ScriptC.
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

async function disposeRuntimeResources(
  hosts: readonly ResolverHost[],
  directories: readonly string[],
): Promise<void> {
  let failure: unknown;
  for (const host of hosts) {
    try {
      await host.dispose?.();
    } catch (error) {
      failure ??= error;
    }
  }
  for (const directory of directories) {
    try {
      if (exists(directory)) {
        // @ts-ignore Recursive removal is supported by Node and ScriptC.
        fs.rmSync(directory, { recursive: true, force: true });
      }
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

function runtimeCapabilities(manifest: PluginManifest): readonly RuntimeCapability[] {
  const operations = resolverNames(manifest);
  return manifest.runtime.capabilities.map((name) => ({ name, operations }));
}

function unavailableCapabilityBroker(plugin: string): CapabilityBroker {
  return async (request) => ({
    ok: false,
    error: {
      code: "CAPABILITY_NOT_CONFIGURED",
      kind: "capability",
      message: `No host capability broker is configured for ${plugin}: ${request.capability}.${request.operation}`,
      retryable: false,
    },
  });
}

function resolverNames(manifest: PluginManifest): readonly string[] {
  const names = new Set<string>();
  for (const exported of Object.values(manifest.exports)) names.add(exported.resolve);
  for (const type of Object.values(manifest.types)) {
    for (const field of Object.values(type.fields)) {
      if (field.kind === "set" && field.resolve !== undefined) names.add(field.resolve);
    }
  }
  return [...names].sort();
}

function repositoryDirectory(repositoryPath: string): string {
  const slash = repositoryPath.lastIndexOf("/");
  return slash < 0 ? "" : repositoryPath.slice(0, slash);
}

function pluginKey(name: string, contractMajor: number): string {
  return `${name}@${contractMajor}`;
}

function assertSameLockedSource(actual: LockedPlugin, expected: LockedPlugin): void {
  if (
    actual.name !== expected.name ||
    actual.version !== expected.version ||
    actual.contractMajor !== expected.contractMajor ||
    actual.source.kind !== expected.source.kind ||
    actual.source.locator !== expected.source.locator
  )
    throw new TypeError("Built-in github lock entry does not select the embedded provider.");
}
