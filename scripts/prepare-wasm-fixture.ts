import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const artifact = resolve("examples/runtime/wasm/runtime.wasm");
const digestFile = resolve("examples/runtime/wasm/runtime.wasm.source.sha256");
if (!existsSync(artifact)) {
  throw new Error(
    "examples/runtime/wasm/runtime.wasm is missing; run pnpm run build:wasm-fixture.",
  );
}
if (!existsSync(digestFile))
  throw new Error(`${digestFile} is missing; run pnpm run build:wasm-fixture.`);
const hash = createHash("sha256");
hash.update("polici-wasi-fixture-v1\0");
for (const path of [resolve("examples/runtime/wasm/runtime.c")]) {
  hash.update(readFileSync(path));
  hash.update("\0");
}
const expected = hash.digest("hex");
const digest = readFileSync(digestFile, "utf8");
if (digest !== `source=${expected}\nartifact=${sha256(artifact)}\n`)
  throw new Error(
    "examples/runtime/wasm/runtime.wasm or its source provenance is stale; run pnpm run build:wasm-fixture.",
  );

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
