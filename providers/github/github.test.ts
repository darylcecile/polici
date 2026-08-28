// @ts-ignore This bare repository intentionally does not depend on @types/node.
import assert from "node:assert/strict";
// @ts-ignore This bare repository intentionally does not depend on @types/node.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// @ts-ignore This bare repository intentionally does not depend on @types/node.
import { tmpdir } from "node:os";
// @ts-ignore This bare repository intentionally does not depend on @types/node.
import { join } from "node:path";
// @ts-ignore This bare repository intentionally does not depend on @types/node.
import test from "node:test";

import { File } from "../../src/core/file.js";
import { RepositorySnapshot } from "../../src/core/repository.js";
import { validatePluginManifest } from "../../src/plugin/manifest.js";
import { validateWireValue, wire, type WireValue } from "../../src/plugin/wire.js";
import { GitHubProvider } from "./api.js";
import { GITHUB_API_VERSION } from "./client.js";
import { githubContextFromActions, githubContextFromEvent } from "./context.js";
import { GitHubProviderError } from "./errors.js";
import { githubManifest } from "./manifest.js";
import { GitHubResolverHost, githubBuiltin } from "./resolver.js";
import type { GitHubProviderOptions } from "./types.js";

const BASE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HEAD = "cccccccccccccccccccccccccccccccccccccccc";
const MERGE_BASE = "dddddddddddddddddddddddddddddddddddddddd";
const BEFORE_SHA = "ee2363a4dfc456efa66b2e71979a1f8f8f07a208";
const AFTER_SHA = "5c80f32d7908f9c0730c009c70915ab560722778";
const COPY_SHA = "88740b2cb92912f8f881654ecbed83c9055139fe";

interface FixtureResult {
  readonly body: unknown;
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

type FixtureRoute = FixtureResult | (() => FixtureResult);

function fetchFixture(routes: Readonly<Record<string, FixtureRoute>>): {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: readonly string[];
} {
  const requests: string[] = [];
  return {
    requests,
    fetch: async (input, init) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input.toString() : input.url,
      );
      const key = `${url.pathname}${url.search}`;
      requests.push(key);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("accept"), "application/vnd.github+json");
      assert.equal(headers.get("authorization"), "Bearer secret");
      assert.equal(headers.get("x-github-api-version"), GITHUB_API_VERSION);
      assert.equal(init?.redirect, "manual");
      const route = routes[key];
      if (!route) throw new Error(`Unexpected GitHub fixture request ${key}`);
      const result = typeof route === "function" ? route() : route;
      const response = new Response(JSON.stringify(result.body), {
        status: result.status ?? 200,
        headers: { "content-type": "application/json", ...result.headers },
      });
      Object.defineProperty(response, "url", { value: url.toString() });
      return response;
    },
  };
}

function user(id: number, login: string): Record<string, unknown> {
  return { id, node_id: `U_${id}`, login };
}

function pullRequest(changedFiles = 2): Record<string, unknown> {
  return {
    id: 10,
    node_id: "PR_10",
    number: 7,
    user: user(1, "author"),
    base: { sha: BASE, repo: { full_name: "acme/repo" } },
    head: { sha: HEAD, repo: { full_name: "contributor/fork" } },
    changed_files: changedFiles,
    draft: false,
    state: "open",
  };
}

function event(): Record<string, unknown> {
  return {
    number: 7,
    repository: { full_name: "acme/repo" },
    pull_request: pullRequest(),
  };
}

function providerOptions(fetch: typeof globalThis.fetch): GitHubProviderOptions {
  return {
    token: "secret",
    owner: "acme",
    repo: "repo",
    pullRequestNumber: 7,
    expectedBaseSha: BASE,
    expectedHeadSha: HEAD,
    expectedHeadRepository: "contributor/fork",
    apiUrl: "https://api.test/",
    fetch,
  };
}

function commonRoutes(): Record<string, FixtureRoute> {
  return {
    "/repos/acme/repo/pulls/7": { body: pullRequest() },
  };
}

