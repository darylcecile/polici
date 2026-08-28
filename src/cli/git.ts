// @ts-ignore This bare repository intentionally uses ScriptC's Node built-ins.
import { createHash } from "node:crypto";

import { RepositorySnapshot, type RepositorySnapshotEntry } from "../core/repository.js";
import { normalizeRepositoryPath } from "../core/path.js";
import {
  MAX_ARTIFACT_BYTES,
  MAX_REPOSITORY_BYTES,
  MAX_REPOSITORY_FILE_BYTES,
  MAX_REPOSITORY_FILES,
  decodeUtf8,
} from "./files.js";
import type { CliProcessResult, CliProcessRunner } from "./process.js";

export interface GitEnvironment {
  readonly [name: string]: string | undefined;
}

interface GitTreeEntry {
  readonly mode: string;
  readonly object: string;
  readonly path: string;
}

interface VerifiedCommit {
  readonly sha: string;
  readonly tree: string;
}

interface GitObjectInformation {
  readonly type: string;
  readonly size: number;
}

const MAX_GIT_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_GIT_TREE_ENTRIES = MAX_REPOSITORY_FILES * 2;

export function assertGitCommit(
  root: string,
  sha: string,
  environment: GitEnvironment,
  runProcess: CliProcessRunner,
): string {
  return verifiedCommit(root, sha, environment, runProcess).sha;
}

export function snapshotGitCommit(
  root: string,
  sha: string,
  environment: GitEnvironment,
  runProcess: CliProcessRunner,
): RepositorySnapshot {
  const commit = verifiedCommit(root, sha, environment, runProcess);
  const tree = walkVerifiedTree(root, commit.tree, environment, runProcess);
  if (tree.length > MAX_REPOSITORY_FILES)
    throw new RangeError(`Git tree exceeds the ${MAX_REPOSITORY_FILES} file limit.`);

  const information = objectInformation(
    root,
    unique(tree.map((entry) => entry.object)),
    environment,
    runProcess,
  );
  let totalBytes = 0;
  for (const item of tree) {
    const object = information.get(item.object);
    if (object?.type !== "blob")
      throw new Error(`Git tree entry ${JSON.stringify(item.path)} does not resolve to a blob.`);
    if (object.size > MAX_REPOSITORY_FILE_BYTES)
      throw new RangeError(
        `Git blob ${JSON.stringify(item.path)} is ${object.size} bytes; limit is ${MAX_REPOSITORY_FILE_BYTES}.`,
      );
    totalBytes += object.size;
    if (totalBytes > MAX_REPOSITORY_BYTES)
      throw new RangeError(`Git tree exceeds the ${MAX_REPOSITORY_BYTES} byte limit.`);
  }

  const blobs = new Map<string, Uint8Array>();
  const entries: RepositorySnapshotEntry[] = [];
  for (const item of tree) {
    const size = information.get(item.object)!.size;
    let content = blobs.get(item.object);
    if (!content) {
      content = verifiedObject(root, "blob", item.object, environment, runProcess, size + 1);
      if (content.byteLength !== size)
        throw new Error(`Git blob ${item.object} has unexpected materialized size.`);
      blobs.set(item.object, content);
    }
    entries.push({ path: item.path, content });
  }
  return RepositorySnapshot.fromEntries(entries);
}

export function readGitFile(
  root: string,
  sha: string,
  filePath: string,
  environment: GitEnvironment,
  runProcess: CliProcessRunner,
  maximumBytes = MAX_ARTIFACT_BYTES,
): Uint8Array {
  const commit = verifiedCommit(root, sha, environment, runProcess);
  assertSafeGitPath(filePath);
  const item = resolveVerifiedTreePath(root, commit.tree, filePath, environment, runProcess);
  assertRegularBlob(item);
  const information = objectInformation(root, [item.object], environment, runProcess).get(
    item.object,
  )!;
  if (information.type !== "blob")
    throw new Error(`Git file ${JSON.stringify(filePath)} does not resolve to a blob.`);
  if (information.size > maximumBytes)
    throw new RangeError(
      `Git file ${JSON.stringify(filePath)} is ${information.size} bytes; limit is ${maximumBytes}.`,
    );
  const content = verifiedObject(
    root,
    "blob",
    item.object,
    environment,
    runProcess,
    information.size + 1,
  );
  if (content.byteLength !== information.size)
    throw new Error(`Git blob ${item.object} has unexpected materialized size.`);
  return content;
}

