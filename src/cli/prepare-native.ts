// @ts-ignore The repository intentionally does not depend on @types/node.
import { execFileSync } from "node:child_process";
// @ts-ignore The repository intentionally does not depend on @types/node.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// @ts-ignore The repository intentionally does not depend on @types/node.
import { resolve } from "node:path";
// @ts-ignore The repository intentionally does not depend on @types/node.
import { cwd, execPath } from "node:process";

import { githubArtifactModule } from "./github-artifact-source.ts";

const root = cwd();
const output = resolve(root, "src/cli/node_modules/polici-native");
const generatedArtifact = resolve(root, "src/cli/github-artifact.generated.ts");
const expectedArtifact = githubArtifactModule(root);
let currentArtifact = "";
try {
  currentArtifact = readFileSync(generatedArtifact, "utf8");
} catch {}
if (currentArtifact !== expectedArtifact)
  throw new Error(
    "src/cli/github-artifact.generated.ts is stale; regenerate it from the production providers/github source bundle.",
  );
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true, mode: 0o700 });

execFileSync(
  execPath,
  [
    resolve(root, "node_modules/typescript/bin/tsc"),
    "--outDir",
    output,
    "--rootDir",
    root,
    "--target",
    "es2023",
    "--module",
    "esnext",
    "--moduleResolution",
    "bundler",
    "--skipLibCheck",
    "--declaration",
    "--rewriteRelativeImportExtensions",
    resolve(root, "src/plugin/node-shims.d.ts"),
    resolve(root, "src/cli/node-shims.d.ts"),
    resolve(root, "src/cli/native.ts"),
    resolve(root, "src/lsp/server.ts"),
  ],
  { cwd: root, stdio: "inherit" },
);
writeFileSync(
  resolve(output, "package.json"),
  `${JSON.stringify({ name: "polici-native", version: "1.0.1", type: "module" })}\n`,
  { encoding: "utf8", mode: 0o600 },
);
