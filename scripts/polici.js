#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const target = `${process.platform}-${process.arch}`;
const packageName = `@polici/polici-${target}`;
const require = createRequire(import.meta.url);
const rootPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
let executable;

try {
  const nativePackage = JSON.parse(
    readFileSync(require.resolve(`${packageName}/package.json`), "utf8"),
  );
  if (nativePackage.name !== packageName || nativePackage.version !== rootPackage.version) {
    throw new Error(
      `native package ${String(nativePackage.name)}@${String(nativePackage.version)} does not match polici@${String(rootPackage.version)}`,
    );
  }
  executable = require.resolve(`${packageName}/bin/polici`);
} catch (error) {
  process.stderr.write(
    `polici: no native executable is installed for ${target}. ` +
      `Install matching ${packageName}@${String(rootPackage.version)}. ` +
      `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(2);
}

const result = spawnSync(executable, process.argv.slice(2), { stdio: "inherit" });
if (result.error !== undefined) {
  process.stderr.write(`polici: ${result.error.message}\n`);
  process.exit(2);
}
if (result.signal !== null) process.kill(process.pid, result.signal);
process.exit(result.status ?? 2);
