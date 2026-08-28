# Runtime Protocol v1

`polici.runtime/v1` is the language-neutral protocol between a Polici process host and an external plugin runtime. It is independent of policy syntax, manifest schema, provider contract major, programming language, and native/WASI execution lane.

The per-message schema is [`runtime-protocol.schema.json`](../schemas/runtime-protocol.schema.json). Runtime validators additionally enforce byte/resource bounds, fresh continuation tokens, lifecycle and capability ordering, manifest result types, canonical sets, and duplicate identity rejection.

## Logical Sessions

A resolver host owns one logical session and serializes calls through it:

1. The first resolver call starts with `initialize`; the runtime returns `initialized` and a fresh opaque continuation.
2. Each `call` carries the latest continuation and an absolute Unix-millisecond deadline.
3. The runtime returns `result`/`error`, or requests host work with `capability-call`.
4. The host validates and brokers a capability call, then resumes the same logical call with `capability-result`. Steps 3-4 may repeat.
5. Later resolver calls reuse the newest continuation without another initialization.
6. `dispose()` sends `shutdown` with the newest continuation and expects `stopped`.

Each exchange launches a process, sends exactly one framed host message on stdin, reads exactly one framed runtime response from stdout, waits for exit 0, then carries state to the next exchange only through the returned continuation. This provides persistent **logical** sessions without requiring a long-lived child process. Runtime implementations must not depend on process globals, files, environment, or memory surviving an exchange.

Calls on one host are queued, not concurrent. Distinct host instances may run concurrently. A protocol fault or an unexpected non-`ResolverFault` marks the session failed; later resolution returns `RUNTIME_SESSION_FAILED`. Structured runtime, process, timeout, cancellation, permission, and capability faults fail the current resolver operation but do not by themselves set that terminal flag. A call-level runtime error must return a fresh continuation so later calls can resume valid state. Disposal after a terminally failed session performs no shutdown exchange.

## Framing

Every frame contains one strict UTF-8 JSON object. Unknown properties are invalid. The host emits canonical JSON, but runtimes need only emit valid contract-conforming JSON. JSON Schema's `number` type cannot represent JavaScript `NaN`/infinities; the runtime validator explicitly requires finite wire numbers.

### JSONL

One JSON object followed by byte `0A`. Empty/ASCII-whitespace-only lines are ignored, but a non-empty final frame without newline is invalid. Exactly one non-empty runtime message is allowed per exchange.

### Length-prefixed

A four-byte unsigned big-endian payload length followed by that many UTF-8 JSON bytes. Zero-length frames, truncated headers/payloads, and oversized frames are rejected. There is no delimiter, magic, or checksum.

The manifest and lock choose `jsonl` or `length-prefixed`; a runtime must not auto-detect. Both `TypeScriptProcessResolverHost` and `WasiProcessResolverHost` use byte-oriented stdin/stdout and support both transports equivalently. `encodeProtocolMessages` and `decodeProtocolMessages` expose the same framing.

## Envelope and Names

Every message includes:

```json
{
  "protocol": "polici.runtime/v1",
  "type": "call",
  "id": "call-2"
}
```

`id` and `requestId` start with an ASCII alphanumeric and continue with ASCII alphanumerics, `.`, `_`, `:`, or `-`. Resolver/operation/implementation names start with an ASCII letter or `_` and continue with ASCII alphanumerics, `_`, `.`, or `-`. Capability names have two or more colon-separated lowercase components, for example `example:data`.

## Continuations

A continuation is an opaque non-empty string using ASCII alphanumerics plus `.`, `_`, `~`, `+`, `/`, `=`, or `-`. Because the alphabet is ASCII, its character and UTF-8 byte lengths are equal. The protocol hard limit is 16,384 bytes; the host's advertised `maxContinuationBytes` may be lower.

