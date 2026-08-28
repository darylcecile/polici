import { decodeUtf8 } from "./utf8.ts";

const HEADER_END = new Uint8Array([13, 10, 13, 10]);
const DEFAULT_MAX_HEADER_BYTES = 8192;

export interface LspFrame {
  readonly body?: string;
  readonly error?: string;
}

function append(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right.slice();
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left, 0);
  joined.set(right, left.length);
  return joined;
}

function indexOfHeaderEnd(bytes: Uint8Array): number {
  for (let index = 0; index <= bytes.length - HEADER_END.length; index++) {
    if (
      bytes[index] === 13 &&
      bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 &&
      bytes[index + 3] === 10
    )
      return index;
  }
  return -1;
}

function ascii(bytes: Uint8Array): string | undefined {
  let result = "";
  for (const byte of bytes) {
    if (byte > 0x7f) return undefined;
    result += String.fromCharCode(byte);
  }
  return result;
}

function contentLength(header: string): number | undefined {
  let found: number | undefined;
  for (const line of header.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) return undefined;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name !== "content-length") continue;
    if (found !== undefined || !/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) return undefined;
    found = parsed;
  }
  return found;
}

/** Stateful Content-Length parser supporting arbitrary chunk boundaries and multiple frames. */
export class LspFramer {
  private buffer: Uint8Array = new Uint8Array(0);
  private expected: number | undefined;
  private discard = 0;

  constructor(
    readonly maxMessageBytes = 8 * 1024 * 1024,
    readonly maxHeaderBytes = DEFAULT_MAX_HEADER_BYTES,
  ) {
    if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes <= 0)
      throw new RangeError("maxMessageBytes must be a positive safe integer");
    if (!Number.isSafeInteger(maxHeaderBytes) || maxHeaderBytes <= 0)
      throw new RangeError("maxHeaderBytes must be a positive safe integer");
  }

  push(chunk: Uint8Array | string): readonly LspFrame[] {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    this.buffer = append(this.buffer, bytes);
    const result: LspFrame[] = [];
    while (true) {
      if (this.discard > 0) {
        const amount = Math.min(this.discard, this.buffer.length);
        this.buffer = this.buffer.slice(amount);
        this.discard -= amount;
        if (this.discard > 0) break;
        result.push({ error: `Content-Length exceeds the ${this.maxMessageBytes} byte limit.` });
        continue;
      }
      if (this.expected !== undefined) {
        if (this.buffer.length < this.expected) break;
        const body = this.buffer.slice(0, this.expected);
        this.buffer = this.buffer.slice(this.expected);
        this.expected = undefined;
        const decoded = decodeUtf8(body);
        result.push(
          decoded === undefined ? { error: "Message body is not valid UTF-8." } : { body: decoded },
        );
        continue;
      }
      const headerEnd = indexOfHeaderEnd(this.buffer);
      if (headerEnd < 0) {
        if (this.buffer.length > this.maxHeaderBytes) {
          this.buffer = new Uint8Array(0);
          result.push({ error: `Header exceeds the ${this.maxHeaderBytes} byte limit.` });
        }
        break;
      }
      if (headerEnd > this.maxHeaderBytes) {
        this.buffer = new Uint8Array(0);
        result.push({ error: `Header exceeds the ${this.maxHeaderBytes} byte limit.` });
        break;
      }
      const headerBytes = this.buffer.slice(0, headerEnd);
      this.buffer = this.buffer.slice(headerEnd + HEADER_END.length);
      const header = ascii(headerBytes);
      const length = header === undefined ? undefined : contentLength(header);
      if (length === undefined) {
        this.buffer = new Uint8Array(0);
        result.push({ error: "Header must contain exactly one valid Content-Length field." });
        break;
      }
      if (length > this.maxMessageBytes) {
        this.discard = length;
        continue;
      }
      this.expected = length;
    }
    return result;
  }

  finish(): readonly LspFrame[] {
    if (this.buffer.length === 0 && this.expected === undefined && this.discard === 0) return [];
    this.buffer = new Uint8Array(0);
    this.expected = undefined;
    this.discard = 0;
    return [{ error: "Input ended with an incomplete LSP frame." }];
  }
}

export function encodeLspMessage(message: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(message));
  const header = new TextEncoder().encode(`Content-Length: ${body.length}\r\n\r\n`);
  return append(header, body);
}
