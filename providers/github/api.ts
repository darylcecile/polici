// @ts-ignore This bare repository intentionally does not depend on @types/node.
import { createHash } from "node:crypto";

import { PoliciGlob } from "../../src/core/glob.js";
import { normalizeRepositoryPath } from "../../src/core/path.js";
import { GitHubClient, type GitHubRequestOptions } from "./client.js";
import { validateGitHubContext } from "./context.js";
import { GitHubProviderError } from "./errors.js";
import type {
  GitHubChange,
  GitHubChangeSet,
  GitHubCheck,
  GitHubCheckSource,
  GitHubCheckState,
  GitHubFileVersion,
  GitHubProviderOptions,
  GitHubPullRequest,
  GitHubTeam,
  GitHubUser,
} from "./types.js";

type RawObject = Record<string, unknown>;

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_PULL_REQUEST_FILES = 3_000;
export const DEFAULT_GITHUB_MAX_RESPONSE_BYTES = 96 * 1024 * 1024;
export const DEFAULT_GITHUB_MAX_BLOB_BYTES = 64 * 1024 * 1024;

interface ParsedChangedFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: GitHubChange["status"];
  readonly githubBlobSha: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

interface ParsedReview {
  readonly id: number;
  readonly state: "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED";
  readonly commitId: string;
  readonly submittedAt: number;
  readonly user: GitHubUser;
}

interface ParsedCheckSource extends GitHubCheckSource {
  readonly order: number;
}

export class GitHubProvider {
  readonly maxResponseBytes: number;
  readonly maxBlobBytes: number;
  readonly #options: GitHubProviderOptions;
  readonly #client: GitHubClient;
  readonly #blobs = new Map<string, Promise<Uint8Array>>();
  readonly #versions = new Map<string, Promise<GitHubFileVersion>>();

