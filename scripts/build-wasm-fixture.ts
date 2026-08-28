import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const source = resolve(root, "examples/runtime/wasm/runtime.c");
const artifact = resolve(root, "examples/runtime/wasm/runtime.wasm");
const digestFile = resolve(root, "examples/runtime/wasm/runtime.wasm.source.sha256");

execFileSync(
  "zig",
  ["cc", "--target=wasm32-wasi", "-O2", "-Wl,--strip-all", "-o", artifact, source],
  {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  },
);
writeFileSync(digestFile, `source=${sourceDigest(source)}\nartifact=${sha256(artifact)}\n`);

function sourceDigest(...paths: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update("polici-wasi-fixture-v1\0");
  for (const path of paths) {
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
