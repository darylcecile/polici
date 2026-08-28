export interface GitHubRepositoryContext {
  readonly owner: string;
  readonly repo: string;
  readonly pullRequestNumber: number;
  readonly expectedBaseSha: string;
  readonly expectedHeadSha: string;
  readonly expectedHeadRepository: string;
}

export interface GitHubActionsEnvironment {
  readonly GITHUB_EVENT_PATH?: string;
  readonly GITHUB_REPOSITORY?: string;
}

export interface GitHubUser {
  readonly id: string;
  readonly databaseId: number;
  readonly login: string;
}

export interface GitHubTeam {
  readonly id: string;
  readonly databaseId: number;
  readonly slug: string;
  readonly name: string;
  readonly organization: string;
}

export interface GitHubPullRequest {
  readonly id: string;
  readonly databaseId: number;
  readonly number: number;
  readonly author: GitHubUser;
  readonly baseSha: string;
  readonly headSha: string;
  readonly baseRepository: string;
  readonly headRepository: string;
  readonly changedFileCount: number;
  readonly draft: boolean;
  readonly state: "open" | "closed";
}

export type GitHubChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface GitHubFileVersion {
  readonly path: string;
  readonly commitSha: string;
  /** Immutable Git blob object ID. */
  readonly sha: string;
  readonly content: Uint8Array;
}

export interface GitHubChange {
  readonly path: string;
  readonly status: GitHubChangeStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly before?: GitHubFileVersion;
  readonly after?: GitHubFileVersion;
}

export interface GitHubChangeSet {
  readonly mergeBaseSha: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly changes: readonly GitHubChange[];
}

export type GitHubCheckState = "passed" | "pending" | "failed" | "cancelled" | "missing";

export interface GitHubCheckSource {
  readonly kind: "check-run" | "status";
  readonly id: string;
  readonly name: string;
  /** Immutable selector: `app:<database id>` or `status:<creator node id>`. */
  readonly producer: string;
  readonly producerName?: string;
  readonly status: Exclude<GitHubCheckState, "missing">;
  readonly rawState: string;
  readonly timestamp?: string;
  readonly url?: string;
}

export interface GitHubCheck {
  readonly name: string;
  readonly producer?: string;
  readonly status: GitHubCheckState;
  readonly headSha: string;
  readonly sources: readonly GitHubCheckSource[];
}

export interface GitHubProviderOptions extends GitHubRepositoryContext {
  readonly token: string;
  readonly apiUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Test-only escape hatch. Requires an injected fetch implementation. */
  readonly allowInsecureHttpForTests?: boolean;
  readonly timeoutMs?: number;
  readonly maxPages?: number;
  readonly maxItems?: number;
  readonly maxResponseBytes?: number;
  readonly maxBlobBytes?: number;
}
