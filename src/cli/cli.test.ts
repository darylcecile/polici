// @ts-ignore This bare repository intentionally does not depend on @types/node.
import assert from "node:assert/strict";
// @ts-ignore This bare repository intentionally does not depend on @types/node.
import { execFileSync } from "node:child_process";
// @ts-ignore This bare repository intentionally does not depend on @types/node.
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// @ts-ignore This bare repository intentionally does not depend on @types/node.
import { tmpdir } from "node:os";
// @ts-ignore This bare repository intentionally does not depend on @types/node.
import { resolve } from "node:path";
// @ts-ignore This bare repository intentionally does not depend on @types/node.
import { deflateSync } from "node:zlib";
// @ts-ignore This bare repository intentionally does not depend on @types/node.
import test from "node:test";

import { parseCliArguments } from "./arguments.js";
import { runCli, type CliEnvironment } from "./cli.js";
import { readGitFile } from "./git.js";
import { githubArtifactModule } from "./github-artifact-source.js";
import { GITHUB_BUILTIN_ARTIFACT } from "./github-artifact.generated.js";
import { nodeProcessRunner } from "./process.js";

const EMPTY_LOCK = '{"plugins":[],"schema":"polici.lock/v2","schemaVersion":2}\n';
const PASS_POLICY = 'policy "repository" { rule "always" { require true } }\n';
const FAIL_POLICY = 'policy "repository" { rule "always" { require false } }\n';

interface Invocation {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function invoke(
  argv: readonly string[],
  environment: CliEnvironment = {},
): Promise<Invocation> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(argv, environment, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { exitCode, stdout, stderr };
}

function repository(policy = PASS_POLICY): string {
  const root = mkdtempSync(resolve(tmpdir(), "polici-cli-test-"));
  writeFileSync(resolve(root, "ci.pol"), policy);
  writeFileSync(resolve(root, "polici.lock"), EMPTY_LOCK);
  return root;
}

function git(root: string, arguments_: readonly string[]): string {
  return execFileSync("git", [...arguments_], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      LC_ALL: "C",
    },
    encoding: "utf8",
  }).trim();
}

test("argument parser handles defaults, repeats, equals values, and errors", () => {
  const parsed = parseCliArguments([
    "lock",
    "--file=ci.pol",
    "--plugin",
    "one/manifest.json",
    "--plugin=two/manifest.json",
    "--format",
    "json",
    "--offline",
    "--check",
  ]);
  assert.equal(parsed.command, "lock");
  assert.equal(parsed.lockfile, "polici.lock");
  assert.equal(parsed.repository, ".");
  assert.equal(parsed.format, "json");
  assert.equal(parsed.offline, true);
  assert.equal(parsed.frozenLockfile, true);
  assert.deepEqual(parsed.plugins, ["one/manifest.json", "two/manifest.json"]);
  assert.throws(() => parseCliArguments(["check"]), /requires --file/);
  assert.throws(() => parseCliArguments(["unknown", "--file", "x"]), /Unknown command/);
  assert.throws(
    () => parseCliArguments(["validate", "--file", "x", "--format", "yaml"]),
    /human.*json/,
  );
});

test("help and extensible lsp dispatch do not require repository files", async () => {
  const help = await invoke(["--help"]);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /Usage: polici <command>/);
  assert.match(help.stdout, /--github-event/);
  assert.equal(help.stderr, "");

  let command = "";
  let arguments_: readonly string[] = [];
  let stdout = "";
  const exitCode = await runCli(
    ["lsp", "--", "--stdio"],
    {},
    {
      stdout: (text) => {
        stdout += text;
      },
      dispatch: async (value, context) => {
        command = value;
        arguments_ = context.argv;
        context.writeStdout("delegated\n");
        return 0;
      },
    },
  );
  assert.equal(exitCode, 0);
  assert.equal(command, "lsp");
  assert.deepEqual(arguments_, ["--stdio"]);
  assert.equal(stdout, "delegated\n");
});