  constructor(options: GitHubProviderOptions) {
    validateGitHubContext(options);
    if (!options.token)
      throw new GitHubProviderError(
        "GITHUB_AUTHENTICATION",
        "A GitHub token is required by the host provider",
      );
    if ((options.timeoutMs ?? 30_000) <= 0) throw new TypeError("GitHub timeout must be positive");
    for (const [label, value] of [
      ["page", options.maxPages ?? 100],
      ["item", options.maxItems ?? 10_000],
      ["response byte", options.maxResponseBytes ?? DEFAULT_GITHUB_MAX_RESPONSE_BYTES],
      ["blob byte", options.maxBlobBytes ?? DEFAULT_GITHUB_MAX_BLOB_BYTES],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new TypeError(`GitHub ${label} limit must be a positive safe integer`);
    }
    if (options.allowInsecureHttpForTests && options.fetch === undefined)
      throw new TypeError("Insecure test HTTP requires an injected fetch implementation");
    this.#options = options;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_GITHUB_MAX_RESPONSE_BYTES;
    this.maxBlobBytes = options.maxBlobBytes ?? DEFAULT_GITHUB_MAX_BLOB_BYTES;
    this.#client = new GitHubClient({
      token: options.token,
      apiUrl: options.apiUrl ?? "https://api.github.com/",
      fetch: options.fetch ?? globalThis.fetch,
      injectedFetch: options.fetch !== undefined,
      allowInsecureHttpForTests: options.allowInsecureHttpForTests ?? false,
      timeoutMs: options.timeoutMs ?? 30_000,
      maxPages: options.maxPages ?? 100,
      maxItems: options.maxItems ?? 10_000,
      maxResponseBytes: this.maxResponseBytes,
    });
  }

  pullRequest(options: GitHubRequestOptions = {}): Promise<GitHubPullRequest> {
    return this.#loadPullRequest(options);
  }

  async changes(pattern = "**/*", options: GitHubRequestOptions = {}): Promise<GitHubChangeSet> {
    const glob = new PoliciGlob(pattern);
    const pullRequest = await this.pullRequest(options);
    if (pullRequest.changedFileCount > MAX_PULL_REQUEST_FILES)
      throw new GitHubProviderError(
        "GITHUB_TRUNCATED",
        `Pull request has ${pullRequest.changedFileCount} changed files; GitHub exposes at most ${MAX_PULL_REQUEST_FILES}`,
      );
    const mergeBaseSha = await this.#mergeBase(pullRequest, options);
    const values = await this.#client.paginate(
      `${this.#repositoryPath()}/pulls/${this.#options.pullRequestNumber}/files?per_page=100`,
      (body) => requireArray(body, "pull request files"),
      options,
    );
    if (values.length > MAX_PULL_REQUEST_FILES || values.length !== pullRequest.changedFileCount)
      throw new GitHubProviderError(
        "GITHUB_TRUNCATED",
        `GitHub returned ${values.length} of ${pullRequest.changedFileCount} changed files`,
      );
    const parsed = values.map(parseChangedFile);
    assertUnique(parsed, (file) => file.path, "changed file path");

    const selected = parsed.filter(
      (file) =>
        glob.matches(file.path) ||
        (file.previousPath !== undefined && glob.matches(file.previousPath)),
    );
    const changes: GitHubChange[] = [];
    for (const file of selected) {
      const before =
        file.status === "added"
          ? undefined
          : await this.#fileVersion(
              pullRequest.baseRepository,
              mergeBaseSha,
              file.previousPath ?? file.path,
              options,
            );
      const after =
        file.status === "deleted"
          ? undefined
          : await this.#fileVersion(
              pullRequest.headRepository,
              pullRequest.headSha,
              file.path,
              options,
            );
      const githubVersion = file.status === "deleted" ? before : after;
      if (githubVersion?.sha !== file.githubBlobSha)
        throw new GitHubProviderError(
          "GITHUB_RESPONSE",
          `Changed file ${JSON.stringify(file.path)} blob SHA disagrees with immutable repository content`,
        );
      changes.push({
        path: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        ...(before === undefined ? {} : { before }),
        ...(after === undefined ? {} : { after }),
      });
    }
    await this.#assertPinned(pullRequest, options);
    return {
      mergeBaseSha,
      baseSha: pullRequest.baseSha,
      headSha: pullRequest.headSha,
      changes,
    };
  }

  /**
   * Latest submitted decisive review per immutable user wins. COMMENTED and PENDING are ignored;
   * DISMISSED is a decisive non-approval. Conservatively, an APPROVED review counts only when
   * its commit_id is the pinned pull request head.
   */
  async effectiveApprovers(options: GitHubRequestOptions = {}): Promise<readonly GitHubUser[]> {
    const pullRequest = await this.pullRequest(options);
    const values = await this.#client.paginate(
      `${this.#repositoryPath()}/pulls/${this.#options.pullRequestNumber}/reviews?per_page=100`,
      (body) => requireArray(body, "pull request reviews"),
      options,
    );
    const latest = new Map<string, ParsedReview>();
    for (const value of values) {
      const review = parseOpinionatedReview(value);
      if (!review) continue;
      const previous = latest.get(review.user.id);
      if (
        previous === undefined ||
        review.submittedAt > previous.submittedAt ||
        (review.submittedAt === previous.submittedAt && review.id > previous.id)
      ) {
        latest.set(review.user.id, review);
      }
    }
    const approvers = [...latest.values()]
      .filter((review) => review.state === "APPROVED" && review.commitId === pullRequest.headSha)
      .map((review) => review.user)
      .sort(compareUsers);
    await this.#assertPinned(pullRequest, options);
    return approvers;
  }

  async team(slug: string, options: GitHubRequestOptions = {}): Promise<GitHubTeam> {
    if (!/^[A-Za-z0-9_.-]+$/.test(slug))
      throw new GitHubProviderError(
        "GITHUB_CONTEXT",
        `Invalid GitHub team slug ${JSON.stringify(slug)}`,
      );
    const pullRequest = await this.pullRequest(options);
    const body = await this.#client.get(
      `orgs/${encodeURIComponent(this.#options.owner)}/teams/${encodeURIComponent(slug)}`,
      options,
    );
    const team = parseTeam(body, this.#options.owner);
    await this.#assertPinned(pullRequest, options);
    return team;
  }

  async teamMembers(
    team: GitHubTeam | string,
    options: GitHubRequestOptions = {},
  ): Promise<readonly GitHubUser[]> {
    const pullRequest = await this.pullRequest(options);
    const resolvedTeam = typeof team === "string" ? await this.team(team, options) : team;
    if (resolvedTeam.organization.toLowerCase() !== this.#options.owner.toLowerCase())
      throw new GitHubProviderError(
        "GITHUB_CONTEXT",
        "Team does not belong to the configured organization",
      );
    const values = await this.#client.paginate(
      `orgs/${encodeURIComponent(this.#options.owner)}/teams/${encodeURIComponent(resolvedTeam.slug)}/members?role=all&per_page=100`,
      (body) => requireArray(body, "team members"),
      options,
    );
    const members = new Map<string, GitHubUser>();
    for (const value of values) {
      const user = parseUser(value, "team member");
      const existing = members.get(user.id);
      if (existing && (existing.databaseId !== user.databaseId || existing.login !== user.login))
        throw new GitHubProviderError(
          "GITHUB_RESPONSE",
          `GitHub returned inconsistent duplicate team member ${user.id}`,
        );
      members.set(user.id, user);
    }
    await this.#assertPinned(pullRequest, options);
    return [...members.values()].sort(compareUsers);
  }

  async check(
    name: string,
    producer?: string,
    options: GitHubRequestOptions = {},
  ): Promise<GitHubCheck> {
    if (!name) throw new GitHubProviderError("GITHUB_CONTEXT", "Check name cannot be empty");
    if (producer !== undefined && !/^(?:app:[1-9]\d*|status:[^\0\r\n]+)$/.test(producer))
      throw new GitHubProviderError(
        "GITHUB_CONTEXT",
        "Check producer must be an immutable app:<id> or status:<creator-node-id> selector",
      );
    const pullRequest = await this.pullRequest(options);
    const sha = encodeURIComponent(pullRequest.headSha);
    let checkSuiteTotal: number | undefined;
    const [checkSuites, statuses] = await Promise.all([
      this.#client.paginate(
        `${this.#repositoryPath()}/commits/${sha}/check-suites?per_page=100`,
        (body) => {
          const result = requireObject(body, "check suites");
          checkSuiteTotal = consistentTotal(result.total_count, checkSuiteTotal, "check suite");
          return requireArray(result.check_suites, "check suites");
        },
        options,
      ),
      this.#client.paginate(
        `${this.#repositoryPath()}/commits/${sha}/statuses?per_page=100`,
        (body) => requireArray(body, "commit statuses"),
        options,
      ),
    ]);
    assertComplete(checkSuites, checkSuiteTotal, "check suites");

    const suiteIds = checkSuites.map((value) => {
      const suite = requireObject(value, "check suite");
      const suiteHead = requireSha(suite.head_sha, "check suite head_sha");
      if (suiteHead !== pullRequest.headSha)
        throw new GitHubProviderError(
          "GITHUB_INCONSISTENT_HEAD",
          `Check suite resolved ${suiteHead}, expected ${pullRequest.headSha}`,
        );
      return requirePositiveInteger(suite.id, "check suite id");
    });
    assertUnique(suiteIds, String, "check suite");
    const checkRuns: unknown[] = [];
    for (const suiteId of suiteIds) {
      let checkRunTotal: number | undefined;
      const suiteRuns = await this.#client.paginate(
        `${this.#repositoryPath()}/check-suites/${suiteId}/check-runs?filter=all&per_page=100`,
        (body) => {
          const result = requireObject(body, "check runs");
          checkRunTotal = consistentTotal(result.total_count, checkRunTotal, "check run");
          return requireArray(result.check_runs, "check runs");
        },
        options,
      );
      assertComplete(suiteRuns, checkRunTotal, `check runs for suite ${suiteId}`);
      checkRuns.push(...suiteRuns);
    }

    const allSources = [
      ...checkRuns.map((value) => parseCheckRun(value, pullRequest.headSha)),
      ...statuses.map(parseStatus),
    ];
    assertUnique(allSources, (source) => `${source.kind}:${source.id}`, "check source");
    const latest = new Map<string, ParsedCheckSource>();
    for (const source of allSources) {
      const key = `${source.producer}\0${source.name}`;
      const previous = latest.get(key);
      if (
        previous === undefined ||
        source.order > previous.order ||
        (source.order === previous.order &&
          `${source.kind}:${source.id}` > `${previous.kind}:${previous.id}`)
      ) {
        latest.set(key, source);
      }
    }
    const sources = [...latest.values()]
      .filter(
        (source) =>
          source.name === name && (producer === undefined || source.producer === producer),
      )
      .sort(compareCheckSources)
      .map(({ order: _order, ...source }) => source);
    await this.#assertPinned(pullRequest, options);
    const aggregate = aggregateCheckStatus(sources);
    return {
      name,
      ...(producer === undefined ? {} : { producer }),
      status: producer === undefined && aggregate === "passed" ? "failed" : aggregate,
      headSha: pullRequest.headSha,
      sources,
    };
  }

  async #loadPullRequest(options: GitHubRequestOptions): Promise<GitHubPullRequest> {
    const pullRequest = parsePullRequest(
      await this.#client.get(
        `${this.#repositoryPath()}/pulls/${this.#options.pullRequestNumber}`,
        options,
      ),
    );
    this.#validatePinnedPullRequest(pullRequest);
    return pullRequest;
  }

  async #mergeBase(pullRequest: GitHubPullRequest, options: GitHubRequestOptions): Promise<string> {
    const comparison = requireObject(
      await this.#client.get(
        `${this.#repositoryPath()}/compare/${encodeURIComponent(pullRequest.baseSha)}...${encodeURIComponent(pullRequest.headSha)}`,
        options,
      ),
      "comparison",
    );
    const baseCommit = requireObject(comparison.base_commit, "comparison base_commit");
    const mergeBase = requireObject(comparison.merge_base_commit, "comparison merge_base_commit");
    const resolvedBase = requireSha(baseCommit.sha, "comparison base commit sha");
    if (resolvedBase !== pullRequest.baseSha)
      throw new GitHubProviderError(
        "GITHUB_RESPONSE",
        `Comparison resolved base ${resolvedBase}, expected ${pullRequest.baseSha}`,
      );
    return requireSha(mergeBase.sha, "comparison merge base sha");
  }

  async #fileVersion(
    repository: string,
    commitSha: string,
    path: string,
    options: GitHubRequestOptions,
  ): Promise<GitHubFileVersion> {
    const key = `${repository}\0${commitSha}\0${path}`;
    if (options.signal || options.timeoutMs !== undefined)
      return copyFileVersion(await this.#loadFileVersion(repository, commitSha, path, options));
    let version = this.#versions.get(key);
    if (!version) {
      version = this.#loadFileVersion(repository, commitSha, path, options);
      this.#versions.set(key, version);
      void version.catch(() => {
        if (this.#versions.get(key) === version) this.#versions.delete(key);
      });
    }
    return copyFileVersion(await version);
  }

  async #loadFileVersion(
    repository: string,
    commitSha: string,
    path: string,
    options: GitHubRequestOptions,
  ): Promise<GitHubFileVersion> {
    const normalizedPath = normalizeChangedPath(path, "file version path");
    const metadata = requireObject(
      await this.#client.get(
        `${repositoryPath(repository)}/contents/${encodePath(normalizedPath)}?ref=${encodeURIComponent(commitSha)}`,
        options,
      ),
      "repository content",
    );
    const resolvedPath = normalizeChangedPath(
      requireString(metadata.path, "repository content path"),
      "repository content path",
    );
    if (resolvedPath !== normalizedPath)
      throw new GitHubProviderError(
        "GITHUB_RESPONSE",
        `Repository content resolved ${JSON.stringify(resolvedPath)}, expected ${JSON.stringify(normalizedPath)}`,
      );
    const blobSha = requireSha(metadata.sha, "repository content sha");
    const content = await this.#blob(repository, blobSha, options);
    return { path: normalizedPath, commitSha, sha: blobSha, content };
  }

  async #blob(repository: string, sha: string, options: GitHubRequestOptions): Promise<Uint8Array> {
    const key = `${repository}\0${sha}`;
    if (options.signal || options.timeoutMs !== undefined)
      return copyBytes(await this.#loadBlob(repository, sha, options));
    let blob = this.#blobs.get(key);
    if (!blob) {
      blob = this.#loadBlob(repository, sha, options);
      this.#blobs.set(key, blob);
      void blob.catch(() => {
        if (this.#blobs.get(key) === blob) this.#blobs.delete(key);
      });
    }
    return copyBytes(await blob);
  }

  async #loadBlob(
    repository: string,
    sha: string,
    options: GitHubRequestOptions,
  ): Promise<Uint8Array> {
    const blob = requireObject(
      await this.#client.get(
        `${repositoryPath(repository)}/git/blobs/${encodeURIComponent(sha)}`,
        options,
      ),
      "Git blob",
    );
    const responseSha = requireSha(blob.sha, "Git blob sha");
    if (responseSha !== sha)
      throw new GitHubProviderError(
        "GITHUB_RESPONSE",
        `GitHub returned blob ${responseSha}, expected ${sha}`,
      );
    if (requireString(blob.encoding, "Git blob encoding") !== "base64")
      throw new GitHubProviderError("GITHUB_RESPONSE", "GitHub Git blob was not base64 encoded");
    const size = requireInteger(blob.size, "Git blob size");
    if (size < 0)
      throw new GitHubProviderError("GITHUB_RESPONSE", "GitHub Git blob size was negative");
    if (size > this.maxBlobBytes)
      throw new GitHubProviderError(
        "GITHUB_TRUNCATED",
        `GitHub Git blob exceeds the configured ${this.maxBlobBytes}-byte limit`,
      );
    const content = decodeBase64(requireBlobContent(blob.content), this.maxBlobBytes);
    if (size !== content.byteLength)
      throw new GitHubProviderError("GITHUB_RESPONSE", "GitHub Git blob size was inconsistent");
    if (gitBlobSha(content, sha.length) !== sha)
      throw new GitHubProviderError(
        "GITHUB_RESPONSE",
        `Git blob content does not hash to its claimed object ID ${sha}`,
      );
    return content;
  }

  async #assertPinned(expected: GitHubPullRequest, options: GitHubRequestOptions): Promise<void> {
    const current = parsePullRequest(
      await this.#client.get(
        `${this.#repositoryPath()}/pulls/${this.#options.pullRequestNumber}`,
        options,
      ),
    );
    this.#validatePinnedPullRequest(current);
    if (
      current.baseRepository !== expected.baseRepository ||
      current.headRepository !== expected.headRepository
    )
      throw new GitHubProviderError(
        "GITHUB_INCONSISTENT_HEAD",
        "Pull request repositories changed during evaluation",
        { retryable: true },
      );
  }

  #validatePinnedPullRequest(pullRequest: GitHubPullRequest): void {
    if (pullRequest.number !== this.#options.pullRequestNumber)
      throw new GitHubProviderError(
        "GITHUB_RESPONSE",
        "GitHub returned a different pull request number",
      );
    if (
      pullRequest.baseRepository.toLowerCase() !==
      `${this.#options.owner}/${this.#options.repo}`.toLowerCase()
    )
      throw new GitHubProviderError(
        "GITHUB_RESPONSE",
        "GitHub returned a pull request for a different base repository",
      );
    if (
      pullRequest.headRepository.toLowerCase() !==
      this.#options.expectedHeadRepository.toLowerCase()
    )
      throw new GitHubProviderError(
        "GITHUB_INCONSISTENT_HEAD",
        `Pull request head repository is ${pullRequest.headRepository}, expected ${this.#options.expectedHeadRepository}`,
        { retryable: true },
      );
    if (
      pullRequest.baseSha !== this.#options.expectedBaseSha.toLowerCase() ||
      pullRequest.headSha !== this.#options.expectedHeadSha.toLowerCase()
    )
      throw new GitHubProviderError(
        "GITHUB_INCONSISTENT_HEAD",
        `Pull request is ${pullRequest.baseSha}...${pullRequest.headSha}, expected ${this.#options.expectedBaseSha}...${this.#options.expectedHeadSha}`,
        { retryable: true },
      );
  }

  #repositoryPath(): string {
    return repositoryPath(`${this.#options.owner}/${this.#options.repo}`);
  }
}

