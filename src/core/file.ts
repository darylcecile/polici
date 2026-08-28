import { PoliciGlob } from "./glob.js";
import { sha256Bytes } from "./hash.js";
import { JsonDocument, parseStrictJson, type JsonParseOptions } from "./json.js";
import { normalizeRepositoryPath, type RepositoryPath } from "./path.js";
import type { JsonValue } from "./serializable.js";

export const json = "json" as const;
export type JsonFormat = typeof json;

export interface FileOptions {
  readonly json?: Omit<JsonParseOptions, "sourceName">;
}

export interface SerializedFile {
  readonly kind: "file";
  readonly path: RepositoryPath;
  readonly size: number;
  readonly sha256: string;
  readonly encoding: "base64";
  readonly content: string;
}

export interface SerializedParsedFile {
  readonly kind: "parsed-file";
  readonly format: "json";
  readonly path: RepositoryPath;
  readonly value: JsonValue;
  readonly document: ReturnType<JsonDocument["toJSON"]>;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function base64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const parts: string[] = [];
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const value = first * 65_536 + second * 256 + third;
    parts.push(
      alphabet.charAt(Math.floor(value / 262_144) % 64),
      alphabet.charAt(Math.floor(value / 4_096) % 64),
      index + 1 < bytes.length ? alphabet.charAt(Math.floor(value / 64) % 64) : "=",
      index + 2 < bytes.length ? alphabet.charAt(value % 64) : "=",
    );
  }
  return parts.join("");
}

function assertValidUtf8(bytes: Uint8Array, path: RepositoryPath): void {
  for (let index = 0; index < bytes.length; index += 1) {
    const first = bytes[index] ?? 0;
    if (first <= 0x7f) continue;

    const second = bytes[index + 1];
    if (
      first >= 0xc2 &&
      first <= 0xdf &&
      second !== undefined &&
      second >= 0x80 &&
      second <= 0xbf
    ) {
      index += 1;
      continue;
    }

    const third = bytes[index + 2];
    if (
      third !== undefined &&
      third >= 0x80 &&
      third <= 0xbf &&
      ((first === 0xe0 && second !== undefined && second >= 0xa0 && second <= 0xbf) ||
        (first >= 0xe1 &&
          first <= 0xec &&
          second !== undefined &&
          second >= 0x80 &&
          second <= 0xbf) ||
        (first === 0xed && second !== undefined && second >= 0x80 && second <= 0x9f) ||
        (first >= 0xee &&
          first <= 0xef &&
          second !== undefined &&
          second >= 0x80 &&
          second <= 0xbf))
    ) {
      index += 2;
      continue;
    }

    const fourth = bytes[index + 3];
    if (
      third !== undefined &&
      third >= 0x80 &&
      third <= 0xbf &&
      fourth !== undefined &&
      fourth >= 0x80 &&
      fourth <= 0xbf &&
      ((first === 0xf0 && second !== undefined && second >= 0x90 && second <= 0xbf) ||
        (first >= 0xf1 &&
          first <= 0xf3 &&
          second !== undefined &&
          second >= 0x80 &&
          second <= 0xbf) ||
        (first === 0xf4 && second !== undefined && second >= 0x80 && second <= 0x8f))
    ) {
      index += 3;
      continue;
    }

    throw new TypeError(`File ${JSON.stringify(path)} is not valid UTF-8 at byte ${index}`);
  }
}

export class File {
  readonly #path: RepositoryPath;
  readonly #data: Uint8Array;
  private readonly jsonOptions: Omit<JsonParseOptions, "sourceName"> | undefined;
  readonly #sha256: string;

  constructor(path: string, content: string | Uint8Array, options: FileOptions = {}) {
    this.#path = normalizeRepositoryPath(path);
    if (this.#path === "") throw new TypeError("A file path cannot be the repository root");
    this.#data =
      typeof content === "string" ? new TextEncoder().encode(content) : copyBytes(content);
    this.jsonOptions = options.json === undefined ? undefined : Object.freeze({ ...options.json });
    this.#sha256 = sha256Bytes(this.#data);
  }

  get path(): RepositoryPath {
    return this.#path;
  }

  get sha256(): string {
    return this.#sha256;
  }

  get size(): number {
    return this.#data.byteLength;
  }

  get bytes(): Uint8Array {
    return copyBytes(this.#data);
  }

  get content(): string {
    return this.text();
  }

  text(): string {
    assertValidUtf8(this.#data, this.path);
    return new TextDecoder().decode(this.#data);
  }

  as(format: JsonFormat): ParsedFile<JsonValue>;
  as(format: JsonFormat): ParsedFile<JsonValue> {
    if (format !== json) throw new TypeError(`Unsupported file format ${JSON.stringify(format)}`);
    const document = parseStrictJson(this.text(), { ...this.jsonOptions, sourceName: this.path });
    return new ParsedFile(this, format, document);
  }

  equals(other: File | undefined): boolean {
    if (other === undefined || this.path !== other.path || this.size !== other.size) return false;
    for (let index = 0; index < this.#data.length; index += 1) {
      if (this.#data[index] !== other.#data[index]) return false;
    }
    return true;
  }

  toJSON(): SerializedFile {
    return {
      kind: "file",
      path: this.path,
      size: this.size,
      sha256: this.sha256,
      encoding: "base64",
      content: base64(this.#data),
    };
  }
}

export class ParsedFile<T extends JsonValue = JsonValue> {
  readonly file: File;
  readonly path: RepositoryPath;
  readonly format: "json";
  readonly document: JsonDocument<T>;
  readonly value: T;

  constructor(file: File, format: JsonFormat, document: JsonDocument<T>) {
    this.file = file;
    this.path = file.path;
    this.format = format;
    this.document = document;
    this.value = document.value;
  }

  toJSON(): SerializedParsedFile {
    return {
      kind: "parsed-file",
      format: this.format,
      path: this.path,
      value: this.value,
      document: this.document.toJSON(),
    };
  }
}

export class FileCollection {
  private readonly items: readonly File[];

  constructor(files: readonly File[] = []) {
    this.items = [...files].sort((left, right) => {
      return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
    });
  }

  get size(): number {
    return this.items.length;
  }

  get length(): number {
    return this.items.length;
  }

  at(index: number): File | undefined {
    return this.items.at(index);
  }

  toArray(): readonly File[] {
    return [...this.items];
  }

  matching(pattern: string | PoliciGlob): FileCollection {
    const glob = typeof pattern === "string" ? new PoliciGlob(pattern) : pattern;
    return new FileCollection(this.items.filter((file) => glob.matches(file.path)));
  }

  as(format: JsonFormat): ParsedFileCollection {
    return new ParsedFileCollection(this.items.map((file) => file.as(format)));
  }
}

export class ParsedFileCollection {
  private readonly items: readonly ParsedFile<JsonValue>[];

  constructor(items: readonly ParsedFile<JsonValue>[] = []) {
    this.items = [...items];
  }

  get size(): number {
    return this.items.length;
  }

  get length(): number {
    return this.items.length;
  }

  at(index: number): ParsedFile<JsonValue> | undefined {
    return this.items.at(index);
  }

  toArray(): readonly ParsedFile<JsonValue>[] {
    return [...this.items];
  }
}

export { FileCollection as Files };
