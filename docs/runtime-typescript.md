# TypeScript Runtime Author Guide

A manifest runtime with `kind: "typescript"` denotes a TypeScript-authored runtime compiled to a native executable before Polici loads it. The v2 manifest rejects `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.mts`, and `.cts` entrypoints. Polici does not execute provider source through Node.js or `tsx`.

## Build

The repository uses ScriptC:

```console
pnpm exec scriptc build examples/runtime/typescript/runtime.ts -o examples/runtime/typescript/runtime
```

Hash the exact executable bytes into `polici.lock`. A typical manifest uses `entrypoint: "./runtime"`; rebuilds that alter bytes require a reviewed lock update. Both `jsonl` and `length-prefixed` transports are implemented.

[`examples/runtime/typescript/runtime.ts`](../examples/runtime/typescript/runtime.ts) is a standalone language-neutral-contract fixture. It supports `--length-prefixed`, fresh encoded continuation state, repeated logical calls, and interactive broker callbacks.

## Exchange Contract

Polici resolves `cwd + entrypoint` to an executable. Every logical protocol exchange starts a fresh process with an empty environment, writes one framed host message to stdin, reads one framed response from stdout, applies wall-clock/output/log bounds, and requires exit status 0. Stderr is counted across the resolver operation and included in nonzero-exit errors; stdout must contain protocol only.

The runtime must:

1. Read exactly one frame in the manifest-selected transport.
2. Validate protocol, type, IDs, current continuation, deadline, resolver, and tagged arguments.
3. Reconstruct bounded logical state from the continuation rather than process memory.
4. Return the exact locked implementation name/version during initialization.
5. Activate only grants it may call.
6. Return exactly one `result`, `error`, `capability-call`, `initialized`, or `stopped` response as appropriate.
7. Use a fresh continuation for every state-bearing response, flush stdout, and exit 0.

The host serializes calls, initializes once, may make multiple resolver calls, loops through any number permitted by `maxCapabilityCalls`, and shuts down once. See [Runtime protocol](runtime-protocol.md).

## Trust and Sandbox

`TypeScriptProcessResolverHost` refuses to start unless one condition is explicit:

- `trustedRuntime: true` makes the executable part of the host trusted computing base.
- `sandbox` names a host-controlled launcher and sets `denyNetwork`, `denyFilesystem`, `denyEnvironment`, and `denyChildProcess` to literal `true`.

These booleans are attestations, not enforcement. The launcher and arguments must actually establish a deny-by-default OS boundary. Invocation is:

```text
sandbox-launcher [launcher arguments...] absolute-runtime [runtime arguments...]
```

The runtime environment is always empty in the current process host, including for trusted runtimes. Executable lookup may use the parent host's `PATH` before launch, but that environment is not inherited by the child. A sandbox may need narrowly controlled access to the materialized executable itself; it must not expose arbitrary host files or the repository.

In the CLI, `--trust-plugin name@major` selects the first condition. Otherwise `--sandbox-launcher` and repeatable `--sandbox-arg` select the second.

## Capabilities

Initialization grants name, allowed operations, optional description, non-secret scope, and optional per-session call quota. A runtime lists activated capability names in `initialized`, then requests an operation with ordered `capability-call` messages. It never receives API tokens; the in-process broker owns credentials and returns only a tagged result/error.

The library host supports a real `CapabilityBroker`. The CLI currently gives generic path plugins an unavailable broker, so a capability attempt fails with `CAPABILITY_NOT_CONFIGURED`. Do not interpret a manifest capability declaration as proof that the standalone CLI supplies that service.

## Packaging Checklist

- A validated canonical `polici.plugin/v2` manifest is readable without execution.
- The `./`-relative entrypoint is traversal-free, executable, and has no source suffix.
- Exact artifact and canonical manifest hashes match `polici.lock`.
- Runtime identity equals the manifest exactly.
- Both selected framing and strict UTF-8 are implemented byte-for-byte.
- Continuations are bounded, fresh, non-secret, and sufficient to resume all logical state.
- Resolver and capability results use valid tagged values and canonical sets.
- stdout contains one response only; stderr and output are bounded by Polici, and CPU/memory are bounded by the trusted OS sandbox or process supervisor selected by the host.
- The host either fully trusts the executable or supplies a genuine hardened sandbox.
