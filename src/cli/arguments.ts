export type CliCommand = "check" | "validate" | "lock" | "lsp";
export type CliFormat = "human" | "json";

export interface CliArguments {
  readonly command?: CliCommand;
  readonly file?: string;
  readonly lockfile: string;
  readonly repository: string;
  readonly format: CliFormat;
  readonly offline: boolean;
  readonly githubEvent?: string;
  readonly githubEventFromEnvironment: boolean;
  readonly plugins: readonly string[];
  readonly frozenLockfile: boolean;
  readonly trustedPlugins: readonly string[];
  readonly sandboxLauncher?: string;
  readonly sandboxArguments: readonly string[];
  readonly wasiCommand?: string;
  readonly wasiArguments: readonly string[];
  readonly help: boolean;
  readonly version: boolean;
  readonly passthrough: readonly string[];
}

export class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgumentError";
  }
}

const COMMANDS: readonly CliCommand[] = ["check", "validate", "lock", "lsp"];
const VALUE_OPTIONS = new Set([
  "--file",
  "--lockfile",
  "--repository",
  "--format",
  "--plugin",
  "--trust-plugin",
  "--sandbox-launcher",
  "--sandbox-arg",
  "--wasi-command",
  "--wasi-arg",
]);

export function parseCliArguments(argv: readonly string[]): CliArguments {
  let command: CliCommand | undefined;
  let file: string | undefined;
  let lockfile = "polici.lock";
  let repository = ".";
  let format: CliFormat = "human";
  let offline = false;
  let githubEvent: string | undefined;
  let githubEventFromEnvironment = false;
  let frozenLockfile = false;
  let sandboxLauncher: string | undefined;
  let wasiCommand: string | undefined;
  let help = false;
  let version = false;
  const plugins: string[] = [];
  const trustedPlugins: string[] = [];
  const sandboxArguments: string[] = [];
  const wasiArguments: string[] = [];
  const passthrough: string[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]!;
    if (raw === "--" && command === "lsp") {
      passthrough.push(...argv.slice(index + 1));
      break;
    }
    if (!raw.startsWith("-")) {
      if (command === undefined && COMMANDS.includes(raw as CliCommand)) {
        command = raw as CliCommand;
        continue;
      }
      if (command === "lsp") {
        passthrough.push(raw);
        continue;
      }
      throw new CliArgumentError(
        command === undefined
          ? `Unknown command ${JSON.stringify(raw)}.`
          : `Unexpected argument ${JSON.stringify(raw)}.`,
      );
    }

    const equals = raw.indexOf("=");
    const name = equals < 0 ? raw : raw.slice(0, equals);
    const inlineValue = equals < 0 ? undefined : raw.slice(equals + 1);
    if (name === "-h" || name === "--help") {
      rejectInlineValue(name, inlineValue);
      help = true;
      continue;
    }
    if (name === "-v" || name === "--version") {
      rejectInlineValue(name, inlineValue);
      version = true;
      continue;
    }
    if (name === "--offline") {
      rejectInlineValue(name, inlineValue);
      rejectDuplicate(seen, name);
      offline = true;
      continue;
    }
    if (name === "--check") {
      rejectInlineValue(name, inlineValue);
      rejectDuplicate(seen, name);
      frozenLockfile = true;
      continue;
    }
    if (name === "--github-event") {
      rejectDuplicate(seen, name);
      if (inlineValue !== undefined) {
        if (inlineValue.length === 0) throw new CliArgumentError("--github-event cannot be empty.");
        githubEvent = inlineValue;
      } else if (argv[index + 1] !== undefined && !argv[index + 1]!.startsWith("-")) {
        githubEvent = argv[++index]!;
      } else {
        githubEventFromEnvironment = true;
      }
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) {
      if (command === "lsp") {
        passthrough.push(raw);
        continue;
      }
      throw new CliArgumentError(`Unknown option ${JSON.stringify(name)}.`);
    }
    const value = optionValue(argv, index, name, inlineValue);
    if (inlineValue === undefined) index += 1;
    switch (name) {
      case "--file":
        rejectDuplicate(seen, name);
        file = value;
        break;
      case "--lockfile":
        rejectDuplicate(seen, name);
        lockfile = value;
        break;
      case "--repository":
        rejectDuplicate(seen, name);
        repository = value;
        break;
      case "--format":
        rejectDuplicate(seen, name);
        if (value !== "human" && value !== "json")
          throw new CliArgumentError("--format must be 'human' or 'json'.");
        format = value;
        break;
      case "--plugin":
        plugins.push(value);
        break;
      case "--trust-plugin":
        trustedPlugins.push(value);
        break;
      case "--sandbox-launcher":
        rejectDuplicate(seen, name);
        sandboxLauncher = value;
        break;
      case "--sandbox-arg":
        sandboxArguments.push(value);
        break;
      case "--wasi-command":
        rejectDuplicate(seen, name);
        wasiCommand = value;
        break;
      case "--wasi-arg":
        wasiArguments.push(value);
        break;
    }
  }

  if (!help && !version) {
    if (command === undefined) throw new CliArgumentError("A command is required.");
    if (command !== "lsp" && file === undefined)
      throw new CliArgumentError(`${command} requires --file <policy>.`);
    if (frozenLockfile && command !== "lock")
      throw new CliArgumentError("--check is valid only with the lock command.");
    if (plugins.length > 0 && command !== "lock")
      throw new CliArgumentError("--plugin is valid only with the lock command.");
    if (command === "lock" && (githubEvent !== undefined || githubEventFromEnvironment))
      throw new CliArgumentError("lock cannot update a trusted GitHub event revision.");
  }

  return {
    ...(command === undefined ? {} : { command }),
    ...(file === undefined ? {} : { file }),
    lockfile,
    repository,
    format,
    offline,
    ...(githubEvent === undefined ? {} : { githubEvent }),
    githubEventFromEnvironment,
    plugins,
    frozenLockfile,
    trustedPlugins,
    ...(sandboxLauncher === undefined ? {} : { sandboxLauncher }),
    sandboxArguments,
    ...(wasiCommand === undefined ? {} : { wasiCommand }),
    wasiArguments,
    help,
    version,
    passthrough,
  };
}

