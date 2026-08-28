// @ts-ignore This bare repository has no @types/node; ScriptC provides its own built-in types.
import * as fs from "node:fs";
// @ts-ignore This bare repository has no @types/node; ScriptC provides its own built-in types.
import { resolve } from "node:path";
import { File, FileCollection, type FileOptions } from "./file.js";
import { PoliciGlob } from "./glob.js";
import { joinRepositoryPath, normalizeRepositoryPath, type RepositoryPath } from "./path.js";
import { canonicalSha256 } from "./serializable.js";

export interface RepositoryScanOptions {
  readonly ignore?: readonly string[];
  readonly useGitignore?: boolean;
  readonly maxFileBytes?: number;
  readonly file?: FileOptions;
}

export interface RepositorySnapshotEntry {
  readonly path: string;
  readonly content: string | Uint8Array;
  readonly file?: FileOptions;
}

export interface ExactRepositorySnapshotOptions {
  readonly maxFileBytes?: number;
  readonly file?: FileOptions;
}

export interface SerializedRepositorySnapshot {
  readonly kind: "repository-snapshot";
  readonly files: readonly ReturnType<File["toJSON"]>[];
  readonly sha256: string;
}

interface IgnoreRule {
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  readonly basenameOnly: boolean;
  readonly base: RepositoryPath;
  readonly pattern: string;
}

const ALWAYS_IGNORED = new Set([".git", "node_modules"]);

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateMaxFileBytes(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError("maxFileBytes must be a non-negative safe integer");
  return value;
}

function readRegularFile(
  path: string,
  relativePath: RepositoryPath,
  maxBytes?: number,
): Uint8Array {
  const before = fs.lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new TypeError(`Repository entry ${JSON.stringify(relativePath)} is not a regular file`);
  }
  if (maxBytes !== undefined && before.size > maxBytes) {
    throw new RangeError(
      `File ${JSON.stringify(relativePath)} is ${before.size} bytes; maxFileBytes is ${maxBytes}`,
    );
  }

  const content = fs.readFileSync(path);
  const after = fs.lstatSync(path);
  if (after.isSymbolicLink() || !after.isFile()) {
    throw new TypeError(`Repository entry ${JSON.stringify(relativePath)} is not a regular file`);
  }
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    content.byteLength !== after.size
  ) {
    throw new Error(`Repository file ${JSON.stringify(relativePath)} changed while it was read`);
  }
  return content;
}

function trimUnescapedTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line.charAt(end - 1) === " ") {
    let slashCount = 0;
    for (let index = end - 2; index >= 0 && line.charAt(index) === "\\"; index -= 1)
      slashCount += 1;
    if (slashCount % 2 === 1) break;
    end -= 1;
  }
  return line.slice(0, end);
}

function unescapeLiteral(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.charAt(index) === "\\" && index + 1 < value.length) index += 1;
    result += value.charAt(index);
  }
  return result;
}

function parseIgnoreRule(rawLine: string, base: RepositoryPath): IgnoreRule | undefined {
  let line = trimUnescapedTrailingSpaces(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
  if (line === "" || line.startsWith("#")) return undefined;

  let negated = false;
  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1);
  } else if (line.startsWith("\\#") || line.startsWith("\\!")) {
    line = line.slice(1);
  }

  let directoryOnly = false;
  if (line.endsWith("/") && !line.endsWith("\\/")) {
    directoryOnly = true;
    line = line.slice(0, -1);
  }
  if (line === "") return undefined;
  if (line.includes("\\*")) return undefined;

  const anchored = line.startsWith("/");
  if (anchored) line = line.slice(1);
  line = unescapeLiteral(line);
  if (line.includes("?") || line.includes("[") || line.includes("]")) return undefined;

  const basenameOnly = !anchored && !line.includes("/");
  const fullPattern = basenameOnly ? line : base === "" ? line : `${base}/${line}`;
  try {
    new PoliciGlob(fullPattern);
    return { negated, directoryOnly, basenameOnly, base, pattern: fullPattern };
  } catch {
    return undefined;
  }
}

function parseIgnoreSource(source: string, base: RepositoryPath): readonly IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const line of source.split("\n")) {
    const rule = parseIgnoreRule(line, base);
    if (rule !== undefined) rules.push(rule);
  }
  return rules;
}

function candidateAncestors(path: RepositoryPath, isDirectory: boolean): readonly RepositoryPath[] {
  const segments = path.split("/");
  const result: RepositoryPath[] = [];
  const limit = isDirectory ? segments.length : segments.length - 1;
  for (let length = 1; length <= limit; length += 1) {
    result.push(segments.slice(0, length).join("/") as RepositoryPath);
  }
  return result;
}

