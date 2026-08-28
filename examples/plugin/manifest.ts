import { core, definePlugin, type } from "../../src/sdk/index.js";

export const exampleManifest = definePlugin({
  name: "example",
  version: "1.0.0",
  policiApi: 1,
  contractMajor: 1,
  documentation: {
    summary: "Example static provider contract.",
  },
  types: {
    User: type.entity({
      identity: "id",
      fields: {
        id: type.id("example:user"),
        login: type.string(),
        groups: type.set(type.string(), { resolve: "user.groups" }),
      },
    }),
  },
  exports: {
    user: type.function({
      parameters: [type.parameter("login", type.string())],
      returns: type.ref("User"),
      resolve: "user",
    }),
    health: type.resource(core.Check, { resolve: "health" }),
  },
  permissions: ["example:users:read"],
  runtime: {
    kind: "typescript",
    entrypoint: "./runtime",
    transport: "jsonl",
  },
});
