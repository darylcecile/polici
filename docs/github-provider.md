# GitHub Provider Contract

The included `github` provider is a trusted host implementation for provider contract major 1. It uses GitHub REST API version `2022-11-28`, keeps the token in the host, and emits typed wire values through `GitHubResolverHost`. Its static manifest is `providers/github/manifest.json`.

## Integration

The native CLI locks the embedded provider without `--plugin` and uses it automatically at check time:

```console
./dist/polici lock --file ci.pol
GITHUB_TOKEN=... ./dist/polici check --file ci.pol --github-event "$GITHUB_EVENT_PATH"
```

The resulting `polici.lock` entry has source `builtin` and locator `polici:provider:github@1.0.0`, plus deterministic manifest/artifact digests. Before reading anything from the event-selected base, the CLI authenticates all event coordinates against the live GitHub PR API using `GITHUB_TOKEN` or `GH_TOKEN`. As an offline alternative, a trusted launcher may set `POLICI_GITHUB_BASE_SHA` independently of repository/event data; it must exactly equal the event base. That offline alternative supports `validate` and automatic Actions mode. A full `check` using explicit `--github-event` always requires live API authentication so the explicit file cannot substitute the candidate head. In pull-request mode, the CLI then reads policy and lock from the authenticated base commit, snapshots the exact event head commit, and requires the checkout's Git object database to contain both.

`--github-event` never makes its file trusted. Explicit and automatic Actions event files must resolve outside the repository root, including through parent-directory aliases. Automatic mode is enabled only for `GITHUB_ACTIONS=true` and the `pull_request` or `pull_request_target` event names, and uses the platform `GITHUB_EVENT_PATH`. A repository-controlled event path is rejected.

Library hosts can integrate directly:

```ts
import { checkPolicy } from "../src/index.js";
import { readGitFile, snapshotGitCommit } from "../src/cli/git.js";
import { nodeProcessRunner } from "../src/cli/process.js";
import {
  createGitHubResolverHost,
  GitHubProvider,
  githubBuiltin,
  githubContextFromActions,
} from "../providers/github/index.js";

const context = githubContextFromActions(process.env);
const root = process.cwd();
const providerOptions = { ...context, token: process.env.GITHUB_TOKEN! };
// Event JSON is untrusted until these coordinates match the live PR.
await new GitHubProvider(providerOptions).pullRequest();
const repository = snapshotGitCommit(root, context.expectedHeadSha, process.env, nodeProcessRunner);
const policySource = new TextDecoder().decode(
  readGitFile(
    root,
    context.expectedBaseSha,
    "ci.pol",
    process.env,
    nodeProcessRunner,
    4 * 1024 * 1024,
  ),
);
const github = createGitHubResolverHost(providerOptions, repository);

const result = await checkPolicy(policySource, {
  repository,
  trustedBuiltins: [githubBuiltin],
  resolvers: { Git: github },
}).finally(() => github.dispose());
```

`githubBuiltin` is an explicit `TrustedBuiltinPluginInput` with locator `polici:provider:github@1.0.0`. Using it asserts that the in-process provider is part of the reviewed host trusted computing base. The policy alias and resolver map key must match. The resolver host and evaluator MUST receive the same repository snapshot instance/data.

## Immutable Context

`GitHubRepositoryContext` requires owner, repository, positive PR number, expected base SHA, expected head SHA, and expected head repository full name. SHAs are 40 or 64 hexadecimal characters.

`githubContextFromActions(environment)` requires `GITHUB_EVENT_PATH`, reads and parses that event file, and derives context from `event.repository`, `event.number`, and `pull_request.base/head`. This parsing does not authenticate repository-controlled JSON. A library host must call `GitHubProvider.pullRequest()` and wait for success, or independently compare the base SHA to a trusted value, before loading policy, lock, or plugins from the selected base. Context parsing verifies:

- the event and embedded PR numbers agree;
- event repository equals the PR base repository;
- optional `GITHUB_REPOSITORY` equals that repository;
- both base and head repositories have valid `owner/name` form;
- the head repository full name is retained and later matched against live PR data;
- every supplied override exactly equals the event-derived value.

