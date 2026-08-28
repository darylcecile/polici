# Polici Documentation

These documents describe the behavior implemented by this repository. Normative words such as MUST and MUST NOT identify caller, provider, runtime, or editor contracts.

| Document                                     | Contract                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| [Language](language.md)                      | Grammar, scopes, types, core values, globs, absence, and evaluation                     |
| [CLI](cli.md)                                | Native executable, commands, options, snapshots, output, and exit codes                 |
| [Library API](library-api.md)                | Engine, repository, resolver, runtime-host, and result APIs                             |
| [Plugin SDK](plugin-sdk.md)                  | Default-exported TypeScript contracts/runtimes, typed builders, and build tooling       |
| [Lockfiles](lockfiles.md)                    | Lockfile v2, CLI resolution, canonicalization, digests, and CI workflow                 |
| [Runtime protocol](runtime-protocol.md)      | Language-neutral resumable sessions, framing, wire values, capabilities, and limits     |
| [TypeScript runtimes](runtime-typescript.md) | Native executable build, trust, sandbox, and process contract                           |
| [WASM runtimes](runtime-wasm.md)             | WASI command build, isolation, and protocol parity                                      |
| [GitHub provider](github-provider.md)        | Pull requests, before/after changes, reviews, teams, checks, endpoints, and permissions |
| [Security](security.md)                      | Threat model, trust boundaries, capabilities, and safe GitHub Actions deployment        |
| [Editors](editors.md)                        | Stdio LSP, static manifest discovery, VS Code, and language features                    |

## Schemas

- [`plugin-manifest.schema.json`](../schemas/plugin-manifest.schema.json): `polici.plugin/v2`
- [`plugin-lock.schema.json`](../schemas/plugin-lock.schema.json): `polici.lock/v2`
- [`policy-report.schema.json`](../schemas/policy-report.schema.json): CLI/library policy result
- [`runtime-protocol.schema.json`](../schemas/runtime-protocol.schema.json): all host/runtime messages and tagged values
- [WASM/WASI runtime guide](runtime-wasm.md): implemented Preview 1 core-command ABI

The TypeScript validators remain authoritative for limits and relationships not expressible in JSON Schema, including manifest references and identity fields, default/type compatibility, permission/capability inclusion, regular-expression validity, unique lock `(name, contractMajor)` keys, canonical wire-set ordering, duplicate entity identities, continuation freshness, and lifecycle ordering.
