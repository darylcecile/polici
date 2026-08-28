# TypeScript Runtime Example

`runtime.ts` is a low-level resumable `polici.runtime/v1` conformance fixture. Normal plugins should default-export `defineRuntime(plugin, { resolvers })` as shown in [`examples/plugin/runtime.ts`](../../plugin/runtime.ts), then build through `polici-plugin`:

```console
polici-plugin build examples/plugin/plugin.ts
```

`polici-plugin` generates the protocol bootstrap and uses scriptc internally. The native runtime must still be marked fully trusted or launched through a real hardened sandbox. The SDK adapter owns framing, continuation state, primitive value conversion, resolver errors, and capability replay.

JSONL is the default. Pass `--length-prefixed` to use four-byte big-endian length framing. The fixture activates `example:data` when granted and implements success, missing, capability, permission, timeout, invalid-result, quota, lifecycle, and multiple-call cases for conformance testing. Capability arguments and results are tagged wire values; no credential enters the runtime.
