# Editor and LSP Integration

Polici ships a real blocking stdio language server in the native executable and a VS Code client in [`editors/vscode`](../editors/vscode). All semantic features use policy text plus validated static manifests. The LSP never loads or executes plugin artifacts and makes no network requests.

## Start the Server

```console
./dist/polici lsp --stdio
```

Stdio is the only LSP transport. `--stdio` is accepted and optional; any other native LSP argument exits 2. Messages use JSON-RPC 2.0 with standard `Content-Length: <bytes>\r\n\r\n` framing and strict UTF-8 bodies.

Defaults are an 8 MiB message body limit, 8 KiB header limit, and 64 KiB read buffer. The framer accepts arbitrary chunk boundaries and multiple frames. It requires exactly one valid Content-Length, discards oversized bodies, reports parse/invalid-request errors, and diagnoses incomplete EOF.

## Advertised Capabilities

Initialization returns UTF-16 positions and:

```json
{
  "positionEncoding": "utf-16",
  "textDocumentSync": { "openClose": true, "change": 1 },
  "completionProvider": { "triggerCharacters": ["."] },
  "hoverProvider": true,
  "signatureHelpProvider": {
    "triggerCharacters": ["(", ","],
    "retriggerCharacters": [","]
  },
  "semanticTokensProvider": {
    "legend": {
      "tokenTypes": [
        "comment",
        "string",
        "number",
        "keyword",
        "operator",
        "namespace",
        "function",
        "method",
        "property",
        "variable",
        "parameter"
      ],
      "tokenModifiers": ["declaration", "readonly"]
    },
    "full": true
  },
  "workspace": {
    "workspaceFolders": { "supported": true, "changeNotifications": true }
  }
}
```

The server supports full-text `didOpen`, `didChange`, and `didClose`; workspace folder/configuration/watched-file changes; request cancellation observed before dispatch; orderly `shutdown`/`exit`; and JSON-RPC method errors. It does not advertise incremental edits, completion resolve, definitions/references/rename, formatting, code actions, semantic token ranges/deltas, or dynamic registration.

## Diagnostics

Diagnostics are pushed on open/full change and republished after manifest configuration, workspace-folder, or watched-file changes. Close publishes an empty list.

- Complete static metadata produces lexer/parser/core binder/type diagnostics plus unknown top-level provider member and provider argument-count diagnostics. Full manifest result-field checking remains the `validate` command's responsibility.
- Missing/invalid static metadata degrades to parser diagnostics plus an `LSP_*` manifest problem rather than treating unverified metadata as authoritative.
- Ranges and related information are zero-based UTF-16; severities map to LSP error/warning/information.
- Diagnostic sources are `polici-lexer`, `polici-parser`, `polici-binder`, or `polici-type`.

## Completion, Hover, and Signatures

Completion includes core globals/keywords, active bindings and loop variables, core projection fields, provider aliases, verified provider exports, and fields or methods of provider-returned entities inferred from the static manifest. Member completion after `.` is prefix-filtered case-insensitively and includes static signature/detail, Markdown documentation, insertion text, and replacement edit. Provider function and method insertion appends `(`. No completion-resolve request is used.

Hover returns static types/signatures and documentation for core declarations/references, provider aliases, and top-level provider exports. It returns `null` where no static item is available.

Signature help recognizes recovered call syntax, reports one signature, computes the active comma-delimited parameter, and includes parameter names/types, optional markers, defaults, and documentation. It is available only when all imported plugin metadata is complete.

## Semantic Tokens

`textDocument/semanticTokens/full` combines lexical and resolved static classifications and returns standard five-integer delta encoding. Token index is the order in the advertised legend; modifier bit 0 is `declaration`, bit 1 is `readonly`. Multiline lexical tokens are split per line. Provider aliases are namespaces, functions are functions, resources/fields are properties, bindings are variables, and loop locals are parameters.

## Static Manifest Resolution

The embedded `github@1` static manifest requires no file. Every other `using "name@major"` is resolved offline:

1. Find exactly one matching entry in lockfile v2.
2. Read candidate `manifest.json` files only, with a default 4 MiB limit.
3. Validate manifest v2, exact name/version/major/runtime metadata, and canonical manifest SHA-256 from the lock.
4. Normalize only static types/exports/documentation into LSP-owned data.

Runtime artifacts are never read or executed. A path lock source is searched relative to workspace/lock locations. Static manifests may also come from configured explicit paths or cache directories.

Workspace lock/manifests remain editor inputs, not enforcement trust anchors. They can influence diagnostics and displayed Markdown even though validation is bounded and runtime execution is prohibited. Review or isolate workspace metadata according to the editor's normal untrusted-workspace policy.

Configuration section `polici` accepts:

| Setting            | Default                                         | Meaning                                                                   |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------------------- |
| `lockFile`         | empty                                           | Workspace-relative/absolute lock path; empty uses nearest lock discovery. |
| `manifestCache`    | empty internally; VS Code supplies two defaults | One path or array of offline cache directories.                           |
| `manifests`        | `{}`                                            | Paths keyed by `provider@major`, exact source locator, or provider name.  |
| `maxManifestBytes` | `4194304`                                       | Positive read limit, capped at 64 MiB.                                    |

Automatic discovery searches for `polici.lock` first and then the legacy `polici.lock.json` name. An explicit `polici.lockFile` path takes precedence.

Cache candidates include `<digest>.json`, `name@version.json`, `name/version/manifest.json`, and encoded-locator names under configured directories plus `.polici/manifests` and `.polici/cache/manifests`.

## VS Code

The extension contributes `.pol`, TextMate grammar, comments/brackets/folding/indentation, and snippets, and starts a `vscode-languageclient` process. Defaults are:

```json
{
  "polici.binary": "polici",
  "polici.args": ["lsp", "--stdio"],
  "polici.lockFile": "",
  "polici.manifestCache": [".polici/manifests", ".polici/cache/manifests"],
  "polici.manifests": {},
  "polici.maxManifestBytes": 4194304
}
```

It watches `polici.lock`, legacy `polici.lock.json`, and `manifest.json`, then asks the server to republish. Build/develop it with the instructions in [`editors/README.md`](../editors/README.md).

Release packaging runs esbuild first and places the complete language-client dependency graph in the CommonJS `dist/extension.js` bundle, with only VS Code's host-provided `vscode` module external. `.vscodeignore` excludes sources, maps, lockfiles, and `node_modules`; CI creates and inspects the VSIX before release.

## Static Library Services

Editor-neutral integrations can call `compile`, `getCompletions`, `getHover`, `getSemanticTokens`, and LSP `getSignatureHelp` helpers from source modules. The first four accept language-level `ProviderManifest`; adapt strict plugin manifests with `adaptPluginManifest`. They operate on UTF-16 offsets and never call resolver hosts.
