import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const IO_CHUNK_BYTES = 64 * 1024;

function writeAll(bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(1, bytes, offset, bytes.length - offset, null);
    if (!Number.isSafeInteger(written) || written <= 0)
      throw new Error("Standard output made no progress.");
    offset += written;
  }
}

function drainLspOutput(cli: any): void {
  while (true) {
    const encoded = cli.nativeLspTakeOutput(IO_CHUNK_BYTES) as string;
    if (encoded.length === 0) return;
    writeAll(Buffer.from(encoded, "base64"));
  }
}

async function main(): Promise<void> {
  try {
    const cli = await import("polici-native/src/cli/native.js");
    if (process.argv[2] === "lsp") {
      if (process.argv.slice(3).some((argument) => argument !== "--stdio")) {
        process.stderr.write("polici: lsp accepts only --stdio.\n");
        process.exit(2);
      }
      cli.nativeLspStart();
      const buffer = new Uint8Array(IO_CHUNK_BYTES);
      while (cli.nativeLspExitCode() < 0) {
        const count = readSync(0, buffer, 0, buffer.length, null);
        if (!Number.isSafeInteger(count) || count < 0 || count > buffer.length)
          throw new Error("Standard input returned an invalid byte count.");
        if (count === 0) {
          cli.nativeLspEnd();
          drainLspOutput(cli);
          break;
        }
        cli.nativeLspReceive(Buffer.from(buffer.subarray(0, count)).toString("base64"));
        drainLspOutput(cli);
      }
      process.exit(Math.max(0, cli.nativeLspExitCode()));
    }
    const exitCode = (await cli.nativeRealRun(runProcess)) as number;
    process.exit(exitCode);
  } catch (error) {
    process.stderr.write(`polici: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}

const runProcess = (
  command: string,
  arguments_: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
  inputBase64: string,
  timeoutMs: number,
  maxOutputBytes: number,
  maxErrorBytes: number = maxOutputBytes,
): any => {
  const input = Buffer.from(inputBase64, "base64");
  const directory = mkdtempSync(resolve(tmpdir(), "polici-exchange-"));
  const inputPath = resolve(directory, "stdin");
  const outputPath = resolve(directory, "stdout");
  const errorPath = resolve(directory, "stderr");
  const statusPath = resolve(directory, "status");
  const encode = (value: string | Uint8Array | undefined): string =>
    value === undefined
      ? ""
      : Buffer.from(typeof value === "string" ? new TextEncoder().encode(value) : value).toString(
          "base64",
        );
  writeFileSync(inputPath, input);
  try {
    let failed = false;
    const blocks = String(
      Math.max(1, Math.ceil((Math.max(maxOutputBytes, maxErrorBytes) + 1) / 512)),
    );
    try {
      execFileSync(
        "/bin/sh",
        [
          "-c",
          `ulimit -f "$1"; input="$2"; output="$3"; error="$4"; status_file="$5"; shift 5; child=""; trap 'test -z "$child" || { kill -TERM "$child" 2>/dev/null; sleep 0.05; kill -KILL "$child" 2>/dev/null; wait "$child" 2>/dev/null; }; exit 124' TERM INT HUP; "$@" < "$input" > "$output" 2> "$error" & child=$!; wait "$child"; status=$?; printf "%s" "$status" > "$status_file"; exit 0`,
          "polici-exchange",
          blocks,
          inputPath,
          outputPath,
          errorPath,
          statusPath,
          command,
          ...arguments_,
        ],
        {
          cwd,
          env: { ...environment },
          input: "",
          timeout: timeoutMs,
          maxBuffer: 1024,
          windowsHide: true,
          killSignal: "SIGTERM",
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch {
      failed = true;
    }
    const stdout = readFileOrEmpty(outputPath);
    const stderr = readFileOrEmpty(errorPath);
    if (failed)
      return JSON.stringify({
        stdoutBase64: encode(stdout),
        stderrBase64: encode(stderr),
        status: null,
        signal: null,
        error: { code: "ETIMEDOUT", message: "Process deadline exceeded." },
        timedOut: true,
      });
    const status = Number(readFileSync(statusPath, "utf8"));
    return JSON.stringify({
      stdoutBase64: encode(stdout),
      stderrBase64: encode(stderr),
      status: Number.isSafeInteger(status) ? status : null,
      signal: null,
      ...(status === 0
        ? {}
        : { error: { message: `Process exited with status ${String(status)}.` } }),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

void main();

function readFileOrEmpty(path: string): Uint8Array {
  try {
    return readFileSync(path);
  } catch {
    return new Uint8Array(0);
  }
}
