import { GitHubProviderError } from "./errors.js";

export const GITHUB_API_VERSION = "2022-11-28" as const;

export interface GitHubRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface GitHubClientOptions {
  readonly token: string;
  readonly apiUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly injectedFetch: boolean;
  readonly allowInsecureHttpForTests: boolean;
  readonly timeoutMs: number;
  readonly maxPages: number;
  readonly maxItems: number;
  readonly maxResponseBytes: number;
}

interface GitHubResponse {
  readonly body: unknown;
  readonly next?: string;
}

export class GitHubClient {
  readonly #options: GitHubClientOptions;
  readonly #baseUrl: URL;

  constructor(options: GitHubClientOptions) {
    this.#options = options;
    this.#baseUrl = new URL(options.apiUrl.endsWith("/") ? options.apiUrl : `${options.apiUrl}/`);
    if (
      this.#baseUrl.username ||
      this.#baseUrl.password ||
      this.#baseUrl.hash ||
      this.#baseUrl.search
    )
      throw new TypeError("GitHub API URL cannot contain credentials, a query, or a fragment");
    if (
      this.#baseUrl.protocol !== "https:" &&
      !(
        options.injectedFetch &&
        options.allowInsecureHttpForTests &&
        this.#baseUrl.protocol === "http:"
      )
    )
      throw new TypeError("GitHub API URL must use HTTPS");
  }

