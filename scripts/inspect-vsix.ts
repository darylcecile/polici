import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const vsix = process.argv[2] ?? "editors/vscode/polici-language.vsix";
const listing = execFileSync("unzip", ["-Z1", vsix], { encoding: "utf8" });
const files = listing.trim().split("\n").sort();
assert.deepEqual(files, [
  "[Content_Types].xml",
  "extension.vsixmanifest",
  "extension/LICENSE.txt",
  "extension/dist/extension.js",
  "extension/language-configuration.json",
  "extension/package.json",
  "extension/readme.md",
  "extension/snippets/polici.json",
  "extension/syntaxes/polici.tmLanguage.json",
]);
const bundle = readFileSync("editors/vscode/dist/extension.js", "utf8");
assert.match(bundle, /BaseLanguageClient = class/);
assert.doesNotMatch(bundle, /require\(["']vscode-languageclient/);
