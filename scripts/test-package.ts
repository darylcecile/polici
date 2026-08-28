import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = process.cwd();
const packDirectory = mkdtempSync(resolve(tmpdir(), "polici-pack-"));
execFileSync(
  process.execPath,
  ["--experimental-strip-types", "--no-warnings", "scripts/pack-root.ts", packDirectory],
  { cwd: root, stdio: "inherit" },
);
const packageVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
const archive = resolve(packDirectory, `polici-${packageVersion}.tgz`);
const paths = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
  .trim()
  .split("\n")
  .map((path) => path.replace(/^package\//, ""));
assert.ok(paths.includes("lib/src/index.js"));
assert.ok(paths.includes("lib/src/index.d.ts"));
assert.ok(paths.includes("scripts/polici.js"));
assert.ok(paths.includes("scripts/polici-plugin.js"));
assert.ok(paths.includes("LICENSE"));
assert.ok(paths.every((path) => !path.includes("node_modules")));
assert.ok(paths.every((path) => !path.startsWith("dist/")));
assert.ok(paths.every((path) => !path.endsWith(".map")));
assert.ok(
  paths.every((path) =>
    /^(?:package\.json|README\.md|LICENSE|scripts\/(?:polici|polici-plugin)\.js|lib\/.*\.(?:js|d\.ts)|schemas\/[^/]+\.json|docs\/[^/]+\.md|editors\/README\.md|editors\/vscode\/(?:README\.md|LICENSE|package\.json|language-configuration\.json|snippets\/[^/]+\.json|syntaxes\/[^/]+\.json)|examples\/.*\.(?:pol|json|md|ts|c|wasm|sha256|lock))$/.test(
      path,
    ),
  ),
);
for (const schema of ["plugin-lock", "plugin-manifest", "policy-report", "runtime-protocol"]) {
  assert.ok(paths.includes(`schemas/${schema}.schema.json`));
}
const packedManifest = JSON.parse(
  execFileSync("tar", ["-xOzf", archive, "package/package.json"], { encoding: "utf8" }),
) as { optionalDependencies?: Record<string, string> };
assert.deepEqual(packedManifest.optionalDependencies, {
  "@polici/polici-darwin-arm64": packageVersion,
  "@polici/polici-darwin-x64": packageVersion,
  "@polici/polici-linux-arm64": packageVersion,
  "@polici/polici-linux-x64": packageVersion,
});

const consumer = mkdtempSync(resolve(tmpdir(), "polici-packed-consumer-"));
try {
  execFileSync("npm", ["init", "-y"], { cwd: consumer, stdio: "ignore" });
  execFileSync("npm", ["install", "--ignore-scripts", archive], {
    cwd: consumer,
    stdio: "inherit",
  });
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'const p=await import("polici");if(typeof p.compilePolicy!=="function")process.exit(1)',
    ],
    { cwd: consumer, stdio: "inherit" },
  );
  const pluginDirectory = resolve(consumer, "plugin");
  mkdirSync(pluginDirectory);
  writeFileSync(
    resolve(pluginDirectory, "plugin.ts"),
    `import { definePlugin, type } from "polici/plugin-sdk";
export default definePlugin({
  name: "ownership",
  version: "${packageVersion}",
  policiApi: 1,
  contractMajor: 1,
  exports: {
    approved: type.function({
      parameters: { owner: type.string() },
      returns: type.boolean(),
      resolve: "approved",
    }),
  },
  runtime: { kind: "typescript", entrypoint: "./runtime.ts" },
});
`,
  );
  writeFileSync(
    resolve(pluginDirectory, "runtime.ts"),
    `import { defineRuntime } from "polici/runtime-sdk";
import plugin from "./plugin.ts";
export default defineRuntime(plugin, {
  resolvers: {
    approved(_context, { owner }) { return owner === "platform"; },
  },
});
`,
  );
  execFileSync(
    resolve(consumer, "node_modules/.bin/polici-plugin"),
    ["manifest", resolve(pluginDirectory, "plugin.ts")],
    { cwd: consumer, stdio: "inherit" },
  );
  const generatedManifest = JSON.parse(
    readFileSync(resolve(pluginDirectory, "manifest.json"), "utf8"),
  );
  assert.equal(generatedManifest.runtime.entrypoint, "./runtime");
  assert.deepEqual(generatedManifest.exports.approved.parameters, [
    { name: "owner", type: { kind: "string" } },
  ]);
  execFileSync(
    resolve(consumer, "node_modules/.bin/polici-plugin"),
    [
      "build",
      resolve(pluginDirectory, "plugin.ts"),
      "--out",
      resolve(pluginDirectory, "runtime"),
      "--scriptc",
      resolve(consumer, "node_modules/.bin/scriptc"),
    ],
    { cwd: consumer, stdio: "inherit" },
  );
  const limits = {
    maxFrameBytes: 1024,
    maxMessageBytes: 1024,
    maxOutputBytes: 4096,
    maxLogBytes: 1024,
    maxContinuationBytes: 4096,
    maxCapabilityCalls: 8,
  };
  const initialized = JSON.parse(
    execFileSync(resolve(pluginDirectory, "runtime"), [], {
      input: `${JSON.stringify({
        protocol: "polici.runtime/v1",
        type: "initialize",
        id: "initialize",
        host: { name: "polici", version: packageVersion },
        plugin: { name: "ownership", version: packageVersion },
        capabilities: [],
        limits,
      })}\n`,
      encoding: "utf8",
    }),
  );
  const approved = JSON.parse(
    execFileSync(resolve(pluginDirectory, "runtime"), [], {
      input: `${JSON.stringify({
        protocol: "polici.runtime/v1",
        type: "call",
        id: "approved",
        resolver: "approved",
        arguments: { owner: { tag: "string", value: "platform" } },
        continuation: initialized.continuation,
        deadlineUnixMs: Date.now() + 30_000,
      })}\n`,
      encoding: "utf8",
    }),
  );
  assert.deepEqual(approved.value, { tag: "boolean", value: true });
  const nativeDirectory = resolve(
    consumer,
    "node_modules/@polici",
    `polici-${process.platform}-${process.arch}`,
  );
  mkdirSync(resolve(nativeDirectory, "bin"), { recursive: true });
  writeFileSync(
    resolve(nativeDirectory, "package.json"),
    JSON.stringify({
      name: `@polici/polici-${process.platform}-${process.arch}`,
      version: packageVersion,
      exports: {
        "./package.json": "./package.json",
        "./bin/polici": "./bin/polici",
      },
    }),
  );
  writeFileSync(
    resolve(nativeDirectory, "bin/polici"),
    `#!/bin/sh\nprintf 'polici ${packageVersion}\\n'\n`,
  );
  chmodSync(resolve(nativeDirectory, "bin/polici"), 0o755);
  const cli = execFileSync(resolve(consumer, "node_modules/.bin/polici"), ["--version"], {
    cwd: consumer,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(
    readFileSync(resolve(consumer, "node_modules/polici/package.json"), "utf8").includes('"os"'),
    false,
  );
  assert.match(cli, /polici/);
  writeFileSync(
    resolve(nativeDirectory, "package.json"),
    JSON.stringify({
      name: `@polici/polici-${process.platform}-${process.arch}`,
      version: "0.0.0",
      exports: {
        "./package.json": "./package.json",
        "./bin/polici": "./bin/polici",
      },
    }),
  );
  assert.throws(
    () =>
      execFileSync(resolve(consumer, "node_modules/.bin/polici"), ["--version"], {
        cwd: consumer,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    new RegExp(`does not match polici@${packageVersion.replaceAll(".", "\\.")}`),
  );
} finally {
  rmSync(consumer, { recursive: true, force: true });
  rmSync(packDirectory, { recursive: true, force: true });
}
