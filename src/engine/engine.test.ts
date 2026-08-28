// @ts-ignore This bare repository intentionally does not depend on @types/node.
import assert from "node:assert/strict";
// @ts-ignore This bare repository intentionally does not depend on @types/node.
import test from "node:test";

import { File } from "../core/file.js";
import { RepositorySnapshot } from "../core/repository.js";
import { getCompletions, getHover } from "../language/editor.ts";
import { getSignatureHelp } from "../lsp/signature.ts";
import type { PluginManifest } from "../plugin/manifest.js";
import { FunctionResolverHost, ResolverFault } from "../plugin/resolver.js";
import { wire } from "../plugin/wire.js";
import {
  adaptPluginManifest,
  checkPolicy,
  compilePolicy,
  evaluatePolicy,
  parsePolicy,
} from "./index.ts";

const manifest: PluginManifest = {
  schema: "polici.plugin/v2",
  schemaVersion: 2,
  name: "github",
  version: "1.0.0",
  policiApi: 1,
  contractMajor: 1,
  types: {
    User: {
      kind: "entity",
      identity: "id",
      fields: {
        id: { kind: "id", namespace: "github:user" },
        login: { kind: "string" },
      },
    },
    Team: {
      kind: "entity",
      identity: "id",
      fields: {
        id: { kind: "id", namespace: "github:team" },
        slug: { kind: "string" },
        members: {
          kind: "set",
          items: { kind: "ref", type: "User" },
          resolve: "team.members",
        },
      },
      methods: {
        has_member: {
          parameters: [
            {
              name: "login",
              type: { kind: "string", pattern: "^[a-z]+$" },
              summary: "Login to locate.",
            },
          ],
          returns: { kind: "boolean" },
          resolve: "team.hasMember",
          summary: "Tests membership by login.",
        },
        same_members: {
          parameters: [
            { name: "users", type: { kind: "set", items: { kind: "ref", type: "User" } } },
          ],
          returns: { kind: "boolean" },
          resolve: "team.sameMembers",
        },
        accept_list: {
          parameters: [
            { name: "users", type: { kind: "list", items: { kind: "ref", type: "User" } } },
          ],
          returns: { kind: "boolean" },
          resolve: "team.acceptList",
        },
      },
    },
    PullRequest: {
      kind: "entity",
      identity: "id",
      fields: {
        id: { kind: "id", namespace: "github:pull-request" },
        approvers: {
          kind: "set",
          items: { kind: "ref", type: "User" },
          resolve: "pullRequest.approvers",
        },
      },
    },
    Config: {
      kind: "value",
      fields: { enabled: { kind: "boolean" } },
    },
  },
  exports: {
    config: {
      kind: "resource",
      type: { kind: "ref", type: "Config" },
      resolve: "config",
    },
    pull_request: {
      kind: "resource",
      type: { kind: "ref", type: "PullRequest" },
      context: "pull-request",
      resolve: "pullRequest",
    },
    changes: {
      kind: "function",
      parameters: [
        {
          name: "pattern",
          type: { kind: "glob" },
          default: "**/*",
        },
      ],
      returns: { kind: "core", type: "ChangeSet" },
      resolve: "changes",
    },
    team: {
      kind: "function",
      parameters: [{ name: "slug", type: { kind: "string" } }],
      returns: { kind: "ref", type: "Team" },
      resolve: "team",
    },
    check: {
      kind: "function",
      parameters: [
        { name: "name", type: { kind: "string" } },
        { name: "producer", type: { kind: "string" }, optional: true },
      ],
      returns: { kind: "core", type: "Check" },
      resolve: "check",
    },
    file: {
      kind: "function",
      parameters: [],
      returns: { kind: "core", type: "File" },
      resolve: "file",
    },
  },
  permissions: ["github:read"],
  runtime: {
    kind: "typescript",
    protocol: 1,
    entrypoint: "./host",
    transport: "jsonl",
    capabilities: ["github:read"],
  },
};

const trustedBuiltins = [
  { manifest, source: { kind: "builtin", locator: "builtin:github" } },
] as const;