function parsePullRequest(value: unknown): GitHubPullRequest {
  const pullRequest = requireObject(value, "pull request");
  const base = requireObject(pullRequest.base, "pull request base");
  const head = requireObject(pullRequest.head, "pull request head");
  const state = requireString(pullRequest.state, "pull request state");
  if (state !== "open" && state !== "closed")
    throw new GitHubProviderError(
      "GITHUB_RESPONSE",
      `Unknown pull request state ${JSON.stringify(state)}`,
    );
  return {
    id: requireString(pullRequest.node_id, "pull request node_id"),
    databaseId: requireInteger(pullRequest.id, "pull request id"),
    number: requireInteger(pullRequest.number, "pull request number"),
    author: parseUser(pullRequest.user, "pull request author"),
    baseSha: requireSha(base.sha, "pull request base sha"),
    headSha: requireSha(head.sha, "pull request head sha"),
    baseRepository: requireRepositoryFullName(base.repo, "pull request base repository"),
    headRepository: requireRepositoryFullName(head.repo, "pull request head repository"),
    changedFileCount: requireNonNegativeInteger(
      pullRequest.changed_files,
      "pull request changed_files",
    ),
    draft: requireBoolean(pullRequest.draft, "pull request draft"),
    state,
  };
}

function parseChangedFile(value: unknown): ParsedChangedFile {
  const file = requireObject(value, "pull request file");
  const path = normalizeChangedPath(
    requireString(file.filename, "changed file name"),
    "changed file name",
  );
  const rawStatus = requireString(file.status, "changed file status");
  const previous = optionalString(file.previous_filename, "previous file name");
  const status = normalizeChangeStatus(rawStatus);
  const previousPath =
    status === "renamed"
      ? normalizeChangedPath(
          previous ?? missingPreviousPath(path),
          "renamed file previous file name",
        )
      : undefined;
  if (previousPath === path)
    throw new GitHubProviderError("GITHUB_RESPONSE", "Renamed file paths must be distinct");
  return {
    path,
    ...(previousPath === undefined ? {} : { previousPath }),
    status,
    githubBlobSha: requireSha(file.sha, "changed file sha"),
    additions: requireNonNegativeInteger(file.additions, "file additions"),
    deletions: requireNonNegativeInteger(file.deletions, "file deletions"),
    changes: requireNonNegativeInteger(file.changes, "file changes"),
  };
}

