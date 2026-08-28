# Polici Language Reference

This document is normative for the implemented policy language.

## Source Model

Policy files conventionally use `.pol`. Source positions are zero-based UTF-16 offsets, lines, and columns. Whitespace and comments are accepted wherever tokens may be separated. Line comments start with `//`; block comments start with `/*` and end at the next `*/` and do not nest.

Identifiers start with `_`, an ASCII letter, or any UTF-16 code unit at or above U+0080. Subsequent characters may also be decimal ASCII digits. Keywords are lowercase and case-sensitive.

Strings use JSON double-quoted syntax and JSON escapes. Numbers use JSON number syntax, including an optional leading minus, fraction, and exponent; leading zeroes and non-finite results are errors. Semicolons after declarations and statements are optional.

## Grammar

The grammar below is EBNF. `*` means zero or more, `?` means optional, and alternatives use `|`.

```ebnf
program          = { using-declaration | policy-declaration }, EOF ;

using-declaration = "using", string, "as", identifier, [ ";" ] ;
policy-declaration = "policy", string, "{", { policy-member }, "}", [ ";" ] ;
policy-member     = binding | rule-declaration ;
binding           = identifier, "=", expression, [ ";" ] ;

rule-declaration  = "rule", string, { when-clause | "optional" },
                    "{", { statement }, "}", [ ";" ] ;
when-clause       = "when", expression ;
statement         = require-statement | for-each-statement ;
require-statement = "require", expression, [ ";" ] ;
for-each-statement = "for", "each", identifier, "in", expression,
                     "{", { statement }, "}", [ ";" ] ;

expression        = or-expression ;
or-expression     = and-expression, { "or", and-expression } ;
and-expression    = unary-expression, { "and", unary-expression } ;
unary-expression  = "not", unary-expression
                  | quantified-expression
                  | comparison-expression ;
quantified-expression = quantifier, comparison-expression,
                        [ "in", comparison-expression ] ;
quantifier        = "some" | "every" | "no" ;
comparison-expression = postfix-expression,
                        { "passed"
                        | "matches", postfix-expression
                        | "unique", "in", postfix-expression
                        | ( "==" | "!=" ), postfix-expression } ;
postfix-expression = primary-expression,
                     { "(", [ expression, { ",", expression } ], ")"
                     | ".", member-name
                     | ".", "{", expression, "}" } ;
primary-expression = identifier | string | number | "true" | "false" | "null"
                   | "(", expression, ")" ;
```

`member-name` may be an identifier or any keyword, so provider fields such as `.optional` remain addressable. A `using` source MUST have the exact decoded form `name@major`, where `major` is a positive decimal integer without a sign or leading zero. The major is the provider's `contractMajor`, not its package version and not the manifest schema version.

The parser recovers from errors and returns an AST plus diagnostics. A host MUST NOT evaluate a compilation containing an error diagnostic; `evaluatePolicy` returns status `error`, exit code `2`, and no policies in that case.

## Precedence and Associativity

From highest to lowest:

| Level | Forms                                                | Associativity |
| ----- | ---------------------------------------------------- | ------------- |
| 1     | primary expressions and parentheses                  | n/a           |
| 2     | calls `f(...)`, members `a.b`, projections `a.{ b }` | left          |
| 3     | postfix `passed`, `matches`, `unique in`, `==`, `!=` | left          |
| 4     | prefix `not`; prefix `some`, `every`, `no`           | right/prefix  |
| 5     | `and`                                                | left          |
| 6     | `or`                                                 | left          |

All comparison forms share one level. Parenthesize mixed comparisons. `and` and `or` short-circuit left to right. Collection folds and relations short-circuit once their result is known.

## Declarations and Scopes

Provider aliases are program-global. Aliases may not collide with core globals, prior aliases, or other global symbols. Policy names must be unique in a source file.

A policy binding is immutable and visible to rules and later binding expressions in that policy. Bindings are processed in source order; a binding cannot refer forward to a later binding. Duplicate bindings are errors. Bindings are lazy during evaluation and memoized within one policy evaluation, so an unused binding does not call a resolver.

Rule names must be unique within a policy. Each rule sees the policy bindings and globals. A `for each` variable is visible only in its loop body; nested loops create nested scopes and may shadow outer names. Projection bodies do not declare an item name. Instead, fields of each statically named element are in implicit scope:

```polici
require every Files("**/*").{ path matches "**/*.md" }
```

For dynamic JSON, any otherwise unresolved identifier in a projection body is treated as a field of the current JSON item; lexically declared names take precedence. An explicit loop variable is required when nested access would otherwise be unclear.

## Static Types

The frontend has these types:

| Type            | Meaning                                                                           |
| --------------- | --------------------------------------------------------------------------------- |
| `boolean`       | `true` or `false`                                                                 |
| `integer`       | A finite integer; provider wire integers must fit JavaScript's safe integer range |
| `number`        | A finite JSON number                                                              |
| `string`        | Text                                                                              |
| `glob`          | A string used as a Polici path pattern; statically assignable to/from `string`    |
| `null`          | The literal `null`                                                                |
| `Json`          | Dynamically shaped strict JSON; field access remains `Json`                       |
| `Parser<json>`  | The core `json` parser value                                                      |
| `Collection<T>` | Ordered values; duplicates may occur                                              |
| `Set<T>`        | Values declared unique by the provider wire contract                              |
| `File`          | Core repository file                                                              |
| `Change`        | Core changed path                                                                 |
| `ChangeSet`     | Iterable, status-filterable changes                                               |
| `Check`         | Core normalized check                                                             |
| `provider.Type` | Manifest-defined entity or value type                                             |

An integer is assignable to `number`. Dynamic `Json` is permissive at compile time and checked when demanded at runtime. Named values are compatible only when provider and type names match. Collection compatibility is based on element compatibility; set-ness does not make a distinct relation type.

Provider entities compare by provider name, provider type, identity namespace, and immutable identity value. Other values use structural equality. This rule is used by `==`, `!=`, uniqueness, set relationships, and evidence.

## Core Values

### `Files(pattern)`

`Files` requires one glob and returns `Collection<File>` from the supplied immutable head snapshot, sorted by repository-relative path. A `File` has `path`, UTF-8 `content`, and `.as(json)`. Calling `.as(json)` on a file collection parses every file with strict JSON and returns `Collection<Json>` while retaining paths, JSON Pointers, and source spans for evidence.

Strict JSON rejects duplicate keys, trailing commas, invalid escapes, non-finite numbers, excess depth, and excess byte size. Core defaults are 16 MiB and depth 128 per parsed JSON source.

### `Change` and `ChangeSet`

`Change.status` is exactly `added`, `modified`, `deleted`, or `renamed`. `Change.path` is the current/head-side path. `Change.previous_path` is the old path for a rename and is missing for all other statuses. `before` is always missing for additions and `after` is always missing for deletions. Other legal sides are readable `File` values when materialized; the built-in GitHub provider materializes every legal `before` from the merge base and every legal `after` from the exact head snapshot.

At the provider boundary, a `before` map may contain UTF-8 text or base64 bytes and is materialized directly as a core file. A rename requires `before.path`, which becomes `previous_path`. For non-deleted changes the evaluator resolves `after` by path from the supplied head `RepositorySnapshot` rather than trusting provider content; the GitHub host first verifies those snapshot bytes against the immutable Git blob. Invalid/missing legal sides fail closed when demanded.

A `ChangeSet` is iterable as `Change`, sorted by `path`, then status, then previous path. Duplicate current paths are invalid. It exposes `.added`, `.modified`, `.deleted`, and `.renamed` filters.

`.files(pattern?)` returns materialized head-side files for non-deleted changes. The default pattern is `**/*`. Deleted changes are omitted. A matching non-deleted change whose head content is not in the supplied repository snapshot is **missing data**, not an omitted item. `changes.before` and `changes.after` exist in the core library model as `FileCollection` accessors, but they are not language members; iterate changes and read each `before`/`after` instead. A policy that wants both additions and renames in a status-specific content rule must state both branches because the language has no collection concatenation operator.

### `Check`

A check has `name`, `status`, and alias field `conclusion`. Status is `missing`, `pending`, `passed`, `failed`, or `cancelled`. `check passed` is true only for `passed`; every other state is an ordinary false requirement, not missing data.

## Operators

### Projection and folds

`collection.{ expression }` evaluates the expression once for each item and preserves collection order. If the source static type is a set, the projected static type is also a set, although runtime uniqueness is guaranteed only by valid provider input.