Every `initialized`, `result`, and `capability-call` response must return a **fresh** continuation. A call-level `error` must include one so the host can retain valid state. No continuation may be replayed anywhere in a session. The runtime should authenticate state encoded into a continuation if tampering is possible in its deployment, and it must never place secrets in the token because hosts may log protocol metadata.

`stopped` has no continuation. An initialization or shutdown `error` may omit one. Other runtime `error` messages are schema-valid with or without a continuation, but the current host requires a fresh continuation for an error that terminates a resolver call, including one returned after a capability result. JSON Schema checks per-message shape only; freshness and lifecycle-dependent requirements are runtime responsibilities.

## Initialization

Host:

```json
{
  "protocol": "polici.runtime/v1",
  "type": "initialize",
  "id": "initialize-1",
  "host": { "name": "polici", "version": "1" },
  "plugin": { "name": "example", "version": "1.0.0" },
  "capabilities": [
    {
      "name": "example:data",
      "operations": ["read"],
      "description": "Read host-owned example data.",
      "scope": { "tag": "string", "value": "public" },
      "maxCalls": 4
    }
  ],
  "limits": {
    "maxFrameBytes": 1048576,
    "maxMessageBytes": 1048576,
    "maxOutputBytes": 4194304,
    "maxLogBytes": 262144,
    "maxContinuationBytes": 16384,
    "maxCapabilityCalls": 64
  }
}
```

Runtime:

```json
{
  "protocol": "polici.runtime/v1",
  "type": "initialized",
  "id": "initialize-1",
  "implementation": { "name": "example", "version": "1.0.0" },
  "capabilities": ["example:data"],
  "continuation": "opaque-session-state-1"
}
```

Implementation name and version must equal the locked plugin exactly. The runtime activates only grants it will use; every activated name must occur in `initialize.capabilities`. An empty activation list is valid. Capability grants have unique names, their operations are unique, and the process host requires at least one operation in every grant. A process host also requires a broker whenever it is constructed with non-empty grants.

All limit fields are positive safe integers. The library defaults are:

| Limit                  | Default | Scope                                                               |
| ---------------------- | ------: | ------------------------------------------------------------------- |
| `maxFrameBytes`        |   1 MiB | One encoded JSON payload                                            |
| `maxMessageBytes`      |   1 MiB | One decoded message; cannot exceed frame limit                      |
| `maxOutputBytes`       |   4 MiB | Cumulative stdout across one resolver operation and its resumptions |
| `maxLogBytes`          | 256 KiB | Cumulative stderr across one resolver operation and its resumptions |
| `maxContinuationBytes` |  16 KiB | One continuation; cannot exceed protocol hard limit                 |
| `maxCapabilityCalls`   |      64 | Capability callbacks within one resolver call                       |

The host also defaults to 4,096 exchanges over the logical session, reserving one for shutdown, and 30 seconds for one resolver call including initialization, process exchanges, and broker work. The session-level per-grant `maxCalls` counter and seen capability request IDs persist across resolver calls; the advertised `maxCapabilityCalls` counter resets for each resolver call.

## Resolver Calls

```json
{
  "protocol": "polici.runtime/v1",
  "type": "call",
  "id": "call-2",
  "resolver": "user",
  "arguments": {
    "login": { "tag": "string", "value": "octocat" }
  },
  "continuation": "opaque-session-state-1",
  "deadlineUnixMs": 1787836800000
}
```

`arguments` contains every manifest parameter by declared name. The evaluator materializes defaults and sends omitted optional parameters as `missing`. It validates and encodes each value against its declared `TypeExpression` before invoking either an in-process or external host. Exact list/set tags, canonical unique sets, string/integer/glob constraints, references, IDs, and closed object fields are preserved on the wire. A typed entity method or lazy direct entity set field additionally sends the original entity wire value as `subject`.

Success returns a manifest-conforming tagged value and a fresh continuation:

```json
{
  "protocol": "polici.runtime/v1",
  "type": "result",
  "id": "call-2",
  "value": { "tag": "string", "value": "octocat" },
  "continuation": "opaque-session-state-2"
}
```

