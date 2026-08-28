import { runNativeCli, type CliEnvironment } from "./cli.js";
import { encodeLspMessage } from "../lsp/framing.js";
import { LanguageServerSession } from "../lsp/server.js";
import type { CliProcessRunner } from "./process.js";

let lspSession: LanguageServerSession | undefined;
let lspOutput: Uint8Array[] = [];
let lspOutputOffset = 0;
let lspOutputBytes = 0;
const MAX_LSP_OUTPUT_BYTES = 8 * 1024 * 1024;

export async function nativeRealRun(runProcess: CliProcessRunner): Promise<number> {
  return runNativeCli(process.argv.slice(2), process.env, runProcess);
}

export function nativeLspStart(): void {
  lspOutput = [];
  lspOutputOffset = 0;
  lspOutputBytes = 0;
  lspSession = new LanguageServerSession((message) => {
    const encoded = encodeLspMessage(message);
    if (lspOutputBytes + encoded.length > MAX_LSP_OUTPUT_BYTES)
      throw new Error(`LSP pending output exceeds ${MAX_LSP_OUTPUT_BYTES} bytes.`);
    lspOutput.push(encoded);
    lspOutputBytes += encoded.length;
  });
}

export function nativeLspReceive(inputBase64: string): void {
  if (lspSession === undefined) throw new Error("LSP session has not been started.");
  lspSession.receive(new Uint8Array(Buffer.from(inputBase64, "base64")));
}

export function nativeLspEnd(): void {
  if (lspSession === undefined) throw new Error("LSP session has not been started.");
  lspSession.end();
}

export function nativeLspTakeOutput(maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new RangeError("LSP output chunk size must be a positive safe integer.");
  const first = lspOutput[0];
  if (first === undefined) return "";
  const size = Math.min(maxBytes, first.length - lspOutputOffset);
  const output = first.subarray(lspOutputOffset, lspOutputOffset + size);
  lspOutputOffset += size;
  lspOutputBytes -= size;
  if (lspOutputOffset === first.length) {
    lspOutput.shift();
    lspOutputOffset = 0;
  }
  return Buffer.from(output).toString("base64");
}

export function nativeLspExitCode(): number {
  return lspSession?.exitCode ?? -1;
}

export async function runNativeEntrypoint(
  argv: readonly string[],
  environment: CliEnvironment,
  runProcess: CliProcessRunner,
): Promise<void> {
  const nativeProcess = process as unknown as {
    exitCode?: number;
    readonly stderr: { write(text: string): void };
  };
  try {
    nativeProcess.exitCode = await runNativeCli(argv, environment, runProcess);
  } catch (error) {
    nativeProcess.stderr.write(
      `polici: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    nativeProcess.exitCode = 2;
  }
}

export async function runNativeProcessEntrypoint(runProcess: CliProcessRunner): Promise<void> {
  await runNativeEntrypoint(process.argv.slice(2), process.env, runProcess);
}