function verifiedCommit(
  root: string,
  sha: string,
  environment: GitEnvironment,
  runProcess: CliProcessRunner,
): VerifiedCommit {
  const object = requireObjectId(sha, "Git commit");
  const content = verifiedObject(
    root,
    "commit",
    object,
    environment,
    runProcess,
    MAX_GIT_METADATA_BYTES,
  );
  const firstLineEnd = content.indexOf(0x0a);
  if (firstLineEnd < 0) throw new Error(`Git commit ${object} has no tree header.`);
  const firstLine = decodeUtf8(content.subarray(0, firstLineEnd), "Git commit tree header");
  const match = /^tree ([a-f0-9]{40}|[a-f0-9]{64})$/.exec(firstLine);
  if (match === null || match[1]!.length !== object.length)
    throw new Error(`Git commit ${object} has an invalid tree header.`);
  return { sha: object, tree: match[1]! };
}

function walkVerifiedTree(
  root: string,
  rootTree: string,
  environment: GitEnvironment,
  runProcess: CliProcessRunner,
): readonly GitTreeEntry[] {
  const files: GitTreeEntry[] = [];
  let entryCount = 0;
  const active = new Set<string>();
  const trees = new Map<string, readonly GitTreeEntry[]>();

  const visit = (tree: string, prefix: string): void => {
    if (active.has(tree)) throw new Error(`Git tree ${tree} contains a cycle.`);
    active.add(tree);
    let children = trees.get(tree);
    if (!children) {
      children = parseTreeObject(
        verifiedObject(root, "tree", tree, environment, runProcess, MAX_GIT_METADATA_BYTES),
        tree.length,
      );
      trees.set(tree, children);
    }
    for (const child of children) {
      entryCount += 1;
      if (entryCount > MAX_GIT_TREE_ENTRIES)
        throw new RangeError(`Git tree exceeds the ${MAX_GIT_TREE_ENTRIES} entry limit.`);
      const fullPath = prefix === "" ? child.path : `${prefix}/${child.path}`;
      assertSafeGitPath(fullPath);
      if (child.mode === "40000") visit(child.object, fullPath);
      else {
        const file = { ...child, path: fullPath };
        assertRegularBlob(file);
        files.push(file);
      }
    }
    active.delete(tree);
  };

  visit(rootTree, "");
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  for (let index = 1; index < files.length; index += 1) {
    if (files[index - 1]!.path === files[index]!.path)
      throw new Error(`Git tree contains duplicate path ${JSON.stringify(files[index]!.path)}.`);
  }
  return files;
}

function resolveVerifiedTreePath(
  root: string,
  rootTree: string,
  filePath: string,
  environment: GitEnvironment,
  runProcess: CliProcessRunner,
): GitTreeEntry {
  const segments = filePath.split("/");
  let tree = rootTree;
  for (let index = 0; index < segments.length; index += 1) {
    const entries = parseTreeObject(
      verifiedObject(root, "tree", tree, environment, runProcess, MAX_GIT_METADATA_BYTES),
      tree.length,
    );
    const matches = entries.filter((entry) => entry.path === segments[index]);
    if (matches.length !== 1)
      throw new Error(`Git file ${JSON.stringify(filePath)} does not exist uniquely.`);
    const entry = matches[0]!;
    if (index === segments.length - 1) return { ...entry, path: filePath };
    if (entry.mode !== "40000")
      throw new Error(`Git file ${JSON.stringify(filePath)} traverses a non-directory entry.`);
    tree = entry.object;
  }
  throw new Error(`Git file ${JSON.stringify(filePath)} does not exist.`);
}

