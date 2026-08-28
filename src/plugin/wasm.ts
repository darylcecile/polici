import { readFileSync } from "node:fs";

export interface WasmImport {
  readonly module: string;
  readonly name: string;
  readonly kind: "function" | "table" | "memory" | "global" | "tag";
}

const WASI_MODULE = "wasi_snapshot_preview1";
const ALLOWED_WASI_IMPORTS = new Set([
  "args_get",
  "args_sizes_get",
  "environ_get",
  "environ_sizes_get",
  "fd_close",
  "fd_fdstat_get",
  "fd_prestat_dir_name",
  "fd_prestat_get",
  "fd_read",
  "fd_seek",
  "fd_write",
  "path_readlink",
  "proc_exit",
]);
const MAX_WASM_MEMORY_PAGES = 1024;
const MAX_WASM_TABLE_ELEMENTS = 100_000;

export function validateWasiCommandFile(path: string): readonly WasmImport[] {
  return validateWasiCommand(new Uint8Array(readFileSync(path)));
}

/** Validates the capability-minimal WASI Preview 1 command ABI used by Polici. */
export function validateWasiCommand(bytes: Uint8Array): readonly WasmImport[] {
  const reader = new WasmReader(bytes);
  reader.expectBytes([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00], "WASM header");
  const imports: WasmImport[] = [];
  let hasStartExport = false;
  let previousSection = 0;
  while (!reader.done) {
    const id = reader.byte("section id");
    const size = reader.unsigned("section size");
    const section = reader.section(size);
    if (id !== 0 && id < previousSection) throw new TypeError("WASM sections are out of order");
    if (id !== 0) previousSection = id;
    if (id === 2) {
      readImports(section, imports);
      section.finish("WASM import section");
    } else if (id === 4) {
      validateTables(section);
      section.finish("WASM table section");
    } else if (id === 5) {
      validateMemories(section);
      section.finish("WASM memory section");
    } else if (id === 7) {
      hasStartExport = readExports(section) || hasStartExport;
      section.finish("WASM export section");
    }
  }
  if (!hasStartExport) throw new TypeError("WASI runtime must export the _start function");
  for (const item of imports) {
    if (
      item.module !== WASI_MODULE ||
      item.kind !== "function" ||
      !ALLOWED_WASI_IMPORTS.has(item.name)
    ) {
      throw new TypeError(
        `WASI runtime import ${item.module}.${item.name} (${item.kind}) is not permitted`,
      );
    }
  }
  return imports;
}

function validateTables(reader: WasmReader): void {
  const count = reader.unsigned("table count");
  if (count > 1) throw new TypeError("WASI runtime may declare at most one table");
  for (let index = 0; index < count; index += 1) {
    reader.byte("table element type");
    reader.boundedLimits("table limits", MAX_WASM_TABLE_ELEMENTS);
  }
}

function validateMemories(reader: WasmReader): void {
  const count = reader.unsigned("memory count");
  if (count !== 1) throw new TypeError("WASI runtime must declare exactly one memory");
  reader.boundedLimits("memory limits", MAX_WASM_MEMORY_PAGES);
}

function readImports(reader: WasmReader, imports: WasmImport[]): void {
  const count = reader.unsigned("import count");
  for (let index = 0; index < count; index += 1) {
    const module = reader.name("import module");
    const name = reader.name("import name");
    const kind = reader.byte("import kind");
    if (kind === 0) reader.unsigned("function type");
    else if (kind === 1) {
      reader.byte("table element type");
      reader.limits("table limits");
    } else if (kind === 2) reader.limits("memory limits");
    else if (kind === 3) {
      reader.byte("global value type");
      reader.byte("global mutability");
    } else if (kind === 4) {
      reader.byte("tag attribute");
      reader.unsigned("tag type");
    } else throw new TypeError(`Unknown WASM import kind ${kind}`);
    imports.push({ module, name, kind: importKind(kind) });
  }
}

function readExports(reader: WasmReader): boolean {
  const count = reader.unsigned("export count");
  let found = false;
  for (let index = 0; index < count; index += 1) {
    const name = reader.name("export name");
    const kind = reader.byte("export kind");
    reader.unsigned("export index");
    if (name === "_start" && kind === 0) found = true;
  }
  return found;
}

function importKind(value: number): WasmImport["kind"] {
  return (["function", "table", "memory", "global", "tag"] as const)[value]!;
}

class WasmReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.offset === this.bytes.length;
  }

  byte(label: string): number {
    const value = this.bytes[this.offset];
    if (value === undefined) throw new TypeError(`Truncated ${label}`);
    this.offset += 1;
    return value;
  }

  unsigned(label: string): number {
    let value = 0;
    let shift = 0;
    for (let index = 0; index < 5; index += 1) {
      const byte = this.byte(label);
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) {
        if (!Number.isSafeInteger(value)) throw new TypeError(`Invalid ${label}`);
        return value;
      }
      shift += 7;
    }
    throw new TypeError(`Invalid ${label}`);
  }

  name(label: string): string {
    const size = this.unsigned(`${label} length`);
    const bytes = this.take(size, label);
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (value.includes("\0")) throw new TypeError(`${label} contains NUL`);
    return value;
  }

  limits(label: string): void {
    const flags = this.byte(`${label} flags`);
    if (flags > 3) throw new TypeError(`Unsupported ${label} flags`);
    this.unsigned(`${label} minimum`);
    if ((flags & 1) !== 0) this.unsigned(`${label} maximum`);
  }

  boundedLimits(label: string, maximum: number): void {
    const flags = this.byte(`${label} flags`);
    if (flags > 1) throw new TypeError(`Unsupported ${label} flags`);
    const minimum = this.unsigned(`${label} minimum`);
    const declaredMaximum = (flags & 1) !== 0 ? this.unsigned(`${label} maximum`) : maximum;
    if (minimum > maximum || declaredMaximum > maximum || declaredMaximum < minimum)
      throw new TypeError(`${label} exceeds the configured limit ${maximum}`);
  }

  section(size: number): WasmReader {
    return new WasmReader(this.take(size, "section payload"));
  }

  expectBytes(expected: readonly number[], label: string): void {
    for (const value of expected)
      if (this.byte(label) !== value) throw new TypeError(`Invalid ${label}`);
  }

  finish(label: string): void {
    if (!this.done) throw new TypeError(`Unexpected data in ${label}`);
  }

  private take(size: number, label: string): Uint8Array {
    if (!Number.isSafeInteger(size) || size < 0 || this.offset + size > this.bytes.length)
      throw new TypeError(`Truncated ${label}`);
    const value = this.bytes.subarray(this.offset, this.offset + size);
    this.offset += size;
    return value;
  }
}
