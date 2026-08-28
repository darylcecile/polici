# Deterministic Plugin Lockfiles

Policy imports select a provider contract major, not an implementation artifact:

```polici
using "github@1" as Git
```

Every CLI import is bound by `polici.lock/v2` to an exact source coordinate, static manifest, artifact, and runtime metadata. The default filename is `polici.lock`.

## CLI Workflow

Create or intentionally update a lock:

```console
./dist/polici lock --file ci.pol
./dist/polici lock --file ci.pol --plugin plugins/example/plugin.ts
```

Verify the committed bytes in CI:

```console
./dist/polici lock --file ci.pol --plugin plugins/example/plugin.ts --check
./dist/polici validate --file ci.pol
./dist/polici check --file ci.pol
```

`lock` parses all imports, chooses exactly one implementation for each distinct `(name, contractMajor)`, parses a declarative `plugin.ts` contract in memory without executing it (or accepts canonical JSON), reads the adjacent runtime artifact named by the contract, hashes exact bytes, validates compilation, sorts/canonicalizes content, and atomically replaces the target. Stale entries are removed. `--check` performs the same resolution but requires the existing file to equal canonical output byte-for-byte.

Implemented CLI resolvers are:

- `github@1`, built into `dist/polici` at locator `polici:provider:github@1.0.0` with deterministic embedded artifact bytes;
- repeatable local `--plugin <plugin.ts>` or `<manifest.json>` inputs, recorded as `source.kind: "path"` with a locator relative to the lockfile directory. Source contracts are preferred and remove generated manifests from version control.

There is no implemented package-range, registry, or URL fetch. `registry` and `url` are valid schema/library source identities for an embedding host that supplies exact verified bytes, but the native CLI rejects them while loading. It will not silently resolve an unsupported source during check.

## Shape

The schema is [`plugin-lock.schema.json`](../schemas/plugin-lock.schema.json):

```json
{
  "schema": "polici.lock/v2",
  "schemaVersion": 2,
  "plugins": [
    {
      "name": "example",
      "version": "1.0.0",
      "contractMajor": 1,
      "source": {
        "kind": "path",
        "locator": "plugins/example/plugin.ts"
      },
      "manifest": {
        "algorithm": "sha256",
        "value": "0000000000000000000000000000000000000000000000000000000000000000"
      },
      "artifact": {
        "algorithm": "sha256",
        "value": "0000000000000000000000000000000000000000000000000000000000000000"
      },
      "runtime": {
        "kind": "typescript",
        "protocol": 1,
        "entrypoint": "./runtime",
        "transport": "jsonl",
        "capabilities": ["example:users:read"]
      }
    }
  ]
}
```

`source.kind` is `registry`, `url`, `path`, or `builtin`. A locator is a non-empty printable exact coordinate; core library validation records but does not prove its immutability. Digests are lowercase 64-character SHA-256. Runtime protocol is a positive safe integer, although the current manifest contract emits protocol 1. Runtime entrypoints are safe package-relative paths and WASM entries end in `.wasm`; integrity comparison with the manifest also enforces the manifest's native source-suffix rule. At most one entry may use a given `(name, contractMajor)`. Unknown properties are rejected.

A CLI path locator has stricter semantics: it is relative to the lockfile's directory, uses `/`, contains no absolute/drive prefix, control character, empty segment, `.` segment, or `..` traversal. The resolved manifest and its artifact must remain within the trusted repository revision.

## Canonical Form

`canonicalPluginLockfile` validates and then sorts entries by:

1. Name in locale-independent UTF-16/code-unit order.
2. Numeric `contractMajor`.
3. `source.locator` in code-unit order.

It also sorts each runtime capability list. `pluginLockfileJson` recursively sorts object keys, preserves array order, normalizes `-0` to `0`, and emits one JSON line with a final newline. Canonicalization copies top-level/plugin/source/runtime records but does not promise deep freezing through this API.

## Integrity

`canonicalPluginManifestSha256(manifest)` hashes UTF-8 canonical manifest JSON without a final newline. `pluginArtifactSha256(bytes)` hashes exact artifact bytes. `createLockedPlugin({source, manifest, artifact})` derives the complete entry.

`assertLockedPluginIntegrity` verifies:

- name, exact semantic version, and contract major;
- runtime kind, protocol, entrypoint, transport, and capability set;
- canonical manifest SHA-256;
- exact artifact SHA-256.

During library compilation, each supplied `LockedPluginInput.lock` must occur exactly once in the validated lockfile with matching identity, source kind/locator, metadata, and digests. CLI loading additionally requires lock entries to match policy imports exactly: missing, additional, stale, or ambiguous entries are errors with advice to run `polici lock`.

The CLI verifies all bytes before external artifact materialization. For source contracts, the generated in-memory canonical manifest must match the lock manifest digest. In pull-request mode, policy, lock, local contracts, and artifacts come from the exact event base commit while the evaluated repository snapshot comes from the exact event head commit.

## Library Hosts

An embedding host can acquire exact immutable artifacts itself:

1. Resolve and fetch a reviewed exact source with bounded I/O.
2. Parse/validate its `polici.plugin/v2` manifest.
3. Confirm the intended policy provider and contract major.
4. Create a lock entry from the exact source, manifest, and artifact.
5. Review and persist complete canonical lock content.
6. On evaluation, acquire those exact bytes again and pass `{lockfile, lockedPlugins}` to `compilePolicy`/`checkPolicy`.
7. Construct runtime hosts from the same verified artifacts and locked runtime metadata.

`trustedBuiltins` is a library escape hatch for code already in the host TCB. The CLI does not use that digest-free route: it creates and verifies a deterministic lock entry for its built-in GitHub implementation.

Malformed lockfiles, changed manifests/artifacts, and unresolved sources fail with exit 2. SHA-256 proves equality with reviewed bytes, not publisher identity, safety, provenance, or sandboxing.
