# Example Plugin

`plugin.ts` is the source contract. It default-exports `definePlugin(...)`, uses `type.*` and `core.*` helpers, and uses object-shaped named parameters. `runtime.ts` default-exports `defineRuntime(plugin, { resolvers })`; resolver arguments are inferred from the contract and protocol framing is SDK-owned.

Generate the static contract and native runtime together:

```console
polici-plugin build examples/plugin/plugin.ts --no-manifest
```

The command imports the default-exported contract and runtime definitions, generates the protocol bootstrap internally, and compiles the artifact with scriptc. `polici lock --plugin examples/plugin/plugin.ts` and the LSP parse the declarative contract in memory without executing it, so no generated manifest needs to be committed.

`polici.lock` demonstrates the lock v2 shape using deterministic fixture digests. For a real policy, run `polici lock --file <policy> --plugin examples/plugin/plugin.ts` after building.
