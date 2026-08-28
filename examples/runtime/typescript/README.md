# TypeScript Runtime Example

`runtime.ts` is a resumable `polici.runtime/v1` command runtime. Compile it to a native executable before use:

```console
pnpm exec scriptc build examples/runtime/typescript/runtime.ts -o examples/runtime/typescript/runtime
```

The native runtime must be marked fully trusted or launched through a real hardened sandbox. Each process invocation reads one framed message from stdin and emits one framed response. The opaque continuation carries non-secret runtime state between invocations, allowing one logical initialization, multiple lazy resolver calls, any number of capability callbacks, and one shutdown despite `scriptc` not lowering piped child stdin in the host build.

JSONL is the default. Pass `--length-prefixed` to use four-byte big-endian length framing. The fixture activates `example:data` when granted and implements success, missing, capability, permission, timeout, invalid-result, quota, lifecycle, and multiple-call cases for conformance testing. Capability arguments and results are tagged wire values; no credential enters the runtime.
