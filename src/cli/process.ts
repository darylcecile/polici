import { spawnSync } from "node:child_process";

export interface CliProcessResult {
  readonly stdoutBase64: string;
  readonly stderrBase64: string;
  readonly status: number | null;
  readonly signal: string | null;
  readonly error?: {
    readonly code?: string;
    readonly message: string;
  };
  readonly timedOut?: true;
}

export type CliProcessRunner = (
  command: string,
  arguments_: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
  inputBase64: string,
  timeoutMs: number,
  maxOutputBytes: number,
  maxErrorBytes?: number,
) => string;

export const nodeProcessRunner: CliProcessRunner = (
  command,
  arguments_,
  cwd,
  environment,
  inputBase64,
  timeoutMs,
  maxOutputBytes,
  maxErrorBytes = maxOutputBytes,
) => {
  const input = Buffer.from(inputBase64, "base64");
  const result = spawnSync(command, [...arguments_], {
    cwd,
    env: { ...environment },
    input,
    timeout: timeoutMs,
    maxBuffer: Math.max(maxOutputBytes, maxErrorBytes) + 1,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return serializeProcessResult({
    stdoutBase64: encodeBytes(result.stdout),
    stderrBase64: encodeBytes(result.stderr),
    status: result.status,
    signal: result.signal,
    ...(result.error === undefined
      ? {}
      : {
          error: {
            ...(result.error.code === undefined ? {} : { code: result.error.code }),
            message: result.error.message,
          },
        }),
    ...(result.error?.code === "ETIMEDOUT" ? { timedOut: true } : {}),
  });
};

export function serializeProcessResult(result: CliProcessResult): string {
  return JSON.stringify(result);
}

function encodeBytes(value: Uint8Array | string | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "string")
    return Buffer.from(new TextEncoder().encode(value)).toString("base64");
  return Buffer.from(value).toString("base64");
}