function ruleMatches(rule: IgnoreRule, path: RepositoryPath, isDirectory: boolean): boolean {
  const pattern = new PoliciGlob(rule.pattern);
  if (rule.basenameOnly) {
    const parts = path.split("/");
    const start = rule.base === "" ? 0 : rule.base.split("/").length;
    for (let index = start; index < parts.length; index += 1) {
      if (pattern.matches(parts[index] ?? "")) {
        if (!rule.directoryOnly || index < parts.length - 1 || isDirectory) return true;
      }
    }
    return false;
  }

  if (pattern.matches(path) && (!rule.directoryOnly || isDirectory)) return true;
  if (!rule.directoryOnly) return false;
  return candidateAncestors(path, isDirectory).some((ancestor) => pattern.matches(ancestor));
}

function isIgnored(
  path: RepositoryPath,
  isDirectory: boolean,
  rules: readonly IgnoreRule[],
): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (ruleMatches(rule, path, isDirectory)) ignored = !rule.negated;
  }
  return ignored;
}

function customIgnoreRules(patterns: readonly string[]): readonly IgnoreRule[] {
  return patterns.map((raw) => {
    let negated = false;
    let pattern = raw;
    if (pattern.startsWith("!")) {
      negated = true;
      pattern = pattern.slice(1);
    }
    let directoryOnly = false;
    if (pattern.endsWith("/")) {
      directoryOnly = true;
      pattern = pattern.slice(0, -1);
    }
    return {
      negated,
      directoryOnly,
      basenameOnly: !pattern.includes("/"),
      base: "" as RepositoryPath,
      pattern,
    };
  });
}

function safeAbsoluteRoot(root: string): string {
  if (typeof root !== "string" || root === "")
    throw new TypeError("Repository root must be a non-empty path");
  return resolve(root);
}

export class RepositorySnapshot {
  readonly #files: FileCollection;
  readonly #sha256: string;

  constructor(files: readonly File[] = []) {
    const sorted = [...files].sort((left, right) => compareNames(left.path, right.path));
    let previousPath: RepositoryPath | undefined;
    for (const file of sorted) {
      if (file.path === previousPath)
        throw new TypeError(`Duplicate repository file ${JSON.stringify(file.path)}`);
      previousPath = file.path;
    }
    this.#files = new FileCollection(sorted);
    this.#sha256 = canonicalSha256(sorted.map((file) => file.toJSON()));
  }

  get files(): FileCollection {
    return this.#files;
  }

  get sha256(): string {
    return this.#sha256;
  }

  static fromFiles(files: readonly File[]): RepositorySnapshot {
    return new RepositorySnapshot(files);
  }

  static fromEntries(entries: readonly RepositorySnapshotEntry[]): RepositorySnapshot {
    return new RepositorySnapshot(
      Array.from(entries, (entry) => new File(entry.path, entry.content, entry.file)),
    );
  }

  get size(): number {
    return this.files.size;
  }

  has(path: string): boolean {
    return this.get(path) !== undefined;
  }

  get(path: string): File | undefined {
    const normalized = normalizeRepositoryPath(path);
    let low = 0;
    let high = this.files.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const file = this.files.at(middle);
      if (file === undefined) return undefined;
      if (file.path === normalized) return file;
      if (file.path < normalized) low = middle + 1;
      else high = middle;
    }
    return undefined;
  }

  matching(pattern: string | PoliciGlob = "**/*"): FileCollection {
    return this.files.matching(pattern);
  }

  equals(other: unknown): boolean {
    if (!(other instanceof RepositorySnapshot) || this.size !== other.size) return false;
    const right = other.files.toArray();
    let index = 0;
    for (const file of this.files.toArray()) {
      if (!file.equals(right[index])) return false;
      index += 1;
    }
    return true;
  }

  toJSON(): SerializedRepositorySnapshot {
    return {
      kind: "repository-snapshot",
      files: this.files.toArray().map((file) => file.toJSON()),
      sha256: this.sha256,
    };
  }
}

/**
 * Scan an immutable in-memory snapshot. Symbolic links and other non-regular
 * entries are skipped. `.git` and `node_modules` are always excluded.
 *
 * Supported `.gitignore` subset: comments, negation, root anchors, directory
 * suffixes, literals, `*`, and segment `**`. Character classes and `?` rules
 * are ignored rather than interpreted incorrectly. Nested `.gitignore` files
 * apply from their containing directory.
 */
