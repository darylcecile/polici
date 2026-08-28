# Plugin SDK and Manifest

Polici plugins have a static contract and a runtime implementation. The compiler and editor MUST be able to read the static manifest without loading or executing runtime code. Plugins cannot add syntax, keywords, operators, parsers, or global names; all exports are accessed through the alias declared by `using`.

## Versions

The implemented strict manifest discriminator is:

```json
{
  "schema": "polici.plugin/v2",
  "schemaVersion": 2,
  "policiApi": 1,
  "contractMajor": 1
}
```

- `schema` and `schemaVersion` version the JSON shape.
- `policiApi` is the compiler-facing plugin manifest API and MUST be `1`.
- `contractMajor` is a positive integer naming the provider-facing type/export contract. Policy `using "github@1"` selects this value.
- `version` is the exact semantic implementation version recorded in a lockfile. It does not participate directly in policy source binding.
- `runtime.protocol` is the independent host/runtime message protocol and MUST be `1`.

Changing or removing a type, field, export, identity namespace, resolver meaning, parameter order, or return type requires a new `contractMajor`. Compatible implementation fixes may retain it and change exact `version` plus lock digests.

## SDK Authoring

The npm entry `polici/plugin-sdk` exports `definePlugin`, `pluginManifestJson`, `type`, and `core`. The TypeScript contract is the source of truth; `manifest.json` is generated static output.

Install Polici as a development dependency so contract types, runtime types, the builder, and its pinned scriptc compiler stay versioned together:

```console
npm install --save-dev polici@1.0.3
```

```ts
import { core, definePlugin, type } from "polici/plugin-sdk";

export default definePlugin({
  name: "example",
  version: "1.0.0",
  policiApi: 1,
  contractMajor: 1,
  types: {
    User: type.entity({
      identity: "id",
      fields: {
        id: type.id("example:user"),
        login: type.string(),
      },
      methods: {
        belongs_to: type.method({
          parameters: [type.parameter("group", type.string())],
          returns: type.boolean(),
          resolve: "user.belongsTo",
          summary: "Tests group membership.",
        }),
      },
    }),
  },
  exports: {
    user: type.function({
      parameters: { login: type.string() },
      returns: type.ref("User"),
      resolve: "user",
    }),
    health: type.resource(core.Check, { resolve: "health" }),
  },
  permissions: ["example:users:read"],
  runtime: {
    kind: "typescript",
    entrypoint: "./runtime.ts",
  },
});
```

`definePlugin` fills empty maps/arrays, defaults protocol 1 and JSONL transport, defaults runtime capabilities to permissions, sorts and de-duplicates permissions/capabilities, validates, recursively canonicalizes, and deep-freezes the returned JSON-shaped manifest. Object-shaped function/method parameters preserve declaration order and normalize to the manifest's language-neutral parameter array. A `type.glob({ default })` parameter moves that default onto the parameter during normalization. TypeScript entrypoints such as `./runtime.ts` normalize to the compiled `./runtime` path in generated static metadata. `pluginManifestJson` validates and emits recursively canonical one-line JSON followed by one newline. `type.method` builds an entity method; methods are not valid on value types.

The runtime source binds back to the default-exported contract:

```ts
import { defineRuntime } from "polici/runtime-sdk";
import plugin from "./plugin.ts";

export default defineRuntime(plugin, {
  resolvers: {
    user(context, { login }) {
      return context.value.entity(
        "example:User",
        { namespace: "example:user", value: login },
        {
          id: context.value.id("example:user", login),
          login,
          groups: new Set(),
        },
      );
    },
  },
});
```

`defineRuntime` derives the runtime name, version, transport, capabilities, resolver names, and resolver argument types from the plugin contract. `polici-plugin build plugin.ts` validates both default exports, checks every declared resolver exists, optionally emits canonical `manifest.json`, generates the protocol entrypoint internally, bundles the adapter, and invokes scriptc. Use `--no-manifest` when the repository consumes `plugin.ts` directly. Normal plugin code does not parse protocol messages, tag primitive values, or manage continuations.

