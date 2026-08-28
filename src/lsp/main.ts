import { readSync, writeSync } from "node:fs";
import { runLanguageServer } from "./server.ts";

const exitCode = runLanguageServer(
  {
    read(buffer): number {
      return readSync(0, buffer, 0, buffer.length, null);
    },
  },
  {
    write(buffer): number {
      return writeSync(1, buffer, 0, buffer.length, null);
    },
  },
);
if (exitCode !== 0) throw new Error("Language server exited before shutdown.");