It does not infer a PR from `GITHUB_REF`, and it does not trust standalone head-SHA environment variables. `githubContextFromEvent` performs the same validation on an already parsed event object. Neither function by itself establishes trust in an explicit event file.

Every provider operation loads or rechecks the PR against pinned base/head SHAs and repository identity. Operations that aggregate additional API data re-fetch the PR before returning. A mismatch yields retryable `GITHUB_INCONSISTENT_HEAD`; data is never silently evaluated against a moved head.

## Policy Contract

```polici
using "github@1" as Git
```

### Resources and functions

| Expression                   | Type                 | Resolver      |
| ---------------------------- | -------------------- | ------------- |
| `Git.pull_request`           | `github.PullRequest` | `pullRequest` |
| `Git.changes(pattern?)`      | `ChangeSet`          | `changes`     |
| `Git.team(slug)`             | `github.Team`        | `team`        |
| `Git.check(name, producer?)` | `Check`              | `check`       |

The default change pattern is `**/*`. `producer` is syntactically optional so unscoped lookups can return diagnostic evidence, but an unscoped check can never have status `passed`. A passing policy must supply an immutable selector: `app:<positive database id>` for a check run or `status:<creator node id>` for a commit status. Selector values must be non-empty and contain no NUL or line break.

### Entity types

`github.User` uses GitHub GraphQL node ID identity namespace `github:user` and exposes `id` and mutable `login`.

`github.Team` uses node ID identity namespace `github:team` and exposes `id`, `slug`, `name`, `organization`, and lazily resolved `members: Set<github.User>`.

`github.PullRequest` uses node ID identity namespace `github:pull-request` and exposes `id`, `number`, `author`, `base_sha`, `head_sha`, `changed_files`, `draft`, `state` (`open` or `closed`), and lazily resolved `approvers: Set<github.User>`.

Membership and approver relations compare immutable node IDs, not logins or team display names.

## Change Semantics

`Git.changes(pattern)` performs these operations:

1. Rejects a PR whose declared `changed_files` exceeds GitHub's 3,000-file REST limit.
2. Resolves the merge base using `compare/{base}...{head}` and verifies the comparison's base SHA.
3. Paginates all PR file records at 100 per page and requires count equality with `changed_files`.
4. Normalizes GitHub statuses: `copied` to `added`, `changed` to `modified`, `removed` to `deleted`; retains `renamed`.
5. Rejects duplicate/non-canonical paths; a rename requires a distinct `previous_filename`.
6. Selects a change when the pattern matches either its current path **or its previous path**. A rename out of or into a protected path is therefore selected.
7. Materializes `before` from the merge-base repository/path and `after` from the head repository/path using Contents metadata plus Git Blob bytes.
8. Verifies content path, commit coordinate, Git object ID, byte size, base64, and SHA-1/SHA-256 Git blob hash, and cross-checks the PR-file blob ID.
9. Revalidates pinned PR context before returning.

The direct `GitHubProvider.changes()` API returns `mergeBaseSha`, event base tip `baseSha`, head `headSha`, and selected `GitHubChange` records with immutable bytes. Before emitting wire data, `GitHubResolverHost` compares every non-deleted `after` byte sequence with the repository snapshot supplied to its constructor. Absence or mismatch is `GITHUB_MATERIALIZATION`. The engine materializes wire `before.content` as a readable DSL `File`, derives rename `previous_path` from `before.path`, and resolves `after` from that same exact-head snapshot rather than trusting provider bytes. Deleted files are available through `change.before` but never through `ChangeSet.files()`.

A path-only activation rule should use the complete change set:

```polici
when some changes.{ path matches "schema/**" }
```

Because `path` is the new path, explicitly inspect `previous_path` when a complete unfiltered change set is already available. `previous_path` is missing on non-renames, so gate access by the renamed subset:

```polici
renamed_schema = changes.renamed.{
  path matches "schema/**" or previous_path matches "schema/**"
}
rule "schema changes need approval" when some renamed_schema { /* ... */ }
```