function parseTreeObject(content: Uint8Array, objectIdLength: number): readonly GitTreeEntry[] {
  const objectBytes = objectIdLength / 2;
  const entries: GitTreeEntry[] = [];
  const names = new Set<string>();
  let offset = 0;
  while (offset < content.byteLength) {
    const space = content.indexOf(0x20, offset);
    const nul = content.indexOf(0x00, space + 1);
    if (space <= offset || nul <= space + 1 || nul + objectBytes > content.byteLength)
      throw new Error("Git tree object has an invalid entry.");
    const mode = decodeUtf8(content.subarray(offset, space), "Git tree mode");
    const name = decodeUtf8(content.subarray(space + 1, nul), "Git tree path");
    if (!/^(?:40000|100644|100755|120000|160000)$/.test(mode))
      throw new TypeError(`Git tree contains unsupported mode ${mode} at ${JSON.stringify(name)}.`);
    if (name === "." || name === ".." || name.includes("/") || name.includes("\\"))
      throw new TypeError(`Git tree contains unsafe path component ${JSON.stringify(name)}.`);
    assertSafeGitPath(name);
    if (names.has(name))
      throw new Error(`Git tree contains duplicate entry ${JSON.stringify(name)}.`);
    names.add(name);
    const object = hex(content.subarray(nul + 1, nul + 1 + objectBytes));
    entries.push({ mode, object, path: name });
    offset = nul + 1 + objectBytes;
  }
  return entries;
}

function assertRegularBlob(entry: GitTreeEntry): void {
  if (entry.mode === "120000")
    throw new TypeError(`Git tree contains symbolic link ${JSON.stringify(entry.path)}.`);
  if (entry.mode === "160000")
    throw new TypeError(`Git tree contains submodule ${JSON.stringify(entry.path)}.`);
  if (entry.mode !== "100644" && entry.mode !== "100755")
    throw new TypeError(
      `Git tree contains unsupported mode ${entry.mode} at ${JSON.stringify(entry.path)}.`,
    );
}

function assertSafeGitPath(filePath: string): void {
  if (filePath.length === 0 || normalizeRepositoryPath(filePath) !== filePath)
    throw new TypeError(`Git tree contains unsafe path ${JSON.stringify(filePath)}.`);
  for (let index = 0; index < filePath.length; index += 1) {
    const code = filePath.charCodeAt(index);
    if (code < 32 || code === 127)
      throw new TypeError(
        `Git tree contains control characters in path ${JSON.stringify(filePath)}.`,
      );
  }
}

function objectInformation(
  root: string,
  objects: readonly string[],
  environment: GitEnvironment,
  runProcess: CliProcessRunner,
): ReadonlyMap<string, GitObjectInformation> {
  if (objects.length === 0) return new Map();
  const input = new TextEncoder().encode(`${objects.join("\n")}\n`);
  const output = runGitText(
    root,
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    environment,
    runProcess,
    Math.max(1024, objects.length * 160),
    input,
  );
  const lines = output.trimEnd().split("\n");
  if (lines.length !== objects.length)
    throw new Error("git cat-file returned an incomplete object list.");
  const result = new Map<string, GitObjectInformation>();
  for (let index = 0; index < objects.length; index += 1) {
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) ([a-z-]+) ([0-9]+)$/.exec(lines[index]!);
    const expected = objects[index]!;
    if (match === null || match[1] !== expected)
      throw new Error(`git cat-file returned invalid information for ${expected}.`);
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size) || size < 0)
      throw new Error(`git cat-file returned an invalid size for ${expected}.`);
    result.set(expected, { type: match[2]!, size });
  }
  return result;
}

