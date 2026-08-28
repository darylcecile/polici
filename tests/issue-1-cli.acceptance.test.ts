import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "node:test";

import {
  cliRepository,
  createStaticPluginRepository,
  parseSingleJsonReport,
  removeTemporaryDirectory,
  runPolici,
  temporaryDirectory,
  workspaceRoot,
} from "./helpers.ts";

describe("Issue #1 compiled CLI acceptance", () => {
  test("check exits 0, 1, and 2 and keeps JSON stdout pure for every policy outcome", () => {
    const cases = [
      {
        expected: { exitCode: 0, status: "passed" },
        policy: 'policy "p" { rule "pass" { require true } }\n',
      },
      {
        expected: { exitCode: 1, status: "failed" },
        policy: 'policy "p" { rule "fail" { require false } }\n',
      },
      {
        expected: { exitCode: 2, status: "error" },
        policy: 'policy "p" { rule "error" { require } }\n',
      },
    ] as const;

    for (const fixture of cases) {
      const root = cliRepository(fixture.policy);
      try {
        const result = runPolici([
          "check",
          "--file",
          "ci.pol",
          "--repository",
          root,
          "--format",
          "json",
        ]);
        assert.equal(result.exitCode, fixture.expected.exitCode, result.stderr);
        assert.equal(result.stderr, "");
        const report = parseSingleJsonReport(result);
        assert.equal(report.status, fixture.expected.status);
        assert.deepEqual(Object.keys(report), [
          "kind",
          "status",
          "exitCode",
          "policies",
          "diagnostics",
        ]);
      } finally {
        removeTemporaryDirectory(root);
      }
    }
  });

  test("human failures include rule, source location, and evidence", () => {
    const root = cliRepository(
      'policy "repository" { rule "Markdown only" { require every Files("unexpected.txt").{ path matches "**/*.md" } } }\n',
    );
    writeFileSync(resolve(root, "unexpected.txt"), "not Markdown\n");
    try {
      const result = runPolici(["check", "--file", "ci.pol", "--repository", root]);
      assert.equal(result.exitCode, 1, result.stderr);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, /FAIL rule "Markdown only" ci\.pol:1:/);
      assert.match(result.stdout, /unexpected\.txt/);
      assert.match(result.stdout, /offending-item/);
      assert.match(result.stdout, /Policy failed \(exit 1\)/);
    } finally {
      removeTemporaryDirectory(root);
    }
  });

  test("validate consumes static manifests without executing their runtime", () => {
    const root = temporaryDirectory("polici-validate-static-");
    try {
      const sentinel = createStaticPluginRepository(root, "polici.lock");
      writeFileSync(
        resolve(root, "policy.pol"),
        'using "safe@1" as Safe\npolicy "p" { rule "r" { require Safe.lookup() } }\n',
      );
      const result = runPolici([
        "validate",
        "--file",
        "policy.pol",
        "--repository",
        root,
        "--format",
        "json",
      ]);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.equal(parseSingleJsonReport(result).status, "passed");
      assert.equal(existsSync(sentinel), false, "validate executed the plugin runtime");
    } finally {
      removeTemporaryDirectory(root);
    }
  });

  test("manifest and artifact lock digest tampering fail closed before runtime execution", () => {
    for (const digest of ["manifest", "artifact"] as const) {
      const root = temporaryDirectory(`polici-lock-${digest}-`);
      try {
        const sentinel = createStaticPluginRepository(root, "polici.lock");
        const lockPath = resolve(root, "polici.lock");
        const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
          plugins: { manifest: { value: string }; artifact: { value: string } }[];
        };
        assert.equal(lock.plugins.length, 1);
        lock.plugins[0]![digest].value = digest === "manifest" ? "f".repeat(64) : "e".repeat(64);
        writeFileSync(lockPath, `${JSON.stringify(lock)}\n`);

        const result = runPolici([
          "validate",
          "--file",
          "policy.pol",
          "--repository",
          root,
          "--format",
          "json",
        ]);
        assert.equal(result.exitCode, 2);
        const report = parseSingleJsonReport(result);
        assert.equal(report.status, "error");
        assert.match(result.stderr, new RegExp(`${digest} SHA-256 does not match`, "i"));
        assert.ok(report.diagnostics.some((item) => item.source === "evaluator"));
        assert.equal(existsSync(sentinel), false, "tampered input executed the plugin runtime");
      } finally {
        removeTemporaryDirectory(root);
      }
    }
  });

  test("compiled CLI executes a locked scriptc runtime with binary framing", () => {
    const root = temporaryDirectory("polici-external-runtime-");
    const runtimeSource = resolve(root, "runtime.ts");
    const runtime = resolve(root, "runtime");
    writeFileSync(
      resolve(root, "ci.pol"),
      'using "example@1" as Example\npolicy "runtime" { rule "healthy" { require Example.health passed } }\n',
    );
    writeFileSync(
      resolve(root, "manifest.json"),
      JSON.stringify({
        schema: "polici.plugin/v2",
        schemaVersion: 2,
        name: "example",
        version: "1.0.0",
        policiApi: 1,
        contractMajor: 1,
        types: {},
        exports: {
          health: {
            kind: "resource",
            type: { kind: "core", type: "Check" },
            resolve: "health",
          },
        },
        permissions: [],
        runtime: {
          kind: "typescript",
          protocol: 1,
          entrypoint: "./runtime",
          transport: "length-prefixed",
          capabilities: [],
        },
      }),
    );
    writeFileSync(
      runtimeSource,
      `import { readFileSync } from "node:fs";
const input = readFileSync(0);
const length = new DataView(input.buffer, input.byteOffset, input.byteLength).getUint32(0, false);
const message = JSON.parse(new TextDecoder().decode(input.subarray(4, 4 + length)));
let response;
if (message.type === "initialize") response = { protocol: "polici.runtime/v1", type: "initialized", id: message.id, implementation: message.plugin, capabilities: [], continuation: "state-1" };
else if (message.type === "call") response = { protocol: "polici.runtime/v1", type: "result", id: message.id, value: { tag: "entity", type: "core:Check", identity: { namespace: "polici:check", value: "health" }, fields: { name: { tag: "string", value: "health" }, status: { tag: "string", value: "passed" } } }, continuation: "state-2" };
else response = { protocol: "polici.runtime/v1", type: "stopped", id: message.id };
const payload = new TextEncoder().encode(JSON.stringify(response));
const output = new Uint8Array(payload.length + 4);
new DataView(output.buffer).setUint32(0, payload.length, false);
output.set(payload, 4);
process.stdout.write(output);
`,
    );
    try {
      const build = spawnSync(
        resolve(workspaceRoot, "node_modules/.bin/scriptc"),
        ["build", runtimeSource, "--dynamic", "--no-keep-c", "-o", runtime],
        { cwd: workspaceRoot, encoding: "utf8" },
      );
      assert.equal(build.status, 0, build.stderr);
      chmodSync(runtime, 0o700);
      const locked = runPolici([
        "lock",
        "--repository",
        root,
        "--file",
        "ci.pol",
        "--plugin",
        "manifest.json",
      ]);
      assert.equal(locked.exitCode, 0, locked.stderr);
      const checked = runPolici([
        "check",
        "--repository",
        root,
        "--file",
        "ci.pol",
        "--trust-plugin",
        "example@1",
        "--format",
        "json",
      ]);
      assert.equal(checked.exitCode, 0, checked.stderr);
      assert.equal(parseSingleJsonReport(checked).status, "passed");
    } finally {
      removeTemporaryDirectory(root);
    }
  });
});