function normalizeChangeStatus(status: string): GitHubChange["status"] {
  switch (status.toLowerCase()) {
    case "added":
    case "copied":
      return "added";
    case "modified":
    case "changed":
      return "modified";
    case "removed":
    case "deleted":
      return "deleted";
    case "renamed":
      return "renamed";
    default:
      throw new GitHubProviderError(
        "GITHUB_RESPONSE",
        `Unknown GitHub change status ${JSON.stringify(status)}`,
      );
  }
}

function parseOpinionatedReview(value: unknown): ParsedReview | undefined {
  const review = requireObject(value, "pull request review");
  // Deleted users cannot provide the immutable identity needed for review reduction.
  if (review.user === null || review.user === undefined) return undefined;
  const state = requireString(review.state, "review state").toUpperCase();
  if (state === "COMMENTED" || state === "PENDING") return undefined;
  if (state !== "APPROVED" && state !== "CHANGES_REQUESTED" && state !== "DISMISSED")
    throw new GitHubProviderError(
      "GITHUB_RESPONSE",
      `Unknown opinionated review state ${JSON.stringify(state)}`,
    );
  return {
    id: requireInteger(review.id, "review id"),
    state,
    commitId: requireSha(review.commit_id, "review commit_id"),
    submittedAt: requireTimestamp(review.submitted_at, "review submitted_at"),
    user: parseUser(review.user, "review user"),
  };
}

