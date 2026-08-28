import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { GitHubProvider, type GitHubProviderOptions } from "../providers/github/index.ts";

const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const MERGE_BASE = "d".repeat(40);
const BEFORE_SHA = "ee2363a4dfc456efa66b2e71979a1f8f8f07a208";
const AFTER_SHA = "5c80f32d7908f9c0730c009c70915ab560722778";

interface FixtureResponse {
  readonly body: unknown;
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

type FixtureRoute = FixtureResponse | (() => FixtureResponse);

function fixtureFetch(routes: Readonly<Record<string, FixtureRoute>>): {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: string[];
} {
  const requests: string[] = [];
  return {
    requests,
    fetch: async (input, init) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input.toString() : input.url,
      );
      assert.equal(url.origin, "https://api.test");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer fixture-token");
      assert.equal(headers.get("x-github-api-version"), "2022-11-28");
      const key = `${url.pathname}${url.search}`;
      requests.push(key);
      const route = routes[key];
      assert.ok(route, `unexpected non-fixture GitHub request: ${key}`);
      const value = typeof route === "function" ? route() : route;
      const response = new Response(JSON.stringify(value.body), {
        status: value.status ?? 200,
        headers: { "content-type": "application/json", ...value.headers },
      });
      Object.defineProperty(response, "url", { value: url.toString() });
      return response;
    },
  };
}

function user(id: number, login: string): Record<string, unknown> {
  return { id, node_id: `U_${id}`, login };
}

function pullRequest(changedFiles = 0): Record<string, unknown> {
  return {
    id: 1,
    node_id: "PR_1",
    number: 1,
    user: user(1, "author"),
    base: { sha: BASE, repo: { full_name: "acme/repo" } },
    head: { sha: HEAD, repo: { full_name: "contributor/fork" } },
    changed_files: changedFiles,
    draft: false,
    state: "open",
  };
}

function options(fetch: typeof globalThis.fetch): GitHubProviderOptions {
  return {
    token: "fixture-token",
    owner: "acme",
    repo: "repo",
    pullRequestNumber: 1,
    expectedBaseSha: BASE,
    expectedHeadSha: HEAD,
    expectedHeadRepository: "contributor/fork",
    apiUrl: "https://api.test/",
    fetch,
  };
}

function commonRoutes(changedFiles = 0): Record<string, FixtureRoute> {
  return { "/repos/acme/repo/pulls/1": { body: pullRequest(changedFiles) } };
}

