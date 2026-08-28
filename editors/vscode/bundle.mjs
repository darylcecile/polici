import { createRequire } from "node:module";
import { dirname } from "node:path";

import { build } from "esbuild";

const require = createRequire(import.meta.url);
const languageClient = require.resolve("vscode-languageclient/node");
const languageClientRoot = dirname(languageClient);

await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  outfile: "dist/extension.js",
  plugins: [
    {
      name: "vscode-languageclient-dependencies",
      setup(build) {
        build.onResolve({ filter: /^vscode-languageclient\/node$/ }, () => ({
          path: languageClient,
        }));
        build.onResolve(
          {
            filter:
              /^(brace-expansion|balanced-match|concat-map|minimatch|semver(?:\/.*)?|vscode-jsonrpc(?:\/.*)?|vscode-languageserver-(?:protocol|types)(?:\/.*)?)$/,
          },
          (args) => ({ path: require.resolve(args.path, { paths: [languageClientRoot] }) }),
        );
      },
    },
  ],
});