  async get(path: string, options: GitHubRequestOptions = {}): Promise<unknown> {
    return (await this.#request(path, options)).body;
  }

  async paginate(
    path: string,
    select: (body: unknown) => readonly unknown[],
    options: GitHubRequestOptions = {},
  ): Promise<readonly unknown[]> {
    const values: unknown[] = [];
    const visited = new Set<string>();
    let page = 0;
    let next: string | undefined = path;
    while (next) {
      const resolved = this.#resolveUrl(next);
      if (visited.has(resolved))
        throw new GitHubProviderError("GITHUB_RESPONSE", "GitHub pagination contained a cycle");
      visited.add(resolved);
      page += 1;
      if (page > this.#options.maxPages)
        throw new GitHubProviderError(
          "GITHUB_TRUNCATED",
          `GitHub pagination exceeded the configured ${this.#options.maxPages}-page limit`,
        );
      const response = await this.#request(resolved, options);
      const pageValues = select(response.body);
      if (values.length + pageValues.length > this.#options.maxItems)
        throw new GitHubProviderError(
          "GITHUB_TRUNCATED",
          `GitHub response exceeded the configured ${this.#options.maxItems}-item limit`,
        );
      values.push(...pageValues);
      next = response.next;
      if (next && page >= this.#options.maxPages)
        throw new GitHubProviderError(
          "GITHUB_TRUNCATED",
          `GitHub pagination exceeded the configured ${this.#options.maxPages}-page limit`,
        );
    }
    return values;
  }

  async #request(path: string, options: GitHubRequestOptions): Promise<GitHubResponse> {
    const url = this.#resolveUrl(path);
    const timeoutMs = options.timeoutMs ?? this.#options.timeoutMs;
    if (timeoutMs <= 0) throw new TypeError("GitHub request timeout must be positive");
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("GitHub request timed out")),
      timeoutMs,
    );
    try {
      const response = await this.#options.fetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.#options.token}`,
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.redirected)
        throw new GitHubProviderError(
          "GITHUB_RESPONSE",
          "GitHub fetch followed a redirect despite redirect: manual",
        );
      if (response.status >= 300 && response.status < 400)
        throw new GitHubProviderError("GITHUB_RESPONSE", "GitHub API redirects are not permitted");
      if (!response.url)
        throw new GitHubProviderError("GITHUB_RESPONSE", "GitHub response had no final URL");
      this.#assertResponseUrl(response.url, url);
      const bytes = await readBoundedResponse(response, this.#options.maxResponseBytes);
      if (!response.ok) throwResponseError(response, bytes);
      return {
        body: parseJson(bytes),
        ...(nextLink(response.headers.get("link"))
          ? { next: nextLink(response.headers.get("link")) }
          : {}),
      };
    } catch (error) {
      if (error instanceof GitHubProviderError) throw error;
      if (options.signal?.aborted)
        throw new GitHubProviderError("GITHUB_ABORTED", "GitHub request was aborted", {
          cause: options.signal.reason,
        });
      if (controller.signal.aborted)
        throw new GitHubProviderError(
          "GITHUB_TIMEOUT",
          `GitHub request timed out after ${timeoutMs}ms`,
          { retryable: true, cause: error },
        );
      throw new GitHubProviderError("GITHUB_API", `GitHub request failed: ${errorMessage(error)}`, {
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  #resolveUrl(path: string): string {
    const url = new URL(
      /^https?:\/\//i.test(path) ? path : `${this.#baseUrl.toString()}${path.replace(/^\//, "")}`,
    );
    if (!sameApiLocation(url, this.#baseUrl))
      throw new GitHubProviderError(
        "GITHUB_RESPONSE",
        "GitHub pagination attempted to leave the configured API origin",
      );
    return url.toString();
  }

  #assertResponseUrl(responseUrl: string, requestedUrl: string): void {
    const response = new URL(responseUrl);
    if (!sameApiLocation(response, this.#baseUrl) || response.toString() !== requestedUrl)
      throw new GitHubProviderError(
        "GITHUB_RESPONSE",
        "GitHub response final URL did not match the authenticated request URL",
      );
  }
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(declared))
      throw new GitHubProviderError("GITHUB_RESPONSE", "GitHub returned an invalid Content-Length");
    const length = Number(declared);
    if (!Number.isSafeInteger(length))
      throw new GitHubProviderError("GITHUB_RESPONSE", "GitHub returned an invalid Content-Length");
    if (length > maximumBytes)
      throw new GitHubProviderError(
        "GITHUB_TRUNCATED",
        `GitHub response exceeds the configured ${maximumBytes}-byte limit`,
      );
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximumBytes)
        throw new GitHubProviderError(
          "GITHUB_TRUNCATED",
          `GitHub response exceeds the configured ${maximumBytes}-byte limit`,
        );
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    throw new GitHubProviderError("GITHUB_RESPONSE", "GitHub returned invalid JSON", {
      cause: error,
    });
  }
}

function throwResponseError(response: Response, bytes: Uint8Array): never {
  const status = response.status;
  const remaining = response.headers.get("x-ratelimit-remaining");
  const retryAfter = response.headers.get("retry-after") ?? undefined;
  const rateLimitReset = response.headers.get("x-ratelimit-reset") ?? undefined;
  let message = response.statusText;
  try {
    const body = parseJson(bytes) as { message?: unknown };
    if (typeof body.message === "string") message = body.message;
  } catch {
    // HTTP status remains sufficient when an error body is not JSON.
  }
  if (status === 401)
    throw new GitHubProviderError(
      "GITHUB_AUTHENTICATION",
      `GitHub authentication failed: ${message}`,
      { status },
    );
  if (
    status === 429 ||
    (status === 403 &&
      (remaining === "0" ||
        retryAfter !== undefined ||
        /(?:secondary |abuse |primary )?rate limit/i.test(message)))
  )
    throw new GitHubProviderError("GITHUB_RATE_LIMIT", `GitHub rate limit exceeded: ${message}`, {
      status,
      retryable: true,
      retryAfter: retryAfter ?? (remaining === "0" ? rateLimitReset : undefined),
    });
  if (status === 403)
    throw new GitHubProviderError("GITHUB_PERMISSION", `GitHub permission denied: ${message}`, {
      status,
    });
  if (status === 404)
    throw new GitHubProviderError(
      "GITHUB_NOT_FOUND",
      `GitHub resource not found or inaccessible: ${message}`,
      { status },
    );
  throw new GitHubProviderError("GITHUB_API", `GitHub API returned ${status}: ${message}`, {
    status,
    retryable: status >= 500,
  });
}

function sameApiLocation(url: URL, base: URL): boolean {
  return (
    url.protocol === base.protocol &&
    url.host === base.host &&
    !url.username &&
    !url.password &&
    !url.hash &&
    url.pathname.startsWith(base.pathname)
  );
}

function nextLink(value: string | null): string | undefined {
  if (!value) return undefined;
  for (const part of value.split(",")) {
    const match = /^\s*<([^>]+)>\s*((?:;\s*[^;]+)*)$/.exec(part);
    const relation = /(?:^|;)\s*rel="([^"]+)"(?:;|$)/.exec(match?.[2] ?? "");
    if (relation?.[1]?.split(/\s+/).includes("next")) return match?.[1];
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
