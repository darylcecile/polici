# CLI Reference

`pnpm build` compiles `src/cli/main.ts` with ScriptC and writes the development executable `dist/polici`. The published root package maps `polici` to a platform-neutral Node launcher that resolves the exact `@polici/polici-<platform>-<arch>` native package. Install that target package beside `polici` when using the CLI; it is deliberately a clean package split rather than a root dependency, so library-only consumers need no native package and package managers never fetch incompatible targets.

Native executables are target-specific; the ESM library is not. Maintainers use `pnpm run build:native-packages <os>-<cpu>` with Zig for Darwin arm64/x64 and glibc 2.36+ Linux arm64/x64 packages. Linux packages are not compatible with musl or older glibc. Each package declares exactly one `os` and `cpu`, and staging rejects a binary whose Mach-O/ELF header disagrees. The root package has no `os`/`cpu` restriction, so importing its ESM API works independently of native CLI availability.

```text
Usage: polici <command> [options]
```

`--help`/`-h` prints help and `--version`/`-v` prints `polici 1.0.3`; neither requires a command. Argument/configuration errors return 2 and write an error plus help to stderr. If either flag is present, it takes precedence over normal required-command/file validation; help is handled before version when both are present.

## Commands

### `check`

```console
polici check --file <policy> [options]
```

Loads trusted policy, `polici.lock`, locked manifests and artifacts; compiles; constructs an exact repository snapshot; initializes resolver hosts; evaluates every policy; disposes runtime hosts; renders the result; and exits with its result code. It never edits the lockfile.

For a local snapshot:

```console
./dist/polici check --repository examples --file policies/core.pol
```

For a GitHub pull request:

```console
GITHUB_TOKEN=... ./dist/polici check --file ci.pol --github-event "$GITHUB_EVENT_PATH"
```

An imported `github@1` requires pull-request mode and `GITHUB_TOKEN` or `GH_TOKEN`. `GITHUB_API_URL` overrides the default REST API base. In GitHub Actions, automatic pull-request mode uses `GITHUB_EVENT_PATH` only when `GITHUB_EVENT_NAME` is `pull_request` or `pull_request_target`; push and other workflows remain local unless `--github-event` is explicit. The same selection applies to `validate`.

### `validate`

```console
polici validate --file <policy> [options]
```

Reads and validates policy, lockfile, static manifests, exact artifact digests, imports, binding, and types. It does not snapshot repository contents, create runtime hosts, call providers, or evaluate rules. The result has no policies: status `passed`/exit 0 when compilation is clean, otherwise `error`/exit 2.

In pull-request mode, validation reads policy, lockfile, path manifests, and artifacts from the event's trusted base commit.

### `lock`

```console
polici lock --file <policy> [--plugin <plugin.ts|manifest.json> ...] [options]
```

Parses imports, resolves exact implemented sources, validates and hashes manifests/artifacts, compiles against those manifests, and atomically writes canonical `polici.lock/v2`. The output contains exactly one entry per distinct imported `(name, contractMajor)` and removes stale entries.

Implemented resolution is intentionally limited:

- `github@1` resolves to the provider embedded in this host, locator `polici:provider:github@1.0.0`.
- Each repeatable `--plugin` supplies a local manifest. Its runtime entrypoint selects the adjacent artifact bytes. The path locator is relative to the lockfile directory and cannot traverse upward.
- Every non-GitHub import must match exactly one supplied manifest. Supplying the same coordinate twice is an error.
- Registry and URL source kinds are representable in lock schema/library APIs but the CLI does not fetch or update them.

`--check` is valid only with `lock`. It computes canonical current content and returns 0 only if the existing lockfile bytes match exactly:

```console
polici lock --file ci.pol --plugin plugins/a/plugin.ts --check
```

Without `--check`, the writer uses a private same-directory temporary file, mode `0600`, and atomic rename. With `--format json`, stdout is the canonical lock JSON, not a policy report; frozen mode prints the same JSON after successful verification. Locking a trusted event revision is rejected; create lock updates in a reviewed working tree.

### `lsp`

```console
polici lsp --stdio
```

Starts the blocking JSON-RPC Language Server Protocol implementation on stdin/stdout. `--stdio` is optional because stdio is the only transport; any other LSP argument is rejected. In the native executable, `lsp` must be the first argument. The native LSP branch accepts no common CLI options, including `--help` or `--version`; use top-level `polici --help`/`--version` instead. See [Editors](editors.md).

Input is read in bounded 64 KiB chunks and each chunk is processed immediately. Responses, including `initialize`, are written while stdin remains open. `exit` after `shutdown` returns 0; `exit` before `shutdown` returns 1.

## Options