test("Actions context is derived from standard GITHUB_EVENT_PATH pull request JSON", () => {
  const root = mkdtempSync(join(tmpdir(), "polici-github-"));
  const path = join(root, "event.json");
  try {
    writeFileSync(path, JSON.stringify(event()));
    assert.deepEqual(
      githubContextFromActions({
        GITHUB_EVENT_PATH: path,
        GITHUB_REPOSITORY: "acme/repo",
      }),
      {
        owner: "acme",
        repo: "repo",
        pullRequestNumber: 7,
        expectedBaseSha: BASE,
        expectedHeadSha: HEAD,
        expectedHeadRepository: "contributor/fork",
      },
    );
    assert.throws(
      () =>
        githubContextFromActions({
          GITHUB_EVENT_PATH: path,
          GITHUB_REPOSITORY: "other/repo",
        }),
      (error: unknown) => error instanceof GitHubProviderError && error.code === "GITHUB_CONTEXT",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("event context rejects conflicting embedded data and overrides", () => {
  const inconsistent = event();
  inconsistent.number = 8;
  assert.throws(
    () => githubContextFromEvent(inconsistent),
    (error: unknown) => error instanceof GitHubProviderError && error.code === "GITHUB_CONTEXT",
  );
  assert.throws(
    () => githubContextFromEvent(event(), undefined, { expectedHeadSha: "a".repeat(40) }),
    (error: unknown) => error instanceof GitHubProviderError && error.code === "GITHUB_CONTEXT",
  );
});

test("changes use merge base, match either rename path, normalize copied, and verify blobs", async () => {
  const fixture = fetchFixture({
    ...commonRoutes(),
    [`/repos/acme/repo/compare/${BASE}...${HEAD}`]: {
      body: { base_commit: { sha: BASE }, merge_base_commit: { sha: MERGE_BASE } },
    },
    "/repos/acme/repo/pulls/7/files?per_page=100": {
      body: [
        {
          filename: "copies/copy.txt",
          status: "copied",
          sha: COPY_SHA,
          additions: 1,
          deletions: 0,
          changes: 1,
        },
        {
          filename: "new/name.txt",
          previous_filename: "old/name.txt",
          status: "renamed",
          sha: AFTER_SHA,
          additions: 1,
          deletions: 1,
          changes: 2,
        },
      ],
    },
    [`/repos/contributor/fork/contents/copies/copy.txt?ref=${HEAD}`]: {
      body: { path: "copies/copy.txt", sha: COPY_SHA },
    },
    [`/repos/acme/repo/contents/old/name.txt?ref=${MERGE_BASE}`]: {
      body: { path: "old/name.txt", sha: BEFORE_SHA },
    },
    [`/repos/contributor/fork/contents/new/name.txt?ref=${HEAD}`]: {
      body: { path: "new/name.txt", sha: AFTER_SHA },
    },
    [`/repos/contributor/fork/git/blobs/${COPY_SHA}`]: {
      body: { sha: COPY_SHA, size: 4, encoding: "base64", content: "Y29weQ==" },
    },
    [`/repos/acme/repo/git/blobs/${BEFORE_SHA}`]: {
      body: { sha: BEFORE_SHA, size: 6, encoding: "base64", content: "YmVmb3Jl" },
    },
    [`/repos/contributor/fork/git/blobs/${AFTER_SHA}`]: {
      body: { sha: AFTER_SHA, size: 5, encoding: "base64", content: "YWZ0ZXI=" },
    },
  });
  const provider = new GitHubProvider(providerOptions(fixture.fetch));
  const all = await provider.changes();
  assert.equal(all.mergeBaseSha, MERGE_BASE);
  assert.deepEqual(
    all.changes.map((change) => change.status),
    ["added", "renamed"],
  );
  assert.equal(new TextDecoder().decode(all.changes[0]?.after?.content), "copy");
  assert.equal(all.changes[1]?.before?.commitSha, MERGE_BASE);
  assert.equal(new TextDecoder().decode(all.changes[1]?.before?.content), "before");
  assert.equal(new TextDecoder().decode(all.changes[1]?.after?.content), "after");

  all.changes[1]!.after!.content[0] = 0;

  const renamed = await provider.changes("old/**");
  assert.equal(renamed.changes.length, 1);
  assert.equal(renamed.changes[0]?.path, "new/name.txt");
  assert.equal(new TextDecoder().decode(renamed.changes[0]?.after?.content), "after");
});

test("change resolver carries verified before/after bytes and immutable SHA evidence", async () => {
  const fixture = fetchFixture({
    "/repos/acme/repo/pulls/7": { body: pullRequest(1) },
    [`/repos/acme/repo/compare/${BASE}...${HEAD}`]: {
      body: { base_commit: { sha: BASE }, merge_base_commit: { sha: MERGE_BASE } },
    },
    "/repos/acme/repo/pulls/7/files?per_page=100": {
      body: [
        {
          filename: "copy.txt",
          status: "modified",
          sha: COPY_SHA,
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ],
    },
    [`/repos/acme/repo/contents/copy.txt?ref=${MERGE_BASE}`]: {
      body: { path: "copy.txt", sha: BEFORE_SHA },
    },
    [`/repos/contributor/fork/contents/copy.txt?ref=${HEAD}`]: {
      body: { path: "copy.txt", sha: COPY_SHA },
    },
    [`/repos/acme/repo/git/blobs/${BEFORE_SHA}`]: {
      body: { sha: BEFORE_SHA, size: 6, encoding: "base64", content: "YmVmb3Jl" },
    },
    [`/repos/contributor/fork/git/blobs/${COPY_SHA}`]: {
      body: { sha: COPY_SHA, size: 4, encoding: "base64", content: "Y29weQ==" },
    },
  });
  const host = new GitHubResolverHost(
    providerOptions(fixture.fetch),
    new RepositorySnapshot([new File("copy.txt", "copy")]),
  );
  const result = await host.resolve({
    resolver: "changes",
    arguments: { pattern: wire.string("**/*") },
  });
  assert.equal(validateWireValue(result).ok, true);
  assert.equal(result.tag, "entity");
  if (result.tag !== "entity") return;
  const changes = result.fields.changes;
  assert.equal(changes?.tag, "list");
  if (changes?.tag !== "list") return;
  const change = changes.items[0];
  assert.equal(change?.tag, "entity");
  if (change?.tag !== "entity") return;
  const before = change.fields.before;
  assert.equal(before?.tag, "map");
  if (before?.tag !== "map") return;
  assert.deepEqual(before.entries.content, wire.bytes("YmVmb3Jl"));
  assert.deepEqual(before.entries.commit_sha, wire.string(MERGE_BASE));
  assert.deepEqual(before.entries.sha, wire.string(BEFORE_SHA));
  const after = change.fields.after;
  assert.equal(after?.tag, "map");
  if (after?.tag !== "map") return;
  assert.deepEqual(after.entries.content, wire.bytes("Y29weQ=="));
  assert.deepEqual(after.entries.commit_sha, wire.string(HEAD));
  assert.deepEqual(after.entries.sha, wire.string(COPY_SHA));
});

test("a pull request beyond GitHub's 3000-file API ceiling fails closed", async () => {
  const fixture = fetchFixture({
    "/repos/acme/repo/pulls/7": { body: pullRequest(3_001) },
  });
  const provider = new GitHubProvider(providerOptions(fixture.fetch));
  await assert.rejects(
    provider.changes(),
    (error: unknown) => error instanceof GitHubProviderError && error.code === "GITHUB_TRUNCATED",
  );
  assert.deepEqual(fixture.requests, ["/repos/acme/repo/pulls/7"]);
});

test("resolver rejects worktree content that differs from the verified head blob", async () => {
  const fixture = fetchFixture({
    "/repos/acme/repo/pulls/7": { body: pullRequest(1) },
    [`/repos/acme/repo/compare/${BASE}...${HEAD}`]: {
      body: { base_commit: { sha: BASE }, merge_base_commit: { sha: MERGE_BASE } },
    },
    "/repos/acme/repo/pulls/7/files?per_page=100": {
      body: [
        {
          filename: "copy.txt",
          status: "added",
          sha: COPY_SHA,
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ],
    },
    [`/repos/contributor/fork/contents/copy.txt?ref=${HEAD}`]: {
      body: { path: "copy.txt", sha: COPY_SHA },
    },
    [`/repos/contributor/fork/git/blobs/${COPY_SHA}`]: {
      body: { sha: COPY_SHA, size: 4, encoding: "base64", content: "Y29weQ==" },
    },
  });
  const host = new GitHubResolverHost(
    providerOptions(fixture.fetch),
    new RepositorySnapshot([new File("copy.txt", "unverified worktree content")]),
  );
  await assert.rejects(
    host.resolve({ resolver: "changes", arguments: { pattern: wire.string("**/*") } }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: unknown }).code === "GITHUB_MATERIALIZATION",
  );
});

test("tampered Git blob content and pull request head drift fail closed", async () => {
  const tampered = fetchFixture({
    "/repos/acme/repo/pulls/7": { body: pullRequest(1) },
    [`/repos/acme/repo/compare/${BASE}...${HEAD}`]: {
      body: { base_commit: { sha: BASE }, merge_base_commit: { sha: MERGE_BASE } },
    },
    "/repos/acme/repo/pulls/7/files?per_page=100": {
      body: [
        {
          filename: "copy.txt",
          status: "added",
          sha: COPY_SHA,
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ],
    },
    [`/repos/contributor/fork/contents/copy.txt?ref=${HEAD}`]: {
      body: { path: "copy.txt", sha: COPY_SHA },
    },
    [`/repos/contributor/fork/git/blobs/${COPY_SHA}`]: {
      body: { sha: COPY_SHA, size: 4, encoding: "base64", content: "ZXZpbA==" },
    },
  });
  await assert.rejects(
    new GitHubProvider(providerOptions(tampered.fetch)).changes(),
    (error: unknown) => error instanceof GitHubProviderError && error.code === "GITHUB_RESPONSE",
  );

  let pullRequestReads = 0;
  const drifted = fetchFixture({
    "/repos/acme/repo/pulls/7": () => {
      pullRequestReads += 1;
      const value = pullRequest();
      if (pullRequestReads > 1) {
        value.head = { sha: "a".repeat(40), repo: { full_name: "contributor/fork" } };
      }
      return { body: value };
    },
    "/repos/acme/repo/pulls/7/reviews?per_page=100": { body: [] },
  });
  await assert.rejects(
    new GitHubProvider(providerOptions(drifted.fetch)).effectiveApprovers(),
    (error: unknown) =>
      error instanceof GitHubProviderError && error.code === "GITHUB_INCONSISTENT_HEAD",
  );
});

test("effective approvers use latest decisive review and pinned-head approval", async () => {
  const fixture = fetchFixture({
    ...commonRoutes(),
    "/repos/acme/repo/pulls/7/reviews?per_page=100": {
      body: [
        {
          id: 1,
          state: "APPROVED",
          commit_id: HEAD,
          submitted_at: "2026-01-01T00:00:00Z",
          user: user(2, "alice"),
        },
        {
          id: 2,
          state: "CHANGES_REQUESTED",
          commit_id: HEAD,
          submitted_at: "2026-01-02T00:00:00Z",
          user: user(2, "alice"),
        },
        {
          id: 3,
          state: "APPROVED",
          commit_id: BASE,
          submitted_at: "2026-01-03T00:00:00Z",
          user: user(3, "bob"),
        },
        {
          id: 4,
          state: "APPROVED",
          commit_id: HEAD,
          submitted_at: "2026-01-04T00:00:00Z",
          user: user(4, "carol"),
        },
        {
          id: 5,
          state: "APPROVED",
          commit_id: HEAD,
          submitted_at: "2026-01-05T00:00:00Z",
          user: null,
        },
        {
          id: 6,
          state: "APPROVED",
          commit_id: HEAD,
          submitted_at: "2026-01-05T00:00:00Z",
          user: user(5, "dana"),
        },
        {
          id: 7,
          state: "DISMISSED",
          commit_id: HEAD,
          submitted_at: "2026-01-06T00:00:00Z",
          user: user(5, "dana"),
        },
      ],
    },
  });
  const provider = new GitHubProvider(providerOptions(fixture.fetch));
  assert.deepEqual(await provider.effectiveApprovers(), [
    { id: "U_4", databaseId: 4, login: "carol" },
  ]);
});

test("effective approvers ignore non-opinions and break timestamp ties by review ID", async () => {
  const timestamp = "2026-02-01T00:00:00Z";
  const fixture = fetchFixture({
    ...commonRoutes(),
    "/repos/acme/repo/pulls/7/reviews?per_page=100": {
      body: [
        {
          id: 10,
          state: "APPROVED",
          commit_id: HEAD,
          submitted_at: "2026-01-01T00:00:00Z",
          user: user(6, "erin"),
        },
        { id: 11, state: "COMMENTED", user: user(6, "erin") },
        { id: 12, state: "PENDING", submitted_at: null, user: user(6, "erin") },
        {
          id: 21,
          state: "DISMISSED",
          commit_id: HEAD,
          submitted_at: timestamp,
          user: user(7, "frank"),
        },
        {
          id: 20,
          state: "APPROVED",
          commit_id: HEAD,
          submitted_at: timestamp,
          user: user(7, "frank"),
        },
        {
          id: 30,
          state: "CHANGES_REQUESTED",
          commit_id: HEAD,
          submitted_at: timestamp,
          user: user(8, "grace"),
        },
        {
          id: 31,
          state: "APPROVED",
          commit_id: HEAD,
          submitted_at: timestamp,
          user: user(8, "grace"),
        },
        {
          id: 41,
          state: "APPROVED",
          commit_id: HEAD,
          submitted_at: timestamp,
          user: user(9, "heidi"),
        },
        {
          id: 40,
          state: "CHANGES_REQUESTED",
          commit_id: HEAD,
          submitted_at: timestamp,
          user: user(9, "heidi"),
        },
        {
          id: 50,
          state: "APPROVED",
          commit_id: HEAD,
          submitted_at: "2026-01-01T00:00:00Z",
          user: user(2, "alice"),
        },
        {
          id: 51,
          state: "CHANGES_REQUESTED",
          commit_id: HEAD,
          submitted_at: "2026-01-02T00:00:00Z",
          user: user(2, "alice"),
        },
        {
          id: 52,
          state: "APPROVED",
          commit_id: HEAD,
          submitted_at: "2026-01-03T00:00:00Z",
          user: user(2, "alice"),
        },
        { user: null },
      ],
    },
  });
  assert.deepEqual(await new GitHubProvider(providerOptions(fixture.fetch)).effectiveApprovers(), [
    { id: "U_2", databaseId: 2, login: "alice" },
    { id: "U_6", databaseId: 6, login: "erin" },
    { id: "U_8", databaseId: 8, login: "grace" },
    { id: "U_9", databaseId: 9, login: "heidi" },
  ]);
});

test("team pagination is exhaustive, deduplicated, and inaccessible is an error", async () => {
  const next = "https://api.test/orgs/acme/teams/platform/members?role=all&per_page=100&page=2";
  const fixture = fetchFixture({
    ...commonRoutes(),
    "/orgs/acme/teams/platform": {
      body: { id: 20, node_id: "T_20", slug: "platform", name: "Platform" },
    },
    "/orgs/acme/teams/platform/members?role=all&per_page=100": {
      body: [user(2, "alice")],
      headers: { link: `<${next}>; type="application/json"; rel="next"` },
    },
    "/orgs/acme/teams/platform/members?role=all&per_page=100&page=2": {
      body: [user(2, "alice"), user(3, "bob")],
    },
  });
  const provider = new GitHubProvider(providerOptions(fixture.fetch));
  assert.deepEqual(await provider.teamMembers("platform"), [
    { id: "U_2", databaseId: 2, login: "alice" },
    { id: "U_3", databaseId: 3, login: "bob" },
  ]);

  const inaccessible = fetchFixture({
    ...commonRoutes(),
    "/orgs/acme/teams/private": { status: 404, body: { message: "Not Found" } },
  });
  const denied = new GitHubProvider(providerOptions(inaccessible.fetch));
  await assert.rejects(
    denied.teamMembers("private"),
    (error: unknown) => error instanceof GitHubProviderError && error.code === "GITHUB_NOT_FOUND",
  );
});

function checkRoutes(): Record<string, FixtureRoute> {
  return {
    ...commonRoutes(),
    [`/repos/acme/repo/commits/${HEAD}/check-suites?per_page=100`]: {
      body: {
        total_count: 2,
        check_suites: [
          { id: 100, head_sha: HEAD },
          { id: 200, head_sha: HEAD },
        ],
      },
    },
    "/repos/acme/repo/check-suites/100/check-runs?filter=all&per_page=100": {
      body: {
        total_count: 2,
        check_runs: [
          {
            node_id: "CR_1",
            name: "build",
            app: { id: 10, slug: "actions" },
            head_sha: HEAD,
            status: "completed",
            conclusion: "success",
            completed_at: "2026-01-01T00:00:00Z",
            created_at: "2026-01-01T00:00:00Z",
            html_url: "https://github.test/check/1",
          },
          {
            node_id: "CR_2",
            name: "build",
            app: { id: 10, slug: "actions" },
            head_sha: HEAD,
            status: "completed",
            conclusion: "neutral",
            completed_at: "2026-01-02T00:00:00Z",
            created_at: "2026-01-02T00:00:00Z",
            html_url: "https://github.test/check/2",
          },
        ],
      },
    },
    "/repos/acme/repo/check-suites/200/check-runs?filter=all&per_page=100": {
      body: {
        total_count: 1,
        check_runs: [
          {
            node_id: "CR_3",
            name: "build",
            app: { id: 20, slug: "other" },
            head_sha: HEAD,
            status: "completed",
            conclusion: "success",
            completed_at: "2026-01-03T00:00:00Z",
            created_at: "2026-01-03T00:00:00Z",
            html_url: "https://github.test/check/3",
          },
        ],
      },
    },
    [`/repos/acme/repo/commits/${HEAD}/statuses?per_page=100`]: {
      body: [
        {
          node_id: "S_1",
          context: "build",
          creator: user(30, "ci"),
          state: "success",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          target_url: "https://github.test/status/1",
        },
        {
          node_id: "S_2",
          context: "build",
          creator: user(30, "ci"),
          state: "pending",
          created_at: "2026-01-02T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
          target_url: "https://github.test/status/2",
        },
      ],
    },
  };
}

test("checks retain latest component per producer, require exact success, and disambiguate", async () => {
  const fixture = fetchFixture(checkRoutes());
  const provider = new GitHubProvider(providerOptions(fixture.fetch));
  const aggregate = await provider.check("build");
  assert.equal(aggregate.status, "failed");
  assert.deepEqual(
    aggregate.sources.map((source) => [source.producer, source.rawState, source.status]),
    [
      ["app:10", "neutral", "failed"],
      ["app:20", "success", "passed"],
      ["status:U_30", "pending", "pending"],
    ],
  );
  assert.equal((await provider.check("build", "app:20")).status, "passed");
  assert.equal((await provider.check("absent")).status, "missing");
});

test("check resolver retains deterministic selected-source evidence", async () => {
  const fixture = fetchFixture(checkRoutes());
  const host = new GitHubResolverHost(
    new GitHubProvider(providerOptions(fixture.fetch)),
    new RepositorySnapshot(),
  );
  const result = await host.resolve({
    resolver: "check",
    arguments: { name: wire.string("build") },
  });
  assert.equal(result.tag, "entity");
  if (result.tag !== "entity") return;
  assert.deepEqual(
    result.fields.summary,
    wire.string(
      [
        "check-run app:10/build: neutral (failed)",
        "check-run app:20/build: success (passed)",
        "status status:U_30/build: pending (pending)",
      ].join("\n"),
    ),
  );
  const sources = result.fields.sources;
  assert.equal(sources?.tag, "list");
  if (sources?.tag !== "list") return;
  assert.deepEqual(
    sources.items.map((source) =>
      source.tag === "map"
        ? [source.entries.kind, source.entries.id, source.entries.producer]
        : source,
    ),
    [
      [wire.string("check-run"), wire.string("CR_2"), wire.string("app:10")],
      [wire.string("check-run"), wire.string("CR_3"), wire.string("app:20")],
      [wire.string("status"), wire.string("S_2"), wire.string("status:U_30")],
    ],
  );
});

test("check totals, exact SHA, and permission failures fail closed", async () => {
  const truncated = fetchFixture({
    ...commonRoutes(),
    [`/repos/acme/repo/commits/${HEAD}/check-suites?per_page=100`]: {
      body: { total_count: 1, check_suites: [] },
    },
    [`/repos/acme/repo/commits/${HEAD}/statuses?per_page=100`]: {
      body: [],
    },
  });
  await assert.rejects(
    new GitHubProvider(providerOptions(truncated.fetch)).check("build"),
    (error: unknown) => error instanceof GitHubProviderError && error.code === "GITHUB_TRUNCATED",
  );

  const denied = fetchFixture({
    ...commonRoutes(),
    [`/repos/acme/repo/commits/${HEAD}/check-suites?per_page=100`]: {
      status: 403,
      body: { message: "Resource not accessible by integration" },
    },
    [`/repos/acme/repo/commits/${HEAD}/statuses?per_page=100`]: {
      body: [],
    },
  });
  await assert.rejects(
    new GitHubProvider(providerOptions(denied.fetch)).check("build"),
    (error: unknown) => error instanceof GitHubProviderError && error.code === "GITHUB_PERMISSION",
  );
});

test("unscoped checks cannot pass and status selectors bind immutable creator node IDs", async () => {
  const routes = checkRoutes();
  const statuses = routes[
    `/repos/acme/repo/commits/${HEAD}/statuses?per_page=100`
  ] as FixtureResult;
  const body = statuses.body as Record<string, unknown>[];
  body[1]!.state = "success";
  const runs = routes[
    "/repos/acme/repo/check-suites/100/check-runs?filter=all&per_page=100"
  ] as FixtureResult;
  const runBody = runs.body as { check_runs: Record<string, unknown>[] };
  runBody.check_runs[1]!.conclusion = "success";
  const fixture = fetchFixture(routes);
  const provider = new GitHubProvider(providerOptions(fixture.fetch));
  assert.equal((await provider.check("build")).status, "failed");
  assert.equal((await provider.check("build", "status:U_30")).status, "passed");
  assert.equal((await provider.check("build", "status:build")).status, "missing");
});

test("API transport rejects insecure URLs, redirects, and cross-origin final responses", async () => {
  assert.throws(
    () =>
      new GitHubProvider({
        ...providerOptions(async () => new Response("{}")),
        apiUrl: "http://api.test/",
      }),
    /HTTPS/,
  );
  const insecureTestFetch: typeof globalThis.fetch = async (input) => {
    const response = new Response(JSON.stringify(pullRequest()));
    Object.defineProperty(response, "url", { value: String(input) });
    return response;
  };
  assert.equal(
    (
      await new GitHubProvider({
        ...providerOptions(insecureTestFetch),
        apiUrl: "http://api.test/",
        allowInsecureHttpForTests: true,
      }).pullRequest()
    ).headSha,
    HEAD,
  );

  let redirectRequests = 0;
  const redirectFetch: typeof globalThis.fetch = async (input, init) => {
    redirectRequests += 1;
    assert.equal(init?.redirect, "manual");
    const response = new Response("", {
      status: 302,
      headers: { location: "https://evil.test/stolen" },
    });
    Object.defineProperty(response, "url", { value: String(input) });
    return response;
  };
  await assert.rejects(
    new GitHubProvider(providerOptions(redirectFetch)).pullRequest(),
    (error: unknown) => error instanceof GitHubProviderError && error.code === "GITHUB_RESPONSE",
  );
  assert.equal(redirectRequests, 1);

  const wrongOrigin: typeof globalThis.fetch = async () => {
    const response = new Response(JSON.stringify(pullRequest()));
    Object.defineProperty(response, "url", { value: "https://evil.test/result" });
    return response;
  };
  await assert.rejects(
    new GitHubProvider(providerOptions(wrongOrigin)).pullRequest(),
    (error: unknown) => error instanceof GitHubProviderError && error.code === "GITHUB_RESPONSE",
  );

  const missingFinalUrl: typeof globalThis.fetch = async () =>
    new Response(JSON.stringify(pullRequest()));
  await assert.rejects(
    new GitHubProvider(providerOptions(missingFinalUrl)).pullRequest(),
    (error: unknown) => error instanceof GitHubProviderError && error.code === "GITHUB_RESPONSE",
  );
});

test("successful, error, and blob payloads enforce configured byte limits", async () => {
  const oversized: typeof globalThis.fetch = async (input) => {
    const response = new Response(JSON.stringify(pullRequest()), {
      headers: { "content-length": "4096" },
    });
    Object.defineProperty(response, "url", { value: String(input) });
    return response;
  };
  await assert.rejects(
    new GitHubProvider({ ...providerOptions(oversized), maxResponseBytes: 1024 }).pullRequest(),
    (error: unknown) => error instanceof GitHubProviderError && error.code === "GITHUB_TRUNCATED",
  );

  const errorBody: typeof globalThis.fetch = async (input) => {
    const response = new Response(JSON.stringify({ message: "x".repeat(2048) }), { status: 403 });
    Object.defineProperty(response, "url", { value: String(input) });
    return response;
  };
  await assert.rejects(
    new GitHubProvider({ ...providerOptions(errorBody), maxResponseBytes: 1024 }).pullRequest(),
    (error: unknown) => error instanceof GitHubProviderError && error.code === "GITHUB_TRUNCATED",
  );

  const fixture = fetchFixture({
    "/repos/acme/repo/pulls/7": { body: pullRequest(1) },
    [`/repos/acme/repo/compare/${BASE}...${HEAD}`]: {
      body: { base_commit: { sha: BASE }, merge_base_commit: { sha: MERGE_BASE } },
    },
    "/repos/acme/repo/pulls/7/files?per_page=100": {
      body: [
        {
          filename: "copy.txt",
          status: "added",
          sha: COPY_SHA,
          additions: 1,
          deletions: 0,
          changes: 1,
        },
      ],
    },
    [`/repos/contributor/fork/contents/copy.txt?ref=${HEAD}`]: {
      body: { path: "copy.txt", sha: COPY_SHA },
    },
    [`/repos/contributor/fork/git/blobs/${COPY_SHA}`]: {
      body: { sha: COPY_SHA, size: 4, encoding: "base64", content: "Y29weQ==" },
    },
  });
  const provider = new GitHubProvider({
    ...providerOptions(fixture.fetch),
    maxBlobBytes: 3,
  });
  assert.equal(provider.maxBlobBytes, 3);
  assert.equal(provider.maxResponseBytes, 96 * 1024 * 1024);
  await assert.rejects(
    provider.changes(),
    (error: unknown) => error instanceof GitHubProviderError && error.code === "GITHUB_TRUNCATED",
  );
});

test("strict manifest and explicit trusted built-in descriptor stay synchronized", () => {
  assert.equal(validatePluginManifest(githubManifest).ok, true);
  assert.equal(githubManifest.contractMajor, 1);
  assert.deepEqual(
    githubManifest.exports.check.kind === "function"
      ? githubManifest.exports.check.parameters.map((parameter) => parameter.name)
      : [],
    ["name", "producer"],
  );
  assert.equal(githubManifest.runtime.entrypoint.includes("host.ts"), false);
  assert.deepEqual(githubBuiltin, {
    manifest: githubManifest,
    source: { kind: "builtin", locator: "polici:provider:github@1.0.0" },
  });
  const staticManifest = JSON.parse(
    new TextDecoder().decode(readFileSync("providers/github/manifest.json")),
  ) as unknown;
  assert.deepEqual(staticManifest, githubManifest);
});

test("resolver maps GitHub errors to non-optional permission faults", async () => {
  const fixture = fetchFixture({
    ...commonRoutes(),
    "/orgs/acme/teams/private": { status: 403, body: { message: "denied" } },
  });
  const host = new GitHubResolverHost(providerOptions(fixture.fetch), new RepositorySnapshot());
  await assert.rejects(
    host.resolve({ resolver: "team", arguments: { slug: wire.string("private") } }),
    (error: unknown) =>
      error instanceof Error &&
      "kind" in error &&
      (error as { kind: unknown }).kind === "permission",
  );
});

function _wireCompileCheck(value: WireValue): WireValue {
  return value;
}