export function scanRepository(
  root: string,
  options: RepositoryScanOptions = {},
): RepositorySnapshot {
  const absoluteRoot = safeAbsoluteRoot(root);
  const rootStats = fs.lstatSync(absoluteRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new TypeError(`Repository root ${JSON.stringify(root)} must be a non-symlink directory`);
  }
  const maxFileBytes = validateMaxFileBytes(options.maxFileBytes);
  const initialRules = customIgnoreRules(options.ignore ?? []);
  const files: File[] = [];

  const visit = (
    relativeDirectory: RepositoryPath,
    inheritedRules: readonly IgnoreRule[],
  ): void => {
    const absoluteDirectory =
      relativeDirectory === ""
        ? absoluteRoot
        : resolve(absoluteRoot, ...relativeDirectory.split("/"));
    const directoryStats = fs.lstatSync(absoluteDirectory);
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) return;
    const entries = [...fs.readdirSync(absoluteDirectory, { withFileTypes: true })].sort(
      (left, right) => {
        return compareNames(left.name, right.name);
      },
    );

    let rules = inheritedRules;
    if (options.useGitignore === true) {
      const ignoreEntry = entries.find((entry) => entry.name === ".gitignore" && entry.isFile());
      if (ignoreEntry !== undefined) {
        const ignorePath = resolve(absoluteDirectory, ".gitignore");
        const relativeIgnorePath = joinRepositoryPath(relativeDirectory, ".gitignore");
        const source = new File(
          relativeIgnorePath,
          readRegularFile(ignorePath, relativeIgnorePath, maxFileBytes),
        ).text();
        rules = [...inheritedRules, ...parseIgnoreSource(source, relativeDirectory)];
      }
    }

    for (const entry of entries) {
      if (ALWAYS_IGNORED.has(entry.name)) continue;
      const relativePath = joinRepositoryPath(relativeDirectory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!isIgnored(relativePath, true, rules)) visit(relativePath, rules);
        continue;
      }
      if (!entry.isFile() || isIgnored(relativePath, false, rules)) continue;

      const absolutePath = resolve(absoluteRoot, ...relativePath.split("/"));
      const content = readRegularFile(absolutePath, relativePath, maxFileBytes);
      files.push(new File(relativePath, content, options.file));
    }
  };

  visit("" as RepositoryPath, initialRules);
  return new RepositorySnapshot(files);
}

export const scanRepositorySnapshot = scanRepository;

/** Build a snapshot from an explicit immutable file list, without ignore-file interpretation. */
export function snapshotRepositoryFiles(
  root: string,
  paths: readonly string[],
  options: ExactRepositorySnapshotOptions = {},
): RepositorySnapshot {
  const absoluteRoot = safeAbsoluteRoot(root);
  const rootStats = fs.lstatSync(absoluteRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new TypeError(`Repository root ${JSON.stringify(root)} must be a non-symlink directory`);
  }
  const maxFileBytes = validateMaxFileBytes(options.maxFileBytes);
  const normalized = paths.map(normalizeRepositoryPath).sort(compareNames);
  const files: File[] = [];
  let previous: RepositoryPath | undefined;
  for (const path of normalized) {
    if (path === "") throw new TypeError("An exact snapshot path cannot be the repository root");
    if (path === previous) throw new TypeError(`Duplicate repository file ${JSON.stringify(path)}`);
    previous = path;
    const absolutePath = resolve(absoluteRoot, ...path.split("/"));
    files.push(new File(path, readRegularFile(absolutePath, path, maxFileBytes), options.file));
  }
  return new RepositorySnapshot(files);
}

/** Local convenience scan that explicitly opts into nested `.gitignore` handling. */
export function scanLocalRepository(
  root: string,
  options: RepositoryScanOptions = {},
): RepositorySnapshot {
  return scanRepository(root, { ...options, useGitignore: true });
}

export class LocalRepository {
  readonly root: string;
  readonly options: RepositoryScanOptions;

  constructor(root: string, options: RepositoryScanOptions = {}) {
    this.root = safeAbsoluteRoot(root);
    this.options = Object.freeze({
      ...options,
      ignore: options.ignore === undefined ? undefined : Object.freeze([...options.ignore]),
      file:
        options.file === undefined
          ? undefined
          : Object.freeze({
              ...options.file,
              json:
                options.file.json === undefined
                  ? undefined
                  : Object.freeze({ ...options.file.json }),
            }),
    });
    Object.freeze(this);
  }

  snapshot(): RepositorySnapshot {
    return scanRepository(this.root, this.options);
  }
}
