# WASM/WASI Runtime Example

Polici implements a WASI Preview 1 core-command ABI over stdin/stdout. It is not a Preview 2 component and has no WIT world; resolver calls remain canonical `polici.runtime/v1` JSON frames. `runtime.c` is a language-neutral conformance provider with no clock, random, socket, or path-opening imports. It implements the same success, missing, capability, lifecycle, and shutdown semantics exercised by the TypeScript-authored native fixture.

## Build

```console
pnpm run build:wasm-fixture
```

The build records the C source and artifact digests in `runtime.wasm.source.sha256`; tests reject stale bytes. The host starts every exchange with an empty environment and no preopened directories, sockets, network access, or subprocess grants. The module uses only the permitted `wasi_snapshot_preview1` descriptor I/O and process-exit ABI and exports `_start`.

## Command ABI

Each command invocation reads exactly one host message from stdin, writes exactly one runtime message to stdout, flushes it, and exits with status 0. Diagnostics may use stderr within the host's log quota. Runtime state never uses files or environment variables; it is serialized into the opaque, bounded `continuation` returned to the host.

JSONL is the default: one UTF-8 JSON object followed by byte `0A`. With `--length-prefixed` after the module path, each exchange is a four-byte unsigned big-endian payload length followed by that many UTF-8 JSON bytes. The selected transport is fixed for the entire logical session.

Every message has `protocol: "polici.runtime/v1"`, a `type`, and an ID. The logical sequence is:

1. Host `initialize` includes host/plugin identity, effective capability grants, non-secret scopes, operation names, and quotas. Runtime returns `initialized` with exact plugin identity, activated capability names, and a fresh continuation.
2. Host `call` includes resolver, tagged wire arguments, optional tagged subject, the latest continuation, and an absolute Unix-millisecond deadline.
3. Runtime returns `result`/`error`, or `capability-call` with the call ID, unique request ID, one-based sequence, activated capability, declared operation, tagged arguments, optional tighter deadline, and a fresh continuation.
4. Host validates declaration, activation, operation, order, quota, scope, and deadline before invoking its in-process broker. It returns `capability-result` with the same call ID, request ID, sequence, latest continuation, and exactly one tagged result or structured error. Steps 3-4 may repeat.
5. Runtime eventually returns `result` or `error` with a fresh continuation. The host may lazily issue more resolver calls using it.
6. Host sends one `shutdown` with the latest accepted continuation. Runtime returns `stopped` and retains no state.

Credentials and privileged data are never protocol fields. They remain inside the host broker. Capability and resolver values use the normalized tagged wire representation validated by Polici.

`cross-runtime-conformance.ts` accepts native-runtime, wasmtime, and wasm-runtime paths and asserts byte-equivalent parsed transcripts across initialization, two capability callbacks, result, and shutdown.
