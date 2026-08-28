declare const process: {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly pid: number;
  readonly execPath: string;
  exitCode?: number;
  cwd(): string;
  readonly stdout: { write(value: string | Uint8Array): void };
  readonly stderr: { write(value: string | Uint8Array): void };
  exit(code?: number): never;
  on?(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
};

declare const Buffer: {
  from(value: string, encoding: "base64"): Uint8Array & { toString(encoding: "base64"): string };
  from(value: Uint8Array): Uint8Array & { toString(encoding: "base64"): string };
};

declare module "node:child_process" {
  export function spawnSync(
    command: string,
    args: string[],
    options: {
      readonly cwd: string;
      readonly env?: Readonly<Record<string, string>>;
      readonly input?: string | Uint8Array;
      readonly timeout?: number;
      readonly maxBuffer?: number;
      readonly windowsHide?: boolean;
      readonly killSignal?: string;
      readonly stdio: readonly ["pipe", "pipe", "pipe"];
    },
  ): {
    readonly status: number | null;
    readonly signal: string | null;
    readonly stdout: Uint8Array;
    readonly stderr: Uint8Array;
    readonly error?: Error & { readonly code?: string };
  };
  export function execFileSync(
    command: string,
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly env?: Readonly<Record<string, string>>;
      readonly input?: string | Uint8Array;
      readonly timeout?: number;
      readonly maxBuffer?: number;
      readonly windowsHide?: boolean;
      readonly encoding?: "utf8";
      readonly stdio: "inherit" | readonly ["pipe", "pipe", "pipe"];
    },
  ): Uint8Array;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "polici-native/src/cli/native.js" {
  export function nativeRealRun(
    runProcess: (
      command: string,
      arguments_: readonly string[],
      cwd: string,
      environment: Readonly<Record<string, string>>,
      inputBase64: string,
      timeoutMs: number,
      maxOutputBytes: number,
    ) => string,
  ): Promise<number>;
  export function nativeLspStart(): void;
  export function nativeLspReceive(inputBase64: string): void;
  export function nativeLspEnd(): void;
  export function nativeLspTakeOutput(maxBytes: number): string;
  export function nativeLspExitCode(): number;
  export function runNativeEntrypoint(
    argv: readonly string[],
    environment: Readonly<Record<string, string | undefined>>,
    runProcess: (
      command: string,
      arguments_: readonly string[],
      cwd: string,
      environment: Readonly<Record<string, string>>,
      inputBase64: string,
      timeoutMs: number,
      maxOutputBytes: number,
      maxErrorBytes?: number,
    ) => string,
  ): Promise<void>;
  export function runNativeProcessEntrypoint(
    runProcess: (
      command: string,
      arguments_: readonly string[],
      cwd: string,
      environment: Readonly<Record<string, string>>,
      inputBase64: string,
      timeoutMs: number,
      maxOutputBytes: number,
      maxErrorBytes?: number,
    ) => string,
  ): Promise<void>;
}

declare module "node:path" {
  export const sep: string;
  export function basename(path: string): string;
  export function dirname(path: string): string;
  export function parse(path: string): { readonly root: string };
  export function relative(from: string, to: string): string;
}

declare module "node:fs" {
  export function chmodSync(path: string, mode: number): void;
  export function fsyncSync(fd: number): void;
  export function mkdirSync(
    path: string,
    options?: { readonly recursive?: boolean; readonly mode?: number },
  ): string | undefined;
  export function mkdtempSync(prefix: string): string;
  export function openSync(path: string, flags: string | number, mode?: number): number;
  export function realpathSync(path: string): string;
  export function renameSync(oldPath: string, newPath: string): void;
  export function rmSync(
    path: string,
    options?: { readonly recursive?: boolean; readonly force?: boolean },
  ): void;
  export function unlinkSync(path: string): void;
  export function readFileSync(path: string, encoding: "utf8" | "utf-8"): string;
  export function readFileSync(path: string | number): Uint8Array;
  export function readSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ): number;
  export function writeSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ): number;
  export function writeFileSync(
    path: string | number,
    data: string | Uint8Array,
    options?: { readonly encoding?: "utf8"; readonly mode?: number },
  ): void;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:process" {
  export const execPath: string;
  export function cwd(): string;
}
