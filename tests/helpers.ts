import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RepositorySnapshot } from "../src/core/index.ts";
import type { PolicyCheckResult } from "../src/engine/index.ts";
import { FunctionResolverHost, wire, type ResolverFunction } from "../src/plugin/index.ts";
import {
  githubBuiltin,
  githubCapabilities,
  type GitHubCheckState,
} from "../providers/github/index.ts";

export const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const policiExecutable = resolve(workspaceRoot, "dist/polici");
export const emptyLockfile = '{"plugins":[],"schema":"polici.lock/v2","schemaVersion":2}\n';

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runPolici(
  arguments_: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly input?: Uint8Array | string;
  } = {},
): ProcessResult {
  const result = spawnSync(policiExecutable, [...arguments_], {
    cwd: options.cwd ?? workspaceRoot,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? tmpdir(),
      LC_ALL: "C",
      LANG: "C",
      GITHUB_ACTIONS: "",
      ...options.env,
    },
    input: options.input,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, null, `polici terminated by ${result.signal ?? "unknown signal"}`);
  return {
    exitCode: result.status!,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function temporaryDirectory(prefix = "polici-acceptance-"): string {
  return mkdtempSync(resolve(tmpdir(), prefix));
}

export function removeTemporaryDirectory(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function writeTree(
  root: string,
  files: Readonly<Record<string, string | Uint8Array>>,
): void {
  for (const [path, content] of Object.entries(files)) {
    const absolute = resolve(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}

export function cliRepository(policy: string): string {
  const root = temporaryDirectory("polici-cli-acceptance-");
  writeTree(root, { "ci.pol": policy, "polici.lock": emptyLockfile });
  return root;
}

export function parseSingleJsonReport(result: ProcessResult): PolicyCheckResult {
  assert.equal(result.stdout.endsWith("\n"), true, "JSON output must end with one newline");
  assert.equal(result.stdout.trim().split("\n").length, 1, "stdout must contain one JSON value");
  const parsed = JSON.parse(result.stdout) as PolicyCheckResult;
  assert.equal(parsed.kind, "policy-evaluation");
  assert.equal(parsed.exitCode, result.exitCode);
  return parsed;
}

const BASE_SHA = "b".repeat(40);
const HEAD_SHA = "c".repeat(40);

export function githubUser(id: string, login: string) {
  return wire.entity("github:User", "github:user", id, {
    id: wire.id("github:user", id),
    login: wire.string(login),
  });
}

export function githubPullRequest(approvers = wire.missing()) {
  return wire.entity("github:PullRequest", "github:pull-request", "PR_1", {
    id: wire.id("github:pull-request", "PR_1"),
    number: wire.integer(1),
    author: githubUser("U_author", "author"),
    base_sha: wire.string(BASE_SHA),
    head_sha: wire.string(HEAD_SHA),
    changed_files: wire.integer(0),
    draft: wire.boolean(false),
    state: wire.string("open"),
    approvers,
  });
}

export function githubTeam(id: string, slug: string, members = wire.missing()) {
  return wire.entity("github:Team", "github:team", id, {
    id: wire.id("github:team", id),
    slug: wire.string(slug),
    name: wire.string(slug),
    organization: wire.string("acme"),
    members,
  });
}

export function coreCheck(name: string, state: GitHubCheckState) {
  return wire.entity("core:Check", "polici:check", `${HEAD_SHA}:${name}`, {
    name: wire.string(name),
    status: wire.string(state),
  });
}

export function changeFile(path: string, content?: string) {
  return wire.map({
    path: wire.string(path),
    ...(content === undefined ? {} : { content: wire.string(content) }),
  });
}

export function coreChange(input: {
  readonly id: string;
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "renamed";
  readonly before?: { readonly path: string; readonly content?: string };
  readonly after?: { readonly path: string; readonly content?: string };
}) {
  return wire.entity("core:Change", "polici:change", input.id, {
    path: wire.string(input.path),
    status: wire.string(input.status),
    before:
      input.before === undefined
        ? wire.missing()
        : changeFile(input.before.path, input.before.content),
    after:
      input.after === undefined
        ? wire.missing()
        : changeFile(input.after.path, input.after.content),
  });
}

export function coreChangeSet(changes: readonly ReturnType<typeof coreChange>[]) {
  return wire.entity("core:ChangeSet", "polici:change-set", "base..head", {
    changes: wire.list(changes),
  });
}

export function githubResolverHost(
  resolvers: Readonly<Record<string, ResolverFunction>>,
): FunctionResolverHost {
  return new FunctionResolverHost(resolvers, githubCapabilities);
}

export function githubOptions(
  repository: RepositorySnapshot,
  resolvers: Record<string, ResolverFunction>,
) {
  return {
    repository,
    trustedBuiltins: [githubBuiltin],
    resolvers: { Git: githubResolverHost(resolvers) },
  } as const;
}

export function createStaticPluginRepository(root: string, lockfile = "polici.lock.json"): string {
  const sentinel = resolve(root, "EXECUTED");
  const manifest = {
    schema: "polici.plugin/v2",
    schemaVersion: 2,
    name: "safe",
    version: "1.0.0",
    policiApi: 1,
    contractMajor: 1,
    types: {},
    exports: {
      lookup: {
        kind: "function",
        parameters: [],
        returns: { kind: "boolean" },
        resolve: "lookup",
        summary: "A statically described safe lookup.",
      },
    },
    permissions: [],
    runtime: {
      kind: "typescript",
      protocol: 1,
      entrypoint: "./runtime-do-not-run",
      transport: "jsonl",
      capabilities: [],
    },
  };
  const runtime = `#!/bin/sh\nprintf executed > ${JSON.stringify(sentinel)}\n`;
  writeTree(root, {
    "policy.pol": 'using "safe@1" as Safe\npolicy "p" { rule "r" { require true } }\n',
    "plugin/manifest.json": JSON.stringify(manifest),
    "plugin/runtime-do-not-run": runtime,
  });
  chmodSync(resolve(root, "plugin/runtime-do-not-run"), 0o755);
  const locked = runPolici(
    [
      "lock",
      "--file",
      "policy.pol",
      "--repository",
      root,
      "--lockfile",
      lockfile,
      "--plugin",
      "plugin/manifest.json",
      "--format",
      "json",
    ],
    { cwd: root },
  );
  assert.equal(locked.exitCode, 0, locked.stderr);
  return sentinel;
}