describe("Issue #1 offline GitHub provider acceptance", () => {
  test("latest opinionated review wins by immutable user ID while comments and stale approvals do not", async () => {
    const fixture = fixtureFetch({
      ...commonRoutes(),
      "/repos/acme/repo/pulls/1/reviews?per_page=100": {
        body: [
          {
            id: 1,
            state: "APPROVED",
            commit_id: HEAD,
            submitted_at: "2026-01-01T00:00:00Z",
            user: user(2, "alice-old-login"),
          },
          {
            id: 2,
            state: "COMMENTED",
            commit_id: HEAD,
            submitted_at: "2026-01-02T00:00:00Z",
            user: user(2, "alice-new-login"),
          },
          {
            id: 3,
            state: "APPROVED",
            commit_id: HEAD,
            submitted_at: "2026-01-03T00:00:00Z",
            user: user(3, "bob"),
          },
          {
            id: 4,
            state: "CHANGES_REQUESTED",
            commit_id: HEAD,
            submitted_at: "2026-01-03T00:00:00Z",
            user: user(3, "bob"),
          },
          {
            id: 5,
            state: "APPROVED",
            commit_id: BASE,
            submitted_at: "2026-01-04T00:00:00Z",
            user: user(4, "stale"),
          },
        ],
      },
    });
    const approvers = await new GitHubProvider(options(fixture.fetch)).effectiveApprovers();
    assert.deepEqual(approvers, [{ id: "U_2", databaseId: 2, login: "alice-old-login" }]);
    assert.ok(fixture.requests.every((request) => request.startsWith("/repos/")));
  });

  test("a later dismissed review revokes an earlier approval", async () => {
    const fixture = fixtureFetch({
      ...commonRoutes(),
      "/repos/acme/repo/pulls/1/reviews?per_page=100": {
        body: [
          {
            id: 10,
            state: "APPROVED",
            commit_id: HEAD,
            submitted_at: "2026-02-01T00:00:00Z",
            user: user(5, "dismissed-reviewer"),
          },
          {
            id: 11,
            state: "DISMISSED",
            commit_id: HEAD,
            submitted_at: "2026-02-02T00:00:00Z",
            user: user(5, "dismissed-reviewer"),
          },
        ],
      },
    });
    assert.deepEqual(
      await new GitHubProvider(options(fixture.fetch)).effectiveApprovers(),
      [],
      "DISMISSED is a decisive latest review and must revoke approval",
    );
  });

  test("team membership is complete, role=all, deduplicated by node ID, and sorted", async () => {
    const next = "https://api.test/orgs/acme/teams/platform/members?role=all&per_page=100&page=2";
    const fixture = fixtureFetch({
      ...commonRoutes(),
      "/orgs/acme/teams/platform": {
        body: { id: 20, node_id: "T_20", slug: "platform", name: "Platform" },
      },
      "/orgs/acme/teams/platform/members?role=all&per_page=100": {
        body: [user(3, "carol")],
        headers: { link: `<${next}>; rel="next"` },
      },
      "/orgs/acme/teams/platform/members?role=all&per_page=100&page=2": {
        body: [user(2, "bob"), user(3, "carol")],
      },
    });
    const members = await new GitHubProvider(options(fixture.fetch)).teamMembers("platform");
    assert.deepEqual(members, [
      { id: "U_2", databaseId: 2, login: "bob" },
      { id: "U_3", databaseId: 3, login: "carol" },
    ]);
    assert.ok(
      fixture.requests.some((request) => request.includes("members?role=all&per_page=100")),
    );
  });

  test("checks retain only each producer's latest source and aggregate deterministically", async () => {
    const fixture = fixtureFetch({
      ...commonRoutes(),
      [`/repos/acme/repo/commits/${HEAD}/check-suites?per_page=100`]: {
        body: { total_count: 1, check_suites: [{ id: 100, head_sha: HEAD }] },
      },
      "/repos/acme/repo/check-suites/100/check-runs?filter=all&per_page=100": {
        body: {
          total_count: 3,
          check_runs: [
            {
              node_id: "CR_1",
              name: "build",
              app: { id: 10, slug: "actions" },
              head_sha: HEAD,
              status: "completed",
              conclusion: "failure",
              completed_at: "2026-03-01T00:00:00Z",
              created_at: "2026-03-01T00:00:00Z",
            },
            {
              node_id: "CR_2",
              name: "build",
              app: { id: 10, slug: "actions" },
              head_sha: HEAD,
              status: "completed",
              conclusion: "success",
              completed_at: "2026-03-02T00:00:00Z",
              created_at: "2026-03-02T00:00:00Z",
            },
            {
              node_id: "CR_3",
              name: "build",
              app: { id: 20, slug: "other" },
              head_sha: HEAD,
              status: "completed",
              conclusion: "cancelled",
              completed_at: "2026-03-03T00:00:00Z",
              created_at: "2026-03-03T00:00:00Z",
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
            state: "failure",
            created_at: "2026-03-01T00:00:00Z",
            updated_at: "2026-03-01T00:00:00Z",
          },
          {
            node_id: "S_2",
            context: "build",
            creator: user(30, "ci"),
            state: "success",
            created_at: "2026-03-02T00:00:00Z",
            updated_at: "2026-03-02T00:00:00Z",
          },
        ],
      },
    });
    const provider = new GitHubProvider(options(fixture.fetch));
    const aggregate = await provider.check("build");
    assert.equal(aggregate.status, "cancelled");
    assert.deepEqual(
      aggregate.sources.map((source) => [source.producer, source.rawState, source.status]),
      [
        ["app:10", "success", "passed"],
        ["app:20", "cancelled", "cancelled"],
        ["status:U_30", "success", "passed"],
      ],
    );
    assert.equal((await provider.check("build", "app:10")).status, "passed");
    assert.equal((await provider.check("absent")).status, "missing");
  });

  test("rename filtering matches previous_path and materializes immutable before/after blobs", async () => {
    const fixture = fixtureFetch({
      ...commonRoutes(1),
      [`/repos/acme/repo/compare/${BASE}...${HEAD}`]: {
        body: { base_commit: { sha: BASE }, merge_base_commit: { sha: MERGE_BASE } },
      },
      "/repos/acme/repo/pulls/1/files?per_page=100": {
        body: [
          {
            filename: "new/name.md",
            previous_filename: "old/name.md",
            status: "renamed",
            sha: AFTER_SHA,
            additions: 1,
            deletions: 1,
            changes: 2,
          },
        ],
      },
      [`/repos/acme/repo/contents/old/name.md?ref=${MERGE_BASE}`]: {
        body: { path: "old/name.md", sha: BEFORE_SHA },
      },
      [`/repos/contributor/fork/contents/new/name.md?ref=${HEAD}`]: {
        body: { path: "new/name.md", sha: AFTER_SHA },
      },
      [`/repos/acme/repo/git/blobs/${BEFORE_SHA}`]: {
        body: { sha: BEFORE_SHA, size: 6, encoding: "base64", content: "YmVmb3Jl" },
      },
      [`/repos/contributor/fork/git/blobs/${AFTER_SHA}`]: {
        body: { sha: AFTER_SHA, size: 5, encoding: "base64", content: "YWZ0ZXI=" },
      },
    });
    const changes = await new GitHubProvider(options(fixture.fetch)).changes("old/**");
    assert.equal(changes.changes.length, 1);
    assert.equal(changes.changes[0]?.status, "renamed");
    assert.equal(changes.changes[0]?.path, "new/name.md");
    assert.equal(changes.changes[0]?.before?.path, "old/name.md");
    assert.equal(new TextDecoder().decode(changes.changes[0]?.before?.content), "before");
    assert.equal(new TextDecoder().decode(changes.changes[0]?.after?.content), "after");
  });
});
