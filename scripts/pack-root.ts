import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = process.cwd();
const destination = resolve(root, process.argv[2] ?? "release");
const temporary = mkdtempSync(resolve(tmpdir(), "polici-root-pack-"));
const initial = resolve(temporary, "initial");
const extracted = resolve(temporary, "extracted");
mkdirSync(initial, { recursive: true });
mkdirSync(extracted, { recursive: true });
mkdirSync(destination, { recursive: true });

try {
  execFileSync("pnpm", ["run", "prepack"], { cwd: root, stdio: "inherit" });
  const output = JSON.parse(
    execFileSync("pnpm", ["pack", "--json", "--pack-destination", initial], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, npm_config_ignore_scripts: "true" },
    }),
  ) as { filename: string } | { filename: string }[];
  const filename = (Array.isArray(output) ? output[0] : output)?.filename;
  if (filename === undefined) throw new Error("pnpm pack did not return a package filename");
  execFileSync("tar", ["-xzf", filename, "-C", extracted]);

  const packagePath = resolve(extracted, "package/package.json");
  const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as {
    version: string;
    optionalDependencies?: Record<string, string>;
  };
  manifest.optionalDependencies = Object.fromEntries(
    ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"].map((target) => [
      `@polici/polici-${target}`,
      manifest.version,
    ]),
  );
  writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
  execFileSync("npm", ["pack", resolve(extracted, "package"), "--pack-destination", destination], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, npm_config_ignore_scripts: "true" },
  });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