const capability = [{ name: "github:read", operations: ["read"] }] as const;

function user(id: string, login: string) {
  return wire.entity("github:User", "github:user", id, {
    id: wire.id("github:user", id),
    login: wire.string(login),
  });
}

function host(overrides: Record<string, () => ReturnType<(typeof wire)["string"]>> = {}) {
  let calls = 0;
  const resolver = new FunctionResolverHost(
    {
      config: () => {
        calls += 1;
        return wire.map({ enabled: wire.boolean(true) });
      },
      pullRequest: () => {
        calls += 1;
        return wire.entity("github:PullRequest", "github:pull-request", "pr-1", {
          id: wire.id("github:pull-request", "pr-1"),
          approvers: wire.missing(),
        });
      },
      "pullRequest.approvers": () => {
        calls += 1;
        return wire.set([user("u-1", "alice")]);
      },
      team: () => {
        calls += 1;
        return wire.entity("github:Team", "github:team", "t-1", {
          id: wire.id("github:team", "t-1"),
          slug: wire.string("platform"),
          members: wire.missing(),
        });
      },
      "team.members": () => {
        calls += 1;
        return wire.set([user("u-1", "renamed-alice")]);
      },
      "team.hasMember": () => {
        calls += 1;
        return wire.boolean(true);
      },
      "team.sameMembers": () => {
        calls += 1;
        return wire.boolean(true);
      },
      "team.acceptList": () => {
        calls += 1;
        return wire.boolean(true);
      },
      changes: () => {
        calls += 1;
        return wire.entity("core:ChangeSet", "polici:change-set", "base..head", {
          changes: wire.list([
            wire.entity("core:Change", "polici:change", "c-1", {
              path: wire.string("records/new.json"),
              status: wire.string("added"),
              before: wire.missing(),
              after: wire.map({ path: wire.string("records/new.json") }),
            }),
          ]),
        });
      },
      check: () => {
        calls += 1;
        return wire.entity("core:Check", "polici:check", "head:compat", {
          name: wire.string("schema-compatibility"),
          status: wire.string("passed"),
        });
      },
      file: () =>
        wire.entity("core:File", "polici:file", "fixture.txt", {
          path: wire.string("fixture.txt"),
          content: wire.bytes("Zg=="),
        }),
      ...overrides,
    },
    capability,
  );
  return { resolver, calls: () => calls };
}

test("public parse and compile APIs statically adapt strict plugin manifests", () => {
  const source = `using "github@1" as Git\npolicy "p" { value = Git.team("platform") rule "r" { require true } }`;
  assert.equal(parsePolicy(source).diagnostics.length, 0);
  const adapted = adaptPluginManifest(manifest);
  assert.equal(adapted.name, "github");
  assert.equal(adapted.exports?.team?.kind, "function");
  const compiled = compilePolicy(source, { trustedBuiltins });
  assert.equal(compiled.kind, "compiled-policy");
  assert.deepEqual(compiled.diagnostics, []);
  assert.equal(compiled.ir.policies[0]?.bindings[0]?.type, "github.Team");
  assert.ok(JSON.stringify(compiled.diagnostics).startsWith("["));
});

test("empty policies and empty rules are compile errors", () => {
  assert.ok(
    compilePolicy('policy "empty" {}').diagnostics.some(
      (diagnostic) => diagnostic.code === "POLICY_NO_RULES",
    ),
  );
  assert.ok(
    compilePolicy('policy "empty" { rule "r" {} }').diagnostics.some(
      (diagnostic) => diagnostic.code === "POLICY_RULE_NO_REQUIREMENT",
    ),
  );
});

