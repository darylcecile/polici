import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = process.cwd();
const packDirectory = mkdtempSync(resolve(tmpdir(), "polici-pack-"));
execFileSync("pnpm", ["run", "prepack"], { cwd: root, stdio: "inherit" });
const packOutput = JSON.parse(
  execFileSync("pnpm", ["pack", "--json", "--pack-destination", packDirectory], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, npm_config_ignore_scripts: "true" },
  }),
) as
  | { filename: string; files: { path: string }[] }
  | { filename: string; files: { path: string }[] }[];
const pack = Array.isArray(packOutput) ? packOutput[0]! : packOutput;
const paths = pack.files.map((file) => file.path);
assert.ok(paths.includes("lib/src/index.js"));
assert.ok(paths.includes("lib/src/index.d.ts"));
assert.ok(paths.includes("scripts/polici.js"));
assert.ok(paths.includes("LICENSE"));
assert.ok(paths.every((path) => !path.includes("node_modules")));
assert.ok(paths.every((path) => !path.startsWith("dist/")));
assert.ok(paths.every((path) => !path.endsWith(".map")));
assert.ok(
  paths.every((path) =>
    /^(?:package\.json|README\.md|LICENSE|scripts\/polici\.js|lib\/.*\.(?:js|d\.ts)|schemas\/[^/]+\.json|docs\/[^/]+\.md|editors\/README\.md|editors\/vscode\/(?:README\.md|LICENSE|package\.json|language-configuration\.json|snippets\/[^/]+\.json|syntaxes\/[^/]+\.json)|examples\/.*\.(?:pol|json|md|ts|c|wasm|sha256|lock))$/.test(
      path,
    ),
  ),
);
for (const schema of ["plugin-lock", "plugin-manifest", "policy-report", "runtime-protocol"]) {
  assert.ok(paths.includes(`schemas/${schema}.schema.json`));
}

const consumer = mkdtempSync(resolve(tmpdir(), "polici-packed-consumer-"));
try {
  execFileSync("npm", ["init", "-y"], { cwd: consumer, stdio: "ignore" });
  execFileSync("npm", ["install", "--ignore-scripts", "--no-optional", pack.filename], {
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
      version: "1.0.0",
      exports: {
        "./package.json": "./package.json",
        "./bin/polici": "./bin/polici",
      },
    }),
  );
  writeFileSync(resolve(nativeDirectory, "bin/polici"), "#!/bin/sh\nprintf 'polici 1.0.0\\n'\n");
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
    /does not match polici@1\.0\.0/,
  );
} finally {
  rmSync(consumer, { recursive: true, force: true });
  rmSync(packDirectory, { recursive: true, force: true });
}
