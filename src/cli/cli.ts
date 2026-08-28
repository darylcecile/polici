// @ts-ignore This bare repository intentionally uses ScriptC's Node built-ins.
import * as path from "node:path";

import { compilePolicy, parsePolicy } from "../engine/compile.js";
import { evaluatePolicy } from "../engine/evaluate.js";
import type { CompiledPolicy, PolicyCheckResult, PolicyExitCode } from "../engine/types.js";
import { pluginLockfileJson } from "../plugin/lockfile.js";
import type { ResolverHost } from "../plugin/resolver.js";
import {
  GitHubProvider,
  createGitHubResolverHost,
  githubContextFromEvent,
  type GitHubRepositoryContext,
} from "../../providers/github/index.js";
import { CLI_HELP, CliArgumentError, parseCliArguments, type CliArguments } from "./arguments.js";
import {
  MAX_SOURCE_BYTES,
  absoluteRepositoryRoot,
  atomicWriteFile,
  decodeUtf8,
  exists,
  repositoryRelativePath,
  scanLocalSnapshot,
  secureReadExternalFile,
  secureReadFile,
} from "./files.js";
import { snapshotGitCommit } from "./git.js";
import {
  buildLockfile,
  createRuntimeSet,
  gitTrustedFiles,
  loadLockedPlugins,
  localTrustedFiles,
  preflightPlugins,
  type LoadedPlugins,
  type PolicyImport,
  type TrustedFiles,
} from "./plugins.js";
import { operationalDiagnostic, renderHumanReport, validationResult } from "./report.js";
import { nodeProcessRunner, type CliProcessRunner } from "./process.js";

export const CLI_VERSION = "1.0.1";

export interface CliEnvironment {
  readonly [name: string]: string | undefined;
}

