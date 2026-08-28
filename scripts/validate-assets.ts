import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const schemas = [
  "schemas/plugin-lock.schema.json",
  "schemas/plugin-manifest.schema.json",
  "schemas/policy-report.schema.json",
  "schemas/runtime-protocol.schema.json",
] as const;
for (const path of schemas) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(typeof value, "object", `${path} must contain a JSON object.`);
  assert.notEqual(value, null, `${path} must contain a JSON object.`);
  assert.match(
    value.$schema,
    /^https:\/\/json-schema\.org\/draft\//,
    `${path} must declare a JSON Schema draft.`,
  );
  assert.equal(typeof value.$id, "string", `${path} must declare an id.`);
  assert.equal(value.type, "object", `${path} must describe an object root.`);
}

const grammar = JSON.parse(readFileSync("editors/vscode/syntaxes/polici.tmLanguage.json", "utf8"));
assert.equal(grammar.scopeName, "source.polici");
assert.ok(Array.isArray(grammar.patterns) && grammar.patterns.length > 0);
assert.equal(typeof grammar.repository, "object");

const snippets = JSON.parse(readFileSync("editors/vscode/snippets/polici.json", "utf8"));
assert.ok(Object.keys(snippets).length > 0);
for (const snippet of Object.values(snippets) as { prefix?: unknown; body?: unknown }[]) {
  assert.ok(typeof snippet.prefix === "string" || Array.isArray(snippet.prefix));
  assert.ok(typeof snippet.body === "string" || Array.isArray(snippet.body));
}

const language = JSON.parse(readFileSync("editors/vscode/language-configuration.json", "utf8"));
assert.ok(Array.isArray(language.brackets));
assert.equal(typeof language.comments, "object");
