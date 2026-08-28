// @ts-ignore This bare repository intentionally uses ScriptC's Node built-ins.
import * as fs from "node:fs";
// @ts-ignore This bare repository intentionally uses ScriptC's Node built-ins.
import * as path from "node:path";

import { RepositorySnapshot, type RepositorySnapshotEntry } from "../core/repository.js";
import { normalizeRepositoryPath } from "../core/path.js";

export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
export const MAX_REPOSITORY_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_REPOSITORY_FILES = 100_000;
export const MAX_REPOSITORY_BYTES = 1024 * 1024 * 1024;

interface FileStats {
  readonly dev?: number;
  readonly ino?: number;
  readonly size: number;
  readonly mtimeMs: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export function absoluteRepositoryRoot(input: string): string {
  if (input.length === 0) throw new TypeError("Repository path cannot be empty.");
  const root = path.resolve(input);
  const stats = fileStats(root);
  if (stats.isSymbolicLink() || !stats.isDirectory())
    throw new TypeError(`Repository ${JSON.stringify(input)} must be a non-symlink directory.`);
  // Canonicalize platform aliases such as macOS /var -> /private/var once;
  // all repository-relative trust checks below then reject any new symlink.
  // @ts-ignore ScriptC and Node both provide realpathSync.
  return path.resolve(fs.realpathSync(root) as string);
}

export function repositoryRelativePath(root: string, input: string, label: string): string {
  if (input.length === 0) throw new TypeError(`${label} path cannot be empty.`);
  const absolute = path.resolve(root, input);
  const relative = path.relative(root, absolute).replace(/\\/g, "/");
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith("../") ||
    path.isAbsolute(relative)
  )
    throw new TypeError(`${label} must name a file inside the repository.`);
  const normalized = normalizeRepositoryPath(relative);
  if (normalized !== relative || hasUnsafePathCodeUnit(normalized))
    throw new TypeError(`${label} path ${JSON.stringify(relative)} is not a safe canonical path.`);
  return normalized;
}

export function relativeLocator(lockfilePath: string, manifestPath: string): string {
  const base = path.dirname(lockfilePath);
  const relative = path.relative(base, path.resolve(manifestPath)).replace(/\\/g, "/");
  return validatePathLocator(relative);
}

export function validatePathLocator(locator: string): string {
  if (
    locator.length === 0 ||
    locator.includes("\\") ||
    locator.startsWith("/") ||
    /^[A-Za-z]:/.test(locator) ||
    hasUnsafePathCodeUnit(locator)
  )
    throw new TypeError(`Plugin path locator ${JSON.stringify(locator)} is not safe.`);
  const segments = locator.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
    throw new TypeError(`Plugin path locator ${JSON.stringify(locator)} contains traversal.`);
  return locator;
}

export function joinRepositoryPath(base: string, relative: string): string {
  const combined = base === "" ? relative : `${base}/${relative}`;
  const normalized = normalizeRepositoryPath(combined);
  if (normalized !== combined || hasUnsafePathCodeUnit(normalized))
    throw new TypeError(`Repository path ${JSON.stringify(combined)} is not safe and canonical.`);
  return normalized;
}

export function secureReadFile(filePath: string, maximumBytes: number, label: string): Uint8Array {
  assertSecureFilePath(filePath, label);
  const pathBefore = fileStats(filePath);
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile())
    throw new TypeError(`${label} ${JSON.stringify(filePath)} must be a regular non-symlink file.`);
  // @ts-ignore ScriptC exposes the same numeric open flags used by Node.
  // ScriptC's Darwin fs shim omits constants but openSync accepts Darwin flags.
  const noFollow = (fs.constants.O_NOFOLLOW as number | undefined) ?? 0x100;
  // @ts-ignore ScriptC and Node both expose O_RDONLY.
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, (fs.constants.O_RDONLY as number) | noFollow);
  } catch (error) {
    if (!isScriptCWholeFileOnly(error)) throw error;
    return secureReadFileWithoutDescriptors(filePath, maximumBytes, label, pathBefore);
  }
  try {
    const before = descriptorStats(descriptor);
    if (!before.isFile() || !sameFileIdentity(pathBefore, before))
      throw new TypeError(
        `${label} ${JSON.stringify(filePath)} must be a regular non-symlink file.`,
      );
    if (before.size > maximumBytes)
      throw new RangeError(`${label} is ${before.size} bytes; limit is ${maximumBytes}.`);
    // @ts-ignore ScriptC and Node both support reading through an open descriptor.
    const content = fs.readFileSync(descriptor) as Uint8Array;
    const after = descriptorStats(descriptor);
    const pathAfter = fileStats(filePath);
    if (
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      !after.isFile() ||
      !sameFileIdentity(before, after) ||
      !sameFileIdentity(after, pathAfter) ||
      content.byteLength !== after.size
    )
      throw new Error(`${label} changed while it was read.`);
    assertSecureFilePath(filePath, label);
    return new Uint8Array(content);
  } finally {
    // @ts-ignore ScriptC and Node both support closing descriptors.
    fs.closeSync(descriptor);
  }
}