export interface CliDispatchContext {
  readonly argv: readonly string[];
  readonly environment: CliEnvironment;
  readonly signal?: AbortSignal;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

export type CliDispatchHook = (
  command: "lsp",
  context: CliDispatchContext,
) => number | Promise<number>;

export interface CliIo {
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly signal?: AbortSignal;
  readonly dispatch?: CliDispatchHook;
}

interface PullRequestMode {
  readonly eventPath: string;
  readonly automatic: boolean;
  readonly context: GitHubRepositoryContext;
}

interface CommandInputs {
  readonly root: string;
  readonly policyPath: string;
  readonly lockfilePath: string;
  readonly policyText: string;
  readonly lockfileText: string;
  readonly plugins: LoadedPlugins;
  readonly compiled: CompiledPolicy;
  readonly pullRequest?: PullRequestMode;
}

export async function runCli(
  argv: readonly string[],
  environment: CliEnvironment,
  io: CliIo = {},
): Promise<number> {
  return executeCli(
    argv,
    environment,
    io.stdout ?? defaultStdout,
    io.stderr ?? defaultStderr,
    io.signal,
    io.dispatch,
    nodeProcessRunner,
  );
}

/** ScriptC entry surface avoids passing the extensible host-I/O object across its static boundary. */
export async function runNativeCli(
  argv: readonly string[],
  environment: CliEnvironment,
  runProcess: CliProcessRunner,
): Promise<number> {
  return executeCli(
    argv,
    environment,
    defaultStdout,
    defaultStderr,
    undefined,
    undefined,
    runProcess,
  );
}

async function executeCli(
  argv: readonly string[],
  environment: CliEnvironment,
  writeStdout: (text: string) => void,
  writeStderr: (text: string) => void,
  signal: AbortSignal | undefined,
  dispatch: unknown,
  runProcess: CliProcessRunner,
): Promise<number> {
  let arguments_: CliArguments;
  try {
    arguments_ = parseCliArguments(argv);
  } catch (error) {
    writeStderr(`polici: ${errorMessage(error)}\n\n${CLI_HELP}`);
    return 2;
  }

  if (arguments_.help) {
    writeStdout(CLI_HELP);
    return 0;
  }
  if (arguments_.version) {
    writeStdout(`polici ${CLI_VERSION}\n`);
    return 0;
  }
  if (arguments_.command === "lsp") {
    if (dispatch === undefined) {
      writeStderr("polici: lsp is unavailable through this embedded host.\n");
      return 2;
    }
    try {
      const handler = dispatch as CliDispatchHook;
      const exitCode = await handler("lsp", {
        argv: arguments_.passthrough,
        environment,
        ...(signal === undefined ? {} : { signal }),
        writeStdout,
        writeStderr,
      });
      return validExitCode(exitCode);
    } catch (error) {
      writeStderr(`polici: ${errorMessage(error)}\n`);
      return 2;
    }
  }

  try {
    abortIfRequested(signal);
    if (arguments_.command === "lock")
      return runLock(arguments_, environment, writeStdout, writeStderr);
    const inputs = await loadCommandInputs(arguments_, environment, runProcess, signal);
    abortIfRequested(signal);
    if (arguments_.command === "validate") {
      const result = validationResult(inputs.compiled);
      writePolicyResult(result, arguments_, inputs.policyPath, writeStdout);
      return result.exitCode;
    }
    return await runCheck(arguments_, environment, inputs, signal, writeStdout, runProcess);
  } catch (error) {
    const message = errorMessage(error);
    writeStderr(`polici: ${message}\n`);
    if (arguments_.format === "json" && !(error instanceof CliArgumentError)) {
      const result: PolicyCheckResult = {
        kind: "policy-evaluation",
        status: "error",
        exitCode: 2,
        policies: [],
        diagnostics: [operationalDiagnostic(message)],
      };
      writeStdout(`${JSON.stringify(result)}\n`);
    }
    return 2;
  }
}

function defaultStdout(text: string): void {
  // @ts-ignore The local plugin shim deliberately declares only process.env.
  process.stdout.write(text);
}

function defaultStderr(text: string): void {
  // @ts-ignore The local plugin shim deliberately declares only process.env.
  process.stderr.write(text);
}

function runLock(
  arguments_: CliArguments,
  environment: CliEnvironment,
  writeStdout: (text: string) => void,
  writeStderr: (text: string) => void,
): number {
  // @ts-ignore The local plugin shim deliberately declares only process.env.
  const root = absoluteRepositoryRoot(path.resolve(process.cwd(), arguments_.repository));
  const policyPath = repositoryRelativePath(root, arguments_.file!, "Policy");
  const lockfilePath = repositoryRelativePath(root, arguments_.lockfile, "Lockfile");
  const policyText = decodeUtf8(
    secureReadFile(path.resolve(root, policyPath), MAX_SOURCE_BYTES, "Policy"),
    "Policy",
  );
  const parsed = parsePolicy(policyText);
  if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    const compiled = compilePolicy(policyText);
    const result = validationResult(compiled);
    writePolicyResult(result, arguments_, policyPath, writeStdout);
    return result.exitCode;
  }
  const imports = policyImports(parsed.ast.usings);
  const absoluteLockfile = path.resolve(root, lockfilePath);
  const plugins = buildLockfile(imports, arguments_.plugins, root, absoluteLockfile);
  const compiled = compilePolicy(policyText, plugins);
  const result = validationResult(compiled);
  if (result.exitCode !== 0) {
    writePolicyResult(result, arguments_, policyPath, writeStdout);
    return result.exitCode;
  }
  const canonical = pluginLockfileJson(plugins.lockfile);
  if (arguments_.frozenLockfile) {
    if (!exists(absoluteLockfile))
      throw new Error(`Frozen lockfile ${lockfilePath} does not exist.`);
    const current = decodeUtf8(
      secureReadFile(absoluteLockfile, MAX_SOURCE_BYTES, "Lockfile"),
      "Lockfile",
    );
    if (current !== canonical)
      throw new Error(`Lockfile ${lockfilePath} is not current and canonical.`);
    if (arguments_.format === "json") writeStdout(canonical);
    else writeStdout(`Lockfile ${lockfilePath} is current.\n`);
    return 0;
  }
  atomicWriteFile(absoluteLockfile, canonical);
  if (arguments_.format === "json") writeStdout(canonical);
  else writeStdout(`Wrote ${lockfilePath} with ${plugins.lockfile.plugins.length} plugin(s).\n`);
  void writeStderr;
  return 0;
}

