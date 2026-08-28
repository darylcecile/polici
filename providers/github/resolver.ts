import type { RepositorySnapshot } from "../../src/core/repository.js";
import type { RuntimeCapability } from "../../src/plugin/protocol.js";
import {
  LazyMemoizingResolverHost,
  ResolverFault,
  type ResolverCallOptions,
  type ResolverHost,
  type ResolverRequest,
} from "../../src/plugin/resolver.js";
import { validateWireValue, wire, type WireValue } from "../../src/plugin/wire.js";
import { GitHubProvider } from "./api.js";
import { GitHubProviderError } from "./errors.js";
import { githubManifest } from "./manifest.js";
import type {
  GitHubChange,
  GitHubCheck,
  GitHubFileVersion,
  GitHubProviderOptions,
  GitHubPullRequest,
  GitHubTeam,
  GitHubUser,
} from "./types.js";

export const githubCapabilities: readonly RuntimeCapability[] = [
  {
    name: "github:pull-requests:read",
    operations: ["pullRequest", "pullRequest.approvers", "changes"],
    description: "Read the pinned pull request, reviews, changed paths, and immutable blobs.",
  },
  {
    name: "github:checks:read",
    operations: ["check"],
    description: "Read check runs and commit statuses for the pinned pull request head.",
  },
  {
    name: "github:organization-members:read",
    operations: ["team", "team.members"],
    description: "Read teams and complete organization membership.",
  },
];

/** Static compiler input for this trusted, host-implemented first-party provider. */
export const githubBuiltin = {
  manifest: githubManifest,
  source: { kind: "builtin" as const, locator: "polici:provider:github@1.0.0" },
} as const;

export class GitHubResolverHost implements ResolverHost {
  readonly capabilities = githubCapabilities;
  readonly repository: RepositorySnapshot;
  readonly #provider: GitHubProvider;

  constructor(options: GitHubProviderOptions | GitHubProvider, repository: RepositorySnapshot) {
    this.#provider = options instanceof GitHubProvider ? options : new GitHubProvider(options);
    this.repository = repository;
  }