function secureReadFileWithoutDescriptors(
  filePath: string,
  maximumBytes: number,
  label: string,
  before: FileStats,
): Uint8Array {
  if (before.size > maximumBytes)
    throw new RangeError(`${label} is ${before.size} bytes; limit is ${maximumBytes}.`);
  // @ts-ignore ScriptC's filesystem island supports only whole-file reads.
  const content = fs.readFileSync(filePath) as Uint8Array;
  const after = fileStats(filePath);
  if (
    after.isSymbolicLink() ||
    !after.isFile() ||
    !sameFileIdentity(before, after) ||
    content.byteLength !== after.size
  )
    throw new Error(`${label} changed while it was read.`);
  assertSecureFilePath(filePath, label);
  return new Uint8Array(content);
}

export function secureReadExternalFile(
  filePath: string,
  maximumBytes: number,
  label: string,
  repositoryRoot?: string,
): Uint8Array {
  const direct = fileStats(filePath);
  if (direct.isSymbolicLink() || !direct.isFile())
    throw new TypeError(`${label} must be a regular non-symlink file.`);
  // Parent aliases are outside the repository trust boundary. Resolve them,
  // then retain O_NOFOLLOW protection for the event file itself.
  // @ts-ignore ScriptC and Node both provide realpathSync.
  const canonical = fs.realpathSync(filePath) as string;
  if (repositoryRoot !== undefined && pathIsInside(repositoryRoot, canonical))
    throw new TypeError(`${label} must be outside the repository.`);
  return secureReadFile(canonical, maximumBytes, label);
}

export function decodeUtf8(bytes: Uint8Array, label: string): string {
  assertValidUtf8(bytes, label);
  return new TextDecoder().decode(bytes);
}

export function scanLocalSnapshot(root: string): RepositorySnapshot {
  const entries: RepositorySnapshotEntry[] = [];
  let totalBytes = 0;

  const visit = (absoluteDirectory: string, relativeDirectory: string): void => {
    const before = fileStats(absoluteDirectory);
    if (before.isSymbolicLink() || !before.isDirectory())
      throw new TypeError(
        `Repository directory ${JSON.stringify(relativeDirectory)} is not regular.`,
      );
    assertRealPath(absoluteDirectory, `Repository directory ${JSON.stringify(relativeDirectory)}`);
    const directoryEntries = [...fs.readdirSync(absoluteDirectory, { withFileTypes: true })].sort(
      (left, right) => compareStrings(left.name, right.name),
    );
    for (const entry of directoryEntries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const relative = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (normalizeRepositoryPath(relative) !== relative || hasUnsafePathCodeUnit(relative))
        throw new TypeError(`Repository contains unsafe path ${JSON.stringify(relative)}.`);
      const absolute = path.resolve(absoluteDirectory, entry.name);
      const stats = fileStats(absolute);
      if (entry.isSymbolicLink() || stats.isSymbolicLink())
        throw new TypeError(`Repository contains symbolic link ${JSON.stringify(relative)}.`);
      if (entry.isDirectory() && stats.isDirectory()) {
        visit(absolute, relative);
        continue;
      }
      if (!entry.isFile() || !stats.isFile())
        throw new TypeError(`Repository contains non-regular entry ${JSON.stringify(relative)}.`);
      if (entries.length >= MAX_REPOSITORY_FILES)
        throw new RangeError(`Repository exceeds the ${MAX_REPOSITORY_FILES} file limit.`);
      const content = secureReadFile(
        absolute,
        MAX_REPOSITORY_FILE_BYTES,
        `Repository file ${relative}`,
      );
      totalBytes += content.byteLength;
      if (totalBytes > MAX_REPOSITORY_BYTES)
        throw new RangeError(`Repository exceeds the ${MAX_REPOSITORY_BYTES} byte limit.`);
      entries.push({ path: relative, content });
    }
    const after = fileStats(absoluteDirectory);
    if (after.isSymbolicLink() || !after.isDirectory())
      throw new Error(
        `Repository directory ${JSON.stringify(relativeDirectory)} changed during scan.`,
      );
  };

  visit(root, "");
  return RepositorySnapshot.fromEntries(entries);
}

