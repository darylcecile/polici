import { nodeProcessRunner } from "../src/cli/process.js";
import { readGitFile, snapshotGitCommit } from "../src/cli/git.js";
import { checkPolicy } from "../src/index.js";
import {
  createGitHubResolverHost,
  githubBuiltin,
  githubContextFromActions,
} from "../providers/github/index.js";

declare const process: {
  env: Readonly<Record<string, string | undefined>>;
  cwd(): string;
  exitCode: number;
  stdout: { write(value: string): void };
};

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN or GH_TOKEN is required");

  const context = githubContextFromActions(process.env);
  const root = process.cwd();
  const repository = snapshotGitCommit(
    root,
    context.expectedHeadSha,
    process.env,
    nodeProcessRunner,
  );
  const github = createGitHubResolverHost({ ...context, token }, repository);
  // Enforcement policy is trusted base data; only the repository snapshot comes from head.
  const source = new TextDecoder().decode(
    readGitFile(
      root,
      context.expectedBaseSha,
      "examples/ci.pol",
      process.env,
      nodeProcessRunner,
      4 * 1024 * 1024,
    ),
  );
  const result = await checkPolicy(source, {
    repository,
    trustedBuiltins: [githubBuiltin],
    resolvers: { Git: github },
  }).finally(() => github.dispose());

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.exitCode;
}

void main();