test("Issue #1 core and provider integration evaluates lazily with identity relations", async () => {
  const source = `using "github@1" as Git
policy "repository rules" {
  records = Files("records/**/*.json").as(json)
  changes = Git.changes("**/*")

  rule "new record IDs are unique" {
    for each record in changes.added.files("records/**/*.json").as(json) {
      require record.id unique in records.{ id }
    }
  }
  rule "PR contains only JSON changes" {
    require every changes.{ path matches "**/*.json" }
  }
  rule "schema changes need platform approval" {
    require some Git.pull_request.approvers in Git.team("platform").members
    require Git.check("schema-compatibility", "app:15368") passed
  }
}`;
  const repository = new RepositorySnapshot([
    new File("records/old.json", `{"id":"old"}`),
    new File("records/new.json", `{"id":"new"}`),
  ]);
  const runtime = host();
  const result = await checkPolicy(source, {
    repository,
    trustedBuiltins,
    resolvers: { Git: runtime.resolver },
  });
  assert.equal(result.status, "passed");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    result.policies[0]?.rules.map((rule) => rule.status),
    ["passed", "passed", "passed"],
  );
  assert.equal(runtime.calls(), 6);
  assert.ok(JSON.stringify(result).startsWith("{"));
});

test("failures retain requirement spans, offending paths, duplicate pointers, and check states", async () => {
  const duplicate = `policy "duplicates" {
  records = Files("records/*.json").as(json)
  rule "unique" {
    for each record in records { require record.id unique in records.{ id } }
  }
  rule "paths" { require every Files("**/*").{ path matches "**/*.json" } }
}`;
  const repository = new RepositorySnapshot([
    new File("records/a.json", `{"id":"same"}`),
    new File("records/b.json", `{"id":"same"}`),
    new File("README.md", "hello"),
  ]);
  const result = await checkPolicy(duplicate, { repository });
  assert.equal(result.exitCode, 1);
  const unique = result.policies[0]?.rules[0];
  assert.equal(unique?.requirements.length, 2);
  assert.ok(unique?.evidence.some((item) => item.kind === "duplicate"));
  assert.ok(unique?.evidence.some((item) => item.source?.pointer === "/id"));
  const paths = result.policies[0]?.rules[1];
  assert.equal(paths?.evidence[0]?.source?.path, "README.md");
  assert.ok(paths?.requirements[0]?.span.start.offset !== undefined);

  const runtime = host({
    check: () =>
      wire.entity("core:Check", "polici:check", "failed", {
        name: wire.string("schema-compatibility"),
        status: wire.string("failed"),
        summary: wire.string(`component app:42 failed\n${"x".repeat(5_000)}`),
        url: wire.string("https://checks.example.test/runs/42"),
      }),
  });
  const checked = await checkPolicy(
    `using "github@1" as Git\npolicy "checks" { rule "check" { require Git.check("x") passed } }`,
    { repository, trustedBuiltins, resolvers: { Git: runtime.resolver } },
  );
  assert.equal(checked.exitCode, 1);
  assert.equal(checked.policies[0]?.rules[0]?.evidence[0]?.kind, "check");
  const checkEvidence = checked.policies[0]?.rules[0]?.evidence[0];
  assert.match(checkEvidence?.message ?? "", /component app:42 failed/);
  assert.match(checkEvidence?.message ?? "", /URL: https:\/\/checks\.example\.test\/runs\/42/);
  const checkValue = checkEvidence?.value as { summary?: string; url?: string } | undefined;
  assert.equal(checkValue?.summary?.length, 4_096);
  assert.equal(checkValue?.url, "https://checks.example.test/runs/42");
});

test("provider entity equality is isolated by contract major", () => {
  const manifestV2: PluginManifest = {
    ...manifest,
    version: "2.0.0",
    contractMajor: 2,
  };
  const source = `using "github@1" as Git1
using "github@2" as Git2
policy "contract identity" {
  rule "different" { require Git1.team("platform") != Git2.team("platform") }
  rule "evidence" { require Git1.team("platform") == Git2.team("platform") }
}`;
  const compiled = compilePolicy(source, {
    trustedBuiltins: [
      ...trustedBuiltins,
      { manifest: manifestV2, source: { kind: "builtin", locator: "builtin:github-v2" } },
    ],
  });
  assert.ok(compiled.diagnostics.some((diagnostic) => diagnostic.code === "TYPE_INCOMPARABLE"));
});

