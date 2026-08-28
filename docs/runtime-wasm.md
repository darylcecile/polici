# WASM/WASI Runtime Author Guide

Polici's WASM lane is a WASI Preview 1 core-module command with the same `polici.runtime/v1` stdin/stdout protocol as native runtimes. It is not a component and therefore has no WIT world. Resolver values remain canonical JSON so runtimes do not need language-specific component value bindings.

```json
{
  "kind": "wasm",
  "protocol": 1,
  "entrypoint": "./runtime.wasm",
  "transport": "jsonl",
  "capabilities": ["example:data"]
}
```

The entrypoint must be a safe package-relative `.wasm` path. Both JSONL and binary four-byte big-endian length-prefixed framing are implemented.

## Build

The language-neutral conformance fixture uses Zig's WASI libc so its import table is capability-minimal:

```console
pnpm run build:wasm-fixture
```

Hash the exact module bytes into `polici.lock`. Optimizer, linker, toolchain, or embedded timestamp changes that alter bytes require a lock update.

`pnpm run build:wasm-fixture` writes both the example module and `runtime.wasm.source.sha256`. That digest covers `wasm/runtime.c` and a versioned recipe prefix. `pnpm run test:runtime` refuses an artifact whose source digest is absent or stale; existence alone is not accepted.

## Command ABI

The selected runner must execute a Preview 1 core module exporting conventional `_start`. Before launch, Polici parses the module import and export sections. It permits only the documented command imports from `wasi_snapshot_preview1` for arguments, an empty environment, descriptor I/O/metadata, `path_readlink`, and process exit. Clock, random, socket, path-open, non-function, and non-WASI imports are rejected before the runner starts. Every process invocation:

- receives exactly one framed host message on stdin;
- writes exactly one framed runtime response on stdout;
- may write bounded diagnostics to stderr;
- exits with status 0 after flushing;
- receives an empty environment;
- receives no preopened directories, sockets, network grants, repository mount, or subprocess authority from Polici.

State between exchanges is serialized into the opaque continuation. Initialization occurs once per logical host, followed by multiple resolver calls and capability-result resumptions, then one shutdown. Process memory does not persist. Native and WASI hosts validate the same protocol, continuations, capabilities, deadlines, framing, and quotas.

`WasiProcessResolverHost` runs `wasmtime` by default with deterministic NaNs, deterministic relaxed SIMD, 100 million fuel units, 64 MiB linear-memory, 1 MiB stack, one memory/table/instance, and 100,000 table elements before the absolute module path. Module validation rejects multiple/unbounded memories and oversized tables before launch. Current host security rejects every caller-supplied `commandArguments` because arbitrary runner flags can grant host capabilities. The CLI's repeatable `--wasi-arg` therefore cannot be used successfully; choose a reviewed restricted runner executable with `--wasi-command` instead of injecting flags.

## Capabilities

WASI runtimes can activate grants and issue interactive `capability-call` messages exactly like native runtimes. The host broker remains outside the module, validates capability/operation/scope/quota/deadline, and returns a tagged `capability-result`. No credential is a protocol field.

The generic library host accepts a `CapabilityBroker`; the CLI currently supplies an unavailable broker for path plugins. Capability parity means the transport and host loop support the flow, not that the CLI grants arbitrary services.

## Portability

This plain command ABI can be implemented by Rust, Go, Zig, C/C++, TypeScript-to-WASM, or another WASI Preview 1 toolchain. A portable implementation needs no Polici language SDK: implement the [runtime protocol](runtime-protocol.md), tagged wire values, selected framing, and continuation lifecycle. A future component runtime would require a distinct manifest kind and host implementation; the removed Preview 2 WIT description was not the ABI implemented here.

[`examples/runtime/wasm/runtime.c`](../examples/runtime/wasm/runtime.c) implements the language-neutral command protocol without hidden nondeterministic imports. [`examples/runtime/cross-runtime-conformance.ts`](../examples/runtime/cross-runtime-conformance.ts) compares initialization, capability callbacks, result, and shutdown transcripts across the TypeScript-authored native runtime and WASI artifact.

Malformed frames/messages, replayed continuations, out-of-order capability sequences, undeclared operations, invalid values, nonzero exit, timeout/cancellation, and quota violations become exit-code-2 evaluation errors. Policy `optional` does not suppress them.
