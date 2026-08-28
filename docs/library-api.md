# Library API

`pnpm build` emits the native CLI and a Node-compatible ESM library with declarations under `lib/`. The package root exports the engine API; `polici/core`, `polici/language`, `polici/plugin`, `polici/plugin-sdk`, and `polici/github` expose the other public surfaces. Repository examples import source modules so they remain executable before a build.

## Engine

### `parsePolicy(source)`

Returns the lossless tokens, recovered AST, and lexer/parser diagnostics. It does not bind, type-check, inspect plugin integrity, read a repository, or execute a resolver.

### `compilePolicy(source, options?)`

```ts
interface CompilePolicyOptions {
  lockfile?: PluginLockfile;
  lockedPlugins?: readonly {
    lock: LockedPlugin;
    manifest: PluginManifest;
    artifact: Uint8Array;
  }[];
  trustedBuiltins?: readonly {
    manifest: PluginManifest;
    source: { kind: "builtin"; locator: string };
  }[];
}
```

Compilation validates supplied manifests/lock relationships, binds imports, type-checks, and emits typed IR without executing runtime code. Each `using "name@major"` must match exactly one integrity binding. A locked plugin requires an exact lock entry plus canonical manifest and artifact SHA-256. `trustedBuiltins` is an explicit digest-free host TCB escape hatch. Missing/ambiguous bindings produce `PROVIDER_LOCK_REQUIRED`; source with no policy produces `POLICY_NO_DECLARATION`.

`CompiledPolicy` contains source, tokens, AST, diagnostics, type analysis, IR, validated strict manifests, plugin-binding provenance, and an internal integrity digest. Compiler output is cloned and deeply frozen; `evaluatePolicy` rejects structural clones or post-compilation mutation.

### `evaluatePolicy(compiled, options)`

```ts
interface EvaluatePolicyOptions {
  repository: RepositorySnapshot;
  resolvers?: Readonly<Record<string, ResolverHost>>;
  providers?: Readonly<Record<string, ResolverHost>>;
  limits?: {
    files?: number;
    collectionItems?: number;
    resolverCalls?: number;
    evidence?: number;
  };
  signal?: AbortSignal;
  resolverTimeoutMs?: number;
}
```

`repository` is required. `resolvers` and `providers` are aliases and cannot both be supplied. Map keys are policy aliases: `using "github@1" as Git` needs `{ Git: host }`. Compilation errors return error/2 with no policies and no resolver execution. The evaluator does not dispose hosts; the embedder owns lifecycle.

Defaults are 10,000 files per selection, 10,000 collection items, 1,000 resolver calls for the evaluation, and 100 evidence records per rule. Limits are non-negative safe integers. The evaluator forwards cancellation and optional per-resolver timeout.

### `checkPolicy(source, options)`

Compiles and then evaluates using one `CheckPolicyOptions` object. Policy failures are returned, not thrown. Inspect `status` and `exitCode`.

### `adaptPluginManifest(manifest)`

Converts a strict v2 plugin manifest to language-only static metadata. It maps `contractMajor` to import API version and flattens documentation without loading a runtime.

## Repository Model

`src/core/index.ts` exports:

- `File`: copied immutable bytes, normalized non-root path, size, SHA-256, strict UTF-8 text, strict JSON parsing, equality, and base64 serialization.
- `RepositorySnapshot`: sorted duplicate-free immutable file set with canonical SHA-256, `get`, `has`, and glob `matching`.
- `Change`: `added`/`modified`/`deleted`/`renamed`, current `path`, rename `previousPath`, and legal materialized `before`/`after` files.
- `ChangeSet`: sorted duplicate-current-path changes, status filters, before/after collections, and non-deleted `.files(pattern)`.
- `Check`: normalized `missing`/`pending`/`passed`/`failed`/`cancelled` status and optional summary/URL.

`RepositorySnapshot.fromEntries` and `.fromFiles` avoid filesystem discovery. `snapshotRepositoryFiles(root, paths)` securely reads an explicit list. `scanRepository` skips symlinks and always omits `.git`/`node_modules`; `.gitignore` is used only with `useGitignore: true`. `scanLocalRepository` enables that subset. These library scanner semantics differ from the enforcement CLI scanner, which treats links/special entries as hard errors and ignores no files except `.git`/`node_modules`.

`normalizeRepositoryPath` converts separators, resolves safe `.`/`..`, and rejects absolute, drive-qualified, NUL, and root-escaping paths. `PoliciGlob` supplies anchored case-sensitive `*`/`**` matching.

## Resolver Hosts

```ts
interface ResolverHost {
  capabilities: readonly RuntimeCapability[];
  resolve(request: ResolverRequest, options?: ResolverCallOptions): Promise<WireValue>;
  dispose?(): void | Promise<void>;
}
```