async function loadCommandInputs(
  arguments_: CliArguments,
  environment: CliEnvironment,
  runProcess: CliProcessRunner,
  signal: AbortSignal | undefined,
): Promise<CommandInputs> {
  // @ts-ignore The local plugin shim deliberately declares only process.env.
  const root = absoluteRepositoryRoot(path.resolve(process.cwd(), arguments_.repository));
  const policyPath = repositoryRelativePath(root, arguments_.file!, "Policy");
  const lockfilePath = repositoryRelativePath(root, arguments_.lockfile, "Lockfile");
  const pullRequest = pullRequestMode(arguments_, environment);
  const command = arguments_.command;
  if (command !== "check" && command !== "validate")
    throw new Error("Pull-request inputs are available only to check and validate.");
  if (pullRequest !== undefined)
    await authenticatePullRequestMode(pullRequest, command, environment, signal);
  const trustedFiles: TrustedFiles =
    pullRequest === undefined
      ? localTrustedFiles(root, environment)
      : gitTrustedFiles(root, pullRequest.context.expectedBaseSha, environment, runProcess);
  const policyText = decodeUtf8(
    trustedFiles.read(policyPath, MAX_SOURCE_BYTES, "Policy"),
    "Policy",
  );
  const parsed = parsePolicy(policyText);
  const imports = policyImports(parsed.ast.usings);
  const lockfileText = decodeUtf8(
    trustedFiles.read(lockfilePath, MAX_SOURCE_BYTES, "Lockfile"),
    "Lockfile",
  );
  const plugins = loadLockedPlugins(lockfileText, lockfilePath, imports, trustedFiles);
  const compiled = compilePolicy(policyText, plugins);
  return {
    root,
    policyPath,
    lockfilePath,
    policyText,
    lockfileText,
    plugins,
    compiled,
    ...(pullRequest === undefined ? {} : { pullRequest }),
  };
}

async function runCheck(
  arguments_: CliArguments,
  environment: CliEnvironment,
  inputs: CommandInputs,
  signal: AbortSignal | undefined,
  writeStdout: (text: string) => void,
  runProcess: CliProcessRunner,
): Promise<number> {
  const compilation = validationResult(inputs.compiled);
  if (compilation.exitCode !== 0) {
    writePolicyResult(compilation, arguments_, inputs.policyPath, writeStdout);
    return compilation.exitCode;
  }
  preflightPlugins(inputs.compiled, inputs.plugins, arguments_);
  const importsGitHub = inputs.compiled.ir.imports.some(
    (imported) => imported.provider === "github" && imported.apiVersion === 1,
  );
  if (importsGitHub && inputs.pullRequest === undefined)
    throw new Error("github@1 requires --github-event or a GitHub Actions pull request event.");
  if (importsGitHub && !environment.GITHUB_TOKEN && !environment.GH_TOKEN)
    throw new Error("github@1 requires GITHUB_TOKEN (or GH_TOKEN) in the host environment.");

  abortIfRequested(signal);
  const repository =
    inputs.pullRequest === undefined
      ? scanLocalSnapshot(inputs.root)
      : snapshotGitCommit(
          inputs.root,
          inputs.pullRequest.context.expectedHeadSha,
          environment,
          runProcess,
        );
  abortIfRequested(signal);
  const runtimeSet = await createRuntimeSet(
    inputs.compiled,
    inputs.plugins,
    arguments_,
    (): ResolverHost => {
      const context = inputs.pullRequest?.context;
      if (context === undefined) throw new Error("GitHub pull request context is unavailable.");
      return createGitHubResolverHost(githubProviderOptions(context, environment), repository);
    },
    runProcess,
  );
  let result: PolicyCheckResult;
  try {
    result = await evaluatePolicy(inputs.compiled, {
      repository,
      resolvers: runtimeSet.resolvers,
      ...(signal === undefined ? {} : { signal }),
    });
  } finally {
    await runtimeSet.dispose();
  }
  writePolicyResult(result, arguments_, inputs.policyPath, writeStdout);
  return result.exitCode;
}

function pullRequestMode(
  arguments_: CliArguments,
  environment: CliEnvironment,
): PullRequestMode | undefined {
  const automatic =
    arguments_.githubEvent === undefined &&
    !arguments_.githubEventFromEnvironment &&
    environment.GITHUB_ACTIONS === "true" &&
    (environment.GITHUB_EVENT_NAME === "pull_request" ||
      environment.GITHUB_EVENT_NAME === "pull_request_target");
  if (!automatic && arguments_.githubEvent === undefined && !arguments_.githubEventFromEnvironment)
    return undefined;
  const configured = arguments_.githubEvent ?? environment.GITHUB_EVENT_PATH;
  if (configured === undefined || configured.length === 0)
    throw new Error("GITHUB_EVENT_PATH is required for GitHub Actions pull request evaluation.");
  // @ts-ignore The local plugin shim deliberately declares only process.env.
  const eventPath = path.resolve(process.cwd(), configured);
  const eventText = decodeUtf8(
    secureReadExternalFile(
      eventPath,
      MAX_SOURCE_BYTES,
      "GitHub event",
      rootForEventCheck(arguments_),
    ),
    "GitHub event",
  );
  let event: unknown;
  try {
    event = JSON.parse(eventText) as unknown;
  } catch (error) {
    throw new Error("GitHub event is not valid JSON.", { cause: error });
  }
  return {
    eventPath,
    automatic,
    context: githubContextFromEvent(event, environment.GITHUB_REPOSITORY),
  };
}