The response ID must equal the call ID. The process host verifies generic wire shape; the evaluator subsequently verifies the manifest-declared result type, closed fields, constraints, and identity.

## Capability Broker

A runtime may return:

```json
{
  "protocol": "polici.runtime/v1",
  "type": "capability-call",
  "id": "call-2",
  "requestId": "call-2-capability-1",
  "sequence": 1,
  "capability": "example:data",
  "operation": "read",
  "arguments": {
    "key": { "tag": "string", "value": "profile" }
  },
  "continuation": "opaque-session-state-2",
  "deadlineUnixMs": 1787836795000
}
```

The host accepts it only when:

- `id` equals the active resolver call;
- `sequence` starts at 1 and increments by exactly one;
- `requestId` has never appeared in the host session;
- the capability was both granted and activated;
- the operation occurs in that grant;
- per-call, per-grant, deadline, output, and exchange quotas remain available;
- the continuation is fresh.

The optional capability deadline can tighten but never extend the resolver deadline. The broker receives the grant, including non-secret `scope`, plus request arguments, call/request IDs, sequence, effective deadline, and a cancellation signal. Credentials stay inside that host-owned broker.

The host resumes with exactly one result or error:

```json
{
  "protocol": "polici.runtime/v1",
  "type": "capability-result",
  "id": "call-2",
  "requestId": "call-2-capability-1",
  "sequence": 1,
  "continuation": "opaque-session-state-2",
  "result": { "tag": "string", "value": "value" }
}
```

`id`, `requestId`, `sequence`, and continuation copy the accepted capability call. `result` and `error` are mutually exclusive. Broker throws, malformed envelopes, deadline expiry, unavailable brokers, and quota exhaustion are normalized to structured capability errors where possible. A runtime may propagate, transform, or handle that error before returning its next fresh continuation.

The generic library host implements this loop. The current CLI intentionally installs an unavailable broker for external path plugins, so their capability attempts receive `CAPABILITY_NOT_CONFIGURED`; an embedding host can supply a functional `CapabilityBroker`.

## Shutdown

```json
{"protocol":"polici.runtime/v1","type":"shutdown","id":"shutdown-3","continuation":"opaque-session-state-3"}
{"protocol":"polici.runtime/v1","type":"stopped","id":"shutdown-3"}
```

The stopped response must copy the shutdown ID. A runtime should validate and destroy its continuation state, perform bounded cleanup, write one response, and exit 0.

## Errors

```json
{
  "protocol": "polici.runtime/v1",
  "type": "error",
  "id": "call-2",
  "error": {
    "code": "USER_NOT_FOUND",
    "kind": "resolver",
    "message": "No such user",
    "retryable": false,
    "details": { "tag": "string", "value": "octocat" }
  },
  "continuation": "opaque-session-state-3"
}
```

`code` is uppercase ASCII with digits/underscores after the first letter. `kind` is `resolver`, `permission`, `capability`, `invalid-request`, `unavailable`, `timeout`, `cancelled`, or `internal`. `retryable` is advisory. `details` is optional wire data and must not contain credentials.

Hosts also report process/protocol faults such as `RUNTIME_EXECUTABLE`, `RUNTIME_SANDBOX_REQUIRED`, `RUNTIME_WASI_CAPABILITY`, `RUNTIME_TIMEOUT`, `RUNTIME_CANCELLED`, `RUNTIME_SPAWN`, `RUNTIME_EXIT`, `RUNTIME_OUTPUT_LIMIT`, `RUNTIME_LOG_LIMIT`, `RUNTIME_EXCHANGE_QUOTA`, `PROTOCOL_FRAME`, `PROTOCOL_INVALID`, `PROTOCOL_MESSAGE`, `PROTOCOL_LIFECYCLE`, `PROTOCOL_IMPLEMENTATION`, `PROTOCOL_CAPABILITY`, `PROTOCOL_CONTINUATION_LIMIT`, `CAPABILITY_UNDECLARED`, `CAPABILITY_OPERATION_UNDECLARED`, and `CAPABILITY_QUOTA`.