test("wire changes preserve before content and renamed previous_path while trusting head content", async () => {
  const repository = new RepositorySnapshot([
    new File("modified.md", "new modified"),
    new File("new-name.md", "new renamed"),
  ]);
  const runtime = host({
    changes: () =>
      wire.entity("core:ChangeSet", "polici:change-set", "base..head", {
        changes: wire.list([
          wire.entity("core:Change", "polici:change", "modified", {
            path: wire.string("modified.md"),
            status: wire.string("modified"),
            before: wire.map({
              path: wire.string("modified.md"),
              content: wire.string("old modified"),
            }),
            after: wire.map({
              path: wire.string("modified.md"),
              content: wire.string("untrusted modified"),
            }),
          }),
          wire.entity("core:Change", "polici:change", "renamed", {
            path: wire.string("new-name.md"),
            status: wire.string("renamed"),
            before: wire.map({
              path: wire.string("old-name.md"),
              content: wire.string("old renamed"),
            }),
            after: wire.map({
              path: wire.string("new-name.md"),
              content: wire.string("untrusted renamed"),
            }),
          }),
        ]),
      }),
  });
  const result = await checkPolicy(
    `using "github@1" as Git
policy "change sides" {
  changes = Git.changes()
  rule "contents" {
    require every changes.modified.{ before.content == "old modified" and after.content == "new modified" }
    require every changes.renamed.{ previous_path == "old-name.md" }
    require every changes.renamed.{ before.content == "old renamed" and after.content == "new renamed" }
  }
}`,
    { repository, trustedBuiltins, resolvers: { Git: runtime.resolver } },
  );
  assert.equal(result.exitCode, 0, JSON.stringify(result));
});

test("missing and null error by default and skip only the whole optional rule", async () => {
  const repository = new RepositorySnapshot([new File("record.json", `{"name":null}`)]);
  const source = `policy "absence" {
  record = Files("record.json").as(json)
  rule "required missing" { require every record.{ owner matches "@*" } }
  rule "optional null" optional { require true require every record.{ name matches "@*" } require false }
}`;
  const result = await checkPolicy(source, { repository });
  assert.equal(result.exitCode, 2);
  assert.deepEqual(
    result.policies[0]?.rules.map((rule) => rule.status),
    ["error", "skipped"],
  );
  assert.equal(result.policies[0]?.rules[1]?.requirements.length, 0);
});