function verifiedObject(
  root: string,
  type: "commit" | "tree" | "blob",
  object: string,
  environment: GitEnvironment,
  runProcess: CliProcessRunner,
  maxBuffer: number,
): Uint8Array {
  const content = runGitBytes(root, ["cat-file", type, object], environment, runProcess, maxBuffer);
  const header = new TextEncoder().encode(`${type} ${content.byteLength}\0`);
  const hash = createHash(object.length === 40 ? "sha1" : "sha256");
  hash.update(header);
  hash.update(content);
  const actual = hash.digest("hex");
  if (actual !== object)
    throw new Error(
      `Git ${type} object ${object} failed independent content hash verification (read ${actual}).`,
    );
  return content;
}

function requireObjectId(value: string, label: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value))
    throw new TypeError(`${label} ${JSON.stringify(value)} is not a full object ID.`);
  return value.toLowerCase();
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function hex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value;
}

function runGitText(
  root: string,
  arguments_: readonly string[],
  environment: GitEnvironment,
  runProcess: CliProcessRunner,
  maxBuffer = 4 * 1024 * 1024,
  input = new Uint8Array(),
): string {
  try {
    return decodeUtf8(
      decodeProcessOutput(
        runProcess(
          "git",
          hardenedGitArguments(arguments_),
          root,
          gitEnvironment(environment),
          encodeProcessInput(input),
          60_000,
          maxBuffer,
        ),
      ),
      "Git output",
    );
  } catch (error) {
    throw gitFailure(arguments_, error);
  }
}

function runGitBytes(
  root: string,
  arguments_: readonly string[],
  environment: GitEnvironment,
  runProcess: CliProcessRunner,
  maxBuffer: number,
): Uint8Array {
  try {
    return decodeProcessOutput(
      runProcess(
        "git",
        hardenedGitArguments(arguments_),
        root,
        gitEnvironment(environment),
        "",
        60_000,
        maxBuffer,
      ),
    );
  } catch (error) {
    throw gitFailure(arguments_, error);
  }
}

function hardenedGitArguments(arguments_: readonly string[]): readonly string[] {
  return ["--no-replace-objects", "-c", "core.useReplaceRefs=false", ...arguments_];
}

function decodeProcessOutput(value: string): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error("Git process runner returned invalid JSON.", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Git process runner returned an invalid result envelope.");
  const result = parsed as Partial<CliProcessResult>;
  if (
    typeof result.stdoutBase64 !== "string" ||
    typeof result.stderrBase64 !== "string" ||
    (result.status !== null && !Number.isSafeInteger(result.status)) ||
    (result.signal !== null && typeof result.signal !== "string") ||
    (result.error !== undefined &&
      (typeof result.error !== "object" ||
        result.error === null ||
        typeof result.error.message !== "string"))
  )
    throw new Error("Git process runner returned an invalid result envelope.");
  if (result.status !== 0 || result.signal !== null || result.error !== undefined) {
    const failure = new Error(result.error?.message ?? "Git process failed") as Error & {
      stderr?: Uint8Array;
    };
    failure.stderr = new Uint8Array(Buffer.from(result.stderrBase64, "base64"));
    throw failure;
  }
  return new Uint8Array(Buffer.from(result.stdoutBase64, "base64"));
}

function encodeProcessInput(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function gitEnvironment(environment: GitEnvironment): Record<string, string> {
  const result: Record<string, string> = {
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    LC_ALL: "C",
  };
  for (const name of ["PATH", "SYSTEMROOT", "TMPDIR", "TMP", "TEMP"]) {
    const value = environment[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function gitFailure(arguments_: readonly string[], error: unknown): Error {
  const failure = error as Error & { readonly stderr?: string | Uint8Array };
  const stderr =
    typeof failure.stderr === "string"
      ? failure.stderr.trim()
      : failure.stderr instanceof Uint8Array
        ? new TextDecoder().decode(failure.stderr).trim()
        : "";
  return new Error(
    `git ${arguments_[0] ?? "command"} failed${stderr ? `: ${stderr}` : `: ${failure.message}`}`,
    { cause: error },
  );
}
