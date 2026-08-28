import assert from "node:assert/strict";
import test from "node:test";

import {
  compile,
  getCompletions,
  getHover,
  getSemanticTokens,
  lex,
  parse,
  type ProviderManifest,
} from "./index.ts";
import { githubManifest as productionGithubManifest } from "../../providers/github/manifest.ts";
import { canonicalPluginManifestSha256 } from "../plugin/lockfile.js";
import { githubManifest as editorGithubManifest } from "../lsp/github.ts";

const githubManifest: ProviderManifest = {
  name: "github",
  version: "0.0.1",
  policiApi: 1,
  apiVersion: 1,
  documentation: "GitHub policy resources.",
  types: {
    User: {
      kind: "entity",
      identity: "id",
      fields: {
        id: "string",
        login: "string",
      },
    },
    Team: {
      kind: "entity",
      identity: "id",
      fields: {
        id: "string",
        slug: "string",
        members: {
          type: { kind: "set", element: { kind: "ref", name: "User" } },
          documentation: "Team members.",
        },
      },
    },
    PullRequest: {
      kind: "entity",
      identity: "id",
      fields: {
        id: "string",
        approvers: {
          type: { kind: "set", element: { kind: "ref", name: "User" } },
          documentation: "Effective approvers.",
        },
      },
    },
  },
  exports: {
    pull_request: { kind: "resource", type: { kind: "ref", name: "PullRequest" } },
    changes: {
      kind: "function",
      parameters: { pattern: { type: "glob", default: "**/*" } },
      returns: "core.ChangeSet",
      documentation: "Changed repository paths.",
    },
    team: {
      kind: "function",
      parameters: { slug: "string" },
      returns: { kind: "ref", name: "Team" },
    },
    check: {
      kind: "function",
      parameters: [
        { name: "name", type: "string" },
        { name: "producer", type: "string", optional: true },
      ],
      returns: "core.Check",
    },
  },
};

const example = `using "github@1" as Git

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
    optional
  {
    require some Git.pull_request.approvers in Git.team("platform").members
    require Git.check("schema-compatibility", "app:15368") passed
  }
}`;

test("lexer is lossless and tracks UTF-16 locations while recovering", () => {
  const source = `// 😀\r\npolicy "p\\u006flicy" { /* block\n comment */ value = -12.5e+2 @ }`;
  const result = lex(source);
  assert.equal(
    result.tokens
      .filter((token) => token.kind !== "EndOfFile")
      .map((token) => token.text)
      .join(""),
    source,
  );
  assert.equal(result.tokens.find((token) => token.kind === "String")?.value, "policy");
  assert.equal(result.tokens.find((token) => token.kind === "Number")?.value, -1250);
  const policy = result.tokens.find((token) => token.kind === "Policy");
  assert.deepEqual(policy?.span.start, { offset: 7, line: 1, column: 0 });
  assert.equal(result.diagnostics[0]?.code, "LEX_UNKNOWN_CHARACTER");

  const malformed = lex(`"bad\\x" /* open`);
  assert.deepEqual(
    malformed.diagnostics.map((diagnostic) => diagnostic.code),
    ["LEX_INVALID_STRING", "LEX_UNTERMINATED_COMMENT"],
  );
});

test("integer literals are limited to the exact Number safe-integer range", () => {
  const boundaries = lex("-9007199254740991 9007199254740991");
  assert.deepEqual(boundaries.diagnostics, []);
  assert.deepEqual(
    boundaries.tokens.filter((token) => token.kind === "Number").map((token) => token.value),
    [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  );

  for (const source of ["-9007199254740992", "9007199254740992", "9.007199254740992e15"]) {
    const result = lex(source);
    assert.equal(result.diagnostics[0]?.code, "LEX_INTEGER_OUT_OF_RANGE");
    assert.match(result.diagnostics[0]?.message ?? "", /-9007199254740991.*9007199254740991/);
    assert.equal(result.diagnostics[0]?.span.start.offset, 0);
    assert.equal(result.diagnostics[0]?.span.end.offset, source.length);
  }
});

test("parser accepts the complete grammar with optional semicolons", () => {
  const source = `policy "all" {
  values = Files("**/*");
  rule "operators" when not false and (true or false) optional {
		for each file in values {
			for each other in values { require file.path != other.path; }
			require file.path == "README.md"
			require file.path matches "**/*.md"
		};
    require some values in values
    require every values in values
    require no values in Files("none")
    require some values.{ path matches "**" }
    require every values.{ true }
    require no values.{ false }
	};
};`;
  const result = parse(source);
  assert.deepEqual(result.diagnostics, []);
  const policy = result.ast.policies[0];
  assert.equal(policy?.members.length, 2);
  const rule = policy?.members[1];
  assert.equal(rule?.kind, "RuleDeclaration");
  if (rule?.kind === "RuleDeclaration") {
    assert.equal(rule.optional, true);
    assert.equal(rule.statements.length, 7);
    assert.equal(rule.statements[0]?.kind, "ForEachStatement");
  }
});

test("example compiles to canonical typed IR", () => {
  const result = compile(example, [githubManifest]);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.ir.imports[0]?.provider, "github");
  assert.deepEqual(
    result.ir.policies[0]?.bindings.map((binding) => binding.type),
    ["Collection<Json>", "ChangeSet"],
  );
  assert.equal(result.ir.policies[0]?.rules.length, 3);
  assert.equal(result.ir.policies[0]?.rules[0]?.statements[0]?.kind, "for-each");
  assert.equal(result.ir.policies[0]?.rules[2]?.optional, true);
  assert.equal(result.ir.policies[0]?.rules[2]?.condition?.kind, "fold");
});

