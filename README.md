# Polici

Polici is a typed policy engine for repositories and pull requests. It lets you express CI rules in a small, readable language and evaluates them against exact repository files, JSON data, proposed changes, GitHub reviews, teams, and status checks.

Policies produce structured diagnostics and evidence, so a failed check explains which rule failed and which files, values, users, or checks caused it.

## Install

Install the CLI globally:

```sh
npm install --global polici
polici --version
```

Or pin it in a repository:

```sh
npm install --save-dev polici@1.0.3
npx polici --version
```

Polici currently publishes native packages for:

- macOS arm64 and x64
- Linux arm64 and x64 with glibc 2.36 or newer

The JavaScript library remains platform-neutral and requires Node.js 20 or newer.

## Write A Policy

Create `ci.pol`:

```polici
policy "service records" {
  services = Files("data/services/**/*.json").as(json)

  rule "service IDs are unique" {
    for each service in services {
      require service.id unique in services.{ id }
    }
  }

  rule "every service has an owner" {
    require every services.{ owner != "" }
  }
}
```

Validate and run it:

```sh
polici lock --file ci.pol
polici validate --file ci.pol
polici check --file ci.pol
```

The generated `polici.lock` belongs in version control. `check` and `validate` never update it.

## Use Polici In GitHub Actions

Add `.github/workflows/polici.yml`:

```yaml
name: Polici

on:
  pull_request:

permissions:
  contents: read
  pull-requests: read
  checks: read
  statuses: read

jobs:
  policy:
    name: Policy
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          fetch-depth: 0
          persist-credentials: false

      - run: npm install --global --ignore-scripts polici@1.0.3

      - env:
          GITHUB_TOKEN: ${{ github.token }}
        run: polici check --repository . --file ci.pol --lockfile polici.lock
```

Polici reads `ci.pol`, `polici.lock`, and custom plugin artifacts from the exact trusted pull-request base commit. It evaluates the exact head tree and verifies GitHub event, repository, base, and head coordinates before running rules.

See the complete working repository at [darylcecile/polici-example](https://github.com/darylcecile/polici-example).

## Inspect Pull Requests

Import the built-in GitHub provider:

```polici
using "github@1" as Git

policy "pull request" {
  changes = Git.changes("**/*")

  rule "documentation-only area" {
    require every changes.{
      path matches "docs/**/*.md" or
      path matches "README.md"
    }
  }

  rule "required check passed" {
    require Git.check("build", "app:15368") passed
  }
}
```

The GitHub provider can expose:

- Exact added, modified, deleted, and renamed files
- Immutable before and after file content
- Pull-request metadata and pinned base/head commits
- Effective approvers using each reviewer's latest decisive review
- Complete organization team membership
- Check runs and commit statuses selected by immutable producer identity

After adding the import, update the lockfile:

```sh
polici lock --file ci.pol
```

## What Policies Can Do

Polici supports:

- Repository file selection with anchored `*` and `**` globs
- Strict JSON parsing with exact file paths and JSON Pointer evidence
- Local bindings, projections, and nested `for each` loops
- `some`, `every`, and `no` collection relations
- Unique-value constraints
- Boolean logic, equality, pattern matching, and check-state assertions
- Lazy provider resolution and short-circuit evaluation
- Optional rules for genuinely missing or null external data
- Human-readable and schema-backed JSON reports
- Deterministic exit codes: `0` passed, `1` policy failure, `2` error

For the complete syntax and semantics, see the [language reference](docs/language.md).

## Create A Custom Plugin

Install Polici in the plugin project:

```sh
npm install --save-dev polici@1.0.3
```

Define the contract in `plugins/ownership/plugin.ts`:

```ts
import { definePlugin, type } from "polici/plugin-sdk";

export default definePlugin({
  name: "ownership",
  version: "1.0.0",
  policiApi: 1,
  contractMajor: 1,
  exports: {
    approved: type.function({
      parameters: {
        owner: type.string({ enum: ["frontend", "platform"] }),
      },
      returns: type.boolean(),
      resolve: "approved",
    }),
  },
  runtime: {
    kind: "typescript",
    entrypoint: "./runtime.ts",
  },
});
```

Implement it in `plugins/ownership/runtime.ts`:

```ts
import { defineRuntime } from "polici/runtime-sdk";
import plugin from "./plugin.ts";

export default defineRuntime(plugin, {
  resolvers: {
    approved(_context, { owner }) {
      return owner === "frontend" || owner === "platform";
    },
  },
});
```

Build and lock it:

```sh
polici-plugin build plugins/ownership/plugin.ts \
  --no-manifest \
  --out plugins/ownership/runtime

polici lock \
  --file ci.pol \
  --plugin plugins/ownership/plugin.ts
```

`plugin.ts` is parsed as declarative static metadata during lock, check, validate, and editor operations; it is not executed. The generated canonical contract is verified against `polici.lock`. Native runtime artifacts are also exact-byte hash checked before execution.

Use the provider through its policy alias:

```polici
using "ownership@1" as Ownership

policy "ownership" {
  rule "platform is recognized" {
    require Ownership.approved("platform")
  }
}
```

Read the [plugin SDK guide](docs/plugin-sdk.md) for entities, lazy fields, methods, capabilities, native runtimes, and WASI runtimes.

## Use The JavaScript Library

The root package exports the policy engine:

```ts
import { checkPolicy } from "polici";
import { RepositorySnapshot } from "polici/core";

const result = await checkPolicy(`policy "example" { rule "always" { require true } }`, {
  repository: RepositorySnapshot.fromEntries([]),
});

console.log(result.exitCode, result.status);
```

Available exports include:

- `polici`: parse, compile, evaluate, and check APIs
- `polici/core`: repository, file, change, JSON, glob, and evidence types
- `polici/language`: parser, type checker, and editor helpers
- `polici/plugin-sdk`: typed static plugin contracts
- `polici/runtime-sdk`: typed runtime resolver definitions
- `polici/plugin`: lower-level manifest, lockfile, wire, protocol, and host APIs
- `polici/github`: first-party GitHub provider APIs

See the [library API guide](docs/library-api.md) for options and result types.

## VS Code

Install the `polici.polici-language` extension or recommend it from the repository:

```json
{
  "recommendations": ["polici.polici-language"]
}
```

The extension starts `polici lsp --stdio` and provides:

- Live parser and type diagnostics
- Completions for core values and locked provider contracts
- Hover documentation
- Function and method signature help
- Semantic syntax highlighting

The LSP reads static, lock-verified plugin contracts and never executes plugin runtimes.

## Commands

```text
polici lock      Create or verify polici.lock
polici validate  Parse and type-check without executing providers
polici check     Evaluate every policy rule and produce evidence
polici lsp       Start the language server over stdio
polici-plugin    Build TypeScript-authored custom plugins
```

Use `polici --help` or read the [CLI reference](docs/cli.md) for all options and output formats.

## More Documentation

- [Project and contributor guide](GUIDE.md)
- [Documentation map](docs/README.md)
- [Language reference](docs/language.md)
- [CLI reference](docs/cli.md)
- [Library API](docs/library-api.md)
- [Plugin SDK](docs/plugin-sdk.md)
- [GitHub provider](docs/github-provider.md)
- [Security model](docs/security.md)
- [Editor and LSP integration](docs/editors.md)
