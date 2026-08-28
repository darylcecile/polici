import { rmSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
rmSync(resolve(root, "lib"), { recursive: true, force: true });
rmSync(resolve(root, ".pack"), { recursive: true, force: true });