`polici lock --plugin plugins/example/plugin.ts` parses the declarative contract without executing it and records that source path in `polici.lock`. Later check, validate, and LSP operations regenerate the contract in memory and verify its canonical digest. The supported static subset is `export default definePlugin({...})`, imports from `polici/plugin-sdk`, JSON literals, `core.*` references, and `type.*` calls. Variables, spreads, computed properties, templates, arbitrary calls, and dynamic expressions are rejected.

The full example is [`examples/plugin/plugin.ts`](../examples/plugin/plugin.ts) with [`examples/plugin/runtime.ts`](../examples/plugin/runtime.ts).

## Manifest Fields

The JSON Schema is [`schemas/plugin-manifest.schema.json`](../schemas/plugin-manifest.schema.json). Unknown properties are rejected throughout the contract.

| Field           | Rule                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `name`          | Lowercase package-style name: starts with a letter; segments may use lowercase letters/digits and `-` or `.` separators. |
| `version`       | Full semantic version with optional prerelease/build metadata.                                                           |
| `types`         | Map whose keys are ASCII identifiers.                                                                                    |
| `exports`       | Map whose keys are ASCII identifiers.                                                                                    |
| `permissions`   | Unique capability names such as `github:checks:read`.                                                                    |
| `runtime`       | Kind, protocol, safe package-relative entrypoint, transport, and unique capability list.                                 |
| `documentation` | Optional summary, description, deprecation text, and unique examples.                                                    |

Authored entrypoints MUST start with `./`, use `/`, contain no NUL, and have no empty, `.` or `..` segment. WASM entrypoints MUST end in `.wasm`. `definePlugin` accepts a TypeScript source suffix and normalizes it away; the emitted canonical manifest always describes the precompiled executable and rejects source suffixes. The `kind` records the authoring/runtime lane, not permission to execute source directly.

`permissions` and `runtime.capabilities` MUST contain the same capability names. The evaluator requires the resolver host to advertise every manifest permission before any resolver call. A manifest permission is therefore a minimum host grant for the whole plugin, not a resolver-by-resolver dynamic request.

## Type Expressions

| Kind       | Fields and runtime wire value                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------- |
| `string`   | Optional `enum` and safe anchored linear `pattern`; wire `string`                                 |
| `integer`  | Optional safe-integer `minimum`/`maximum`; decimal-string wire `integer`, then safe-range checked |
| `boolean`  | wire `boolean`                                                                                    |
| `glob`     | Optional manifest metadata `default`; wire `string`                                               |
| `id`       | Required capability-shaped `namespace`; wire `id` with the same namespace                         |
| `ref`      | Required local named `type`; entity wire value or map for a value type                            |
| `core`     | `File`, `Change`, `ChangeSet`, or `Check`; entity wire value with core shape                      |
| `list`     | Ordered wire `list` of `items`                                                                    |
| `set`      | Canonically ordered, duplicate-free wire `set`; may have a lazy field resolver                    |
| `optional` | `missing` or `null` permitted, otherwise `value`                                                  |
| `object`   | Closed wire `map` of declared `fields`                                                            |

All `ref` targets, including method parameter and result references, must exist in the same manifest. The evaluator rejects undeclared object/entity fields and enforces string enum/pattern and integer range constraints. A non-optional required value may not be `missing` or `null`.

String patterns are limited to an anchored, non-backtracking subset and at most 256 UTF-16 code units. They MUST begin with `^` and end with `$`. The body supports literal code units, `.`, character classes with ranges or leading `^` negation, backslash-escaped literals, and one `?`, `*`, or `+` quantifier on an atom. Grouping, alternation, counted repetition, backreferences, lookarounds, and stacked quantifiers are rejected. Matching uses a bounded state-set algorithm rather than the ECMAScript regular-expression engine.

## Named Types and Identity