test("dynamic Json permits nested fields but static types stay strict", () => {
  const valid = compile(`policy "json" {
  records = Files("*.json").as(json)
  rule "nested" { require every records.{ metadata.owner.name matches "@*" } }
}`);
  assert.deepEqual(valid.diagnostics, []);

  const invalid = compile(
    `using "github@1" as Git
policy "bad" {
  x = Git.missing
  x = Git.team()
  rule "bad" { require Git.team("x").members matches "x" }
  rule "bad" { require unknown }
}`,
    [githubManifest],
  );
  const codes = invalid.diagnostics.map((diagnostic) => diagnostic.code);
  assert.ok(codes.includes("TYPE_UNKNOWN_MEMBER"));
  assert.ok(codes.includes("BIND_DUPLICATE_BINDING"));
  assert.ok(codes.includes("TYPE_ARGUMENT_COUNT"));
  assert.ok(codes.includes("TYPE_MISMATCH"));
  assert.ok(codes.includes("BIND_DUPLICATE_RULE"));
  assert.ok(codes.includes("BIND_UNKNOWN_NAME"));
});

test("provider source and manifest compatibility diagnostics are recoverable", () => {
  const result = compile(
    `using "github" as A
using "missing@1" as B
using "github@2" as C
policy "p" { rule "r" { require true } }`,
    [githubManifest],
  );
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ["BIND_INVALID_PROVIDER_SOURCE", "BIND_UNKNOWN_PROVIDER", "BIND_PROVIDER_VERSION_MISMATCH"],
  );

  const duplicate = compile(`using "github@1" as Git\npolicy "p" { rule "r" { require true } }`, [
    githubManifest,
    { ...githubManifest, version: "0.0.2" },
  ]);
  assert.equal(duplicate.diagnostics[0]?.code, "BIND_DUPLICATE_MANIFEST");
});

test("provider named types from distinct contract majors are relationally incompatible", () => {
  const githubV2: ProviderManifest = {
    ...githubManifest,
    version: "2.0.0",
    apiVersion: 2,
  };
  const result = compile(
    `using "github@1" as Git1
using "github@2" as Git2
policy "versions" {
  rule "incompatible" {
    require some Git1.pull_request.approvers in Git2.team("platform").members
  }
}`,
    [githubManifest, githubV2],
  );
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ["TYPE_INCOMPARABLE"],
  );
  const majors = result.analysis.expressions.flatMap((item) =>
    item.type.kind === "named" && item.type.provider === "github" ? [item.type.contractMajor] : [],
  );
  assert.ok(majors.includes(1));
  assert.ok(majors.includes(2));
});

test("completion, hover, and semantic tokens use static symbols", () => {
  const memberSource = `using "github@1" as Git\npolicy "p" { value = Git. }`;
  const completions = getCompletions(memberSource, memberSource.indexOf("Git.") + 4, [
    githubManifest,
  ]);
  assert.ok(completions.items.some((item) => item.label === "changes" && item.kind === "function"));
  assert.ok(
    completions.items.some((item) => item.label === "pull_request" && item.kind === "resource"),
  );

  const hoverOffset = example.indexOf("approvers") + 2;
  const hover = getHover(example, hoverOffset, [githubManifest]);
  assert.match(hover?.contents ?? "", /Set<github\.User>/);
  assert.match(hover?.contents ?? "", /Effective approvers/);

  const semantic = getSemanticTokens(example, [githubManifest]);
  assert.ok(semantic.some((token) => token.tokenType === "namespace"));
  assert.ok(semantic.some((token) => token.tokenType === "method"));
  assert.ok(semantic.some((token) => token.tokenType === "parameter"));
  assert.ok(semantic.some((token) => token.tokenType === "property"));
});

test("embedded GitHub editor metadata is identical to the production contract", () => {
  assert.deepEqual(
    canonicalPluginManifestSha256(editorGithubManifest),
    canonicalPluginManifestSha256(productionGithubManifest),
  );
});
