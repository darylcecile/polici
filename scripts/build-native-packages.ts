import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface Target {
  readonly cpu: string;
  readonly os: string;
  readonly scriptcTarget?: string;
}

const targets: readonly Target[] = [
  { os: "darwin", cpu: "arm64" },
  { os: "darwin", cpu: "x64", scriptcTarget: "x86_64-macos-none" },
  { os: "linux", cpu: "arm64", scriptcTarget: "aarch64-linux-gnu.2.36" },
  { os: "linux", cpu: "x64", scriptcTarget: "x86_64-linux-gnu.2.36" },
];

const root = process.cwd();
const basePackage = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  version: string;
};
const requestedTargets = process.argv.slice(2).filter((value) => value !== "--");
if (requestedTargets.length > 1) throw new Error("Expected at most one native target.");
const selectedTarget = requestedTargets[0];
const selected =
  selectedTarget === undefined
    ? targets.filter((target) => target.os === process.platform && target.cpu === process.arch)
    : targets.filter((target) => `${target.os}-${target.cpu}` === selectedTarget);
if (selected.length !== 1)
  throw new Error(
    `Expected one native target (${targets.map((target) => `${target.os}-${target.cpu}`).join(", ")}).`,
  );

for (const target of selected) {
  const name = `polici-${target.os}-${target.cpu}`;
  const directory = resolve(root, "dist/packages", name);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(resolve(directory, "bin"), { recursive: true });
  const output = resolve(directory, "bin/polici");
  execFileSync(
    resolve(root, "node_modules/.bin/scriptc"),
    ["build", resolve(root, "src/cli/main.ts"), "--dynamic", "--no-keep-c", "-o", output],
    {
      cwd: root,
      env: {
        ...process.env,
        ...(target.scriptcTarget === undefined
          ? {}
          : { SCRIPTC_CC: "zigcc", SCRIPTC_TARGET: target.scriptcTarget }),
      },
      stdio: "inherit",
    },
  );
  assertBinaryTarget(output, target);
  chmodSync(output, 0o755);
  writeFileSync(
    resolve(directory, "package.json"),
    `${JSON.stringify(
      {
        name: `@polici/${name}`,
        version: basePackage.version,
        description: `Polici native binary for ${target.os} ${target.cpu}`,
        license: "ISC",
        repository: {
          type: "git",
          url: "git+https://github.com/darylcecile/polici.git",
        },
        os: [target.os],
        cpu: [target.cpu],
        exports: {
          "./package.json": "./package.json",
          "./bin/polici": "./bin/polici",
        },
        files: ["bin/polici"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(resolve(directory, "LICENSE"), readFileSync(resolve(root, "LICENSE")));
}

function assertBinaryTarget(path: string, target: Target): void {
  const bytes = readFileSync(path);
  if (target.os === "darwin") {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, false) !== 0xcffaedfe)
      throw new Error(
        `Native package ${target.os}-${target.cpu} is not a 64-bit Mach-O executable.`,
      );
    const cpu = view.getUint32(4, true);
    const expected = target.cpu === "arm64" ? 0x0100000c : 0x01000007;
    if (cpu !== expected)
      throw new Error(`Native package ${target.os}-${target.cpu} contains the wrong architecture.`);
    return;
  }
  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46)
    throw new Error(`Native package ${target.os}-${target.cpu} is not an ELF executable.`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const machine = view.getUint16(18, true);
  const expected = target.cpu === "arm64" ? 183 : 62;
  if (machine !== expected)
    throw new Error(`Native package ${target.os}-${target.cpu} contains the wrong architecture.`);
}
