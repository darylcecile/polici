# Polici

Polici is a typed, deterministic policy engine for repository snapshots and proposed changes. Its policy language owns matching, strict JSON parsing, iteration, quantification, equality, evidence, and diagnostics. Static plugin manifests add typed resources without extending the grammar, and the built-in GitHub provider supplies pinned pull request, changed-file, review, team, and check data.

The repository builds one native executable at `dist/polici`. It implements `check`, `validate`, `lock`, and an actual stdio language server.

The root npm package is a platform-neutral ESM library and metadata package. Its small `polici` launcher selects a separately installed, exact-version target package named `@polici/polici-<platform>-<arch>`; this clean split means package managers never try to install incompatible targets for library-only consumers. Release jobs publish Darwin arm64/x64 and glibc 2.36+ Linux arm64/x64 packages; every generated binary is inspected for its Mach-O/ELF architecture before its package metadata is written, so a host build cannot be mislabeled.

## Quickstart

Install dependencies, build the ScriptC executable, create the example lockfile, and evaluate the example snapshot:

```console
pnpm install
pnpm build
./dist/polici lock --repository examples --file policies/core.pol
./dist/polici check --repository examples --file policies/core.pol
```

Both commands use `examples/polici.lock`, because `--lockfile` defaults to `<repository>/polici.lock`. `lock` writes canonical lockfile v2 atomically; `check` never updates it. Use `./dist/polici lock --repository examples --file policies/core.pol --check` in CI to prove that the committed lock is current.

The core example checks strict JSON records without a provider:

```polici
policy "record fixtures" {
  records = Files("fixtures/records/**/*.json").as(json)

  rule "record IDs are unique" {
    for each record in records {
      require record.id unique in records.{ id }
    }
  }
}
```

[`examples/ci.pol`](examples/ci.pol) demonstrates `github@1` against the example fixture layout; its matching lock is [`examples/ci.polici.lock`](examples/ci.polici.lock). [`examples/policies/rename.pol`](examples/policies/rename.pol) uses [`examples/rename.polici.lock`](examples/rename.polici.lock). Checking either requires a pull request event, a checkout containing the event's exact base and head commits, and `GITHUB_TOKEN` or `GH_TOKEN`. See [CLI reference](docs/cli.md) and [GitHub provider](docs/github-provider.md).

## Architecture

```text
trusted policy + polici.lock + static manifests + exact artifacts
                              |
                    lexer / recovering parser
                              |
                  binder / type checker / IR
                              |
exact repository snapshot + alias-keyed resolver hosts
                              |
                           evaluator
                              |
policies / rules / requirements / evidence / diagnostics / exit code
```

- **Binary and library:** `pnpm build` uses ScriptC for the development `dist/polici` and TypeScript for the platform-neutral Node-compatible ESM library and declarations under `lib/`. Published native executables live only in separately installed target-constrained packages.
- **Core model:** immutable files, snapshots, materialized before/after changes, checks, strict JSON provenance, canonical collections, and SHA-256.
- **Language:** lossless tokens, parser recovery, lexical scopes, manifest-backed static types, lazy bindings, short-circuit operators, and bounded evaluation.
- **Plugin boundary:** `polici.plugin/v2` describes types, exports, resolver names, permissions, executable kind, transport, and documentation without loading runtime code.
- **TypeScript plugin SDK:** default-export `definePlugin(...)` contracts with `type.*`/`core.*` helpers and default-export `defineRuntime(plugin, { resolvers })` implementations; `polici-plugin build` emits canonical JSON and compiles the generated adapter with scriptc.
- **Integrity boundary:** `polici.lock/v2` binds every import to exact manifest and artifact digests. The CLI resolves local `--plugin` manifests and its embedded `github@1`; it does not fetch registry or URL sources.
- **Runtime boundary:** native TypeScript-authored executables and WASI commands share language-neutral `polici.runtime/v1`. Logical sessions are resumed through fresh continuation tokens across process exchanges and support brokered capability callbacks over JSONL or four-byte big-endian length-prefixed framing.
- **GitHub provider:** authentication stays in the host. Event coordinates, live PR identity, pagination, Git object hashes, before bytes, and the exact head snapshot are checked before evaluation.
- **LSP:** `polici lsp --stdio` provides push diagnostics, completion, hover, signature help, and full semantic tokens. It reads validated static metadata only and never executes plugin artifacts.

Evaluation is deterministic for fixed policy text, lock/manifests/artifacts, repository bytes, resolver responses, options, and limits. A network provider must establish an immutable input context; the included GitHub provider pins and revalidates event base/head coordinates.

## Documentation

- [Documentation map](docs/README.md)
- [Language reference](docs/language.md)
- [CLI reference](docs/cli.md)
- [Library API](docs/library-api.md)
- [Plugin SDK and manifest](docs/plugin-sdk.md)
- [Lockfiles](docs/lockfiles.md)
- [Runtime protocol](docs/runtime-protocol.md)
- [TypeScript runtime guide](docs/runtime-typescript.md)
- [WASM/WASI runtime guide](docs/runtime-wasm.md)
- [GitHub provider](docs/github-provider.md)
- [Security](docs/security.md)
- [Editor and LSP integration](docs/editors.md)

Machine-readable contracts are in [`schemas/`](schemas/). The VS Code client is in [`editors/vscode/`](editors/vscode/).

## Development

```console
pnpm build
pnpm test
pnpm typecheck
pnpm run lint
pnpm exec oxfmt --check README.md docs schemas examples editors/README.md
```

The scoped formatter command checks the documentation-owned surface. Package-wide `pnpm run fmt:check` also checks implementation and configuration files.
