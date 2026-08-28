# Example Plugin

`manifest.ts` demonstrates SDK authoring and `manifest.json` is its canonical static output. `polici.lock` demonstrates the default lock name and v2 shape using deterministic fixture digests: the manifest digest is the canonical manifest SHA-256 and the artifact digest is SHA-256 of the literal UTF-8 bytes `example artifact\n`. Its path locator is relative to this lockfile. No corresponding executable is included, so this fixture MUST NOT be used for runtime execution.

For a real local plugin, put the executable at the manifest's `./runtime` entrypoint and, from the repository root, run `./dist/polici lock --file <policy> --plugin examples/plugin/manifest.json`. The CLI reads and hashes the exact adjacent artifact and writes the repository's selected `polici.lock`. Library hosts can use `createLockedPlugin` and `pluginLockfileJson`; see [Lockfiles](../../docs/lockfiles.md).