export function atomicWriteFile(filePath: string, content: string): void {
  const parent = path.dirname(filePath);
  const parentStats = fileStats(parent);
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory())
    throw new TypeError("Lockfile parent must be a non-symlink directory.");
  assertRealPath(parent, "Lockfile parent");
  if (exists(filePath)) {
    const current = fileStats(filePath);
    if (current.isSymbolicLink() || !current.isFile())
      throw new TypeError("Lockfile target must be a regular non-symlink file.");
  }
  // @ts-ignore ScriptC and Node both support private temporary directories.
  const temporaryDirectory = fs.mkdtempSync(
    path.resolve(parent, `.${path.basename(filePath)}.tmp-`),
  );
  const temporary = path.resolve(temporaryDirectory, path.basename(filePath));
  try {
    // @ts-ignore ScriptC and Node both support whole-file writes.
    fs.writeFileSync(temporary, content);
    // @ts-ignore ScriptC and Node both support restricting temporary files.
    fs.chmodSync(temporary, 0o600);
    // @ts-ignore ScriptC and Node both support atomic same-directory rename.
    fs.renameSync(temporary, filePath);
  } finally {
    // @ts-ignore ScriptC and Node both support recursive cleanup.
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function exists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    const failure = error as Error & { readonly code?: string };
    if (failure.code === "ENOENT" || failure.message.includes("ENOENT")) return false;
    throw error;
  }
}

export function assertSecureFilePath(filePath: string, label: string): void {
  const absolute = path.resolve(filePath);
  const hierarchy: string[] = [];
  let current = absolute;
  while (true) {
    hierarchy.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  hierarchy.reverse();
  for (const item of hierarchy) {
    const stats = fileStats(item);
    if (stats.isSymbolicLink()) throw new TypeError(`${label} path contains a symbolic link.`);
  }
  assertRealPath(absolute, label);
}

function fileStats(filePath: string): FileStats {
  const stats = fs.lstatSync(filePath);
  return {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    // Node exposes these identity fields; ScriptC may omit them, in which
    // case size/mtime plus the repeated no-link checks remain authoritative.
    dev: (stats as unknown as { readonly dev?: number }).dev,
    ino: (stats as unknown as { readonly ino?: number }).ino,
    isDirectory: () => stats.isDirectory(),
    isFile: () => stats.isFile(),
    isSymbolicLink: () => stats.isSymbolicLink(),
  };
}

function descriptorStats(descriptor: number): FileStats {
  // @ts-ignore ScriptC and Node both expose fstat for an open descriptor.
  const stats = fs.fstatSync(descriptor);
  return {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    dev: (stats as unknown as { readonly dev?: number }).dev,
    ino: (stats as unknown as { readonly ino?: number }).ino,
    isDirectory: () => false,
    isFile: () => stats.isFile(),
    isSymbolicLink: () => false,
  };
}

function sameFileIdentity(left: FileStats, right: FileStats): boolean {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    (left.dev === undefined || right.dev === undefined || left.dev === right.dev) &&
    (left.ino === undefined || right.ino === undefined || left.ino === right.ino)
  );
}

function isScriptCWholeFileOnly(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message ===
      "fs.openSync is not available in the scriptc island (whole-file reads/writes only)"
  );
}

function assertValidUtf8(bytes: Uint8Array, label: string): void {
  for (let index = 0; index < bytes.length; index += 1) {
    const first = bytes[index]!;
    if (first <= 0x7f) continue;
    const second = bytes[index + 1];
    if (first >= 0xc2 && first <= 0xdf && continuation(second)) {
      index += 1;
      continue;
    }
    const third = bytes[index + 2];
    if (
      continuation(third) &&
      ((first === 0xe0 && second !== undefined && second >= 0xa0 && second <= 0xbf) ||
        (first >= 0xe1 && first <= 0xec && continuation(second)) ||
        (first === 0xed && second !== undefined && second >= 0x80 && second <= 0x9f) ||
        (first >= 0xee && first <= 0xef && continuation(second)))
    ) {
      index += 2;
      continue;
    }
    const fourth = bytes[index + 3];
    if (
      continuation(third) &&
      continuation(fourth) &&
      ((first === 0xf0 && second !== undefined && second >= 0x90 && second <= 0xbf) ||
        (first >= 0xf1 && first <= 0xf3 && continuation(second)) ||
        (first === 0xf4 && second !== undefined && second >= 0x80 && second <= 0x8f))
    ) {
      index += 3;
      continue;
    }
    throw new TypeError(`${label} is not valid UTF-8 at byte ${index}.`);
  }
}

function continuation(value: number | undefined): boolean {
  return value !== undefined && value >= 0x80 && value <= 0xbf;
}

function assertRealPath(filePath: string, label: string): void {
  // @ts-ignore ScriptC and Node both provide realpathSync.
  const real = fs.realpathSync(filePath) as string;
  if (path.resolve(real) !== path.resolve(filePath))
    throw new TypeError(`${label} path resolves through a symbolic link.`);
}

function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function hasUnsafePathCodeUnit(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
