const DRIVE_ABSOLUTE = /^[A-Za-z]:/;

export type RepositoryPath = string;

export class RepositoryPathError extends TypeError {
  readonly input: string;

  constructor(input: string, message: string) {
    super(`Invalid repository path ${JSON.stringify(input)}: ${message}`);
    this.name = "RepositoryPathError";
    this.input = input;
  }
}

/**
 * Normalize a repository-relative path to slash-separated form. The repository
 * root has the sole canonical spelling "". Paths may not escape that root.
 */
export function normalizeRepositoryPath(input: string): RepositoryPath {
  if (typeof input !== "string") throw new TypeError("Repository path must be a string");
  if (input.includes("\0")) throw new RepositoryPathError(input, "NUL bytes are not allowed");
  if (DRIVE_ABSOLUTE.test(input))
    throw new RepositoryPathError(input, "drive-qualified paths are not allowed");

  const slashPath = input.replace(/\\/g, "/");
  if (slashPath.startsWith("/"))
    throw new RepositoryPathError(input, "absolute paths are not allowed");

  const segments: string[] = [];
  for (const segment of slashPath.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0)
        throw new RepositoryPathError(input, "path escapes the repository root");
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments.join("/") as RepositoryPath;
}

export function isRepositoryPath(value: unknown): value is RepositoryPath {
  if (typeof value !== "string") return false;
  try {
    return normalizeRepositoryPath(value) === value;
  } catch {
    return false;
  }
}

export function assertRepositoryPath(value: unknown): asserts value is RepositoryPath {
  if (!isRepositoryPath(value)) {
    throw new RepositoryPathError(
      typeof value === "string" ? value : String(value),
      "path is not canonical",
    );
  }
}

export function joinRepositoryPath(...parts: readonly string[]): RepositoryPath {
  return normalizeRepositoryPath(parts.filter((part) => part !== "").join("/"));
}

export function repositoryPathSegments(path: string): readonly string[] {
  const normalized = normalizeRepositoryPath(path);
  return normalized === "" ? Object.freeze([]) : Object.freeze(normalized.split("/"));
}

export function repositoryBasename(path: string): string {
  const normalized = normalizeRepositoryPath(path);
  if (normalized === "") return "";
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? normalized : normalized.slice(slash + 1);
}

export function repositoryDirname(path: string): RepositoryPath {
  const normalized = normalizeRepositoryPath(path);
  const slash = normalized.lastIndexOf("/");
  return (slash < 0 ? "" : normalized.slice(0, slash)) as RepositoryPath;
}