function optionValue(
  argv: readonly string[],
  index: number,
  name: string,
  inlineValue: string | undefined,
): string {
  const value = inlineValue ?? argv[index + 1];
  if (
    value === undefined ||
    value.length === 0 ||
    (inlineValue === undefined && value.startsWith("-"))
  )
    throw new CliArgumentError(`${name} requires a value.`);
  return value;
}

function rejectDuplicate(seen: Set<string>, name: string): void {
  if (seen.has(name)) throw new CliArgumentError(`${name} may be specified only once.`);
  seen.add(name);
}

function rejectInlineValue(name: string, value: string | undefined): void {
  if (value !== undefined) throw new CliArgumentError(`${name} does not accept a value.`);
}

export const CLI_HELP = `Usage: polici <command> [options]

Commands:
  check       Evaluate a policy against an exact repository snapshot
  validate    Parse and type-check policy, manifests, and lockfile only
  lock        Resolve imports and atomically write canonical lock v2
  lsp         Start the Polici Language Server over stdio

Required for check, validate, and lock:
  --file <policy>              Repository-relative policy file

Common options:
  --lockfile <path>            Lockfile (default: <repository>/polici.lock)
  --repository <path>          Repository root (default: current directory)
  --format <human|json>        Report format (default: human)
  --offline                    Forbid providers that require network access
  --github-event [path]        Use a pull_request event (default: GITHUB_EVENT_PATH)
  --help, -h                   Show help
  --version, -v                Show version

Lock options:
  --plugin <manifest-path>     Local plugin manifest; repeat for each plugin
  --check                      Verify the lockfile is already canonical and current

External runtime options for check:
  --trust-plugin <name@major>  Explicitly trust a verified native runtime
  --sandbox-launcher <path>    Hardened native sandbox launcher
  --sandbox-arg <argument>     Sandbox launcher argument; repeat as needed
  --wasi-command <path>        WASI runner (default: wasmtime)
  --wasi-arg <argument>        Restricted WASI runner argument; repeat as needed

Local snapshots include regular files except .git and node_modules trees, interpret
no ignore files, and reject links and special files. GitHub pull request snapshots use
the event's exact head tree; policy, lock, and path plugins come from its base SHA.
`;
