// @ts-ignore This bare repository intentionally does not depend on @types/node.
import { existsSync, lstatSync, readFileSync } from "node:fs";
// @ts-ignore This bare repository intentionally does not depend on @types/node.
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { sha256 } from "../core/hash.ts";
import { canonicalJson } from "../core/serializable.ts";
import { adaptPluginManifest } from "../engine/manifest.ts";
import type { ProviderManifest, SourceSpan, UsingDeclaration } from "../language/model.ts";
import {
  validatePluginLockfile,
  type LockedPlugin,
  type PluginLockfile,
} from "../plugin/lockfile.js";
import { validatePluginManifest, type PluginManifest } from "../plugin/manifest.js";
import { githubManifest, githubStaticPlugin } from "./github.ts";
import { normalizePluginManifest, type StaticPlugin } from "./metadata.ts";
import { decodeUtf8 } from "./utf8.ts";

const DEFAULT_MANIFEST_BYTES = 4 * 1024 * 1024;
const LOCK_FILES = ["polici.lock", "polici.lock.json"] as const;

export interface ManifestConfiguration {
  readonly lockFile: string;
  readonly manifestCache: readonly string[];
  readonly manifests: readonly { readonly key: string; readonly path: string }[];
  readonly maxManifestBytes: number;
}

const DEFAULT_CONFIGURATION: ManifestConfiguration = {
  lockFile: "",
  manifestCache: [],
  manifests: [],
  maxManifestBytes: DEFAULT_MANIFEST_BYTES,
};

export interface ManifestProblem {
  readonly code: string;
  readonly message: string;
  readonly span: SourceSpan;
}

export interface ResolvedManifests {
  readonly complete: boolean;
  readonly language: readonly ProviderManifest[];
  readonly plugins: readonly StaticPlugin[];
  readonly problems: readonly ManifestProblem[];
}

interface ReadResult {
  readonly path: string;
  readonly text?: string;
  readonly error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, 64 * 1024 * 1024)
    : fallback;
}

function normalizeConfiguration(value: unknown): ManifestConfiguration {
  if (!isRecord(value)) return DEFAULT_CONFIGURATION;
  const nested = isRecord(value.polici) ? value.polici : value;
  const lockFile =
    typeof nested.lockFile === "string" && nested.lockFile.trim() !== "" ? nested.lockFile : "";
  const cache = nested.manifestCache;
  const manifestCache: string[] =
    typeof cache === "string"
      ? [cache]
      : Array.isArray(cache) && cache.every((item) => typeof item === "string")
        ? (cache as string[])
        : [];
  const rawManifests = nested.manifests;
  const manifests: { key: string; path: string }[] = [];
  if (isRecord(rawManifests)) {
    for (const [key, item] of Object.entries(rawManifests)) {
      if (typeof item === "string") manifests.push({ key, path: item });
    }
  }
  return {
    lockFile,
    manifestCache,
    manifests,
    maxManifestBytes: boundedInteger(nested.maxManifestBytes, DEFAULT_MANIFEST_BYTES),
  };
}

export function fileUriToPath(uri: string): string | undefined {
  if (!uri.startsWith("file://")) return undefined;
  let value = uri.slice("file://".length);
  if (value.startsWith("localhost/")) value = value.slice("localhost".length);
  try {
    value = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  if (/^\/[A-Za-z]:\//.test(value)) value = value.slice(1);
  return value;
}

function isWithin(root: string, path: string): boolean {
  const result = relative(resolve(root), resolve(path));
  return result === "" || (!result.startsWith("..") && !isAbsolute(result));
}

function unique(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) if (!result.includes(value)) result.push(value);
  return result;
}

function readBounded(path: string, maximum: number): ReadResult {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile()) return { path, error: "not a regular file" };
    if (stats.size > maximum) return { path, error: `exceeds the ${maximum} byte limit` };
    const bytes = readFileSync(path);
    if (bytes.byteLength > maximum) return { path, error: `exceeds the ${maximum} byte limit` };
    const text = decodeUtf8(bytes);
    return text === undefined ? { path, error: "not valid UTF-8" } : { path, text };
  } catch (error) {
    return { path, error: error instanceof Error ? error.message : String(error) };
  }
}

function manifestProblem(
  code: string,
  message: string,
  declaration: UsingDeclaration,
): ManifestProblem {
  return { code, message, span: declaration.sourceSpan };
}

/** Resolves only imported static manifests. It performs no network or runtime-artifact I/O. */
export class StaticManifestResolver {
  private roots: string[] = [];
  private configuration: ManifestConfiguration = DEFAULT_CONFIGURATION;

  setWorkspaceRoots(roots: readonly string[]): void {
    this.roots = unique(roots.map((root) => resolve(root)));
  }

  configure(value: unknown): void {
    this.configuration = normalizeConfiguration(value);
  }