test("check reports pass, policy failure, and compilation error with 0/1/2", async () => {
  const passing = repository();
  const failing = repository(FAIL_POLICY);
  const invalid = repository('policy "broken" { rule "x" { require } }\n');
  try {
    const pass = await invoke(["check", "--file", "ci.pol", "--repository", passing]);
    assert.equal(pass.exitCode, 0);
    assert.match(pass.stdout, /PASS rule "always"/);
    assert.equal(pass.stderr, "");

    const fail = await invoke(["check", "--file", "ci.pol", "--repository", failing]);
    assert.equal(fail.exitCode, 1);
    assert.match(fail.stdout, /Policy failed \(exit 1\)/);
    assert.match(fail.stdout, /FAIL rule "always" ci\.pol:1:/);
    assert.match(fail.stdout, /evidence actual/);

    const error = await invoke(["check", "--file", "ci.pol", "--repository", invalid]);
    assert.equal(error.exitCode, 2);
    assert.match(error.stdout, /error .* \[parser\]/);
  } finally {
    rmSync(passing, { recursive: true, force: true });
    rmSync(failing, { recursive: true, force: true });
    rmSync(invalid, { recursive: true, force: true });
  }
});

test("JSON check stdout is one pure schema-shaped report", async () => {
  const root = repository(FAIL_POLICY);
  try {
    const result = await invoke([
      "check",
      "--file",
      "ci.pol",
      "--repository",
      root,
      "--format",
      "json",
    ]);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.endsWith("\n"), true);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), [
      "kind",
      "status",
      "exitCode",
      "policies",
      "diagnostics",
    ]);
    assert.equal(parsed.kind, "policy-evaluation");
    assert.equal(parsed.status, "failed");
    assert.equal(parsed.exitCode, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check and validate never mutate the lockfile", async () => {
  const root = repository();
  const lockPath = resolve(root, "polici.lock");
  const before = readFileSync(lockPath);
  try {
    assert.equal((await invoke(["check", "--file", "ci.pol", "--repository", root])).exitCode, 0);
    assert.deepEqual(readFileSync(lockPath), before);
    assert.equal(
      (await invoke(["validate", "--file", "ci.pol", "--repository", root])).exitCode,
      0,
    );
    assert.deepEqual(readFileSync(lockPath), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lock writes canonical v2, removes stale entries, and supports frozen check", async () => {
  const root = repository();
  writeFileSync(
    resolve(root, "polici.lock"),
    '{"schema":"polici.lock/v2","schemaVersion":2,"plugins":[{"stale":true}]}\n',
  );
  try {
    const locked = await invoke(["lock", "--file", "ci.pol", "--repository", root]);
    assert.equal(locked.exitCode, 0);
    assert.equal(readFileSync(resolve(root, "polici.lock"), "utf8"), EMPTY_LOCK);
    const frozen = await invoke(["lock", "--file", "ci.pol", "--repository", root, "--check"]);
    assert.equal(frozen.exitCode, 0);
    assert.match(frozen.stdout, /is current/);
    writeFileSync(resolve(root, "polici.lock"), `${EMPTY_LOCK.trim()}  \n`);
    const stale = await invoke(["lock", "--file", "ci.pol", "--repository", root, "--check"]);
    assert.equal(stale.exitCode, 2);
    assert.match(stale.stderr, /not current and canonical/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pull request mode loads policy and lock from base but snapshots exact head", async () => {
  const root = repository();
  const eventRoot = mkdtempSync(resolve(tmpdir(), "polici-cli-event-"));
  try {
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "polici@example.invalid"]);
    git(root, ["config", "user.name", "Polici Test"]);
    writeFileSync(
      resolve(root, "ci.pol"),
      'policy "trusted base" { rule "uses pinned head" { require some Files("head-only.txt").{ true } } }\n',
    );
    writeFileSync(resolve(root, "data.txt"), "base\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "base"]);
    const base = git(root, ["rev-parse", "HEAD"]);

    writeFileSync(resolve(root, "ci.pol"), FAIL_POLICY);
    writeFileSync(resolve(root, "polici.lock"), "not json\n");
    writeFileSync(resolve(root, "data.txt"), "head\n");
    writeFileSync(resolve(root, "head-only.txt"), "head\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "head"]);
    const head = git(root, ["rev-parse", "HEAD"]);
    const eventPath = resolve(eventRoot, "event.json");
    writeFileSync(
      eventPath,
      JSON.stringify({
        number: 7,
        repository: { full_name: "octo/repo" },
        pull_request: {
          number: 7,
          base: { sha: base, repo: { full_name: "octo/repo" } },
          head: { sha: head, repo: { full_name: "contributor/repo" } },
        },
      }),
    );

    const result = await invoke(
      ["check", "--file", "ci.pol", "--repository", root, "--format", "json"],
      {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "octo/repo",
        POLICI_GITHUB_BASE_SHA: base,
      },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal((JSON.parse(result.stdout) as { status: string }).status, "passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(eventRoot, { recursive: true, force: true });
  }
});

test("pull request event trust rejects repository files and forged base=head coordinates", async () => {
  const root = repository();
  const eventRoot = mkdtempSync(resolve(tmpdir(), "polici-cli-event-"));
  try {
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "polici@example.invalid"]);
    git(root, ["config", "user.name", "Polici Test"]);
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "base"]);
    const base = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(resolve(root, "head.txt"), "head\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "head"]);
    const head = git(root, ["rev-parse", "HEAD"]);
    const forged = JSON.stringify({
      number: 7,
      repository: { full_name: "octo/repo" },
      pull_request: {
        number: 7,
        base: { sha: head, repo: { full_name: "octo/repo" } },
        head: { sha: head, repo: { full_name: "contributor/repo" } },
      },
    });
    const inside = resolve(root, "event.json");
    const outside = resolve(eventRoot, "event.json");
    writeFileSync(inside, forged);
    writeFileSync(outside, forged);
    const environment = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      GITHUB_REPOSITORY: "octo/repo",
      POLICI_GITHUB_BASE_SHA: base,
    };
    const repositoryEvent = await invoke(
      ["validate", "--file", "ci.pol", "--repository", root, "--github-event", inside],
      environment,
    );
    assert.equal(repositoryEvent.exitCode, 2);
    assert.match(repositoryEvent.stderr, /must be outside the repository/);

    const forgedCoordinates = await invoke(
      ["validate", "--file", "ci.pol", "--repository", root, "--github-event", outside],
      environment,
    );
    assert.equal(forgedCoordinates.exitCode, 2);
    assert.match(forgedCoordinates.stderr, /does not match separately trusted/);

    writeFileSync(
      outside,
      JSON.stringify({
        number: 7,
        repository: { full_name: "octo/repo" },
        pull_request: {
          number: 7,
          base: { sha: base, repo: { full_name: "octo/repo" } },
          head: { sha: head, repo: { full_name: "contributor/repo" } },
        },
      }),
    );
    const unauthenticatedCheck = await invoke(
      ["check", "--file", "ci.pol", "--repository", root, "--github-event", outside],
      environment,
    );
    assert.equal(unauthenticatedCheck.exitCode, 2);
    assert.match(unauthenticatedCheck.stderr, /explicit --github-event requires live/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(eventRoot, { recursive: true, force: true });
  }
});

test("live GitHub authentication rejects an explicit event forged with base=head", async () => {
  const root = repository();
  const eventRoot = mkdtempSync(resolve(tmpdir(), "polici-cli-event-"));
  const originalFetch = globalThis.fetch;
  try {
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "polici@example.invalid"]);
    git(root, ["config", "user.name", "Polici Test"]);
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "base"]);
    const base = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(resolve(root, "ci.pol"), FAIL_POLICY);
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "head"]);
    const head = git(root, ["rev-parse", "HEAD"]);
    const eventPath = resolve(eventRoot, "event.json");
    writeFileSync(
      eventPath,
      JSON.stringify({
        number: 7,
        repository: { full_name: "octo/repo" },
        pull_request: {
          number: 7,
          base: { sha: head, repo: { full_name: "octo/repo" } },
          head: { sha: head, repo: { full_name: "contributor/repo" } },
        },
      }),
    );
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.toString(), "https://api.test/repos/octo/repo/pulls/7");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer token");
      assert.equal(init?.redirect, "manual");
      const response = new Response(
        JSON.stringify({
          id: 1,
          node_id: "PR_1",
          number: 7,
          user: { id: 1, node_id: "U_1", login: "author" },
          base: { sha: base, repo: { full_name: "octo/repo" } },
          head: { sha: head, repo: { full_name: "contributor/repo" } },
          changed_files: 1,
          draft: false,
          state: "open",
        }),
      );
      Object.defineProperty(response, "url", { value: url.toString() });
      return response;
    };
    const result = await invoke(
      ["validate", "--file", "ci.pol", "--repository", root, "--github-event", eventPath],
      {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        GITHUB_REPOSITORY: "octo/repo",
        GITHUB_TOKEN: "token",
        GITHUB_API_URL: "https://api.test/",
      },
    );
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /expected .*\.\.\./);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
    rmSync(eventRoot, { recursive: true, force: true });
  }
});