function parseTeam(value: unknown, organization: string): GitHubTeam {
  const team = requireObject(value, "team");
  return {
    id: requireString(team.node_id, "team node_id"),
    databaseId: requireInteger(team.id, "team id"),
    slug: requireString(team.slug, "team slug"),
    name: requireString(team.name, "team name"),
    organization,
  };
}

function parseUser(value: unknown, label: string): GitHubUser {
  const user = requireObject(value, label);
  return {
    id: requireString(user.node_id, `${label} node_id`),
    databaseId: requireInteger(user.id, `${label} id`),
    login: requireString(user.login, `${label} login`),
  };
}

function parseCheckRun(value: unknown, expectedHeadSha: string): ParsedCheckSource {
  const run = requireObject(value, "check run");
  const app = requireObject(run.app, "check run app");
  const headSha = requireSha(run.head_sha, "check run head_sha");
  if (headSha !== expectedHeadSha)
    throw new GitHubProviderError(
      "GITHUB_INCONSISTENT_HEAD",
      `Check run resolved ${headSha}, expected ${expectedHeadSha}`,
    );
  const status = requireString(run.status, "check run status").toLowerCase();
  const conclusion = optionalString(run.conclusion, "check run conclusion")?.toLowerCase();
  const timestamp =
    optionalTimestamp(run.completed_at, "check run completed_at") ??
    optionalTimestamp(run.started_at, "check run started_at") ??
    requireTimestampValue(run.created_at, "check run created_at");
  const url = optionalString(run.html_url, "check run URL");
  const producerName = optionalString(app.slug, "check run app slug") ?? undefined;
  return {
    kind: "check-run",
    id: requireString(run.node_id, "check run node_id"),
    name: requireString(run.name, "check run name"),
    producer: `app:${requirePositiveInteger(app.id, "check run app id")}`,
    ...(producerName === undefined ? {} : { producerName }),
    status: checkRunStatus(status, conclusion),
    rawState: status === "completed" ? (conclusion ?? "missing-conclusion") : status,
    timestamp: timestamp.value,
    order: timestamp.order,
    ...(url === undefined ? {} : { url }),
  };
}

