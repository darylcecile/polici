// @ts-ignore This bare repository intentionally does not depend on @types/node.
import { readFileSync } from "node:fs";

import { RepositorySnapshot } from "../src/core/repository.js";
import { checkPolicy } from "../src/index.js";

declare const process: {
  exitCode: number;
  stdout: { write(value: string): void };
};

async function main(): Promise<void> {
  const source = new TextDecoder().decode(readFileSync("examples/policies/core.pol"));
  const repository = RepositorySnapshot.fromEntries([
    { path: "fixtures/records/a.json", content: '{"id":"a"}' },
    { path: "fixtures/records/b.json", content: '{"id":"b"}' },
  ]);

  const result = await checkPolicy(source, { repository });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.exitCode;
}

void main();
