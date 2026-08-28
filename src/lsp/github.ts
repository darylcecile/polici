import { validatePluginManifest, type PluginManifest } from "../plugin/manifest.js";
import type { StaticPlugin } from "./metadata.ts";

const githubManifestJson = `{
  "schema": "polici.plugin/v2",
  "schemaVersion": 2,
  "name": "github",
  "version": "1.0.0",
  "policiApi": 1,
  "contractMajor": 1,
  "documentation": {
    "summary": "GitHub pull request, change, team, review, and check data.",
    "description": "Host-side GitHub provider. Authentication remains in the Polici host and is never shared with external plugins."
  },
  "types": {
    "PullRequest": {
      "kind": "entity",
      "identity": "id",
      "fields": {
        "approvers": { "kind": "set", "items": { "kind": "ref", "type": "User" }, "resolve": "pullRequest.approvers" },
        "author": { "kind": "ref", "type": "User" },
        "base_sha": { "kind": "string" },
        "changed_files": { "kind": "integer", "minimum": 0 },
        "draft": { "kind": "boolean" },
        "head_sha": { "kind": "string" },
        "id": { "kind": "id", "namespace": "github:pull-request" },
        "number": { "kind": "integer", "minimum": 1 },
        "state": { "kind": "string", "enum": ["open", "closed"] }
      }
    },
    "Team": {
      "kind": "entity",
      "identity": "id",
      "fields": {
        "id": { "kind": "id", "namespace": "github:team" },
        "members": { "kind": "set", "items": { "kind": "ref", "type": "User" }, "resolve": "team.members" },
        "name": { "kind": "string" },
        "organization": { "kind": "string" },
        "slug": { "kind": "string" }
      }
    },
    "User": {
      "kind": "entity",
      "identity": "id",
      "fields": {
        "id": { "kind": "id", "namespace": "github:user" },
        "login": { "kind": "string" }
      }
    }
  },
  "exports": {
    "changes": {
      "kind": "function",
      "parameters": [{ "name": "pattern", "type": { "kind": "glob" }, "default": "**/*" }],
      "resolve": "changes",
      "returns": { "kind": "core", "type": "ChangeSet" }
    },
    "check": {
      "kind": "function",
      "parameters": [
        { "name": "name", "type": { "kind": "string" } },
        { "name": "producer", "type": { "kind": "string" }, "optional": true, "description": "Immutable producer selector (app:<id> or status:<creator-node-id>). Unscoped checks are diagnostic-only and never pass." }
      ],
      "resolve": "check",
      "returns": { "kind": "core", "type": "Check" }
    },
    "pull_request": {
      "kind": "resource",
      "type": { "kind": "ref", "type": "PullRequest" },
      "context": "pull-request",
      "resolve": "pullRequest"
    },
    "team": {
      "kind": "function",
      "parameters": [{ "name": "slug", "type": { "kind": "string" } }],
      "resolve": "team",
      "returns": { "kind": "ref", "type": "Team" }
    }
  },
  "permissions": ["github:checks:read", "github:organization-members:read", "github:pull-requests:read"],
  "runtime": {
    "kind": "typescript",
    "protocol": 1,
    "entrypoint": "./builtin/github",
    "transport": "length-prefixed",
    "capabilities": ["github:checks:read", "github:organization-members:read", "github:pull-requests:read"]
  }
}`;

/** Static metadata for the host-owned GitHub provider. No runtime module is loaded by the LSP. */
const githubManifestValidation = validatePluginManifest(JSON.parse(githubManifestJson) as unknown);
if (!githubManifestValidation.ok) throw new Error("The embedded GitHub manifest is invalid.");
export const githubManifest: PluginManifest = githubManifestValidation.value;

const githubStaticExports: StaticPlugin["exports"] = [
  {
    kind: "function",
    name: "changes",
    parameters: [
      {
        name: "pattern",
        type: "glob",
        optional: true,
        hasDefault: true,
        defaultText: '"**/*"',
        documentation: "Path glob; defaults to all changed paths.",
      },
    ],
    returns: "ChangeSet",
    resultTypeName: "",
    documentation: "Changed repository paths.",
  },
  {
    kind: "function",
    name: "check",
    parameters: [
      {
        name: "name",
        type: "string",
        optional: false,
        hasDefault: false,
        defaultText: "",
        documentation: "Check name.",
      },
      {
        name: "producer",
        type: "string",
        optional: true,
        hasDefault: false,
        defaultText: "",
        documentation:
          "Immutable producer selector (app:<id> or status:<creator-node-id>); required for a passing check.",
      },
    ],
    returns: "Check",
    resultTypeName: "",
    documentation: "Find a check at the pull request head.",
  },
  {
    kind: "resource",
    name: "pull_request",
    parameters: [],
    returns: "github.PullRequest",
    resultTypeName: "PullRequest",
    documentation: "The current pull request.",
  },
  {
    kind: "function",
    name: "team",
    parameters: [
      {
        name: "slug",
        type: "string",
        optional: false,
        hasDefault: false,
        defaultText: "",
        documentation: "Team slug.",
      },
    ],
    returns: "github.Team",
    resultTypeName: "Team",
    documentation: "Find an organization team by slug.",
  },
];

export const githubStaticPlugin: StaticPlugin = {
  name: "github",
  version: "1.0.0",
  contractMajor: 1,
  documentation: "GitHub pull request, change, team, review, and check data.",
  types: [],
  exports: githubStaticExports,
};