| Option                        | Commands              | Behavior                                                                                                                                      |
| ----------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `--file <path>`               | check, validate, lock | Required policy path inside the repository.                                                                                                   |
| `--repository <path>`         | check, validate, lock | Repository root; default current directory. The root must be a non-symlink directory.                                                         |
| `--lockfile <path>`           | check, validate, lock | Path inside the repository; default `<repository>/polici.lock`.                                                                               |
| `--format human\|json`        | check, validate, lock | Output form; default `human`. Lock JSON is lock content.                                                                                      |
| `--offline`                   | check                 | Rejects built-in GitHub and explicitly trusted native runtimes. Sandboxed native/WASI isolation remains separately enforced.                  |
| `--github-event [path]`       | check, validate       | Enables pull-request mode. With no value, reads `GITHUB_EVENT_PATH`.                                                                          |
| `--plugin <path>`             | lock                  | Repeatable local `polici.plugin/v2` manifest.                                                                                                 |
| `--check`                     | lock                  | Verify existing canonical lock bytes instead of writing.                                                                                      |
| `--trust-plugin <name@major>` | check                 | Repeatable TCB opt-in for a verified TypeScript-authored native runtime.                                                                      |
| `--sandbox-launcher <path>`   | check                 | Hardened launcher for native runtimes not explicitly trusted.                                                                                 |
| `--sandbox-arg <value>`       | check                 | Repeatable launcher argument inserted before the runtime executable.                                                                          |
| `--wasi-command <path>`       | check                 | WASI runner; default `wasmtime`.                                                                                                              |
| `--wasi-arg <value>`          | check                 | Accepted by the parser, but current secure host policy rejects every non-empty WASI runner argument because it could grant host capabilities. |

Value options accept `--name value` or `--name=value`. `--github-event` is the only optional-value option. Single-valued options reject duplicates; repeatable options preserve order. `--plugin` outside `lock` and `--check` outside `lock` are argument errors.

`--offline` is accepted but has no operational work to forbid during `validate` or `lock`. Trust/sandbox/WASI runtime options are also accepted by those commands but inert because neither starts a runtime. `--trust-plugin` selectors are nevertheless preflight-validated during `check`, even when an imported provider is not ultimately used by a rule. `--github-event` affects `validate` and is rejected for `lock`.

## Trusted Inputs

Local mode reads policy, lock, local manifests, and artifacts from the canonical repository root with repeated no-symlink checks. UTF-8 source/lock/manifest files are capped at 4 MiB; artifacts are capped at 256 MiB.

Local `check` scans all regular files recursively except any `.git` and `node_modules` trees. It does not interpret `.gitignore` or other ignore files. Symlinks and special entries are errors, not omissions. Limits are 100,000 files, 64 MiB per file, and 1 GiB total.

Pull-request mode derives exact base/head commits and head repository from event JSON. Policy, lockfile, path manifests, and artifacts are read with `git` from the exact base commit; the evaluated snapshot is the exact head tree. Full 40/64-character object IDs are required. Symlinks, submodules, and unsupported Git modes fail closed. The checkout/object database must contain both commits. The event file itself must be a regular non-symlink UTF-8 file.

## Plugin Execution

All lock metadata and SHA-256 digests are verified before materialization. Exact artifacts are copied to private temporary directories and removed after evaluation.

- TypeScript-authored native executables require either matching `--trust-plugin name@major` or a `--sandbox-launcher` that genuinely denies network, arbitrary filesystem, environment, and child processes.
- WASI artifacts use the selected runner with no runner arguments and an empty environment.
- Generic CLI plugins receive manifest-declared capability grants but the CLI currently configures an unavailable broker. Interactive calls receive `CAPABILITY_NOT_CONFIGURED`; embedders can provide a real broker through the library API.
- The built-in GitHub provider runs in the host and owns its token; it is not launched as an external artifact.

## Output

`--format json` on `check` and `validate` writes one compact JSON result plus newline to stdout. Its schema is [`policy-report.schema.json`](../schemas/policy-report.schema.json). Operational failures after argument parsing write a message to stderr and, in JSON mode, also emit an error report with diagnostic code `CLI_ERROR` on stdout. Argument-parser errors produce stderr/help only because no valid output format has been established.

Human output starts with `Policy <status> (exit <code>)`, then diagnostics and policy/rule/requirement/evidence lines. Locations are displayed as one-based `path:line:column`; JSON spans remain zero-based UTF-16.

## Exit Codes

| Code | Status   | Meaning                                                                                                       |
| ---- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `0`  | `passed` | Compilation succeeded and all evaluated non-skipped requirements passed. Lock/LSP command completed.          |
| `1`  | `failed` | At least one policy requirement failed and no policy errored; LSP also uses 1 for `exit` before `shutdown`.   |
| `2`  | `error`  | Arguments, I/O, compilation, integrity, provider, permission, protocol, sandbox, limit, or evaluation failed. |

Errors outrank failures, which outrank passes. Automation must use the process exit code or JSON `exitCode`, not parse human text.
