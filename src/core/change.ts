import { File, FileCollection } from "./file.js";
import { PoliciGlob } from "./glob.js";
import { normalizeRepositoryPath, type RepositoryPath } from "./path.js";
import { Collection, valueEquals } from "./value.js";

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface ChangeInput {
  readonly status: ChangeStatus;
  readonly path?: string;
  readonly previousPath?: string;
  readonly before?: File;
  readonly after?: File;
}

export interface SerializedChange {
  readonly kind: "change";
  readonly status: ChangeStatus;
  readonly path: RepositoryPath;
  readonly previousPath?: RepositoryPath;
  readonly before?: ReturnType<File["toJSON"]>;
  readonly after?: ReturnType<File["toJSON"]>;
}

export interface SerializedChangeSet {
  readonly kind: "change-set";
  readonly changes: readonly SerializedChange[];
}

function samePath(left: File | undefined, right: RepositoryPath, label: string): void {
  if (left !== undefined && left.path !== right) {
    throw new TypeError(
      `${label} file path ${JSON.stringify(left.path)} does not match ${JSON.stringify(right)}`,
    );
  }
}

export class Change {
  readonly status: ChangeStatus;
  readonly path: RepositoryPath;
  readonly previousPath?: RepositoryPath;
  readonly before?: File;
  readonly after?: File;

  constructor(input: ChangeInput) {
    this.status = input.status;
    if (
      input.status !== "added" &&
      input.status !== "modified" &&
      input.status !== "deleted" &&
      input.status !== "renamed"
    ) {
      throw new TypeError(`Unknown change status ${JSON.stringify(input.status)}`);
    }

    const inferredPath = input.path ?? input.after?.path ?? input.before?.path;
    if (inferredPath === undefined)
      throw new TypeError("A change requires a path or materialized file");
    this.path = normalizeRepositoryPath(inferredPath);
    if (this.path === "") throw new TypeError("A change path cannot be the repository root");

    if (input.status === "renamed") {
      const inferredPrevious = input.previousPath ?? input.before?.path;
      if (inferredPrevious === undefined)
        throw new TypeError("A renamed change requires previousPath or a before file");
      this.previousPath = normalizeRepositoryPath(inferredPrevious);
      if (this.previousPath === "" || this.previousPath === this.path) {
        throw new TypeError("A renamed change requires distinct non-root paths");
      }
    } else if (input.previousPath !== undefined) {
      throw new TypeError("previousPath is only valid for renamed changes");
    }

    if (input.status === "added" && input.before !== undefined)
      throw new TypeError("An added change cannot have a before file");
    if (input.status === "deleted" && input.after !== undefined)
      throw new TypeError("A deleted change cannot have an after file");
    if (input.status === "renamed")
      samePath(input.before, this.previousPath as RepositoryPath, "Before");
    else samePath(input.before, this.path, "Before");
    samePath(input.after, this.path, "After");

    this.before = input.before;
    this.after = input.after;
    Object.freeze(this);
  }

  get materialized(): File | undefined {
    return this.status === "deleted" ? undefined : this.after;
  }

  equals(other: unknown): boolean {
    return (
      other instanceof Change &&
      this.status === other.status &&
      this.path === other.path &&
      this.previousPath === other.previousPath &&
      valueEquals(this.before, other.before) &&
      valueEquals(this.after, other.after)
    );
  }

  toJSON(): SerializedChange {
    const result: {
      kind: "change";
      status: ChangeStatus;
      path: RepositoryPath;
      previousPath?: RepositoryPath;
      before?: ReturnType<File["toJSON"]>;
      after?: ReturnType<File["toJSON"]>;
    } = { kind: "change", status: this.status, path: this.path };
    if (this.previousPath !== undefined) result.previousPath = this.previousPath;
    if (this.before !== undefined) result.before = this.before.toJSON();
    if (this.after !== undefined) result.after = this.after.toJSON();
    return result;
  }
}

function compareChanges(left: Change, right: Change): number {
  const pathOrder = left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  if (pathOrder !== 0) return pathOrder;
  const statusOrder = left.status < right.status ? -1 : left.status > right.status ? 1 : 0;
  if (statusOrder !== 0) return statusOrder;
  const leftPrevious = left.previousPath ?? "";
  const rightPrevious = right.previousPath ?? "";
  return leftPrevious < rightPrevious ? -1 : leftPrevious > rightPrevious ? 1 : 0;
}

export class ChangeSet implements Iterable<Change> {
  private readonly changes: readonly Change[];

  constructor(changes: Iterable<Change | ChangeInput> = []) {
    const normalized = Array.from(changes, (change) =>
      change instanceof Change ? change : new Change(change),
    );
    normalized.sort(compareChanges);
    const paths = new Set<string>();
    for (const change of normalized) {
      if (paths.has(change.path))
        throw new TypeError(`Duplicate change path ${JSON.stringify(change.path)}`);
      paths.add(change.path);
    }
    this.changes = Object.freeze(normalized);
    Object.freeze(this);
  }

  get size(): number {
    return this.changes.length;
  }

  get length(): number {
    return this.changes.length;
  }

  [Symbol.iterator](): Iterator<Change> {
    return this.changes[Symbol.iterator]();
  }

  toArray(): readonly Change[] {
    return Object.freeze([...this.changes]);
  }

  at(index: number): Change | undefined {
    return this.changes.at(index);
  }

  private withStatus(status: ChangeStatus): ChangeSet {
    return new ChangeSet(this.changes.filter((change) => change.status === status));
  }

  get added(): ChangeSet {
    return this.withStatus("added");
  }

  get modified(): ChangeSet {
    return this.withStatus("modified");
  }

  get deleted(): ChangeSet {
    return this.withStatus("deleted");
  }

  get renamed(): ChangeSet {
    return this.withStatus("renamed");
  }

  get before(): FileCollection {
    return new FileCollection(
      this.changes.flatMap((change) => (change.before === undefined ? [] : [change.before])),
    );
  }

  get after(): FileCollection {
    return this.files();
  }

  matching(pattern: string | PoliciGlob): ChangeSet {
    const glob = typeof pattern === "string" ? new PoliciGlob(pattern) : pattern;
    return new ChangeSet(this.changes.filter((change) => glob.matches(change.path)));
  }

  /** Select readable head files. Deleted changes and changes without after content are omitted. */
  files(pattern: string | PoliciGlob = "**/*"): FileCollection {
    const glob = typeof pattern === "string" ? new PoliciGlob(pattern) : pattern;
    return new FileCollection(
      this.changes.flatMap((change) => {
        const file = change.materialized;
        return file !== undefined && glob.matches(file.path) ? [file] : [];
      }),
    );
  }

  toCollection(): Collection<Change> {
    return new Collection(this.changes);
  }

  equals(other: unknown): boolean {
    if (!(other instanceof ChangeSet) || this.size !== other.size) return false;
    for (let index = 0; index < this.changes.length; index += 1) {
      if (!this.changes[index]?.equals(other.changes[index])) return false;
    }
    return true;
  }

  toJSON(): SerializedChangeSet {
    return { kind: "change-set", changes: this.changes.map((change) => change.toJSON()) };
  }
}

export function changeSet(changes: Iterable<Change | ChangeInput> = []): ChangeSet {
  return new ChangeSet(changes);
}
