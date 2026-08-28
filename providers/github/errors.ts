export type GitHubErrorCode =
  | "GITHUB_CONTEXT"
  | "GITHUB_AUTHENTICATION"
  | "GITHUB_PERMISSION"
  | "GITHUB_RATE_LIMIT"
  | "GITHUB_NOT_FOUND"
  | "GITHUB_TRUNCATED"
  | "GITHUB_INCONSISTENT_HEAD"
  | "GITHUB_API"
  | "GITHUB_RESPONSE"
  | "GITHUB_TIMEOUT"
  | "GITHUB_ABORTED"
  | "GITHUB_MATERIALIZATION";

export class GitHubProviderError extends Error {
  readonly code: GitHubErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfter?: string;

  constructor(
    code: GitHubErrorCode,
    message: string,
    options: {
      readonly status?: number;
      readonly retryable?: boolean;
      readonly retryAfter?: string;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GitHubProviderError";
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.retryAfter = options.retryAfter;
  }
}