test("automatic Actions context rejects a repository-controlled event path", async () => {
  const root = repository();
  try {
    const eventPath = resolve(root, "event.json");
    writeFileSync(eventPath, "{}");
    const result = await invoke(["validate", "--file", "ci.pol", "--repository", root], {
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
    });
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /must be outside the repository/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git reads ignore replace refs and reject corrupted loose object substitutions", () => {
  const root = repository();
  try {
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "polici@example.invalid"]);
    git(root, ["config", "user.name", "Polici Test"]);
    writeFileSync(resolve(root, "ci.pol"), "trusted\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "trusted"]);
    const trusted = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(resolve(root, "ci.pol"), "forged\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "forged"]);
    const forged = git(root, ["rev-parse", "HEAD"]);
    git(root, ["replace", trusted, forged]);
    const environment = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
    assert.equal(
      new TextDecoder().decode(
        readGitFile(root, trusted, "ci.pol", environment, nodeProcessRunner, 1024),
      ),
      "trusted\n",
    );

    git(root, ["replace", "-d", trusted]);
    const blob = git(root, ["rev-parse", `${trusted}:ci.pol`]);
    const loose = resolve(root, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    const forgedObject = new TextEncoder().encode("blob 7\0forged\n");
    chmodSync(loose, 0o600);
    writeFileSync(loose, deflateSync(forgedObject));
    assert.throws(
      () => readGitFile(root, trusted, "ci.pol", environment, nodeProcessRunner, 1024),
      /failed independent content hash verification|git cat-file failed/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GitHub Actions push events remain local unless --github-event is explicit", async () => {
  const root = repository();
  try {
    const result = await invoke(["check", "--file", "ci.pol", "--repository", root], {
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "push",
      GITHUB_EVENT_PATH: resolve(root, "missing-event.json"),
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stderr, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external path plugin manifest digest changes fail closed", async () => {
  const root = repository(
    'using "example@1" as Example\npolicy "repository" { rule "always" { require true } }\n',
  );
  const pluginDirectory = resolve(root, "plugin");
  mkdirSync(pluginDirectory);
  const manifestPath = resolve(pluginDirectory, "manifest.json");
  const manifest = {
    schema: "polici.plugin/v2",
    schemaVersion: 2,
    name: "example",
    version: "1.0.0",
    policiApi: 1,
    contractMajor: 1,
    types: {},
    exports: {},
    permissions: [],
    runtime: {
      kind: "typescript",
      protocol: 1,
      entrypoint: "./runtime",
      transport: "jsonl",
      capabilities: [],
    },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(resolve(pluginDirectory, "runtime"), "runtime bytes\n");
  chmodSync(resolve(pluginDirectory, "runtime"), 0o700);
  try {
    const locked = await invoke([
      "lock",
      "--file",
      "ci.pol",
      "--repository",
      root,
      "--plugin",
      "plugin/manifest.json",
    ]);
    assert.equal(locked.exitCode, 0, locked.stderr);
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...manifest, documentation: { summary: "changed" } }),
    );
    const checked = await invoke([
      "validate",
      "--file",
      "ci.pol",
      "--repository",
      root,
      "--format",
      "json",
    ]);
    assert.equal(checked.exitCode, 2);
    assert.match(checked.stderr, /canonical manifest SHA-256 does not match/);
    assert.equal((JSON.parse(checked.stdout) as { exitCode: number }).exitCode, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lock creates a deterministic integrity-bound github built-in entry", async () => {
  const root = repository(
    'using "github@1" as Git\npolicy "repository" { rule "always" { require true } }\n',
  );
  try {
    const result = await invoke(["lock", "--file", "ci.pol", "--repository", root]);
    assert.equal(result.exitCode, 0, result.stderr);
    const lock = JSON.parse(readFileSync(resolve(root, "polici.lock"), "utf8")) as {
      plugins: {
        source: { kind: string; locator: string };
        artifact: { value: string };
      }[];
    };
    assert.equal(lock.plugins.length, 1);
    assert.deepEqual(lock.plugins[0]?.source, {
      kind: "builtin",
      locator: "polici:provider:github@1.0.0",
    });
    assert.match(lock.plugins[0]?.artifact.value ?? "", /^[a-f0-9]{64}$/);

    const second = await invoke(["lock", "--file", "ci.pol", "--repository", root]);
    assert.equal(second.exitCode, 0, second.stderr);
    assert.equal(readFileSync(resolve(root, "polici.lock"), "utf8"), `${JSON.stringify(lock)}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("embedded GitHub artifact is current and names the exact production source bundle", () => {
  assert.equal(
    readFileSync(resolve("src/cli/github-artifact.generated.ts"), "utf8"),
    githubArtifactModule(resolve(".")),
  );
  assert.match(
    new TextDecoder().decode(GITHUB_BUILTIN_ARTIFACT),
    /^polici\.github\.provider-source\/v1\nsha256=[a-f0-9]{64}\n$/,
  );
});