async function authenticatePullRequestMode(
  pullRequest: PullRequestMode,
  command: "check" | "validate",
  environment: CliEnvironment,
  signal: AbortSignal | undefined,
): Promise<void> {
  const trustedBase = environment.POLICI_GITHUB_BASE_SHA;
  if (trustedBase !== undefined) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(trustedBase))
      throw new Error("POLICI_GITHUB_BASE_SHA must be a full Git object ID.");
    if (trustedBase.toLowerCase() !== pullRequest.context.expectedBaseSha.toLowerCase())
      throw new Error(
        "GitHub event base SHA does not match separately trusted POLICI_GITHUB_BASE_SHA.",
      );
  }
  if (environment.GITHUB_TOKEN || environment.GH_TOKEN) {
    await new GitHubProvider(githubProviderOptions(pullRequest.context, environment)).pullRequest(
      signal === undefined ? {} : { signal },
    );
    return;
  }
  if (trustedBase !== undefined && (pullRequest.automatic || command === "validate")) return;
  if (!pullRequest.automatic && command === "check")
    throw new Error(
      "A check using explicit --github-event requires live GitHub authentication; POLICI_GITHUB_BASE_SHA alone is sufficient only for validate.",
    );
  if (trustedBase === undefined)
    throw new Error(
      "Pull-request mode requires live GitHub authentication or separately trusted POLICI_GITHUB_BASE_SHA before base files can be read.",
    );
}

function githubProviderOptions(
  context: GitHubRepositoryContext,
  environment: CliEnvironment,
): ConstructorParameters<typeof GitHubProvider>[0] {
  const maxResponseBytes = optionalPositiveIntegerEnvironment(
    environment,
    "POLICI_GITHUB_MAX_RESPONSE_BYTES",
  );
  const maxBlobBytes = optionalPositiveIntegerEnvironment(
    environment,
    "POLICI_GITHUB_MAX_BLOB_BYTES",
  );
  return {
    ...context,
    token: environment.GITHUB_TOKEN || environment.GH_TOKEN!,
    ...(environment.GITHUB_API_URL === undefined ? {} : { apiUrl: environment.GITHUB_API_URL }),
    ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
    ...(maxBlobBytes === undefined ? {} : { maxBlobBytes }),
  };
}

function optionalPositiveIntegerEnvironment(
  environment: CliEnvironment,
  name: string,
): number | undefined {
  const value = environment[name];
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a positive safe integer.`);
  return parsed;
}

function rootForEventCheck(arguments_: CliArguments): string {
  // @ts-ignore The local plugin shim deliberately declares only process.env.
  return absoluteRepositoryRoot(path.resolve(process.cwd(), arguments_.repository));
}

function policyImports(
  declarations: readonly {
    readonly source: string;
    readonly alias: string;
  }[],
): readonly PolicyImport[] {
  return declarations.map((declaration) => {
    const match = /^([a-z][a-z0-9.-]*)@([1-9][0-9]*)$/.exec(declaration.source);
    if (match === null)
      throw new TypeError(
        `Provider import ${JSON.stringify(declaration.source)} must have name@major form.`,
      );
    return {
      source: declaration.source,
      name: match[1]!,
      contractMajor: Number(match[2]),
      alias: declaration.alias,
    };
  });
}

function writePolicyResult(
  result: PolicyCheckResult,
  arguments_: CliArguments,
  policyPath: string,
  writeStdout: (text: string) => void,
): void {
  writeStdout(
    arguments_.format === "json"
      ? `${JSON.stringify(result)}\n`
      : renderHumanReport(result, policyPath),
  );
}

function validExitCode(value: number): PolicyExitCode {
  if (value !== 0 && value !== 1 && value !== 2)
    throw new TypeError("CLI dispatch hook returned an invalid exit code.");
  return value;
}

function abortIfRequested(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Operation aborted.");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