  async resolve(request: ResolverRequest, options: ResolverCallOptions = {}): Promise<WireValue> {
    try {
      switch (request.resolver) {
        case "pullRequest":
          return validWire(pullRequestValue(await this.#provider.pullRequest(options)));
        case "pullRequest.approvers":
          return validWire(
            wire.set((await this.#provider.effectiveApprovers(options)).map(userValue)),
          );
        case "changes":
          return validWire(
            changeSetValue(
              assertMaterialized(
                await this.#provider.changes(
                  optionalStringArgument(request, "pattern") ?? "**/*",
                  options,
                ),
                this.repository,
              ),
            ),
          );
        case "team":
          return validWire(
            teamValue(await this.#provider.team(requiredStringArgument(request, "slug"), options)),
          );
        case "team.members":
          return validWire(
            wire.set((await this.#provider.teamMembers(teamSlug(request), options)).map(userValue)),
          );
        case "check":
          return validWire(
            checkValue(
              await this.#provider.check(
                requiredStringArgument(request, "name"),
                optionalStringArgument(request, "producer"),
                options,
              ),
            ),
          );
        default:
          throw new ResolverFault(
            "RESOLVER_NOT_FOUND",
            "resolver",
            `Unknown GitHub resolver ${request.resolver}`,
          );
      }
    } catch (error) {
      if (error instanceof ResolverFault) throw error;
      if (error instanceof GitHubProviderError) throw resolverFault(error);
      throw error;
    }
  }
}

export function createGitHubResolverHost(
  options: GitHubProviderOptions,
  repository: RepositorySnapshot,
): LazyMemoizingResolverHost {
  return new LazyMemoizingResolverHost(
    () => new GitHubResolverHost(options, repository),
    githubCapabilities,
  );
}

function assertMaterialized<T extends { readonly changes: readonly GitHubChange[] }>(
  changeSet: T,
  repository: RepositorySnapshot,
): T {
  for (const change of changeSet.changes) {
    if (!change.after) continue;
    const materialized = repository.get(change.after.path);
    if (!materialized || !sameBytes(materialized.bytes, change.after.content))
      throw new GitHubProviderError(
        "GITHUB_MATERIALIZATION",
        `Repository snapshot file ${JSON.stringify(change.after.path)} does not match the verified GitHub blob ${change.after.sha} at ${change.after.commitSha}`,
      );
  }
  return changeSet;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function validWire(value: WireValue): WireValue {
  const validation = validateWireValue(value);
  if (!validation.ok)
    throw new ResolverFault(
      "GITHUB_WIRE_VALUE",
      "resolver",
      `GitHub value exceeds the runtime wire contract: ${validation.issues[0]?.message ?? "invalid value"}`,
    );
  return value;
}

function userValue(user: GitHubUser): WireValue {
  return wire.entity("github:User", "github:user", user.id, {
    id: wire.id("github:user", user.id),
    login: wire.string(user.login),
  });
}

function teamValue(team: GitHubTeam): WireValue {
  return wire.entity("github:Team", "github:team", team.id, {
    id: wire.id("github:team", team.id),
    slug: wire.string(team.slug),
    name: wire.string(team.name),
    organization: wire.string(team.organization),
    members: wire.missing(),
  });
}

function pullRequestValue(pullRequest: GitHubPullRequest): WireValue {
  return wire.entity("github:PullRequest", "github:pull-request", pullRequest.id, {
    id: wire.id("github:pull-request", pullRequest.id),
    number: wire.integer(pullRequest.number),
    author: userValue(pullRequest.author),
    base_sha: wire.string(pullRequest.baseSha),
    head_sha: wire.string(pullRequest.headSha),
    changed_files: wire.integer(pullRequest.changedFileCount),
    draft: wire.boolean(pullRequest.draft),
    state: wire.string(pullRequest.state),
    approvers: wire.missing(),
  });
}

function changeSetValue(changeSet: {
  readonly mergeBaseSha: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly changes: readonly GitHubChange[];
}): WireValue {
  return wire.entity(
    "core:ChangeSet",
    "polici:change-set",
    `${changeSet.mergeBaseSha}..${changeSet.headSha}`,
    {
      merge_base_sha: wire.string(changeSet.mergeBaseSha),
      base_sha: wire.string(changeSet.baseSha),
      head_sha: wire.string(changeSet.headSha),
      changes: wire.list(
        changeSet.changes.map((change) =>
          changeValue(change, changeSet.mergeBaseSha, changeSet.headSha),
        ),
      ),
    },
  );
}

function changeValue(change: GitHubChange, baseSha: string, headSha: string): WireValue {
  return wire.entity(
    "core:Change",
    "polici:change",
    `${baseSha}..${headSha}:${change.status}:${change.before?.path ?? ""}:${change.path}`,
    {
      path: wire.string(change.path),
      status: wire.string(change.status),
      additions: wire.integer(change.additions),
      deletions: wire.integer(change.deletions),
      changes: wire.integer(change.changes),
      before: change.before ? wire.map(fileVersionValue(change.before)) : wire.missing(),
      after: change.after ? wire.map(fileVersionValue(change.after)) : wire.missing(),
    },
  );
}

function fileVersionValue(version: GitHubFileVersion): Record<string, WireValue> {
  return {
    path: wire.string(version.path),
    commit_sha: wire.string(version.commitSha),
    sha: wire.string(version.sha),
    content: wire.bytes(encodeBase64(version.content)),
  };
}

function checkValue(check: GitHubCheck): WireValue {
  const summary = check.sources
    .map(
      (source) =>
        `${source.kind} ${source.producer}/${source.name}: ${source.rawState} (${source.status})`,
    )
    .join("\n");
  const url = check.sources.length === 1 ? check.sources[0]?.url : undefined;
  return wire.entity(
    "core:Check",
    "polici:check",
    `${check.headSha}:${check.producer ?? "*"}:${check.name}`,
    {
      name: wire.string(check.name),
      status: wire.string(check.status),
      head_sha: wire.string(check.headSha),
      producer: check.producer ? wire.string(check.producer) : wire.missing(),
      summary: summary ? wire.string(summary) : wire.missing(),
      url: url ? wire.string(url) : wire.missing(),
      sources: wire.list(
        check.sources.map((source) =>
          wire.map({
            kind: wire.string(source.kind),
            id: wire.string(source.id),
            name: wire.string(source.name),
            producer: wire.string(source.producer),
            producer_name: source.producerName ? wire.string(source.producerName) : wire.missing(),
            status: wire.string(source.status),
            raw_state: wire.string(source.rawState),
            timestamp: source.timestamp ? wire.string(source.timestamp) : wire.missing(),
            url: source.url ? wire.string(source.url) : wire.missing(),
          }),
        ),
      ),
    },
  );
}

function requiredStringArgument(request: ResolverRequest, name: string): string {
  const value = request.arguments[name];
  if (!value || value.tag !== "string" || value.value === "")
    throw new ResolverFault(
      "INVALID_ARGUMENT",
      "resolver",
      `${request.resolver}.${name} must be a non-empty string`,
    );
  return value.value;
}

function optionalStringArgument(request: ResolverRequest, name: string): string | undefined {
  const value = request.arguments[name];
  if (!value || value.tag === "missing") return undefined;
  if (value.tag !== "string" || value.value === "")
    throw new ResolverFault(
      "INVALID_ARGUMENT",
      "resolver",
      `${request.resolver}.${name} must be a non-empty string`,
    );
  return value.value;
}

function teamSlug(request: ResolverRequest): string {
  if (request.subject?.tag !== "entity" || request.subject.type !== "github:Team")
    throw new ResolverFault(
      "INVALID_SUBJECT",
      "resolver",
      "team.members requires a GitHub Team subject",
    );
  const slug = request.subject.fields.slug;
  if (slug?.tag !== "string" || slug.value === "")
    throw new ResolverFault(
      "INVALID_SUBJECT",
      "resolver",
      "GitHub Team subject has no non-empty string slug",
    );
  return slug.value;
}

function resolverFault(error: GitHubProviderError): ResolverFault {
  const kind =
    error.code === "GITHUB_PERMISSION" || error.code === "GITHUB_AUTHENTICATION"
      ? "permission"
      : error.code === "GITHUB_TIMEOUT"
        ? "timeout"
        : "resolver";
  return new ResolverFault(error.code, kind, error.message, {
    retryable: error.retryable,
    cause: error,
  });
}

function encodeBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const value = first * 65_536 + second * 256 + third;
    result += alphabet.charAt(Math.floor(value / 262_144) % 64);
    result += alphabet.charAt(Math.floor(value / 4_096) % 64);
    result += index + 1 < bytes.length ? alphabet.charAt(Math.floor(value / 64) % 64) : "=";
    result += index + 2 < bytes.length ? alphabet.charAt(value % 64) : "=";
  }
  return result;
}