`FunctionResolverHost` dispatches in-process functions and is appropriate for host-owned providers. `LazyMemoizingResolverHost` creates its host on demand and memoizes canonical identical requests only when no signal/per-call timeout is supplied; failures are evicted and disposal delegates. Both validate a closed `ResolverRequest` and every argument/subject wire value before dispatch; process hosts apply the same request validation before starting a runtime exchange.

### Process hosts

`TypeScriptProcessResolverHost` and `WasiProcessResolverHost` implement equivalent resumable command sessions. `WasmWasiProcessResolverHost` is an alias subclass. Shared options include:

```ts
interface ProcessRuntimeOptions {
  entrypoint: string;
  cwd: string;
  plugin: { name: string; version: string };
  timeoutMs?: number;
  transport?: "jsonl" | "length-prefixed";
  maxFrameBytes?: number;
  maxMessageBytes?: number;
  maxOutputBytes?: number;
  maxLogBytes?: number;
  maxContinuationBytes?: number;
  maxCapabilityCalls?: number;
  maxSessionExchanges?: number;
  capabilities?: readonly RuntimeCapability[];
  capabilityBroker?: CapabilityBroker;
  host?: { name: string; version: string };
}
```

Every exchange starts a process with empty environment, sends one byte-framed message, obtains one response, and carries logical state through a fresh continuation. Calls are queued, initialization is lazy/once, capability callbacks can resume a call repeatedly, and `dispose()` shuts down once. Defaults and failure rules are in [Runtime protocol](runtime-protocol.md).

Native options add runtime arguments and either `trustedRuntime: true` or an attested hardened sandbox launcher. WASI options add runner command and module arguments. Current WASI security rejects all non-empty runner `commandArguments`.

```ts
interface RuntimeCapability {
  name: string;
  operations: readonly string[];
  description?: string;
  scope?: WireValue;
  maxCalls?: number;
}

type CapabilityBroker = (
  request: CapabilityRequest,
) => Promise<{ ok: true; value: WireValue } | { ok: false; error: RuntimeError }>;
```

Constructing a process host with capabilities requires a broker. The host validates activation, operation, sequence, unique request ID, grant quota, deadline, returned envelope, and tagged value. The broker owns credentials; `scope` is explicitly non-secret policy metadata.

`encodeProtocolMessages` and `decodeProtocolMessages` implement JSONL and four-byte big-endian framing over `Uint8Array`. The decoder applies frame/message/count limits and strict UTF-8.

## Results

The complete machine contract is [`policy-report.schema.json`](../schemas/policy-report.schema.json). Top-level and policy status precedence is error, failed, passed. Exit codes are 2, 1, 0 respectively. Rules can also be skipped. Diagnostics contain code, message, severity, source, zero-based UTF-16 span, and optional related spans. Evidence can include JSON-compatible values, repository path, RFC 6901 pointer, and exact JSON source span.

Expected compilation/provider/evaluation faults are represented in results. Constructors, validation, malformed configuration, and direct resolver use may throw/reject. Consumers should key on diagnostic codes and display messages without parsing them.

## Canonical Data

`canonicalJson`/`canonicalStringify` sort object keys by locale-independent code-unit order, preserve array order, and normalize `-0`. The plugin-facing `canonicalStringify`, manifest serialization, and manifest hashing validate before serialization: only ordinary arrays and plain/null-prototype data records are accepted, and `undefined`, accessors, symbols, sparse/customized arrays, `Date`, custom prototypes, non-finite values, and cycles are rejected rather than omitted or coerced. Manifest/lock digests use canonical UTF-8 plus lowercase SHA-256. Wire values are closed tagged records; `wire.set` sorts and rejects duplicate values/entity identities, and byte values require canonical padded base64 including zero trailing bits.

Provider calls are manifest-driven. Function and entity-method arguments are encoded by ordered declaration, validated before host invocation, and results are validated after return. Entity methods and lazy direct entity set fields send the original entity wire value as `subject`. Core `File`, `Change`, `ChangeSet`, and `Check` results require canonical qualified types and identity namespaces, closed known fields, exact status values, canonical paths, legal change sides, and consistent side paths. Malformed provider data is an evaluation error with exit code 2; the evaluator does not normalize upstream aliases or states.

## Language and LSP APIs

`src/language/index.ts` exports lexer/parser/compiler/types plus static completion, hover, and semantic-token helpers. They accept UTF-16 offsets and static `ProviderManifest` values, never resolver hosts.

`src/lsp/server.ts` exports `LanguageServerSession`, `runLanguageServer`, and position conversion; `src/lsp/framing.ts` exports byte framing. The server adds signature help and offline integrity-checked plugin metadata. It can run over stdio or supplied synchronous byte I/O, which is useful for tests/embedders. See [Editors](editors.md).

## GitHub API

`providers/github/index.ts` exports direct `GitHubProvider`, context validators, `GitHubResolverHost`/factory, static manifest/capabilities, and `githubBuiltin`. The direct provider returns verified immutable change bytes; the resolver converts them to typed wire data and checks head bytes against the supplied snapshot. See [GitHub provider](github-provider.md).
