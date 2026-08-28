import { definePlugin, type, core } from "../../src/sdk/index.js";

export const githubManifest = definePlugin({
  name: "github",
  version: "1.0.0",
  policiApi: 1,
  contractMajor: 1,
  documentation: {
    summary: "GitHub pull request, change, team, review, and check data.",
    description:
      "Host-side GitHub provider. Authentication remains in the Polici host and is never shared with external plugins.",
  },
  types: {
    User: type.entity({
      identity: "id",
      fields: {
        id: type.id("github:user"),
        login: type.string(),
      },
    }),
    Team: type.entity({
      identity: "id",
      fields: {
        id: type.id("github:team"),
        slug: type.string(),
        name: type.string(),
        organization: type.string(),
        members: type.set(type.ref("User"), { resolve: "team.members" }),
      },
    }),
    PullRequest: type.entity({
      identity: "id",
      fields: {
        id: type.id("github:pull-request"),
        number: type.integer({ minimum: 1 }),
        author: type.ref("User"),
        base_sha: type.string(),
        head_sha: type.string(),
        changed_files: type.integer({ minimum: 0 }),
        draft: type.boolean(),
        state: type.string({ enum: ["open", "closed"] }),
        approvers: type.set(type.ref("User"), { resolve: "pullRequest.approvers" }),
      },
    }),
  },
  exports: {
    pull_request: type.resource(type.ref("PullRequest"), {
      context: "pull-request",
      resolve: "pullRequest",
    }),
    changes: type.function({
      parameters: [type.parameter("pattern", type.glob(), { default: "**/*" })],
      returns: core.ChangeSet,
      resolve: "changes",
    }),
    team: type.function({
      parameters: [type.parameter("slug", type.string())],
      returns: type.ref("Team"),
      resolve: "team",
    }),
    check: type.function({
      parameters: [
        type.parameter("name", type.string()),
        type.parameter("producer", type.string(), {
          optional: true,
          description:
            "Immutable producer selector (app:<id> or status:<creator-node-id>). Unscoped checks are diagnostic-only and never pass.",
        }),
      ],
      returns: core.Check,
      resolve: "check",
    }),
  },
  permissions: [
    "github:pull-requests:read",
    "github:checks:read",
    "github:organization-members:read",
  ],
  runtime: {
    kind: "typescript",
    entrypoint: "./builtin/github",
    transport: "length-prefixed",
    capabilities: [
      "github:pull-requests:read",
      "github:checks:read",
      "github:organization-members:read",
    ],
  },
});

export default githubManifest;
