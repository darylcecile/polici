import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { RepositorySnapshot, matchPoliciGlob } from "../src/core/index.ts";
import { checkPolicy } from "../src/index.ts";
import { ResolverFault, wire } from "../src/plugin/index.ts";
import {
  coreChange,
  coreChangeSet,
  coreCheck,
  githubOptions,
  githubPullRequest,
  githubTeam,
  githubUser,
} from "./helpers.ts";

describe("Issue #1 engine acceptance", () => {
  test("the proposed policy example runs unchanged and reports the non-Markdown changed path", async () => {
    const source = `using "github@1" as Git

policy "repository rules" {
  records = Files("records/**/*.json").as(json)
  changes = Git.changes("**/*")

  rule "new record IDs are unique" {
    for each record in changes.added.files("records/**/*.json").as(json) {
      require record.id unique in records.{ id }
    }
  }

  rule "PR contains only Markdown changes" {
    require every changes.{ path matches "**/*.md" }
  }

  rule "schema changes need platform approval"
    when some changes.{ path matches "schema/**" }
  {
    require some Git.pull_request.approvers in Git.team("platform").members
    require Git.check("schema-compatibility", "app:15368") passed
  }
}`;
    const repository = RepositorySnapshot.fromEntries([
      { path: "records/old.json", content: '{"id":"old"}' },
      { path: "records/new.json", content: '{"id":"new"}' },
      { path: "schema/contract.md", content: "new schema\n" },
    ]);
    const changes = coreChangeSet([
      coreChange({
        id: "added-record",
        path: "records/new.json",
        status: "added",
        after: { path: "records/new.json" },
      }),
      coreChange({
        id: "schema-change",
        path: "schema/contract.md",
        status: "modified",
        before: { path: "schema/contract.md", content: "old schema\n" },
        after: { path: "schema/contract.md" },
      }),
    ]);
    const approver = githubUser("U_1", "alice");
    const result = await checkPolicy(
      source,
      githubOptions(repository, {
        changes: () => changes,
        pullRequest: () => githubPullRequest(),
        "pullRequest.approvers": () => wire.set([approver]),
        team: () => githubTeam("T_1", "platform"),
        "team.members": () => wire.set([githubUser("U_1", "alice-renamed")]),
        check: () => coreCheck("schema-compatibility", "passed"),
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 1);
    assert.deepEqual(
      result.policies[0]?.rules.map((rule) => rule.status),
      ["passed", "failed", "passed"],
    );
    const markdownRule = result.policies[0]?.rules[1];
    assert.ok(markdownRule?.evidence.some((item) => item.kind === "offending-item"));
    assert.ok(markdownRule?.evidence.some((item) => item.source?.path === "records/new.json"));
    assert.ok(markdownRule?.requirements[0]?.span.start.line !== undefined);
  });

  test("globstar includes repository-root files and spans zero or more complete segments", async () => {
    assert.equal(matchPoliciGlob("**/*.md", "README.md"), true);
    assert.equal(matchPoliciGlob("**/*.md", "docs/guide.md"), true);
    assert.equal(matchPoliciGlob("*.md", "docs/guide.md"), false);
    assert.equal(matchPoliciGlob("schema/**", "schema"), true);
    assert.equal(matchPoliciGlob("schema/**", "schema/deep/model.json"), true);
    assert.equal(matchPoliciGlob("**/*", "README.md"), true);
    assert.equal(matchPoliciGlob("**/*", "a/b/c"), true);

    const repository = RepositorySnapshot.fromEntries([
      { path: "README.md", content: "root" },
      { path: "docs/guide.md", content: "nested" },
      { path: "schema", content: "root of schema glob" },
      { path: "schema/deep/model.json", content: "{}" },
    ]);
    const result = await checkPolicy(
      `policy "globs" {
        rule "root markdown" { require some Files("**/*.md").{ path == "README.md" } }
        rule "schema root" { require some Files("schema/**").{ path == "schema" } }
        rule "all paths" { require every Files("**/*").{ path matches "**/*" } }
        rule "single star is one segment" { require no Files("*.md").{ path == "docs/guide.md" } }
      }`,
      { repository },
    );
    assert.equal(result.exitCode, 0, JSON.stringify(result.diagnostics));
    assert.deepEqual(
      result.policies[0]?.rules.map((rule) => rule.status),
      ["passed", "passed", "passed", "passed"],
    );
  });

  test("all empty fold and empty relation identities are explicit", async () => {
    const repository = RepositorySnapshot.fromEntries([{ path: "present.txt", content: "x" }]);
    const result = await checkPolicy(
      `policy "empty algebra" {
        empty = Files("absent/**").{ path }
        present = Files("present.txt").{ path }
        rule "folds" {
          require not (some Files("absent/**").{ true })
          require every Files("absent/**").{ false }
          require no Files("absent/**").{ true }
        }
        rule "both empty" {
          require not (some empty in empty)
          require every empty in empty
          require no empty in empty
        }
        rule "empty left" {
          require not (some empty in present)
          require every empty in present
          require no empty in present
        }
        rule "empty right" {
          require not (some present in empty)
          require not (every present in empty)
          require no present in empty
        }
      }`,
      { repository },
    );
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.ok(
      result.policies[0]?.rules.every(
        (rule) =>
          rule.status === "passed" &&
          rule.requirements.every((requirement) => requirement.status === "passed"),
      ),
    );
  });

  test("duplicate IDs retain both file paths and exact JSON pointers", async () => {
    const repository = RepositorySnapshot.fromEntries([
      { path: "records/a.json", content: '{"id":"duplicate","value":1}' },
      { path: "records/nested/b.json", content: '{"id":"duplicate","value":2}' },
    ]);
    const result = await checkPolicy(
      `policy "records" {
        records = Files("records/**/*.json").as(json)
        rule "IDs are unique" {
          for each record in records {
            require record.id unique in records.{ id }
          }
        }
      }`,
      { repository },
    );
    assert.equal(result.exitCode, 1);
    const rule = result.policies[0]?.rules[0];
    assert.equal(rule?.requirements.length, 2);
    assert.deepEqual(
      [
        ...new Set(
          rule?.evidence
            .filter((item) => item.kind === "duplicate")
            .map((item) => item.source?.path),
        ),
      ].sort(),
      ["records/a.json", "records/nested/b.json"],
    );
    assert.deepEqual(
      [
        ...new Set(
          rule?.evidence
            .filter((item) => item.kind === "duplicate")
            .map((item) => item.source?.pointer),
        ),
      ],
      ["/id"],
    );
  });

  test("Markdown constraints inspect changed paths only and identify the violating change", async () => {
    const repository = RepositorySnapshot.fromEntries([
      { path: "README.md", content: "changed" },
      { path: "legacy.txt", content: "unchanged non-Markdown" },
    ]);
    const markdownOnly = await checkPolicy(
      `using "github@1" as Git
       policy "changes" {
         changes = Git.changes("**/*")
         rule "Markdown only" { require every changes.{ path matches "**/*.md" } }
       }`,
      githubOptions(repository, {
        changes: () =>
          coreChangeSet([
            coreChange({
              id: "readme",
              path: "README.md",
              status: "modified",
              before: { path: "README.md", content: "old" },
              after: { path: "README.md" },
            }),
          ]),
      }),
    );
    assert.equal(markdownOnly.exitCode, 0, JSON.stringify(markdownOnly));

    const withViolation = await checkPolicy(
      `using "github@1" as Git
       policy "changes" {
         changes = Git.changes("**/*")
         rule "Markdown only" { require every changes.{ path matches "**/*.md" } }
       }`,
      githubOptions(repository, {
        changes: () =>
          coreChangeSet([
            coreChange({
              id: "text",
              path: "legacy.txt",
              status: "modified",
              before: { path: "legacy.txt", content: "old" },
              after: { path: "legacy.txt" },
            }),
          ]),
      }),
    );
    assert.equal(withViolation.exitCode, 1);
    assert.equal(withViolation.policies[0]?.rules[0]?.evidence[0]?.source?.path, "legacy.txt");
  });

  test("missing and null skip only optional rules while required absence is an error", async () => {
    const repository = RepositorySnapshot.fromEntries([
      { path: "missing.json", content: "{}" },
      { path: "null.json", content: '{"owner":null}' },
    ]);
    const result = await checkPolicy(
      `policy "absence" {
        missing = Files("missing.json").as(json)
        null_value = Files("null.json").as(json)
        rule "optional missing" optional { require every missing.{ owner matches "@*" } }
        rule "optional null" optional { require every null_value.{ owner matches "@*" } }
        rule "required missing" { require every missing.{ owner matches "@*" } }
      }`,
      { repository },
    );
    assert.equal(result.exitCode, 2);
    assert.deepEqual(
      result.policies[0]?.rules.map((rule) => rule.status),
      ["skipped", "skipped", "error"],
    );
    assert.equal(result.policies[0]?.rules[0]?.requirements.length, 0);
    assert.equal(result.policies[0]?.rules[1]?.requirements.length, 0);
    assert.ok(result.diagnostics.some((item) => item.code === "EVALUATION_MISSING_VALUE"));
  });

  test("optional absence cannot erase an earlier failed requirement", async () => {
    const result = await checkPolicy(
      `policy "p" {
        records = Files("record.json").as(json)
        rule "r" optional {
          require false
          require every records.{ absent == "x" }
        }
      }`,
      {
        repository: RepositorySnapshot.fromEntries([{ path: "record.json", content: "{}" }]),
      },
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result.policies[0]?.rules[0]?.status, "failed");
    assert.equal(result.policies[0]?.rules[0]?.requirements[0]?.status, "failed");
  });

  test("optional does not suppress policy parse, JSON parse, or provider errors", async () => {
    const syntax = await checkPolicy(
      `policy "broken" { rule "optional syntax" optional { require } }`,
      { repository: new RepositorySnapshot() },
    );
    assert.equal(syntax.exitCode, 2);
    assert.equal(syntax.policies.length, 0);
    assert.ok(syntax.diagnostics.some((item) => item.source === "parser"));

    const malformedJson = await checkPolicy(
      `policy "broken JSON" {
        rule "optional parse" optional {
          require every Files("bad.json").as(json).{ owner matches "@*" }
        }
      }`,
      { repository: RepositorySnapshot.fromEntries([{ path: "bad.json", content: '{"owner":}' }]) },
    );
    assert.equal(malformedJson.exitCode, 2);
    assert.equal(malformedJson.policies[0]?.rules[0]?.status, "error");
    assert.ok(malformedJson.diagnostics.some((item) => item.code.startsWith("JSON_")));

    const provider = await checkPolicy(
      `using "github@1" as Git
       policy "provider" { rule "optional provider" optional { require Git.team("platform").slug == "platform" } }`,
      githubOptions(new RepositorySnapshot(), {
        team: () => {
          throw new ResolverFault("UPSTREAM_UNAVAILABLE", "resolver", "fixture unavailable");
        },
      }),
    );
    assert.equal(provider.exitCode, 2);
    assert.equal(provider.policies[0]?.rules[0]?.status, "error");
    assert.ok(provider.diagnostics.some((item) => item.code === "UPSTREAM_UNAVAILABLE"));
  });

  test("added, modified, deleted, and renamed changes expose exact sides, files, and previous_path", async () => {
    const repository = RepositorySnapshot.fromEntries([
      { path: "added/new.md", content: "new added" },
      { path: "modified/file.md", content: "new modified" },
      { path: "renamed/new.md", content: "new renamed" },
    ]);
    const changes = coreChangeSet([
      coreChange({
        id: "a",
        path: "added/new.md",
        status: "added",
        after: { path: "added/new.md", content: "untrusted provider bytes" },
      }),
      coreChange({
        id: "m",
        path: "modified/file.md",
        status: "modified",
        before: { path: "modified/file.md", content: "old modified" },
        after: { path: "modified/file.md", content: "untrusted provider bytes" },
      }),
      coreChange({
        id: "d",
        path: "deleted/old.md",
        status: "deleted",
        before: { path: "deleted/old.md", content: "old deleted" },
      }),
      coreChange({
        id: "r",
        path: "renamed/new.md",
        status: "renamed",
        before: { path: "renamed/old.md", content: "old renamed" },
        after: { path: "renamed/new.md", content: "untrusted provider bytes" },
      }),
    ]);
    const result = await checkPolicy(
      `using "github@1" as Git
       policy "changes" {
         changes = Git.changes()
         rule "status partitions" {
           require every changes.added.{ status == "added" }
           require every changes.modified.{ status == "modified" }
           require every changes.deleted.{ status == "deleted" }
           require every changes.renamed.{ status == "renamed" }
         }
         rule "legal sides" {
           require every changes.added.{ after.content == "new added" }
           require every changes.modified.{ before.content == "old modified" and after.content == "new modified" }
           require every changes.deleted.{ before.content == "old deleted" }
           require every changes.renamed.{ previous_path == "renamed/old.md" }
           require every changes.renamed.{ before.path == "renamed/old.md" and after.content == "new renamed" }
         }
         rule "head files only" {
           require every changes.files().{ path } in Files("**/*").{ path }
           require every Files("**/*").{ path } in changes.files().{ path }
           require every changes.deleted.files().{ false }
         }
         rule "addition has no before" optional { require every changes.added.{ before.path == "x" } }
         rule "deletion has no after" optional { require every changes.deleted.{ after.path == "x" } }
       }`,
      githubOptions(repository, { changes: () => changes }),
    );
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.deepEqual(
      result.policies[0]?.rules.map((rule) => rule.status),
      ["passed", "passed", "passed", "skipped", "skipped"],
    );
  });

  test("provider entities compare by immutable identity rather than mutable login", async () => {
    const repository = new RepositorySnapshot();
    const result = await checkPolicy(
      `using "github@1" as Git
       policy "identity" {
         approvers = Git.pull_request.approvers
         rule "same node ID remains a member" {
           require some approvers in Git.team("platform").members
         }
         rule "same login is not identity" {
           require no approvers in Git.team("impostors").members
         }
       }`,
      githubOptions(repository, {
        pullRequest: () => githubPullRequest(),
        "pullRequest.approvers": () => wire.set([githubUser("U_1", "alice")]),
        team: (request) => {
          const slug = request.arguments.slug;
          assert.equal(slug?.tag, "string");
          return githubTeam(
            slug?.tag === "string" && slug.value === "platform" ? "T_1" : "T_2",
            slug?.tag === "string" ? slug.value : "invalid",
          );
        },
        "team.members": (request) => {
          const slug = request.subject?.tag === "entity" ? request.subject.fields.slug : undefined;
          return slug?.tag === "string" && slug.value === "platform"
            ? wire.set([githubUser("U_1", "renamed-alice")])
            : wire.set([githubUser("U_2", "alice")]);
        },
      }),
    );
    assert.equal(result.exitCode, 0, JSON.stringify(result));
  });

  test("passed is true only for passed; all other check states are ordinary failures with evidence", async () => {
    const states = ["passed", "missing", "pending", "failed", "cancelled"] as const;
    const result = await checkPolicy(
      `using "github@1" as Git
       policy "checks" {
         rule "passed" { require Git.check("passed") passed }
         rule "missing" { require Git.check("missing") passed }
         rule "pending" { require Git.check("pending") passed }
         rule "failed" { require Git.check("failed") passed }
         rule "cancelled" { require Git.check("cancelled") passed }
       }`,
      githubOptions(new RepositorySnapshot(), {
        check: (request) => {
          const name = request.arguments.name;
          assert.equal(name?.tag, "string");
          const state = name?.tag === "string" ? name.value : "failed";
          assert.ok(states.includes(state as (typeof states)[number]));
          return coreCheck(state, state as (typeof states)[number]);
        },
      }),
    );
    assert.equal(result.exitCode, 1);
    assert.deepEqual(
      result.policies[0]?.rules.map((rule) => rule.status),
      ["passed", "failed", "failed", "failed", "failed"],
    );
    for (const [index, state] of states.entries()) {
      const evidence = result.policies[0]?.rules[index]?.evidence.find(
        (item) => item.kind === "check",
      );
      assert.match(evidence?.message ?? "", new RegExp(`${state}\\.$`));
      assert.equal((evidence?.value as { status?: string } | undefined)?.status, state);
    }
    assert.equal(result.diagnostics.length, 0);
  });
});