function parseStatus(value: unknown): ParsedCheckSource {
  const status = requireObject(value, "commit status");
  const creator = requireObject(status.creator, "commit status creator");
  const rawState = requireString(status.state, "commit status state").toLowerCase();
  const timestamp =
    optionalTimestamp(status.updated_at, "commit status updated_at") ??
    requireTimestampValue(status.created_at, "commit status created_at");
  const url = optionalString(status.target_url, "commit status URL");
  const producerName = optionalString(creator.login, "commit status creator login") ?? undefined;
  return {
    kind: "status",
    id: requireString(status.node_id, "commit status node_id"),
    name: requireString(status.context, "commit status context"),
    producer: `status:${requireProducerNodeId(creator.node_id)}`,
    ...(producerName === undefined ? {} : { producerName }),
    status: commitStatus(rawState),
    rawState,
    timestamp: timestamp.value,
    order: timestamp.order,
    ...(url === undefined ? {} : { url }),
  };
}

function checkRunStatus(
  status: string,
  conclusion: string | undefined,
): Exclude<GitHubCheckState, "missing"> {
  if (status !== "completed") return "pending";
  if (conclusion === "success") return "passed";
  if (conclusion === "cancelled") return "cancelled";
  return "failed";
}

function commitStatus(value: string): Exclude<GitHubCheckState, "missing"> {
  if (value === "success") return "passed";
  if (value === "pending") return "pending";
  return "failed";
}