  resolve(documentUri: string, declarations: readonly UsingDeclaration[]): ResolvedManifests {
    const documentPath = fileUriToPath(documentUri);
    const language: ProviderManifest[] = [];
    const plugins: StaticPlugin[] = [];
    const problems: ManifestProblem[] = [];
    const selected = new Set<string>();
    let lockResult: { lockfile?: PluginLockfile; path?: string; error?: string } | undefined;

    for (const declaration of declarations) {
      const coordinate = /^([^@\s]+)@([1-9][0-9]*)$/.exec(declaration.source);
      if (coordinate === null) continue;
      const name = coordinate[1]!;
      const contractMajor = Number(coordinate[2]);
      const key = `${name}@${contractMajor}`;
      if (selected.has(key)) continue;
      selected.add(key);

      if (name === githubManifest.name && contractMajor === githubManifest.contractMajor) {
        language.push(adaptPluginManifest(githubManifest));
        plugins.push(githubStaticPlugin);
        continue;
      }

      if (lockResult === undefined) lockResult = this.loadLockfile(documentPath);
      if (lockResult.error !== undefined || lockResult.lockfile === undefined) {
        problems.push(
          manifestProblem(
            "LSP_LOCK_UNAVAILABLE",
            lockResult.error ?? "No polici.lock was found for this workspace.",
            declaration,
          ),
        );
        continue;
      }
      let locked: LockedPlugin | undefined;
      let lockMatches = 0;
      for (const item of lockResult.lockfile.plugins) {
        if (item.name === name && item.contractMajor === contractMajor) {
          locked = item;
          lockMatches++;
        }
      }
      if (lockMatches !== 1 || locked === undefined) {
        problems.push(
          manifestProblem(
            "LSP_LOCK_ENTRY_REQUIRED",
            `Import '${key}' must have exactly one matching lock entry.`,
            declaration,
          ),
        );
        continue;
      }
      const loaded = this.loadLockedManifest(locked, key, lockResult.path!, documentPath);
      if (loaded.plugin === undefined || loaded.language === undefined) {
        problems.push(manifestProblem(loaded.code, loaded.message, declaration));
        continue;
      }
      language.push(loaded.language);
      plugins.push(loaded.plugin);
    }

    return { complete: problems.length === 0, language, plugins, problems };
  }

