#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildSync } from "esbuild";

import { pluginManifestJson } from "../lib/src/sdk/define.js";
import { validatePluginManifest } from "../lib/src/plugin/manifest.js";

const [command, sourceArgument, ...arguments_] = process.argv.slice(2);

if (command === "--help" || command === "-h" || command === undefined) {
  process.stdout.write(`Usage:
  polici-plugin manifest <plugin.ts> [--out manifest.json]
  polici-plugin build <plugin.ts> [--runtime runtime.ts] [--manifest manifest.json]
                      [--out runtime] [--target scriptc-target] [--scriptc path]
`);
  process.exit(command === undefined ? 2 : 0);
}
if ((command !== "manifest" && command !== "build") || sourceArgument === undefined)
  fail("Expected 'manifest <plugin.ts>' or 'build <plugin.ts>'.");

const options = parseOptions(arguments_);
const source = resolve(sourceArgument);
const directory = dirname(source);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const imported = await importTypeScript(source);
const manifest = imported.default;
const validation = validatePluginManifest(manifest);
if (!validation.ok)
  fail(
    `Default export is not a valid Polici plugin: ${validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
  );

const manifestPath = resolve(
  command === "manifest"
    ? (options.out ?? resolve(directory, "manifest.json"))
    : (options.manifest ?? resolve(directory, "manifest.json")),
);
if (command === "manifest") {
  writeFileSync(manifestPath, pluginManifestJson(validation.value));
  process.stdout.write(`${manifestPath}\n`);
  process.exit(0);
}

const runtimePath = resolve(
  options.runtime ??
    resolve(directory, `${validation.value.runtime.entrypoint}${sourceExtension(source)}`),
);
const runtimeModule = await importTypeScript(runtimePath);
const runtime = runtimeModule.default;
if (
  runtime === null ||
  typeof runtime !== "object" ||
  runtime.name !== validation.value.name ||
  runtime.version !== validation.value.version ||
  runtime.transport !== validation.value.runtime.transport ||
  typeof runtime.resolvers !== "object"
) {
  fail(
    "Runtime default export does not match the plugin name, version, transport, or resolver contract.",
  );
}
for (const exported of Object.values(validation.value.exports)) {
  if (typeof runtime.resolvers[exported.resolve] !== "function")
    fail(`Runtime is missing resolver ${JSON.stringify(exported.resolve)}.`);
}
for (const type of Object.values(validation.value.types)) {
  for (const field of Object.values(type.fields)) {
    if (
      field.kind === "set" &&
      field.resolve !== undefined &&
      typeof runtime.resolvers[field.resolve] !== "function"
    )
      fail(`Runtime is missing resolver ${JSON.stringify(field.resolve)}.`);
  }
  for (const method of Object.values(type.methods ?? {})) {
    if (typeof runtime.resolvers[method.resolve] !== "function")
      fail(`Runtime is missing resolver ${JSON.stringify(method.resolve)}.`);
  }
}

const output = resolve(options.out ?? resolve(directory, validation.value.runtime.entrypoint));
const artifactPath = relative(directory, output).replace(/\\/g, "/");
if (artifactPath === "" || artifactPath === ".." || artifactPath.startsWith("../"))
  fail("Compiled runtime output must stay inside the plugin directory.");
const emittedManifest = {
  ...validation.value,
  runtime: { ...validation.value.runtime, entrypoint: `./${artifactPath}` },
};
const emittedValidation = validatePluginManifest(emittedManifest);
if (!emittedValidation.ok)
  fail(
    `Generated manifest is invalid: ${emittedValidation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
  );
writeFileSync(manifestPath, pluginManifestJson(emittedValidation.value));
const temporary = mkdtempSync(resolve(directory, ".polici-plugin-"));
const entrypoint = resolve(temporary, "entry.ts");
try {
  const packageDirectory = resolve(temporary, "node_modules/polici-plugin-runtime");
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(resolve(temporary, "package.json"), '{"type":"module"}\n');
  const bundledEntrypoint = resolve(temporary, "runtime-entry.ts");
  writeFileSync(
    bundledEntrypoint,
    [
      `import runtime from ${JSON.stringify(runtimePath)};`,
      'import { runRuntimeExchange } from "polici/runtime-sdk";',
      "",
      "export default async function run(input: string): Promise<string> {",
      "  return runRuntimeExchange(runtime, input);",
      "}",
      "",
    ].join("\n"),
  );
  buildSync({
    entryPoints: [bundledEntrypoint],
    outfile: resolve(packageDirectory, "index.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    alias: sdkAliases(),
    logLevel: "silent",
  });
  writeFileSync(
    resolve(packageDirectory, "package.json"),
    `${JSON.stringify({ name: "polici-plugin-runtime", version: "1.0.0", type: "module", types: "./index.d.ts", exports: "./index.js" })}\n`,
  );
  writeFileSync(
    resolve(packageDirectory, "index.d.ts"),
    "declare const run: (input: string) => Promise<string>;\nexport default run;\n",
  );
  writeFileSync(
    entrypoint,
    [
      'import { readFileSync } from "node:fs";',
      "",
      'const runtime = await import("polici-plugin-runtime");',
      'const input = Buffer.from(readFileSync(0)).toString("base64");',
      "const output = await runtime.default(input);",
      'process.stdout.write(Buffer.from(output, "base64"));',
      "",
    ].join("\n"),
  );
  execFileSync(
    options.scriptc ?? "scriptc",
    ["build", entrypoint, "--dynamic", "--no-keep-c", "-o", output],
    {
      cwd: directory,
      env: {
        ...process.env,
        ...(options.target === undefined
          ? {}
          : { SCRIPTC_CC: process.env.SCRIPTC_CC ?? "zigcc", SCRIPTC_TARGET: options.target }),
      },
      stdio: "inherit",
    },
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
process.stdout.write(`${manifestPath}\n${output}\n`);

function parseOptions(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!["--out", "--manifest", "--runtime", "--target", "--scriptc"].includes(key))
      fail(`Unknown option ${JSON.stringify(key)}.`);
    const value = values[++index];
    if (value === undefined || value.startsWith("--")) fail(`${key} requires a value.`);
    result[key.slice(2)] = value;
  }
  return result;
}

function sourceExtension(path) {
  const extension = extname(path);
  return [".ts", ".tsx", ".mts", ".cts"].includes(extension) ? extension : ".ts";
}

async function importTypeScript(path) {
  const temporary = mkdtempSync(resolve(dirname(path), ".polici-definition-"));
  const output = resolve(temporary, "definition.mjs");
  try {
    buildSync({
      entryPoints: [path],
      outfile: output,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      alias: sdkAliases(),
      logLevel: "silent",
    });
    return await import(`${pathToFileURL(output).href}?polici=${Date.now()}`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function sdkAliases() {
  return {
    "polici/plugin-sdk": resolve(packageRoot, "lib/src/sdk/index.js"),
    "polici/runtime-sdk": resolve(packageRoot, "lib/src/sdk/runtime.js"),
  };
}

function fail(message) {
  process.stderr.write(`polici-plugin: ${message}\n`);
  process.exit(2);
}