function aggregateCheckStatus(sources: readonly GitHubCheckSource[]): GitHubCheckState {
  if (sources.length === 0) return "missing";
  if (sources.some((source) => source.status === "failed")) return "failed";
  if (sources.some((source) => source.status === "cancelled")) return "cancelled";
  if (sources.some((source) => source.status === "pending")) return "pending";
  return "passed";
}

function compareUsers(left: GitHubUser, right: GitHubUser): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function copyFileVersion(version: GitHubFileVersion): GitHubFileVersion {
  return { ...version, content: copyBytes(version.content) };
}

function copyBytes(content: Uint8Array): Uint8Array {
  const copy = new Uint8Array(content.byteLength);
  copy.set(content);
  return copy;
}

function compareCheckSources(left: GitHubCheckSource, right: GitHubCheckSource): number {
  const leftKey = `${left.producer}\0${left.name}\0${left.kind}\0${left.id}`;
  const rightKey = `${right.producer}\0${right.name}\0${right.kind}\0${right.id}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function consistentTotal(value: unknown, previous: number | undefined, label: string): number {
  const total = requireNonNegativeInteger(value, `${label} total_count`);
  if (previous !== undefined && previous !== total)
    throw new GitHubProviderError(
      "GITHUB_RESPONSE",
      `GitHub ${label} total changed during pagination`,
    );
  return total;
}

function assertComplete(
  values: readonly unknown[],
  total: number | undefined,
  label: string,
): void {
  if (total === undefined || values.length !== total)
    throw new GitHubProviderError(
      "GITHUB_TRUNCATED",
      `GitHub returned ${values.length} of ${total ?? "an unknown number of"} ${label}`,
    );
}

function assertUnique<T>(values: readonly T[], key: (value: T) => string, label: string): void {
  const found = new Set<string>();
  for (const value of values) {
    const identity = key(value);
    if (found.has(identity))
      throw new GitHubProviderError(
        "GITHUB_RESPONSE",
        `GitHub returned duplicate ${label} ${JSON.stringify(identity)}`,
      );
    found.add(identity);
  }
}

function repositoryPath(repository: string): string {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part ?? "")))
    throw new GitHubProviderError("GITHUB_RESPONSE", "GitHub repository name was invalid");
  return `repos/${encodeURIComponent(parts[0]!)}/${encodeURIComponent(parts[1]!)}`;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function normalizeChangedPath(value: string, label: string): string {
  let normalized: string;
  try {
    normalized = normalizeRepositoryPath(value);
  } catch (error) {
    throw new GitHubProviderError("GITHUB_RESPONSE", `GitHub ${label} was invalid`, {
      cause: error,
    });
  }
  if (normalized === "" || normalized !== value)
    throw new GitHubProviderError("GITHUB_RESPONSE", `GitHub ${label} was not canonical`);
  return normalized;
}

function missingPreviousPath(path: string): never {
  throw new GitHubProviderError(
    "GITHUB_RESPONSE",
    `Renamed file ${JSON.stringify(path)} has no previous_filename`,
  );
}

function requireRepositoryFullName(value: unknown, label: string): string {
  const repository = requireObject(value, label);
  const fullName = requireString(repository.full_name, `${label} full_name`);
  repositoryPath(fullName);
  return fullName;
}

function requireObject(value: unknown, label: string): RawObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new GitHubProviderError("GITHUB_RESPONSE", `GitHub ${label} was not an object`);
  return value as RawObject;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value))
    throw new GitHubProviderError("GITHUB_RESPONSE", `GitHub ${label} was not an array`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new GitHubProviderError("GITHUB_RESPONSE", `GitHub ${label} was missing or invalid`);
  return value;
}

function requireBlobContent(value: unknown): string {
  if (typeof value !== "string")
    throw new GitHubProviderError(
      "GITHUB_RESPONSE",
      "GitHub Git blob content was missing or invalid",
    );
  return value;
}

function requireProducerNodeId(value: unknown): string {
  const id = requireString(value, "commit status creator node_id");
  if (/[\0\r\n]/.test(id))
    throw new GitHubProviderError(
      "GITHUB_RESPONSE",
      "GitHub commit status creator node_id was invalid",
    );
  return id;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return requireString(value, label);
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new GitHubProviderError("GITHUB_RESPONSE", `GitHub ${label} was missing or invalid`);
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  const result = requireInteger(value, label);
  if (result < 0) throw new GitHubProviderError("GITHUB_RESPONSE", `GitHub ${label} was negative`);
  return result;
}

function requirePositiveInteger(value: unknown, label: string): number {
  const result = requireInteger(value, label);
  if (result <= 0)
    throw new GitHubProviderError("GITHUB_RESPONSE", `GitHub ${label} was not positive`);
  return result;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean")
    throw new GitHubProviderError("GITHUB_RESPONSE", `GitHub ${label} was missing or invalid`);
  return value;
}

function requireSha(value: unknown, label: string): string {
  const sha = requireString(value, label).toLowerCase();
  if (!SHA.test(sha))
    throw new GitHubProviderError("GITHUB_RESPONSE", `GitHub ${label} was invalid`);
  return sha;
}

function requireTimestamp(value: unknown, label: string): number {
  return requireTimestampValue(value, label).order;
}

function optionalTimestamp(
  value: unknown,
  label: string,
): { readonly value: string; readonly order: number } | undefined {
  if (value === null || value === undefined) return undefined;
  return requireTimestampValue(value, label);
}

function requireTimestampValue(
  value: unknown,
  label: string,
): { readonly value: string; readonly order: number } {
  const timestamp = requireString(value, label);
  const order = Date.parse(timestamp);
  if (!Number.isFinite(order))
    throw new GitHubProviderError("GITHUB_RESPONSE", `GitHub ${label} was invalid`);
  return { value: timestamp, order };
}

function decodeBase64(value: string, maximumBytes: number): Uint8Array {
  let compactLength = 0;
  let previous = "";
  let last = "";
  for (const character of value) {
    if (character === "\r" || character === "\n") continue;
    compactLength += 1;
    previous = last;
    last = character;
  }
  const padding = previous === "=" && last === "=" ? 2 : last === "=" ? 1 : 0;
  if (compactLength % 4 !== 0)
    throw new GitHubProviderError("GITHUB_RESPONSE", "GitHub Git blob content was invalid base64");
  const decodedLength = Math.floor(compactLength / 4) * 3 - padding;
  if (decodedLength < 0)
    throw new GitHubProviderError("GITHUB_RESPONSE", "GitHub Git blob content was invalid base64");
  if (decodedLength > maximumBytes)
    throw new GitHubProviderError(
      "GITHUB_TRUNCATED",
      `GitHub Git blob exceeds the configured ${maximumBytes}-byte limit`,
    );
  const compact = value.replace(/[\r\n]/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact))
    throw new GitHubProviderError("GITHUB_RESPONSE", "GitHub Git blob content was invalid base64");
  if (!hasCanonicalBase64TrailingBits(compact))
    throw new GitHubProviderError("GITHUB_RESPONSE", "GitHub Git blob content was invalid base64");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = new Uint8Array(decodedLength);
  let output = 0;
  for (let index = 0; index < compact.length; index += 4) {
    const first = alphabet.indexOf(compact.charAt(index));
    const second = alphabet.indexOf(compact.charAt(index + 1));
    const thirdCharacter = compact.charAt(index + 2);
    const fourthCharacter = compact.charAt(index + 3);
    const third = thirdCharacter === "=" ? 0 : alphabet.indexOf(thirdCharacter);
    const fourth = fourthCharacter === "=" ? 0 : alphabet.indexOf(fourthCharacter);
    const combined = first * 262_144 + second * 4_096 + third * 64 + fourth;
    bytes[output++] = Math.floor(combined / 65_536) % 256;
    if (thirdCharacter !== "=") bytes[output++] = Math.floor(combined / 256) % 256;
    if (fourthCharacter !== "=") bytes[output++] = combined % 256;
  }
  return bytes;
}

function hasCanonicalBase64TrailingBits(value: string): boolean {
  if (value.endsWith("==")) return base64Value(value.charAt(value.length - 3)) % 16 === 0;
  if (value.endsWith("=")) return base64Value(value.charAt(value.length - 2)) % 4 === 0;
  return true;
}

function base64Value(value: string): number {
  return "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(value);
}

function gitBlobSha(content: Uint8Array, length: number): string {
  const header = new TextEncoder().encode(`blob ${content.byteLength}\0`);
  const object = new Uint8Array(header.byteLength + content.byteLength);
  object.set(header);
  object.set(content, header.byteLength);
  return createHash(length === 40 ? "sha1" : "sha256")
    .update(object)
    .digest("hex");
}
