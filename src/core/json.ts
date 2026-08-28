import type { JsonValue } from "./serializable.js";

export interface SourcePosition {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

export interface SourceSpan {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

export interface JsonLocation {
  readonly pointer: string;
  readonly value: SourceSpan;
  readonly key?: SourceSpan;
}

export interface JsonParseOptions {
  readonly sourceName?: string;
  readonly maxBytes?: number;
  readonly maxDepth?: number;
}

export type JsonParseErrorCode =
  | "JSON_INVALID"
  | "JSON_DUPLICATE_KEY"
  | "JSON_MAX_DEPTH"
  | "JSON_MAX_SIZE"
  | "JSON_NUMBER_RANGE";

export interface SerializedJsonParseError {
  readonly kind: "json-parse-error";
  readonly code: JsonParseErrorCode;
  readonly message: string;
  readonly sourceName?: string;
  readonly pointer: string;
  readonly position: SourcePosition;
}

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 128;

function freezePosition(position: SourcePosition): SourcePosition {
  return Object.freeze(position);
}

function freezeSpan(span: SourceSpan): SourceSpan {
  return Object.freeze({
    start: freezePosition(span.start),
    end: freezePosition(span.end),
  });
}

export class JsonParseError extends SyntaxError {
  readonly code: JsonParseErrorCode;
  readonly sourceName?: string;
  readonly pointer: string;
  readonly position: SourcePosition;

  constructor(
    code: JsonParseErrorCode,
    message: string,
    position: SourcePosition,
    pointer: string,
    sourceName?: string,
  ) {
    const source = sourceName === undefined ? "JSON" : sourceName;
    super(`${source}:${position.line}:${position.column}: ${message}`);
    this.name = "JsonParseError";
    this.code = code;
    this.sourceName = sourceName;
    this.pointer = pointer;
    this.position = freezePosition(position);
  }

  toJSON(): SerializedJsonParseError {
    const result: {
      kind: "json-parse-error";
      code: JsonParseErrorCode;
      message: string;
      sourceName?: string;
      pointer: string;
      position: SourcePosition;
    } = {
      kind: "json-parse-error",
      code: this.code,
      message: this.message,
      pointer: this.pointer,
      position: this.position,
    };
    if (this.sourceName !== undefined) result.sourceName = this.sourceName;
    return result;
  }
}

function pointerToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function escapeJsonPointerToken(value: string): string {
  return pointerToken(value);
}

export function unescapeJsonPointerToken(value: string): string {
  return value.replace(/~1/g, "/").replace(/~0/g, "~");
}

function freezeJson(value: JsonValue): JsonValue {
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) {
      for (const item of value) freezeJson(item);
    } else {
      const object = value as { readonly [key: string]: JsonValue };
      for (const key of Object.keys(object)) freezeJson(object[key] as JsonValue);
    }
    Object.freeze(value);
  }
  return value;
}

function lineStartOffsets(source: string): readonly number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code === 13) {
      if (source.charCodeAt(index + 1) === 10) index += 1;
      starts.push(index + 1);
    } else if (code === 10) {
      starts.push(index + 1);
    }
  }
  return starts;
}

function positionAt(starts: readonly number[], offset: number): SourcePosition {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle;
  }
  const lineStart = starts[low] ?? 0;
  return { offset, line: low, column: offset - lineStart };
}

function validateLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${name} must be a non-negative safe integer`);
  return value;
}

interface StringToken {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

class StrictJsonParser {
  private index = 0;
  private readonly locations = new Map<string, JsonLocation>();
  private readonly starts: readonly number[];

  constructor(
    private readonly source: string,
    private readonly sourceName: string | undefined,
    private readonly maxDepth: number,
  ) {
    this.starts = lineStartOffsets(source);
  }

  parse(): { readonly value: JsonValue; readonly locations: ReadonlyMap<string, JsonLocation> } {
    this.skipWhitespace();
    const value = this.parseValue("", 0);
    this.skipWhitespace();
    if (this.index !== this.source.length)
      this.fail("JSON_INVALID", "Unexpected trailing content", "");
    return { value: freezeJson(value), locations: this.locations };
  }

  private position(offset = this.index): SourcePosition {
    return positionAt(this.starts, offset);
  }

  private span(start: number, end: number): SourceSpan {
    return freezeSpan({ start: this.position(start), end: this.position(end) });
  }

  private fail(
    code: JsonParseErrorCode,
    message: string,
    pointer: string,
    offset = this.index,
  ): never {
    throw new JsonParseError(code, message, this.position(offset), pointer, this.sourceName);
  }

  private skipWhitespace(): void {
    while (this.index < this.source.length) {
      const code = this.source.charCodeAt(this.index);
      if (code !== 32 && code !== 9 && code !== 10 && code !== 13) return;
      this.index += 1;
    }
  }

  private parseValue(pointer: string, depth: number, key?: SourceSpan): JsonValue {
    const start = this.index;
    const character = this.source.charAt(this.index);
    let value: JsonValue;

    if (character === '"') value = this.parseString(pointer).value;
    else if (character === "{") value = this.parseObject(pointer, depth);
    else if (character === "[") value = this.parseArray(pointer, depth);
    else if (character === "t") value = this.parseLiteral("true", true, pointer);
    else if (character === "f") value = this.parseLiteral("false", false, pointer);
    else if (character === "n") value = this.parseLiteral("null", null, pointer);
    else if (character === "-" || (character >= "0" && character <= "9"))
      value = this.parseNumber(pointer);
    else
      this.fail(
        "JSON_INVALID",
        character === ""
          ? "Expected a JSON value"
          : `Unexpected character ${JSON.stringify(character)}`,
        pointer,
      );

    const location: JsonLocation =
      key === undefined
        ? Object.freeze({ pointer, value: this.span(start, this.index) })
        : Object.freeze({ pointer, value: this.span(start, this.index), key });
    this.locations.set(pointer, location);
    return value;
  }

  private enterContainer(pointer: string, depth: number): void {
    if (depth >= this.maxDepth) {
      this.fail("JSON_MAX_DEPTH", `JSON nesting exceeds maxDepth ${this.maxDepth}`, pointer);
    }
  }

  private parseObject(pointer: string, depth: number): JsonValue {
    this.enterContainer(pointer, depth);
    this.index += 1;
    this.skipWhitespace();
    const value = Object.create(null) as Record<string, JsonValue>;
    const keys = new Set<string>();

    if (this.source.charAt(this.index) === "}") {
      this.index += 1;
      return value;
    }

    while (true) {
      if (this.source.charAt(this.index) !== '"')
        this.fail("JSON_INVALID", "Expected an object key string", pointer);
      const key = this.parseString(pointer);
      const childPointer = `${pointer}/${pointerToken(key.value)}`;
      if (keys.has(key.value)) {
        this.fail(
          "JSON_DUPLICATE_KEY",
          `Duplicate object key ${JSON.stringify(key.value)}`,
          childPointer,
          key.start,
        );
      }
      keys.add(key.value);
      this.skipWhitespace();
      if (this.source.charAt(this.index) !== ":")
        this.fail("JSON_INVALID", "Expected ':' after object key", pointer);
      this.index += 1;
      this.skipWhitespace();
      value[key.value] = this.parseValue(childPointer, depth + 1, this.span(key.start, key.end));
      this.skipWhitespace();

      const separator = this.source.charAt(this.index);
      if (separator === "}") {
        this.index += 1;
        return value;
      }
      if (separator !== ",") this.fail("JSON_INVALID", "Expected ',' or '}' in object", pointer);
      this.index += 1;
      this.skipWhitespace();
      if (this.source.charAt(this.index) === "}")
        this.fail("JSON_INVALID", "Trailing commas are not allowed", pointer);
    }
  }

  private parseArray(pointer: string, depth: number): JsonValue {
    this.enterContainer(pointer, depth);
    this.index += 1;
    this.skipWhitespace();
    const value: JsonValue[] = [];

    if (this.source.charAt(this.index) === "]") {
      this.index += 1;
      return value;
    }

    while (true) {
      const childPointer = `${pointer}/${value.length}`;
      value.push(this.parseValue(childPointer, depth + 1));
      this.skipWhitespace();
      const separator = this.source.charAt(this.index);
      if (separator === "]") {
        this.index += 1;
        return value;
      }
      if (separator !== ",") this.fail("JSON_INVALID", "Expected ',' or ']' in array", pointer);
      this.index += 1;
      this.skipWhitespace();
      if (this.source.charAt(this.index) === "]")
        this.fail("JSON_INVALID", "Trailing commas are not allowed", pointer);
    }
  }

  private parseString(pointer: string): StringToken {
    const start = this.index;
    this.index += 1;
    const parts: string[] = [];
    let chunkStart = this.index;

    while (this.index < this.source.length) {
      const code = this.source.charCodeAt(this.index);
      if (code === 34) {
        parts.push(this.source.slice(chunkStart, this.index));
        this.index += 1;
        return { value: parts.join(""), start, end: this.index };
      }
      if (code < 32) this.fail("JSON_INVALID", "Unescaped control character in string", pointer);
      if (code !== 92) {
        this.index += 1;
        continue;
      }

      parts.push(this.source.slice(chunkStart, this.index));
      this.index += 1;
      const escape = this.source.charAt(this.index);
      if (escape === '"' || escape === "\\" || escape === "/") {
        parts.push(escape);
        this.index += 1;
      } else if (escape === "b") {
        parts.push("\b");
        this.index += 1;
      } else if (escape === "f") {
        parts.push("\f");
        this.index += 1;
      } else if (escape === "n") {
        parts.push("\n");
        this.index += 1;
      } else if (escape === "r") {
        parts.push("\r");
        this.index += 1;
      } else if (escape === "t") {
        parts.push("\t");
        this.index += 1;
      } else if (escape === "u") {
        parts.push(String.fromCharCode(this.parseUnicodeEscape(pointer)));
      } else {
        this.fail("JSON_INVALID", "Invalid string escape", pointer, this.index - 1);
      }
      chunkStart = this.index;
    }

    this.fail("JSON_INVALID", "Unterminated string", pointer, start);
  }

  private parseUnicodeEscape(pointer: string): number {
    this.index += 1;
    if (this.index + 4 > this.source.length)
      this.fail("JSON_INVALID", "Incomplete Unicode escape", pointer);
    let value = 0;
    for (let count = 0; count < 4; count += 1) {
      const code = this.source.charCodeAt(this.index + count);
      let digit: number;
      if (code >= 48 && code <= 57) digit = code - 48;
      else if (code >= 65 && code <= 70) digit = code - 55;
      else if (code >= 97 && code <= 102) digit = code - 87;
      else this.fail("JSON_INVALID", "Invalid Unicode escape", pointer, this.index + count);
      value = value * 16 + digit;
    }
    this.index += 4;
    return value;
  }

  private parseLiteral<T extends JsonValue>(literal: string, value: T, pointer: string): T {
    if (this.source.slice(this.index, this.index + literal.length) !== literal) {
      this.fail("JSON_INVALID", `Expected ${literal}`, pointer);
    }
    this.index += literal.length;
    return value;
  }

  private parseNumber(pointer: string): number {
    const start = this.index;
    if (this.source.charAt(this.index) === "-") this.index += 1;
    const first = this.source.charAt(this.index);
    if (first === "0") {
      this.index += 1;
      const next = this.source.charAt(this.index);
      if (next >= "0" && next <= "9")
        this.fail("JSON_INVALID", "Leading zero in number", pointer, this.index);
    } else if (first >= "1" && first <= "9") {
      while (this.source.charAt(this.index) >= "0" && this.source.charAt(this.index) <= "9")
        this.index += 1;
    } else {
      this.fail("JSON_INVALID", "Expected a digit", pointer);
    }

    if (this.source.charAt(this.index) === ".") {
      this.index += 1;
      const fractionStart = this.index;
      while (this.source.charAt(this.index) >= "0" && this.source.charAt(this.index) <= "9")
        this.index += 1;
      if (fractionStart === this.index)
        this.fail("JSON_INVALID", "Expected digits after decimal point", pointer);
    }

    const exponent = this.source.charAt(this.index);
    if (exponent === "e" || exponent === "E") {
      this.index += 1;
      const sign = this.source.charAt(this.index);
      if (sign === "+" || sign === "-") this.index += 1;
      const exponentStart = this.index;
      while (this.source.charAt(this.index) >= "0" && this.source.charAt(this.index) <= "9")
        this.index += 1;
      if (exponentStart === this.index)
        this.fail("JSON_INVALID", "Expected exponent digits", pointer);
    }

    const value = Number(this.source.slice(start, this.index));
    if (!Number.isFinite(value))
      this.fail("JSON_NUMBER_RANGE", "Number is outside the finite JSON range", pointer, start);
    return value;
  }
}

export interface SerializedJsonDocument {
  readonly kind: "json-document";
  readonly sourceName?: string;
  readonly source: string;
  readonly value: JsonValue;
  readonly locations: readonly JsonLocation[];
}

export class JsonDocument<T extends JsonValue = JsonValue> {
  readonly source: string;
  readonly sourceName?: string;
  readonly value: T;
  readonly locations: readonly JsonLocation[];
  readonly #locationMap: ReadonlyMap<string, JsonLocation>;

  constructor(
    source: string,
    value: T,
    locations: ReadonlyMap<string, JsonLocation>,
    sourceName?: string,
  ) {
    this.source = source;
    this.sourceName = sourceName;
    this.value = value;
    const locationMap = new Map<string, JsonLocation>();
    for (const [pointer, location] of locations) locationMap.set(pointer, location);
    this.#locationMap = locationMap;
    const sortedLocations = [...locations.values()];
    sortedLocations.sort((left, right) => left.value.start.offset - right.value.start.offset);
    this.locations = sortedLocations;
  }

  location(pointer = ""): JsonLocation | undefined {
    return this.#locationMap.get(pointer);
  }

  valueSpan(pointer = ""): SourceSpan | undefined {
    return this.location(pointer)?.value;
  }

  keySpan(pointer: string): SourceSpan | undefined {
    return this.location(pointer)?.key;
  }

  has(pointer: string): boolean {
    return this.location(pointer) !== undefined;
  }

  valueAt(pointer = ""): JsonValue | undefined {
    if (pointer === "") return this.value;
    if (!pointer.startsWith("/"))
      throw new TypeError("JSON Pointer must be empty or start with '/'");
    let current: JsonValue | undefined = this.value;
    for (const encoded of pointer.slice(1).split("/")) {
      const token = unescapeJsonPointerToken(encoded);
      if (Array.isArray(current)) {
        if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
        current = current[Number(token)];
      } else if (current !== null && typeof current === "object") {
        const record = current as { readonly [key: string]: JsonValue };
        if (!Object.keys(record).includes(token)) return undefined;
        current = record[token];
      } else {
        return undefined;
      }
    }
    return current;
  }

  toJSON(): SerializedJsonDocument {
    const result: {
      kind: "json-document";
      sourceName?: string;
      source: string;
      value: JsonValue;
      locations: readonly JsonLocation[];
    } = {
      kind: "json-document",
      source: this.source,
      value: this.value,
      locations: this.locations,
    };
    if (this.sourceName !== undefined) result.sourceName = this.sourceName;
    return result;
  }
}

export function parseStrictJson<T extends JsonValue = JsonValue>(
  source: string,
  options: JsonParseOptions = {},
): JsonDocument<T> {
  if (typeof source !== "string") throw new TypeError("JSON source must be a string");
  const maxBytes = validateLimit(options.maxBytes, DEFAULT_MAX_BYTES, "maxBytes");
  const maxDepth = validateLimit(options.maxDepth, DEFAULT_MAX_DEPTH, "maxDepth");
  const byteLength =
    source.length > maxBytes ? source.length : new TextEncoder().encode(source).byteLength;
  if (byteLength > maxBytes) {
    throw new JsonParseError(
      "JSON_MAX_SIZE",
      `JSON source is ${byteLength} bytes; maxBytes is ${maxBytes}`,
      { offset: 0, line: 0, column: 0 },
      "",
      options.sourceName,
    );
  }

  const parsed = new StrictJsonParser(source, options.sourceName, maxDepth).parse();
  return new JsonDocument(source, parsed.value as T, parsed.locations, options.sourceName);
}

export const locateJsonSource = parseStrictJson;
