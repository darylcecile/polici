# Editor Assets

[`vscode/`](vscode/) is a Visual Studio Code extension for `.pol` files. It preserves the TextMate grammar, language configuration, and snippets and starts the Polici Language Server for diagnostics and language features.

Build the root native executable first, then install and compile the client:

```console
pnpm build
pnpm --dir editors/vscode install
pnpm --dir editors/vscode run compile
pnpm --dir editors/vscode run package
```

Open `editors/vscode` in VS Code and launch an Extension Development Host. The client starts `polici lsp --stdio` by default; while developing this checkout, set `polici.binary` to the absolute root `dist/polici` path. `polici.args` configures another argument list.

External plugin metadata is loaded offline from an integrity-checked lockfile and static manifest cache. The embedded GitHub manifest requires no external cache; runtime artifacts are never loaded by the language server.

The extension entrypoint is bundled with esbuild. The VSIX therefore includes `vscode-languageclient` and its production dependencies inside `dist/extension.js`; it does not depend on a packaged `node_modules` tree.

Automatic discovery uses `polici.lock` and falls back to the legacy `polici.lock.json` name. `polici.lockFile` selects another explicit path. `polici.manifestCache`, `polici.manifests`, and `polici.maxManifestBytes` control bounded offline static metadata discovery. The server provides diagnostics, completion, hover, signature help, and full semantic tokens.