`some booleans` is existential, `every booleans` is universal, and `no booleans` requires no true item. Empty folds evaluate as follows:

| Fold    | Empty result |
| ------- | ------------ |
| `some`  | `false`      |
| `every` | `true`       |
| `no`    | `true`       |

### Collection relationships

Both sides of a quantified `in` relation must be collections with comparable element types:

```polici
some A in B   // intersection is non-empty
every A in B  // A is a subset of B
no A in B     // A and B are disjoint
```

Duplicates do not alter these membership results. Entity membership uses typed immutable identity.

### Uniqueness

`value unique in collection` is true exactly when the value occurs once. Zero occurrences fail, and two or more occurrences fail with duplicate evidence. “Including the current item” is therefore significant in per-record uniqueness rules.

### Matching

`value matches pattern` requires runtime strings and performs an anchored, case-sensitive repository-path glob match. It is not a regular expression.

### Equality and logic

`==` and `!=` use entity identity or structural value equality as described above. `not`, `and`, and `or` require booleans. There is no truthiness conversion.

## Polici Globs

Paths are repository-relative and normalized to `/`. Matching is anchored to the complete path and case-sensitive.

- `*` matches zero or more characters inside one segment and never `/`.
- `**` matches zero or more complete path segments and MUST occupy an entire segment.
- All other characters are literals. There are no `?`, character-class, brace, escape, or negation operators.
- A glob MUST NOT start with `/`, contain `\` or NUL, contain empty segments, or contain `.`/`..` segments.
- The empty glob matches only the repository root; files cannot have the root path.
- `**/*.md` matches `README.md` and `docs/guide.md`.
- `schema/**` matches `schema` itself and everything below it.
- `**/*` matches every non-root repository path.

The GitHub provider filters changed paths before converting them to core changes. Selection matches either a change's current path or rename `previous_path`, using the same `PoliciGlob` implementation. Paths and policy patterns must be canonical forward-slash values.

## Missing, Null, and `optional`

Missing and null are distinct internal values but have the same rule control behavior. Demanding either as a boolean, string, collection, comparison operand, member receiver, provider argument, or uniqueness item raises an evaluation error by default. Missing examples include an absent JSON field, unavailable change content, absent provider field, or unresolved optional provider value. Invalid JSON, an unknown field, a wire type mismatch, and a failed `Check` are not “missing.”

A rule marked `optional` converts only `EVALUATION_MISSING_VALUE` or `EVALUATION_NULL_VALUE` raised while evaluating its condition or body into one skipped rule when no evaluated requirement has already failed. A known failure takes precedence over later absence: the rule remains failed and preserves its requirement evidence. Evidence identifies the missing value where available.

`optional` does not suppress lexing, parsing, binding, type, manifest, lock, permission, timeout, protocol, provider, JSON parse, limit, or other runtime faults. It also does not make a false requirement pass.

`when false` skips a rule with the message `Rule condition was false.` The condition runs before the body. `when` and `optional` may appear in either order, once each.

## Evaluation Order and Limits

Policies, rules, statements, loop items, and projection items evaluate in source or canonical collection order. All rules are attempted even after a prior rule fails. A rule stops on its first evaluation fault. Resolver resources, lazy entity fields, and bindings are memoized by the evaluator; a `LazyMemoizingResolverHost` additionally memoizes identical canonical requests when no signal or per-call timeout is supplied.

Default evaluator limits are 10,000 files per selection, 10,000 collection items, 1,000 resolver calls per complete evaluation, and 100 retained evidence records per rule. Limits are non-negative safe integers; exceeding one is an error and yields exit code 2. Evidence truncation does not change a result.

## Result Semantics

A `require` produces `passed` or `failed`; a runtime fault produces rule `error`; a false condition or optional absence produces `skipped`. A policy is `error` if any rule errors, otherwise `failed` if any rule fails, otherwise `passed`. A complete evaluation uses the same precedence across policies. Exit codes are 0 for passed, 1 for policy failure, and 2 for compilation/provider/evaluation error.

Failures retain policy and requirement source spans and bounded evidence. JSON-derived evidence can include repository path, RFC 6901 JSON Pointer, and the parsed value's source span.
