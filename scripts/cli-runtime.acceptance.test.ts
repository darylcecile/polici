import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { ResolverFault, wire } from "../src/plugin/index.ts";
import { CliTypeScriptProcessResolverHost } from "../src/cli/runtime.ts";
import { nodeProcessRunner } from "../src/cli/process.ts";

test("compiled CLI process envelope keeps stdout and stderr separate", () => {
  const result = JSON.parse(
    nodeProcessRunner(
      "/bin/sh",
      ["-c", "printf protocol; printf diagnostic >&2"],
      "/",
      {},
      "",
      1_000,
      64,
      64,
    ),
  );
  assert.equal(new TextDecoder().decode(Buffer.from(result.stdoutBase64, "base64")), "protocol");
  assert.equal(new TextDecoder().decode(Buffer.from(result.stderrBase64, "base64")), "diagnostic");
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
});

test("compiled CLI runtime enforces cumulative stdout and log quotas independently", async () => {
  await assertQuota("stdout", "RUNTIME_OUTPUT_LIMIT");
  await assertQuota("stderr", "RUNTIME_LOG_LIMIT");
});

test("compiled CLI runtime reports child status and stderr", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "polici-runtime-status-"));
  const runtime = resolve(directory, "runtime.mjs");
  writeFileSync(runtime, 'process.stderr.write("runtime failed"); process.exit(7);\n');
  try {
    const host = hostFor(runtime, 4096, 4096);
    await assert.rejects(
      () => host.resolve({ resolver: "test", arguments: {} }),
      (error: unknown) =>
        error instanceof ResolverFault &&
        error.code === "RUNTIME_EXIT" &&
        /7/.test(error.message) &&
        /runtime failed/.test(error.message),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native executable enforces cumulative external runtime output and log quotas", () => {
  for (const stream of ["stdout", "stderr"] as const) {
    const directory = mkdtempSync(resolve(tmpdir(), `polici-compiled-quota-${stream}-`));
    const source = resolve(directory, "runtime.ts");
    const runtime = resolve(directory, "runtime");
    writeFileSync(
      resolve(directory, "ci.pol"),
      'using "quota@1" as Quota\npolicy "p" { rule "r" { require Quota.health passed } }\n',
    );
    writeFileSync(resolve(directory, "manifest.json"), JSON.stringify(quotaManifest()));
    writeFileSync(source, quotaRuntime(stream));
    try {
      const build = spawnSync(
        resolve("node_modules/.bin/scriptc"),
        ["build", source, "--dynamic", "--no-keep-c", "-o", runtime],
        { encoding: "utf8" },
      );
      assert.equal(build.status, 0, build.stderr);
      chmodSync(runtime, 0o700);
      const locked = runCompiled([
        "lock",
        "--repository",
        directory,
        "--file",
        "ci.pol",
        "--plugin",
        "manifest.json",
      ]);
      assert.equal(locked.status, 0, locked.stderr);
      const checked = runCompiled([
        "check",
        "--repository",
        directory,
        "--file",
        "ci.pol",
        "--trust-plugin",
        "quota@1",
      ]);
      assert.equal(checked.status, 2);
      assert.match(
        `${checked.stderr}\n${checked.stdout}`,
        stream === "stdout"
          ? /Runtime output exceeded 4194304 bytes/
          : /Runtime logs exceeded 262144 bytes/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

async function assertQuota(stream: "stdout" | "stderr", code: string): Promise<void> {
  const directory = mkdtempSync(resolve(tmpdir(), `polici-runtime-${stream}-`));
  const runtime = resolve(directory, "runtime.mjs");
  writeFileSync(
    runtime,
    `import { readFileSync } from "node:fs";
const message = JSON.parse(readFileSync(0, "utf8"));
const continuation = message.type === "initialize" ? "one" : message.type === "call" ? "two" : "three";
const response = message.type === "initialize"
  ? { protocol: "polici.runtime/v1", type: "initialized", id: message.id, implementation: message.plugin, capabilities: ["example:data"], continuation }
  : message.type === "call"
    ? { protocol: "polici.runtime/v1", type: "capability-call", id: message.id, requestId: "request", sequence: 1, capability: "example:data", operation: "read", arguments: {}, continuation }
    : { protocol: "polici.runtime/v1", type: "result", id: message.id, value: { tag: "string", value: "ok" }, continuation };
${stream === "stderr" ? 'process.stderr.write("x".repeat(80));' : ""}
process.stdout.write(JSON.stringify(response) + "\\n"${stream === "stdout" ? ' + " ".repeat(80)' : ""});
`,
  );
  try {
    const host = hostFor(
      runtime,
      stream === "stdout" ? 350 : 4096,
      stream === "stderr" ? 120 : 4096,
    );
    await assert.rejects(() => host.resolve({ resolver: "test", arguments: {} }), { code });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function hostFor(runtime: string, maxOutputBytes: number, maxLogBytes: number) {
  return new CliTypeScriptProcessResolverHost({
    cwd: "/",
    entrypoint: process.execPath,
    trustedRuntime: true,
    plugin: { name: "example", version: "1.0.0" },
    transport: "jsonl",
    capabilities: [{ name: "example:data", operations: ["read"] }],
    capabilityBroker: async () => ({ ok: true, value: wire.string("value") }),
    maxOutputBytes,
    maxLogBytes,
    runProcess: (command, arguments_, cwd, environment, input, timeout, output, logs) =>
      nodeProcessRunner(
        command,
        [runtime, ...arguments_],
        cwd,
        environment,
        input,
        timeout,
        output,
        logs,
      ),
  });
}

function quotaManifest(): object {
  return {
    schema: "polici.plugin/v2",
    schemaVersion: 2,
    name: "quota",
    version: "1.0.0",
    policiApi: 1,
    contractMajor: 1,
    types: {},
    exports: {
      health: { kind: "resource", type: { kind: "core", type: "Check" }, resolve: "health" },
      read: { kind: "function", parameters: [], returns: { kind: "string" }, resolve: "read" },
    },
    permissions: ["example:data"],
    runtime: {
      kind: "typescript",
      protocol: 1,
      entrypoint: "./runtime",
      transport: "jsonl",
      capabilities: ["example:data"],
    },
  };
}

function quotaRuntime(stream: "stdout" | "stderr"): string {
  return `import { readFileSync } from "node:fs";
const message = JSON.parse(readFileSync(0, "utf8"));
const sequence = message.type === "capability-result" ? (message.sequence as number) + 1 : 1;
let response;
if (message.type === "initialize") {
  response = { protocol: "polici.runtime/v1", type: "initialized", id: message.id, implementation: message.plugin, capabilities: ["example:data"], continuation: "state-0" };
} else if (message.type === "shutdown") {
  response = { protocol: "polici.runtime/v1", type: "stopped", id: message.id };
} else if (message.type === "call" || sequence <= 5) {
  response = { protocol: "polici.runtime/v1", type: "capability-call", id: message.id, requestId: "request-" + sequence, sequence, capability: "example:data", operation: "read", arguments: { payload: { tag: "string", value: "x".repeat(${stream === "stdout" ? "900000" : "1"}) } }, continuation: "state-" + sequence };
} else {
  response = { protocol: "polici.runtime/v1", type: "result", id: message.id, value: { tag: "entity", type: "core:Check", identity: { namespace: "polici:check", value: "health" }, fields: { name: { tag: "string", value: "health" }, status: { tag: "string", value: "passed" } } }, continuation: "state-done" };
}
${stream === "stderr" ? 'process.stderr.write("log".repeat(50000));' : ""}
process.stdout.write(JSON.stringify(response) + "\\n");
`;
}

function runCompiled(arguments_: readonly string[]) {
  return spawnSync(resolve("dist/polici"), [...arguments_], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: tmpdir(), LC_ALL: "C" },
  });
}