test("provider value types and every/no/some folds and relations evaluate", async () => {
  const repository = new RepositorySnapshot([new File("a.json", "{}"), new File("b.md", "text")]);
  const runtime = host();
  const result = await checkPolicy(
    `using "github@1" as Git
policy "relations" {
  rule "values" { require Git.config.enabled }
  rule "relations" {
    require every Files("*.json").{ path } in Files("*").{ path }
    require no Files("*.md").{ path } in Files("*.json").{ path }
    require some Files("*").{ true }
    require no Files("*").{ false }
  }
}`,
    { repository, trustedBuiltins, resolvers: { Git: runtime.resolver } },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(runtime.calls(), 1);
});

test("optional rules do not suppress parse, type, permission, or runtime faults", async () => {
  const repository = new RepositorySnapshot();
  const invalid = await checkPolicy(`policy "bad" { rule "r" optional { require unknown } }`, {
    repository,
  });
  assert.equal(invalid.exitCode, 2);
  assert.ok(invalid.diagnostics.some((item) => item.source === "binder"));
  const parseError = await checkPolicy(`policy "bad" { rule "r" optional { require } }`, {
    repository,
  });
  assert.ok(parseError.diagnostics.some((item) => item.source === "parser"));
  const typeError = await checkPolicy(`policy "bad" { rule "r" optional { require "value" } }`, {
    repository,
  });
  assert.ok(typeError.diagnostics.some((item) => item.source === "type"));

  const noPermission = new FunctionResolverHost({ team: () => wire.missing() });
  const denied = await checkPolicy(
    `using "github@1" as Git\npolicy "p" { rule "r" optional { require Git.team("x").slug == "x" } }`,
    { repository, trustedBuiltins, resolvers: { Git: noPermission } },
  );
  assert.equal(denied.policies[0]?.rules[0]?.status, "error");
  assert.ok(denied.diagnostics.some((item) => item.source === "permission"));

  const failed = new FunctionResolverHost(
    {
      team: () => {
        throw new ResolverFault("UPSTREAM", "resolver", "service unavailable");
      },
    },
    capability,
  );
  const fault = await checkPolicy(
    `using "github@1" as Git\npolicy "p" { rule "r" optional { require Git.team("x").slug == "x" } }`,
    { repository, trustedBuiltins, resolvers: { Git: failed } },
  );
  assert.equal(fault.policies[0]?.rules[0]?.status, "error");
  assert.ok(fault.diagnostics.some((item) => item.source === "runtime"));

  const invalidWire = new FunctionResolverHost(
    {
      team: () =>
        ({ tag: "boolean", value: "invalid" }) as unknown as ReturnType<typeof wire.boolean>,
    },
    capability,
  );
  const protocolFault = await checkPolicy(
    `using "github@1" as Git\npolicy "p" { rule "r" optional { require Git.team("x").slug == "x" } }`,
    { repository, trustedBuiltins, resolvers: { Git: invalidWire } },
  );
  assert.equal(protocolFault.diagnostics.at(-1)?.code, "PROVIDER_INVALID_WIRE_VALUE");
});

test("logical and quantified operations short circuit and all rules still evaluate in order", async () => {
  let checkCalls = 0;
  const runtime = host({
    check: () => {
      checkCalls += 1;
      throw new Error("must not run");
    },
  });
  const source = `using "github@1" as Git
policy "short circuit" {
  rule "and" { require false and Git.check("x") passed }
  rule "or" { require true or Git.check("x") passed }
  rule "later" { require false }
}`;
  const result = await checkPolicy(source, {
    repository: new RepositorySnapshot(),
    trustedBuiltins,
    resolvers: { Git: runtime.resolver },
  });
  assert.equal(checkCalls, 0);
  assert.deepEqual(
    result.policies[0]?.rules.map((rule) => rule.status),
    ["failed", "passed", "failed"],
  );
});

test("unused bindings stay lazy and demanded bindings are immutable memoized values", async () => {
  const runtime = host();
  const source = `using "github@1" as Git
policy "lazy" {
  unused = Git.team("unused")
  current = Git.team("platform")
  rule "one" { require current.slug == "platform" }
  rule "two" { require current.slug == "platform" }
}`;
  const result = await checkPolicy(source, {
    repository: new RepositorySnapshot(),
    trustedBuiltins,
    resolvers: { Git: runtime.resolver },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(runtime.calls(), 1);
});

test("file, collection, resolver, and evidence limits produce deterministic errors or truncation", async () => {
  const repository = new RepositorySnapshot([
    new File("a.json", `{"id":"x"}`),
    new File("b.json", `{"id":"x"}`),
  ]);
  const files = await checkPolicy(`policy "p" { rule "r" { require every Files("*").{ true } } }`, {
    repository,
    limits: { files: 1 },
  });
  assert.equal(files.diagnostics.at(-1)?.code, "EVALUATION_FILE_LIMIT");

  const collection = await checkPolicy(
    `policy "p" { rule "r" { require every Files("*").{ true } } }`,
    { repository, limits: { files: 10, collectionItems: 1 } },
  );
  assert.equal(collection.diagnostics.at(-1)?.code, "EVALUATION_COLLECTION_LIMIT");

  const runtime = host();
  const resolver = await checkPolicy(
    `using "github@1" as Git\npolicy "p" { rule "r" { require Git.check("x") passed } }`,
    {
      repository,
      trustedBuiltins,
      resolvers: { Git: runtime.resolver },
      limits: { resolverCalls: 0 },
    },
  );
  assert.equal(resolver.diagnostics.at(-1)?.code, "EVALUATION_RESOLVER_LIMIT");

  const evidence = await checkPolicy(
    `policy "p" { records = Files("*.json").as(json) rule "r" { for each record in records { require record.id unique in records.{ id } } } }`,
    { repository, limits: { evidence: 1 } },
  );
  assert.equal(evidence.policies[0]?.rules[0]?.evidence.length, 1);
});

test("evaluatePolicy accepts precompiled policy and compilation errors use exit code 2", async () => {
  const compiled = compilePolicy(`policy "p" { rule "r" { require true } }`);
  const result = await evaluatePolicy(compiled, { repository: new RepositorySnapshot() });
  assert.equal(result.exitCode, 0);
  const invalid = await evaluatePolicy(compilePolicy(`policy "p" { rule "r" { require } }`), {
    repository: new RepositorySnapshot(),
  });
  assert.equal(invalid.exitCode, 2);
  assert.equal(invalid.policies.length, 0);
});

test("typed entity methods adapt to editor services and send the entity as subject", async () => {
  const adapted = adaptPluginManifest(manifest);
  const completionSource = 'using "github@1" as Git\npolicy "p" { value = Git.team("platform"). }';
  const completions = getCompletions(completionSource, completionSource.indexOf(". }") + 1, [
    adapted,
  ]);
  assert.ok(
    completions.items.some((item) => item.label === "has_member" && item.kind === "method"),
  );

  const hoverSource =
    'using "github@1" as Git\npolicy "p" { value = Git.team("platform").has_member("alice") rule "r" { require value } }';
  const hover = getHover(hoverSource, hoverSource.indexOf("has_member") + 2, [adapted]);
  assert.match(hover?.contents ?? "", /login: string/);
  assert.match(hover?.contents ?? "", /Tests membership by login/);
  const signatureOffset = hoverSource.indexOf('"alice"') + 3;
  const signature = getSignatureHelp(hoverSource, signatureOffset, [adapted], []);
  assert.match(signature?.signatures[0]?.label ?? "", /has_member\(login: string\): boolean/);

  let methodRequest: unknown;
  const runtime = host({
    "team.hasMember": (request?: unknown) => {
      methodRequest = request;
      return wire.boolean(true);
    },
  } as never);
  const result = await checkPolicy(
    'using "github@1" as Git\npolicy "p" { rule "r" { require Git.team("platform").has_member("alice") } }',
    {
      repository: new RepositorySnapshot(),
      trustedBuiltins,
      resolvers: { Git: runtime.resolver },
    },
  );
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  const request = methodRequest as {
    subject?: { tag?: string; type?: string; identity?: { value?: string } };
    arguments?: { login?: unknown };
  };
  assert.equal(request.subject?.tag, "entity");
  assert.equal(request.subject?.type, "github:Team");
  assert.equal(request.subject?.identity?.value, "t-1");
  assert.deepEqual(request.arguments?.login, wire.string("alice"));

  const invalidRuntime = host({ "team.hasMember": () => wire.string("not-boolean") });
  const invalidResult = await checkPolicy(
    'using "github@1" as Git\npolicy "p" { rule "r" { require Git.team("platform").has_member("alice") } }',
    {
      repository: new RepositorySnapshot(),
      trustedBuiltins,
      resolvers: { Git: invalidRuntime.resolver },
    },
  );
  assert.equal(invalidResult.exitCode, 2);
  assert.equal(invalidResult.diagnostics.at(-1)?.code, "PROVIDER_WIRE_TYPE");
});

test("typed provider arguments are constrained before host invocation and preserve set tags", async () => {
  let methodCalls = 0;
  let setArgument: unknown;
  const constrained = host({
    "team.hasMember": () => {
      methodCalls += 1;
      return wire.boolean(true);
    },
    "team.sameMembers": (request?: unknown) => {
      methodCalls += 1;
      setArgument = (request as { arguments?: { users?: unknown } }).arguments?.users;
      return wire.boolean(true);
    },
  } as never);
  const invalid = await checkPolicy(
    'using "github@1" as Git\npolicy "p" { rule "r" { require Git.team("platform").has_member("Alice") } }',
    {
      repository: new RepositorySnapshot(),
      trustedBuiltins,
      resolvers: { Git: constrained.resolver },
    },
  );
  assert.equal(invalid.exitCode, 2);
  assert.equal(methodCalls, 0);
  assert.equal(invalid.diagnostics.at(-1)?.code, "EVALUATION_ARGUMENT_CONSTRAINT");

  const valid = await checkPolicy(
    'using "github@1" as Git\npolicy "p" { rule "r" { require Git.team("platform").same_members(Git.team("platform").members) } }',
    {
      repository: new RepositorySnapshot(),
      trustedBuiltins,
      resolvers: { Git: constrained.resolver },
    },
  );
  assert.equal(valid.exitCode, 0, JSON.stringify(valid));
  assert.equal((setArgument as { tag?: string }).tag, "set");
  assert.equal(methodCalls, 1);

  const mismatch = compilePolicy(
    'using "github@1" as Git\npolicy "p" { rule "r" { require Git.team("platform").accept_list(Git.team("platform").members) } }',
    { trustedBuiltins },
  );
  assert.ok(mismatch.diagnostics.some((item) => item.code === "TYPE_MISMATCH"));
});

test("bound entity method calls preserve strict list/set argument diagnostics", () => {
  const compiled = compilePolicy(
    `using "github@1" as Git
     policy "p" {
       team = Git.team("platform")
       rule "r" { require team.accept_list(team.members) }
     }`,
    { trustedBuiltins },
  );
  assert.ok(compiled.diagnostics.some((diagnostic) => diagnostic.code === "TYPE_MISMATCH"));
});

test("core wire values reject aliases, unknown fields, bad identities, illegal sides, and paths", async () => {
  const validChange = () =>
    wire.entity("core:Change", "polici:change", "change", {
      path: wire.string("a.txt"),
      status: wire.string("modified"),
      before: wire.map({ path: wire.string("a.txt"), content: wire.string("old") }),
      after: wire.map({ path: wire.string("a.txt") }),
    });
  const changeSet = (change: ReturnType<typeof validChange>, fields = {}) =>
    wire.entity("core:ChangeSet", "polici:change-set", "base..head", {
      changes: wire.list([change]),
      ...fields,
    });
  const cases: readonly [string, ReturnType<typeof wire.entity>][] = [
    [
      "status alias",
      changeSet(
        wire.entity("core:Change", "polici:change", "change", {
          path: wire.string("a.txt"),
          status: wire.string("changed"),
          before: wire.map({ path: wire.string("a.txt") }),
          after: wire.map({ path: wire.string("a.txt") }),
        }),
      ),
    ],
    [
      "unqualified type",
      changeSet(
        wire.entity("Change", "polici:change", "change", {
          path: wire.string("a.txt"),
          status: wire.string("modified"),
          before: wire.map({ path: wire.string("a.txt") }),
          after: wire.map({ path: wire.string("a.txt") }),
        }),
      ),
    ],
    [
      "identity namespace",
      changeSet(
        wire.entity("core:Change", "github:change", "change", {
          path: wire.string("a.txt"),
          status: wire.string("modified"),
          before: wire.map({ path: wire.string("a.txt") }),
          after: wire.map({ path: wire.string("a.txt") }),
        }),
      ),
    ],
    ["unknown change field", changeSet(validChange(), { unexpected: wire.string("x") })],
    [
      "illegal added before",
      changeSet(
        wire.entity("core:Change", "polici:change", "change", {
          path: wire.string("a.txt"),
          status: wire.string("added"),
          before: wire.map({ path: wire.string("a.txt") }),
          after: wire.map({ path: wire.string("a.txt") }),
        }),
      ),
    ],
    [
      "missing modified side",
      changeSet(
        wire.entity("core:Change", "polici:change", "change", {
          path: wire.string("a.txt"),
          status: wire.string("modified"),
          before: wire.missing(),
          after: wire.map({ path: wire.string("a.txt") }),
        }),
      ),
    ],
    [
      "noncanonical path",
      changeSet(
        wire.entity("core:Change", "polici:change", "change", {
          path: wire.string("dir/../a.txt"),
          status: wire.string("modified"),
          before: wire.map({ path: wire.string("a.txt") }),
          after: wire.map({ path: wire.string("a.txt") }),
        }),
      ),
    ],
    [
      "inconsistent after path",
      changeSet(
        wire.entity("core:Change", "polici:change", "change", {
          path: wire.string("a.txt"),
          status: wire.string("modified"),
          before: wire.map({ path: wire.string("a.txt") }),
          after: wire.map({ path: wire.string("b.txt") }),
        }),
      ),
    ],
  ];
  for (const [label, value] of cases) {
    const runtime = host({ changes: () => value });
    const result = await checkPolicy(
      'using "github@1" as Git\npolicy "p" { rule "r" { require every Git.changes().{ true } } }',
      {
        repository: new RepositorySnapshot([new File("a.txt", "new")]),
        trustedBuiltins,
        resolvers: { Git: runtime.resolver },
      },
    );
    assert.equal(result.exitCode, 2, `${label}: ${JSON.stringify(result)}`);
  }

  for (const fields of [
    { name: wire.string("x"), state: wire.string("passed") },
    { name: wire.string("x"), status: wire.string("queued") },
    { name: wire.string("x"), status: wire.string("passed"), extra: wire.string("x") },
  ]) {
    const runtime = host({
      check: () => wire.entity("core:Check", "polici:check", "check", fields),
    });
    const result = await checkPolicy(
      'using "github@1" as Git\npolicy "p" { rule "r" { require Git.check("x") passed } }',
      {
        repository: new RepositorySnapshot(),
        trustedBuiltins,
        resolvers: { Git: runtime.resolver },
      },
    );
    assert.equal(result.exitCode, 2, JSON.stringify(result));
  }

  const validFile = await checkPolicy(
    'using "github@1" as Git\npolicy "p" { rule "r" { require Git.file().content == "f" } }',
    {
      repository: new RepositorySnapshot(),
      trustedBuiltins,
      resolvers: { Git: host().resolver },
    },
  );
  assert.equal(validFile.exitCode, 0, JSON.stringify(validFile));
  for (const file of [
    wire.entity("File", "polici:file", "fixture.txt", {
      path: wire.string("fixture.txt"),
      content: wire.string("f"),
    }),
    wire.entity("core:File", "github:file", "fixture.txt", {
      path: wire.string("fixture.txt"),
      content: wire.string("f"),
    }),
    wire.entity("core:File", "polici:file", "different.txt", {
      path: wire.string("fixture.txt"),
      content: wire.string("f"),
    }),
    wire.entity("core:File", "polici:file", "fixture.txt", {
      path: wire.string("fixture.txt"),
      content: wire.string("f"),
      extra: wire.string("x"),
    }),
    wire.entity("core:File", "polici:file", "fixture.txt", {
      path: wire.string("fixture.txt"),
    }),
    wire.entity("core:File", "polici:file", "fixture.txt", {
      path: wire.string("fixture.txt"),
      content: { tag: "bytes", encoding: "base64", value: "Zh==" },
    }),
  ] as const) {
    const runtime = host({ file: () => file as never });
    const result = await checkPolicy(
      'using "github@1" as Git\npolicy "p" { rule "r" { require Git.file().path == "fixture.txt" } }',
      {
        repository: new RepositorySnapshot(),
        trustedBuiltins,
        resolvers: { Git: runtime.resolver },
      },
    );
    assert.equal(result.exitCode, 2, JSON.stringify(result));
  }
});

test("failed relation evidence summarizes the complete left and right operands independently", async () => {
  const result = await checkPolicy(
    'policy "p" { rule "r" { require some Files("absent").{ path } in Files("present").{ path } } }',
    { repository: new RepositorySnapshot([new File("present", "x")]) },
  );
  const comparison = result.policies[0]?.rules[0]?.evidence.find(
    (item) => item.kind === "comparison",
  );
  assert.deepEqual(comparison?.value, { left: [], right: ["present"], relevant: [] });
});