  private loadLockfile(documentPath: string | undefined): {
    lockfile?: PluginLockfile;
    path?: string;
    error?: string;
  } {
    const path = this.findLockfile(documentPath);
    if (path === undefined) return { error: "No polici.lock was found for this workspace." };
    const loaded = readBounded(path, this.configuration.maxManifestBytes);
    if (loaded.text === undefined)
      return { path, error: `Cannot read ${path}: ${loaded.error ?? "unknown error"}.` };
    let value: unknown;
    try {
      value = JSON.parse(loaded.text) as unknown;
    } catch (error) {
      return {
        path,
        error: `Lockfile ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
      };
    }
    const validation = validatePluginLockfile(value);
    if (!validation.ok) {
      const issue = validation.issues[0];
      return {
        path,
        error: `Lockfile ${path} is invalid: ${issue?.path ?? "$lockfile"}: ${issue?.message ?? "validation failed"}.`,
      };
    }
    return { path, lockfile: validation.value };
  }

  private findLockfile(documentPath: string | undefined): string | undefined {
    const root = this.roots.at(0);
    if (this.configuration.lockFile !== "") {
      const configured = this.configuration.lockFile;
      const path = isAbsolute(configured)
        ? configured
        : resolve(
            root ?? (documentPath === undefined ? resolve(".") : dirname(documentPath)),
            configured,
          );
      return existsSync(path) ? path : undefined;
    }
    const directories: string[] = [];
    let directory = documentPath === undefined ? (root ?? resolve(".")) : dirname(documentPath);
    for (let depth = 0; depth < 128; depth++) {
      directories.push(directory);
      if (root !== undefined && directory === root) break;
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    for (const name of LOCK_FILES) {
      for (const candidateDirectory of directories) {
        const candidate = `${candidateDirectory}/${name}`;
        try {
          if (lstatSync(candidate).isFile()) return candidate;
        } catch {}
      }
    }
    return undefined;
  }

  private workspaceRoot(documentPath: string | undefined): string | undefined {
    if (documentPath === undefined) return this.roots.at(0);
    let match: string | undefined;
    for (const root of this.roots) {
      if (!isWithin(root, documentPath)) continue;
      if (
        match === undefined ||
        root.length > match.length ||
        (root.length === match.length && root < match)
      )
        match = root;
    }
    return match;
  }

  private loadLockedManifest(
    locked: LockedPlugin,
    coordinate: string,
    lockPath: string,
    documentPath: string | undefined,
  ): { plugin?: StaticPlugin; language?: ProviderManifest; code: string; message: string } {
    const candidates = this.manifestCandidates(locked, coordinate, lockPath, documentPath);
    const maximum = this.configuration.maxManifestBytes;
    let sawDigestMismatch = false;
    let lastInvalid: string | undefined;
    for (const path of candidates) {
      if (!path.endsWith(".json") || !existsSync(path)) continue;
      const loaded = readBounded(path, maximum);
      if (loaded.text === undefined) {
        lastInvalid = `${path}: ${loaded.error ?? "cannot read file"}`;
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(loaded.text) as unknown;
      } catch (error) {
        lastInvalid = `${path}: ${error instanceof Error ? error.message : String(error)}`;
        continue;
      }
      const validation = validatePluginManifest(value);
      if (!validation.ok) {
        const issue = validation.issues[0];
        lastInvalid = `${path}: ${issue?.path ?? "$manifest"}: ${issue?.message ?? "invalid manifest"}`;
        continue;
      }
      const mismatch = lockedManifestMismatch(locked, validation.value, value);
      if (mismatch !== undefined) {
        if (mismatch.digest) sawDigestMismatch = true;
        lastInvalid = `${path}: ${mismatch.message}`;
        continue;
      }
      const plugin = normalizePluginManifest(value);
      return {
        plugin,
        language: adaptPluginManifest(validation.value),
        code: "",
        message: "",
      };
    }
    if (sawDigestMismatch) {
      return {
        code: "LSP_MANIFEST_DIGEST_MISMATCH",
        message: `No cached manifest for '${coordinate}' matches lock digest ${locked.manifest.value}.`,
      };
    }
    return {
      code: lastInvalid === undefined ? "LSP_MANIFEST_UNAVAILABLE" : "LSP_MANIFEST_INVALID",
      message:
        lastInvalid ??
        `No offline static manifest for '${coordinate}' was found. Configure polici.manifestCache or polici.manifests.`,
    };
  }

  private manifestCandidates(
    locked: LockedPlugin,
    coordinate: string,
    lockPath: string,
    documentPath: string | undefined,
  ): string[] {
    const root = this.workspaceRoot(documentPath) ?? dirname(lockPath);
    const explicit = this.configuration.manifests.find(
      (item) =>
        item.key === coordinate || item.key === locked.source.locator || item.key === locked.name,
    )?.path;
    const result: string[] = [];
    if (explicit !== undefined)
      result.push(isAbsolute(explicit) ? explicit : resolve(root, explicit));

    if (locked.source.kind === "path") {
      let locator = locked.source.locator;
      if (locator.startsWith("file://")) locator = fileUriToPath(locator) ?? locator;
      const versionSuffix = `@${locked.version}`;
      const withoutVersion = locator.endsWith(versionSuffix)
        ? locator.slice(0, -versionSuffix.length)
        : locator;
      for (const base of unique([locator, withoutVersion])) {
        const roots = isAbsolute(base) ? [""] : unique([root, dirname(lockPath)]);
        for (const candidateRoot of roots) {
          const path = isAbsolute(base) ? base : resolve(candidateRoot, base);
          result.push(path.endsWith(".json") ? path : resolve(path, "manifest.json"));
        }
      }
    }

    const cacheValues = [...this.configuration.manifestCache];
    cacheValues.push(".polici/manifests", ".polici/cache/manifests");
    for (const cacheValue of cacheValues) {
      const cache = isAbsolute(cacheValue) ? cacheValue : resolve(root, cacheValue);
      result.push(
        resolve(cache, `${locked.manifest.value}.json`),
        resolve(cache, `${locked.name}@${locked.version}.json`),
        resolve(cache, locked.name, locked.version, "manifest.json"),
        resolve(cache, `${encodeURIComponent(locked.source.locator)}.json`),
      );
    }
    return unique(result);
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (const value of left) if (!right.includes(value)) return false;
  return true;
}

function lockedManifestMismatch(
  locked: LockedPlugin,
  manifest: PluginManifest,
  rawManifest: unknown,
): { readonly message: string; readonly digest: boolean } | undefined {
  if (locked.name !== manifest.name)
    return { message: "lock name does not match the manifest", digest: false };
  if (locked.version !== manifest.version)
    return { message: "lock version does not match the manifest", digest: false };
  if (locked.contractMajor !== manifest.contractMajor)
    return { message: "lock contract major does not match the manifest", digest: false };
  if (
    locked.runtime.kind !== manifest.runtime.kind ||
    locked.runtime.protocol !== manifest.runtime.protocol ||
    locked.runtime.entrypoint !== manifest.runtime.entrypoint ||
    locked.runtime.transport !== manifest.runtime.transport ||
    !sameStrings(locked.runtime.capabilities, manifest.runtime.capabilities)
  )
    return { message: "lock runtime metadata does not match the manifest", digest: false };
  const digest = sha256(canonicalJson(rawManifest));
  if (locked.manifest.algorithm !== "sha256" || locked.manifest.value !== digest)
    return { message: "canonical manifest SHA-256 does not match", digest: true };
  return undefined;
}
