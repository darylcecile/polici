# Threat Model and Trusted Deployment

Policy selection and provider selection are security boundaries. Determinism does not help if an untrusted pull request can replace the enforcing executable, workflow, policy, lockfile, manifest, runtime artifact, sandbox, broker, or credentials.

## Assets and Adversaries

Protected assets include repository/organization credentials, private source, policy and plugin integrity, capability authority, truthful pass/fail evidence, and evaluation availability.

Potentially hostile inputs include PR paths/bytes, event JSON, local filesystem races/links, policy and JSON source, manifests/artifacts, continuations, runtime stdout/stderr, capability requests/results, GitHub API bodies and pagination links, and resource-exhaustion payloads.

The trusted computing base includes:

- `dist/polici` and all host/library code used to run it;
- workflow/action revisions and trusted acquisition of the executable;
- the trusted base revision containing policy, `polici.lock`, path manifests, and artifacts;
- code explicitly marked built-in or trusted native;
- artifact acquisition/storage and any registry resolver implemented by an embedder;
- native sandbox launcher or WASI runner;
- capability brokers and their scope enforcement;
- repository snapshot/Git object construction;
- GitHub, its API semantics, and the selected credential/installation.

An integrity-matching external plugin is reproducibly selected, not intrinsically safe. It still needs isolation, bounded execution, and least privilege.

## Implemented Defenses

- CLI imports exactly match lock v2; canonical manifest and exact artifact SHA-256 are verified before execution.
- CLI lock acquisition supports reviewed local path artifacts and embedded GitHub only; unsupported registry/URL sources fail instead of fetching mutable content.
- Static manifests are closed, bounded, reference/type validated, and consumed without runtime execution.
- Tagged wire data is closed and bounded; result values are checked against manifest types, constraints, fields, set order, and entity identity.
- Runtime logical sessions require fresh bounded continuations and ordered call/capability correlation.
- Process exchanges have deadline, output, log, capability-call, grant-call, frame/message, and session-exchange limits; timeout/cancellation kills the child.
- Child processes receive an empty environment. Native runtimes require explicit TCB trust or an asserted hardened launcher. WASI receives no runner options from the secure host path.
- Capability calls are accepted only for activated grants and declared operations, with sequence, unique request ID, quota, and deadline checks. Brokers validate results before data returns to the runtime.
- CLI repository roots/files reject symlinks and special entries, enforce containment, open files with `O_NOFOLLOW`, validate the same descriptor with `fstat`, recheck path identity, detect changed reads, and cap source/artifact/repository sizes. ScriptC currently exposes only whole-file filesystem reads; its native island therefore retains parent/file lstat and realpath checks plus pre/post path identity checks, and enters that fallback only for ScriptC's explicit descriptor-unavailable error.
- Pull-request mode rejects event files that resolve inside the repository. Before any base policy/lock/plugin read, it either authenticates repository, PR number, base/head SHAs, and head repository against the live GitHub API using the host token, or requires exact equality with independently trusted `POLICI_GITHUB_BASE_SHA`. The SHA-only route supports offline `validate` and automatic platform-event mode; a full `check` using explicit `--github-event` always requires live API authentication.
- Pull-request mode reads enforcement policy/lock/path plugins from the authenticated exact event base commit and snapshots the exact event head tree with strict Git modes and full object IDs. Git commands set `GIT_NO_REPLACE_OBJECTS=1` and `core.useReplaceRefs=false`; commit, tree, and blob bytes are independently hashed against each requested object ID.
- GitHub context pins base SHA, head SHA, base/head repositories, and PR number; operations revalidate the live PR, require complete pagination, and verify Git blob IDs/content.
- GitHub `before` bytes come from the merge base and `after` bytes are cross-checked against the exact head snapshot before DSL materialization.
- GitHub REST requests pin API version `2022-11-28`, use HTTPS, prohibit redirects, validate final request origin, do not retry, and bound successful/error response streams and decoded blobs before parsing/allocation.
- A GitHub check can pass only with an immutable producer selector: check app database ID or commit-status creator node ID. Context, app slug, and login remain display data, not authority.

## Important Limits

