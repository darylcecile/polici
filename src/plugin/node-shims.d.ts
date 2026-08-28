declare module "node:child_process" {
  export function execFileSync(
    command: string,
    args?: readonly string[],
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      input?: string | Uint8Array;
      timeout?: number;
      maxBuffer?: number;
      killSignal?: string;
      windowsHide?: boolean;
      encoding?: "utf8" | "utf-8";
      stdio?: "pipe" | readonly ["pipe", "pipe", "pipe"];
    },
  ): string;
}

declare const process: {
  readonly argv: readonly string[];
  readonly stdout: { write(value: string | Uint8Array): void };
  readonly stderr: { write(text: string): void };
  exit(code?: number): never;
  exitCode?: number;
  readonly env: Readonly<Record<string, string | undefined>>;
};

declare module "node:fs" {
  export const constants: {
    readonly X_OK: number;
    readonly O_RDONLY: number;
    readonly O_NOFOLLOW?: number;
  };
  export function accessSync(path: string, mode?: number): void;
  export function lstatSync(path: string): {
    readonly size: number;
    readonly mtimeMs: number;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  };
  export function fstatSync(fd: number): {
    readonly size: number;
    readonly mtimeMs: number;
    isFile(): boolean;
  };
  export function openSync(path: string, flags: string | number): number;
  export function readFileSync(path: string | number): Uint8Array;
  export function closeSync(fd: number): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(
    path: string,
    options?: { readonly recursive?: boolean; readonly force?: boolean },
  ): void;
  export function writeFileSync(path: string, data: string | Uint8Array): void;
  export function readdirSync(
    path: string,
    options: { readonly withFileTypes: true },
  ): readonly {
    readonly name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }[];
}

declare module "node:path" {
  export const delimiter: string;
  export function isAbsolute(path: string): boolean;
  export function resolve(...paths: string[]): string;
}
