import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const binary = resolve(process.argv[2] ?? "dist/polici");
if (!existsSync(binary)) throw new Error(`macOS binary does not exist: ${binary}`);
const identity = process.env.MACOS_SIGN_IDENTITY;
const requireSigning = process.env.POLICI_REQUIRE_MACOS_SIGNING === "1";
if (identity === undefined || identity.length === 0) {
  if (requireSigning) throw new Error("MACOS_SIGN_IDENTITY is required for this release.");
  process.stdout.write("macOS signing skipped: MACOS_SIGN_IDENTITY is not configured.\n");
  process.exit(0);
}

execFileSync(
  "codesign",
  ["--force", "--options", "runtime", "--timestamp", "--sign", identity, binary],
  {
    stdio: "inherit",
  },
);
execFileSync("codesign", ["--verify", "--strict", "--verbose=2", binary], { stdio: "inherit" });

const appleId = process.env.APPLE_ID;
const teamId = process.env.APPLE_TEAM_ID;
const password = process.env.APPLE_APP_SPECIFIC_PASSWORD;
if (appleId === undefined || teamId === undefined || password === undefined) {
  if (requireSigning)
    throw new Error(
      "APPLE_ID, APPLE_TEAM_ID, and APPLE_APP_SPECIFIC_PASSWORD are required for notarization.",
    );
  process.stdout.write(
    "macOS notarization skipped: Apple notarization credentials are incomplete.\n",
  );
  process.exit(0);
}

const archive = `${binary}.notarization.zip`;
execFileSync("ditto", ["-c", "-k", "--keepParent", binary, archive], { stdio: "inherit" });
try {
  execFileSync(
    "xcrun",
    [
      "notarytool",
      "submit",
      archive,
      "--apple-id",
      appleId,
      "--team-id",
      teamId,
      "--password",
      password,
      "--wait",
    ],
    { stdio: "inherit" },
  );
} finally {
  rmSync(archive, { force: true });
}