- `--trust-plugin`/`trustedRuntime: true` and `trustedBuiltins` are complete TCB opt-ins. The code can do anything the host user can do unless separately isolated.
- Sandbox booleans are attestations. Polici launches the configured program but cannot prove it enforces network/filesystem/environment/process denial.
- An empty child environment does not remove ambient filesystem, network, syscall, CPU, or memory authority from a native executable.
- WASI modules are parsed before execution and reject clock, random, socket, path-open, non-function, and non-WASI imports. Runner arguments are rejected. A malicious wrapper chosen as `--wasi-command` is still host code.
- Continuations are runtime-created opaque data. Polici constrains syntax, freshness, and size but cannot prove confidentiality, integrity, or safe deserialization inside a plugin.
- Capability `scope` is policy metadata. The broker must enforce it; merely passing scope to a plugin is not authorization.
- The standalone CLI exposes no generic privileged capability service. Its path-plugin broker returns `CAPABILITY_NOT_CONFIGURED`; embedders that add brokers enlarge the TCB.
- SHA-256 equality proves bytes, not publisher identity, provenance, review quality, vulnerability absence, or reproducibility from source.
- Resource limits reduce denial-of-service risk but are not a constant-resource sandbox. OS-level CPU/memory/process controls remain appropriate.
- GitHub availability, visibility, rate limits, and semantics remain external. Errors fail closed but can block evaluation.
- Report evidence can contain repository-derived values. JSON output and logs require normal secret-handling and retention controls.

## Pull Request Trust Rule

The executable, workflow, policy, lockfile, local plugin manifests/artifacts, sandbox configuration, and broker must come from a trusted base or immutable reviewed release. Only the candidate repository snapshot should come from the PR head.

The native CLI enforces that policy/lock/path plugin split only after authenticating the pull-request event through the live API or independently supplied `POLICI_GITHUB_BASE_SHA`: trusted files are read with Git from `expectedBaseSha`; candidate files are materialized from `expectedHeadSha`. Explicit `--github-event` is not a trust assertion. Automatic Actions mode accepts the platform path only when it resolves outside the repository. Both Git objects must exist locally and independently hash to their exact IDs. This does not make a PR-built `dist/polici` trusted. Acquire the binary independently.

Pin third-party Actions to full reviewed commit SHAs. Disable credential persistence where possible. Avoid shared writable caches across trust levels. Never execute a binary, local action, lifecycle script, package install, policy runtime, or configuration loader from PR head in a privileged job.

## `pull_request_target`

`pull_request_target` uses base workflow code and can receive secrets/write authority, but it becomes dangerous as soon as it executes PR-controlled code. Never check out the PR head and run its scripts/tools/artifacts under that trigger. `workflow_run` has the same privilege-crossing risk if a privileged follow-up executes an untrusted artifact.

Prefer `pull_request` with read-only permissions and a trusted preinstalled Polici executable. If private organization data needs stronger credentials, use a base-controlled service/job that consumes a narrow authenticated data description and never executes head artifacts.

## GitHub Actions Baseline

```yaml
name: policy

on:
  pull_request:

permissions:
  contents: read
  pull-requests: read
  checks: read
  statuses: read

jobs:
  policy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<full-reviewed-commit-sha>
        with:
          fetch-depth: 0
          persist-credentials: false
      - name: Evaluate with a trusted Polici release
        env:
          GITHUB_TOKEN: ${{ github.token }}
         run: /opt/polici check --repository . --file ci.pol
```

`/opt/polici` means an independently installed, reviewed `dist/polici`, not a binary built from this checkout. Automatic mode reads the external platform `GITHUB_EVENT_PATH` and authenticates it with `GITHUB_TOKEN` before loading base files. `fetch-depth: 0` is needed so exact event base/head objects are available. The workflow must ensure fork head objects are present; if the checkout strategy does not, fetch the pull ref using trusted fixed Git commands without executing it.

Organization team membership usually requires a GitHub App token with organization **Members: read**. Scope it to minimum read permissions, do not expose it to fork code, and keep its complete use path base-controlled. The repository token also needs applicable Pull requests, Contents, Checks, and Commit statuses read access, including access to a private fork/head repository when changes are materialized.

## Runtime and Broker Rules

- Review lock source, permission, capability, runtime, transport, and digest changes.
- Keep native plugins in a real deny-by-default OS sandbox unless they are deliberately host code.
- Use a restricted WASI runner executable; do not wrap it in a script that silently grants preopens/network/environment.
- Never place tokens in plugin environment, arguments, filesystem, continuation, protocol input, scope, error details, or logs.
- Broker only operations declared by the reviewed grant, enforce scope independently, minimize returned data, and honor cancellation/deadlines.
- Treat permission, unavailable broker, not-found, truncation, moving head, timeout, invalid wire, continuation replay, protocol, and quota failures as exit 2, not empty data.
- Dispose process hosts in `finally` so successful logical sessions receive shutdown and temporary artifacts are removed.

## Audit

Retain trusted executable/version/digest, workflow and policy revision, canonical lock, selected plugin bindings/digests, repository snapshot hash, event base/head/repository coordinates, sandbox/broker policy version, provider diagnostic codes, and JSON result. Never retain authorization headers, tokens, unrestricted private blobs, or opaque protocol transcripts without an explicit secure retention need.