An `entity` has `identity` naming one of its `id` fields. A runtime entity MUST repeat exactly the same namespace and value in both the entity identity header and that field. Entity equality includes provider name, provider contract major, entity type, identity namespace, and value; mutable display fields do not affect equality.

A `value` has fields but no identity and is sent as a map. Value equality is structural. Value types may contain optional fields, lists, sets, objects, and references as their expressions permit.

Only a direct `set` field of an `entity` may declare `resolve`. Exports, parameters, method declarations, value-type fields, list types, and nested set/object/optional expressions cannot carry lazy resolver metadata. Return `missing` for the direct entity set field in the initial entity to activate lazy resolution. The evaluator passes the original entity wire value as `subject`, calls the field resolver once per decoded entity, and caches the result. Returning `missing` for any other required field is a wire type error, not a language-optional absence.

An entity may also declare `methods`. Each method has ordered `parameters`, `returns`, `resolve`, and optional documentation, with the same parameter/default rules as a function export. A field and method cannot share a name. Completion, hover, signature help, type checking, and IR all use this static declaration without loading the runtime. Calling `entity.method(...)` sends the original entity wire value as `subject`; arguments are encoded by declared parameter name and the result is decoded against `returns`.

## Exports and Parameters

A resource has a type, resolver name, and optional lowercase-hyphenated context label. A function has an ordered parameter array, return type, and resolver. Resolver names are dot-separated ASCII identifiers.

Parameters are positional in policy source but are encoded by declared `name` in runtime requests. Required parameters MUST precede optional/defaulted parameters. Names are unique. `default` must be strict JSON compatible with the declared type; defaults for `ref` and `core` are not supported. Set defaults cannot contain duplicate JSON encodings. Omitted optional parameters without defaults are sent as wire `missing`.

The evaluator checks policy arity statically and again at runtime, validates every argument against its declared type before invoking any host, then validates the resolver result against the manifest return expression. String enum/pattern, integer range, glob syntax, ID namespace, closed object/value fields, references, and exact list/set tags are enforced. Sets are canonically sorted and duplicate values or entity identities are rejected. Where the static language type preserves the collection tag, passing a `Set<T>` to `list<T>` or a `Collection<T>` to `set<T>` is a compile-time mismatch as well as a runtime error.

## Validation Limits

Default manifest validation bounds are depth 64, 100,000 visited nodes, 10,000 items in any array, 10,000 entries in any object, and 1,048,576 total UTF-16 code units across all property names and string values. The node and string budgets are cumulative across the manifest traversal. Cycles, shared in-memory object references, and keys `__proto__`, `prototype`, and `constructor` are rejected. Programmatic input accepts only primitives, ordinary arrays, and plain or null-prototype data records. It rejects `undefined`, symbols, accessors, non-enumerable data, sparse or customized arrays, `Date`, custom prototypes, unsupported numeric values, and other non-JSON object models without invoking getters. JSON text cannot represent those values and remains subject to all structural checks.

The JSON Schema captures the serializable shape. `validatePluginManifest` is authoritative for resource limits, safe paths, safe-pattern parsing, references, identity field type, default/type compatibility, lazy-resolver placement, and permission/capability closure.

## Resolver Implementation

Resolvers receive:

```ts
interface ResolverRequest {
  resolver: string;
  arguments: Readonly<Record<string, WireValue>>;
  subject?: WireValue;
}
```

They MUST return a wire value conforming to the declared result type or throw a `ResolverFault`. Provider code SHOULD use the `wire` constructors; `wire.set` sorts by canonical JSON and rejects duplicate values and duplicate entity identities. See [Runtime protocol](runtime-protocol.md) for language-neutral implementations.

External process runtimes can request host-owned services through `capability-call`; those interactive grants include declared operation names, optional non-secret scope, and quotas. Manifest `runtime.capabilities` names possible grants, while the actual process host chooses detailed grants and supplies a broker. The standalone CLI currently has no generic broker service and returns `CAPABILITY_NOT_CONFIGURED` to path-plugin callbacks; library embedders may provide one.
