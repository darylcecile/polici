import { normalizeRepositoryPath, type RepositoryPath } from "./path.js";

export type GlobSegment = string;

export class PoliciGlobError extends SyntaxError {
  readonly pattern: string;
  readonly offset: number;

  constructor(pattern: string, offset: number, message: string) {
    super(`Invalid Polici glob ${JSON.stringify(pattern)} at offset ${offset}: ${message}`);
    this.name = "PoliciGlobError";
    this.pattern = pattern;
    this.offset = offset;
  }
}

function matchSegment(pattern: string, value: string): boolean {
  let patternIndex = 0;
  let valueIndex = 0;
  let starIndex = -1;
  let starValueIndex = -1;

  while (valueIndex < value.length) {
    if (patternIndex < pattern.length && pattern.charAt(patternIndex) === "*") {
      starIndex = patternIndex;
      starValueIndex = valueIndex;
      patternIndex += 1;
    } else if (
      patternIndex < pattern.length &&
      pattern.charAt(patternIndex) === value.charAt(valueIndex)
    ) {
      patternIndex += 1;
      valueIndex += 1;
    } else if (starIndex >= 0) {
      patternIndex = starIndex + 1;
      starValueIndex += 1;
      valueIndex = starValueIndex;
    } else {
      return false;
    }
  }

  while (patternIndex < pattern.length && pattern.charAt(patternIndex) === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}

function validatePattern(pattern: string): readonly GlobSegment[] {
  if (typeof pattern !== "string") throw new TypeError("Polici glob must be a string");
  if (pattern.includes("\0"))
    throw new PoliciGlobError(pattern, pattern.indexOf("\0"), "NUL bytes are not allowed");
  if (pattern.includes("\\"))
    throw new PoliciGlobError(pattern, pattern.indexOf("\\"), "use '/' as the path separator");
  if (pattern.startsWith("/"))
    throw new PoliciGlobError(pattern, 0, "globs are repository-relative and anchored");
  if (pattern === "") return [];

  const rawSegments = pattern.split("/");
  const segments: GlobSegment[] = [];
  let offset = 0;
  for (const raw of rawSegments) {
    if (raw === "")
      throw new PoliciGlobError(pattern, offset, "empty path segments are not allowed");
    if (raw === "." || raw === "..") {
      throw new PoliciGlobError(pattern, offset, "'.' and '..' path segments are not allowed");
    }
    if (raw === "**") {
      segments.push("**");
    } else {
      const doubleStar = raw.indexOf("**");
      if (doubleStar >= 0) {
        throw new PoliciGlobError(
          pattern,
          offset + doubleStar,
          "'**' must occupy an entire path segment",
        );
      }
      segments.push(raw);
    }
    offset += raw.length + 1;
  }
  return segments;
}

export class PoliciGlob {
  readonly pattern: string;
  readonly segments: readonly GlobSegment[];

  constructor(pattern: string) {
    this.pattern = pattern;
    this.segments = validatePattern(pattern);
  }

  matches(path: string): boolean {
    const normalized = normalizeRepositoryPath(path);
    const pathSegments = normalized === "" ? [] : normalized.split("/");
    let states = Array.from({ length: this.segments.length + 1 }, () => false);
    states[0] = true;

    const includeEmptyGlobstars = (values: boolean[]): void => {
      for (let index = 0; index < this.segments.length; index += 1) {
        if (values[index] && this.segments[index] === "**") values[index + 1] = true;
      }
    };

    includeEmptyGlobstars(states);
    for (const pathSegment of pathSegments) {
      const next = Array.from({ length: this.segments.length + 1 }, () => false);
      for (let index = 0; index < this.segments.length; index += 1) {
        if (!states[index]) continue;
        const segment = this.segments[index];
        if (segment === "**") next[index] = true;
        else if (segment !== undefined && matchSegment(segment, pathSegment)) {
          next[index + 1] = true;
        }
      }
      includeEmptyGlobstars(next);
      states = next;
    }

    return states[this.segments.length] === true;
  }

  test(path: string): boolean {
    return this.matches(path);
  }

  toJSON(): string {
    return this.pattern;
  }
}

export function parsePoliciGlob(pattern: string): PoliciGlob {
  return new PoliciGlob(pattern);
}

export function matchPoliciGlob(pattern: string | PoliciGlob, path: string): boolean {
  return (typeof pattern === "string" ? new PoliciGlob(pattern) : pattern).matches(path);
}

export function selectMatchingPaths(
  paths: readonly string[],
  pattern: string | PoliciGlob,
): readonly RepositoryPath[] {
  const glob = typeof pattern === "string" ? new PoliciGlob(pattern) : pattern;
  return Object.freeze(paths.map(normalizeRepositoryPath).filter((path) => glob.matches(path)));
}