## Wire Values

| Tag       | Payload                                        | Meaning                                                                 |
| --------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| `null`    | none                                           | Explicit null                                                           |
| `missing` | none                                           | Absent/unavailable data                                                 |
| `boolean` | JSON boolean `value`                           | Boolean                                                                 |
| `string`  | string `value`                                 | Text or glob                                                            |
| `number`  | finite JSON number `value`                     | Numeric wire value                                                      |
| `integer` | canonical decimal string `value`               | Arbitrary wire integer; manifest integers must fit evaluator safe range |
| `bytes`   | `encoding: "base64"`, canonical base64 `value` | Bytes                                                                   |
| `id`      | typed `namespace`, string `value`              | Immutable identity field                                                |
| `list`    | `items`                                        | Ordered collection                                                      |
| `set`     | `items`                                        | Canonically ordered unique collection                                   |
| `map`     | `entries`                                      | String-keyed value/object                                               |
| `entity`  | `type`, `identity`, `fields`                   | Identity-bearing typed value                                            |

Integer strings permit `0` or `-?` plus a nonzero first digit; leading zeroes and `-0` are invalid. Base64 must have canonical padding and zero unused trailing bits: `Zg==` is valid while `Zh==` is invalid. Entity `type` is `Type` or `provider:Type` at the generic wire layer. Manifest entities returned to the evaluator use the exact qualified `provider:Type`; core values use `core:File`, `core:Change`, `core:ChangeSet`, or `core:Check`. A manifest entity repeats the exact identity namespace/value in its header and declared `id` field.

Core evaluator contracts are closed. `File` uses identity namespace `polici:file`, an identity equal to its canonical `path`, and required `path`/`content` fields; `content` may be explicitly `missing` for repository materialization. `Change` uses `polici:change`, exact status `added`, `modified`, `deleted`, or `renamed`, required `path`, `status`, `before`, and `after`, plus optional non-negative `additions`, `deletions`, and `changes`. Added changes require missing `before`; deleted changes require missing `after`; modified and renamed changes require both file-version maps. File-version maps require a canonical `path`, optionally `content`, `commit_sha`, and `sha`; side paths must match the current path except renamed `before.path`. `ChangeSet` uses `polici:change-set`, a list-valued `changes`, and optional `merge_base_sha`, `base_sha`, and `head_sha`. `Check` uses `polici:check`, exact normalized status `missing`, `pending`, `passed`, `failed`, or `cancelled`, required `name` and `status`, and the documented optional GitHub check metadata. Aliases such as `state`/`conclusion`, upstream change states such as `copied`/`changed`, unknown fields, path normalization, and status coercion are not accepted; providers normalize before emitting.

Set items are strictly increasing by each item's canonical JSON string in locale-independent UTF-16/code-unit order. Equal encodings are duplicate values. Two entities with the same `(type, identity.namespace, identity.value)` are invalid even if fields differ. Object key order is not semantically significant; lists preserve order.

Generic wire validation defaults to depth 64, 100,000 nodes, 10,000 items in any collection, 10,000 keys in any object, 1,048,576 total UTF-16 code units across all keys and string values, and 16 MiB decoded bytes in any `bytes` value. Node and string budgets are cumulative across a wire value. Programmatic wire/request records must be plain data records and arrays; accessors, symbols, sparse/customized arrays, and custom prototypes are rejected before host invocation. Process and evaluator limits may be lower.

## Security

Protocol capability metadata is authority description, not authority itself. The runtime receives no host credential unless a deployment violates the contract. The broker validates every callback and returns only scoped tagged data. Native execution still needs explicit TCB trust or a real OS sandbox; WASI receives no runner options, environment, preopened repository, sockets, or subprocess grants from these hosts. See [Security](security.md).
