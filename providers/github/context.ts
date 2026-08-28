// @ts-ignore This bare repository intentionally does not depend on @types/node.
import { readFileSync } from "node:fs";

import { GitHubProviderError } from "./errors.js";
import type { GitHubActionsEnvironment, GitHubRepositoryContext } from "./types.js";

const OWNER_OR_REPO = /^[A-Za-z0-9_.-]+$/;
const SHA = /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/;

export function githubContextFromActions(
  environment: GitHubActionsEnvironment,
  overrides: Partial<GitHubRepositoryContext> = {},
): GitHubRepositoryContext {
  if (!environment.GITHUB_EVENT_PATH)
    throw new GitHubProviderError(
      "GITHUB_CONTEXT",
      "GITHUB_EVENT_PATH is required for an immutable pull request context",
    );
  let event: unknown;
  try {
    event = JSON.parse(
      new TextDecoder().decode(readFileSync(environment.GITHUB_EVENT_PATH)),
    ) as unknown;
  } catch (error) {
    throw new GitHubProviderError("GITHUB_CONTEXT", "GITHUB_EVENT_PATH is not valid event JSON", {
      cause: error,
    });
  }
  return githubContextFromEvent(event, environment.GITHUB_REPOSITORY, overrides);
}

export function githubContextFromEvent(
  value: unknown,
  environmentRepository?: string,
  overrides: Partial<GitHubRepositoryContext> = {},
): GitHubRepositoryContext {
  const event = requireObject(value, "event");
  const pullRequest = requireObject(event.pull_request, "event pull_request");
  const base = requireObject(pullRequest.base, "pull request base");
  const head = requireObject(pullRequest.head, "pull request head");
  const repository = requireObject(event.repository, "event repository");
  const baseRepository = requireObject(base.repo, "pull request base repository");
  const headRepository = requireObject(head.repo, "pull request head repository");
  const repositoryName = requireString(repository.full_name, "event repository full_name");
  const baseRepositoryName = requireString(baseRepository.full_name, "base repository full_name");
  const headRepositoryName = requireString(headRepository.full_name, "head repository full_name");
  requireRepositoryName(headRepositoryName, "head repository full_name");
  if (repositoryName.toLowerCase() !== baseRepositoryName.toLowerCase())
    throw new GitHubProviderError(
      "GITHUB_CONTEXT",
      "Pull request base repository does not match the event repository",
    );
  if (
    environmentRepository !== undefined &&
    environmentRepository.toLowerCase() !== repositoryName.toLowerCase()
  )
    throw new GitHubProviderError(
      "GITHUB_CONTEXT",
      "GITHUB_REPOSITORY does not match the event repository",
    );
  const [owner, repo] = requireRepositoryName(repositoryName, "event repository full_name");
  const eventNumber = requirePositiveInteger(event.number, "event pull request number");
  const embeddedNumber = requirePositiveInteger(pullRequest.number, "pull_request.number");
  if (eventNumber !== embeddedNumber)
    throw new GitHubProviderError(
      "GITHUB_CONTEXT",
      "Event and embedded pull request numbers do not match",
    );
  const context: GitHubRepositoryContext = {
    owner,
    repo,
    pullRequestNumber: eventNumber,
    expectedBaseSha: requireSha(base.sha, "pull request base sha"),
    expectedHeadSha: requireSha(head.sha, "pull request head sha"),
    expectedHeadRepository: headRepositoryName,
  };
  for (const [key, override] of Object.entries(overrides)) {
    if (
      override !== undefined &&
      String(context[key as keyof GitHubRepositoryContext]) !== String(override)
    )
      throw new GitHubProviderError(
        "GITHUB_CONTEXT",
        `Override ${key} does not match GITHUB_EVENT_PATH`,
      );
  }
  validateGitHubContext(context);
  return context;
}

export function validateGitHubContext(context: GitHubRepositoryContext): void {
  if (!OWNER_OR_REPO.test(context.owner))
    throw new GitHubProviderError("GITHUB_CONTEXT", "GitHub owner is missing or invalid");
  if (!OWNER_OR_REPO.test(context.repo))
    throw new GitHubProviderError("GITHUB_CONTEXT", "GitHub repository is missing or invalid");
  if (!Number.isSafeInteger(context.pullRequestNumber) || context.pullRequestNumber <= 0)
    throw new GitHubProviderError(
      "GITHUB_CONTEXT",
      "GitHub pull request number must be a positive integer",
    );
  if (!SHA.test(context.expectedBaseSha))
    throw new GitHubProviderError("GITHUB_CONTEXT", "Expected GitHub base SHA is invalid");
  if (!SHA.test(context.expectedHeadSha))
    throw new GitHubProviderError("GITHUB_CONTEXT", "Expected GitHub head SHA is invalid");
  requireRepositoryName(context.expectedHeadRepository, "expected head repository");
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new GitHubProviderError("GITHUB_CONTEXT", `${label} is missing or invalid`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "")
    throw new GitHubProviderError("GITHUB_CONTEXT", `${label} is missing or invalid`);
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new GitHubProviderError("GITHUB_CONTEXT", `${label} is missing or invalid`);
  return value;
}

function requireSha(value: unknown, label: string): string {
  const sha = requireString(value, label);
  if (!SHA.test(sha)) throw new GitHubProviderError("GITHUB_CONTEXT", `${label} is invalid`);
  return sha.toLowerCase();
}

function requireRepositoryName(value: unknown, label: string): readonly [string, string] {
  const parts = requireString(value, label).split("/");
  if (
    parts.length !== 2 ||
    !OWNER_OR_REPO.test(parts[0] ?? "") ||
    !OWNER_OR_REPO.test(parts[1] ?? "")
  )
    throw new GitHubProviderError("GITHUB_CONTEXT", `${label} must have owner/repository form`);
  return [parts[0]!, parts[1]!];
}