Alternatively bind `Git.changes("schema/**")`; provider filtering matches both current and old names before conversion.

[`examples/ci.pol`](../examples/ci.pol) uses this unambiguous form.

## Effective Approvers

`Git.pull_request.approvers` paginates all PR reviews and computes one latest **opinionated** review per immutable user node ID:

- `APPROVED` and `CHANGES_REQUESTED` are decisive.
- `DISMISSED` is decisive and revokes an earlier approval; `COMMENTED` and `PENDING` are ignored and do not supersede an opinion.
- Latest is greatest parsed `submitted_at`; equal timestamps are broken by greatest numeric review ID.
- Deleted users (`user: null`) are ignored because stable identity is unavailable.
- Unknown opinionated review states, invalid timestamps, and absent/invalid commit IDs are errors.
- A user is an approver only if the latest opinion is `APPROVED` **and** its `commit_id` exactly equals the pinned PR head SHA.
- Results are sorted by immutable user node ID and the PR is revalidated before return.

This deliberately makes approvals on older commits stale and lets a later changes-requested or dismissed review revoke approval. Comments cannot revoke or create approval.

## Teams and Membership

`Git.team(slug)` accepts only non-empty ASCII letters, digits, `_`, `.`, and `-`, reads the team under the configured owner organization, and returns node-ID identity plus slug/name/organization.

`team.members` requests `role=all`, so maintainers and ordinary members are both included. It paginates the complete list, de-duplicates by node ID, rejects inconsistent duplicates, sorts by node ID, and revalidates pinned PR context. The configured repository owner must be the team's organization. A user not visible to the token is not assumed absent; GitHub permission/not-found errors fail evaluation.

## Check Semantics

`Git.check(name)` returns diagnostic evidence from both check runs and commit statuses at the pinned head but can never return `passed`: an all-passed unscoped result is forced to `failed`. Existing failed, cancelled, pending, and missing aggregate states are preserved. `Git.check(name, producer)` narrows to one immutable producer and is the only form that can return `passed`.

The provider:

1. Paginates all check suites for the head and validates suite `head_sha`.
2. Paginates all check runs in each suite with `filter=all`, not GitHub's `latest` filter.
3. Paginates the combined commit-status response and validates response SHA.
4. Requires every reported `total_count` to remain stable and equal the collected item count.
5. Maps check-run producer to `app:<app database id>` and status producer to `status:<creator node id>`. The status context remains the check name. The source records the check app slug or status creator login only as display-only `producerName` where available.
6. Selects the latest source independently for each `(producer, name)` by completion/start/creation or update/creation timestamp, with kind/node ID as deterministic tie-breaker.
7. Filters latest sources by exact, case-sensitive name and optional producer, then aggregates them.

Normalization:

| GitHub source                          | Core source status |
| -------------------------------------- | ------------------ |
| Check run not `completed`              | `pending`          |
| Check-run conclusion `success`         | `passed`           |
| Check-run conclusion `cancelled`       | `cancelled`        |
| Any other/missing completed conclusion | `failed`           |
| Commit status `success`                | `passed`           |
| Commit status `pending`                | `pending`          |
| Any other commit status                | `failed`           |

For a producer-scoped lookup, aggregate precedence is `missing` for no selected source, then `failed`, `cancelled`, `pending`, and `passed` only if every selected latest source passed. `passed` in the policy is true only for aggregate `passed`. An unscoped all-passed lookup is forced to `failed`; other aggregate states remain visible as diagnostics.

Without a producer selector, named checks are evidence-only and fail closed. With a selector, absence yields a normal `Check(status = "missing")`, so `passed` fails rather than raising missing-data absence. The core check evidence contains a source summary; a URL is retained only when exactly one source is selected.

## REST Endpoints

The provider makes bounded GET requests to:

- `repos/{owner}/{repo}/pulls/{number}`
- `repos/{owner}/{repo}/compare/{base}...{head}`
- `repos/{owner}/{repo}/pulls/{number}/files`
- `repos/{owner}/{repo}/pulls/{number}/reviews`
- `repos/{owner}/{repo}/contents/{path}?ref={sha}` for base/head repositories
- `repos/{owner}/{repo}/git/blobs/{sha}` for base/head repositories
- `orgs/{owner}/teams/{slug}`
- `orgs/{owner}/teams/{slug}/members?role=all`
- `repos/{owner}/{repo}/commits/{head}/check-suites`
- `repos/{owner}/{repo}/check-suites/{id}/check-runs?filter=all`
- `repos/{owner}/{repo}/commits/{head}/status`

The API base must use HTTPS. The only exception is `allowInsecureHttpForTests: true` together with an explicitly injected `fetch`; production/global fetch cannot use HTTP. Requests use `redirect: "manual"`, reject every redirect response, reject a fetch implementation that reports it followed a redirect, and validate the final response URL against the exact authenticated request and configured API origin. The authorization token is therefore never intentionally sent to an HTTP or cross-origin URL.

Pagination follows only `Link: rel="next"` URLs that remain under the configured API origin and base path. Cyclic links are rejected. Defaults are 100 pages, 10,000 items per paginated operation, 30 seconds per request, 96 MiB per HTTP response, and 64 MiB per decoded blob. The public provider fields `maxResponseBytes` and `maxBlobBytes` expose the effective byte limits. Options `maxResponseBytes` and `maxBlobBytes`, or CLI environment values `POLICI_GITHUB_MAX_RESPONSE_BYTES` and `POLICI_GITHUB_MAX_BLOB_BYTES`, may lower or raise them with positive safe integers. Both successful and error response bodies are bounded from `Content-Length` and while streaming before JSON parse; blobs are size-checked before compacting or allocating decoded base64. The GitHub 3,000 PR-file cap remains lower and causes a hard error rather than partial evaluation.

Every request pins REST API version `2022-11-28`. The client recognizes primary/secondary rate limiting on HTTP 429 and qualifying HTTP 403 responses, captures `Retry-After` or reset information, and raises retryable `GITHUB_RATE_LIMIT`. It does not retry or sleep automatically. Primary/secondary limits are controlled by GitHub and may be lower than Polici's pagination bounds.

## Token Permissions

The static Polici capabilities are:

- `github:pull-requests:read`: PR, reviews, changes, comparisons, and immutable blobs.
- `github:checks:read`: check suites/runs and commit statuses.
- `github:organization-members:read`: teams and complete membership.

These are Polici capability names, not GitHub token scope strings. The actual GitHub App/fine-grained token needs, at minimum, repository **Pull requests: read**, **Contents: read**, **Checks: read**, and **Commit statuses: read**, plus organization **Members: read** for team resolution. Access is also required to the head repository for fork blob reads. Classic tokens and enterprise installations must provide equivalent access.

A repository `GITHUB_TOKEN` can be constrained with `pull-requests: read`, `contents: read`, `checks: read`, and `statuses: read`, but it generally cannot satisfy private organization team membership or fork-head repository access in every topology. Use a narrowly scoped GitHub App installation token when team rules or private forks require it. Never pass the token into an external plugin subprocess.

HTTP 401 is `GITHUB_AUTHENTICATION`; permission-like 403 is `GITHUB_PERMISSION`; inaccessible 404 is `GITHUB_NOT_FOUND`. Polici never converts those into an empty set or a skipped optional rule.

## Error Codes

`GITHUB_CONTEXT`, `GITHUB_AUTHENTICATION`, `GITHUB_PERMISSION`, `GITHUB_RATE_LIMIT`, `GITHUB_NOT_FOUND`, `GITHUB_TRUNCATED`, `GITHUB_INCONSISTENT_HEAD`, `GITHUB_API`, `GITHUB_RESPONSE`, `GITHUB_TIMEOUT`, `GITHUB_ABORTED`, and `GITHUB_MATERIALIZATION` are the provider error codes. Resolver-emitted values are also prevalidated against generic wire limits; an invalid value becomes `GITHUB_WIRE_VALUE`. Rate limit, inconsistent head, network/API transport, timeout, and aborted errors carry retryability as implemented; hosts decide whether to rerun the complete evaluation.
