import { Change, ChangeSet } from "../core/change.js";
import { Check } from "../core/check.js";
import { File, FileCollection, json } from "../core/file.js";
import { PoliciGlob } from "../core/glob.js";
import { JsonParseError, type JsonDocument } from "../core/json.js";
import type { RepositorySnapshot } from "../core/repository.js";
import type { JsonValue } from "../core/serializable.js";
import { Collection, identityKey, valueEquals } from "../core/value.js";
import type {
  IRBinding,
  IRExpression,
  IRForEach,
  IRPolicy,
  IRRule,
  IRStatement,
  SourceSpan,
} from "../language/model.ts";
import {
  matchesSafePattern,
  type FunctionExport,
  type MethodDefinition,
  type ParameterDefinition,
  type PluginManifest,
  type TypeExpression,
} from "../plugin/manifest.js";
import {
  assertValidResolverRequest,
  ResolverFault,
  type ResolverHost,
} from "../plugin/resolver.js";
import { validateWireValue, wire, type WireValue } from "../plugin/wire.js";
import type {
  CompiledPolicy,
  EvaluatePolicyOptions,
  EvaluatorLimits,
  PolicyDiagnostic,
  PolicyEvaluationResult,
  PolicyEvidence,
  PolicyExitCode,
  PolicyRequirementResult,
  PolicyResult,
  PolicyRuleResult,
  PolicySourceReference,
  SerializableValue,
} from "./types.ts";
import { isCompiledPolicy } from "./compile.ts";

const missing = Object.freeze({ kind: "missing" as const });
const DEFAULT_LIMITS = Object.freeze({
  files: 10_000,
  collectionItems: 10_000,
  resolverCalls: 1_000,
  evidence: 100,
});
const CHECK_EVIDENCE_TEXT_LIMIT = 4_096;

function escapePointerToken(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

interface RuntimeCollection {
  readonly kind: "collection";
  readonly items: readonly Cell[];
  readonly set: boolean;
}

interface RuntimeJson {
  readonly kind: "json";
  readonly value: JsonValue;
  readonly path?: string;
  readonly pointer: string;
  readonly document?: JsonDocument;
}

interface RuntimeObject {
  readonly kind: "object";
  readonly fields: Readonly<Record<string, Cell>>;
}

interface RuntimeEntity {
  readonly kind: "entity";
  readonly alias: string;
  readonly provider: string;
  readonly contractMajor: number;
  readonly name: string;
  readonly identity: { readonly namespace: string; readonly value: string };
  readonly fields: Readonly<Record<string, Cell>>;
  readonly wire: Extract<WireValue, { readonly tag: "entity" }>;
}

interface RuntimeNamespace {
  readonly kind: "namespace";
  readonly alias: string;
  readonly manifest: PluginManifest;
  readonly host?: ResolverHost;
}

interface RuntimeCallable {
  readonly kind: "callable";
  readonly call: (arguments_: readonly Cell[], span: SourceSpan) => Promise<Cell>;
}

interface Cell {
  readonly value:
    | typeof missing
    | null
    | boolean
    | number
    | string
    | Uint8Array
    | File
    | FileCollection
    | Change
    | ChangeSet
    | Check
    | RuntimeCollection
    | RuntimeJson
    | RuntimeObject
    | RuntimeEntity
    | RuntimeNamespace
    | RuntimeCallable;
  readonly source?: PolicySourceReference;
  readonly evidence?: readonly PolicyEvidence[];
}

type RuntimeTagged =
  | typeof missing
  | RuntimeCollection
  | RuntimeJson
  | RuntimeObject
  | RuntimeEntity
  | RuntimeNamespace
  | RuntimeCallable;

interface NormalizedLimits {
  readonly files: number;
  readonly collectionItems: number;
  readonly resolverCalls: number;
  readonly evidence: number;
}

interface EvaluationScope {
  readonly locals: Map<string, Cell>;
  readonly projections: Map<string, Cell>;
}

interface RequirementCollector {
  readonly requirements: PolicyRequirementResult[];
  readonly evidence: EvidenceBudget;
}

class EvaluationFault extends Error {
  readonly code: string;
  readonly source: PolicyDiagnostic["source"];
  readonly span: SourceSpan;
  readonly evidence: readonly PolicyEvidence[];

  constructor(
    code: string,
    source: PolicyDiagnostic["source"],
    message: string,
    span: SourceSpan,
    evidence: readonly PolicyEvidence[] = [],
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "EvaluationFault";
    this.code = code;
    this.source = source;
    this.span = span;
    this.evidence = evidence;
  }
}

class MissingValueFault extends EvaluationFault {
  constructor(label: string, span: SourceSpan, cell: Cell) {
    const isNull = cellValue(cell) === null;
    const source = cellSource(cell);
    super(
      isNull ? "EVALUATION_NULL_VALUE" : "EVALUATION_MISSING_VALUE",
      "evaluator",
      `${label} is ${isNull ? "null" : "missing"}.`,
      span,
      [
        {
          kind: "missing",
          message: `${label} is ${isNull ? "null" : "missing"}.`,
          span,
          ...(source === undefined ? {} : { source }),
        },
      ],
    );
    this.name = "MissingValueFault";
  }
}

class EvidenceBudget {
  readonly maximum: number;
  private used = 0;

  constructor(maximum: number) {
    this.maximum = maximum;
  }

  take(values: readonly PolicyEvidence[]): readonly PolicyEvidence[] {
    const available = Math.max(0, this.maximum - this.used);
    const retained = values.slice(0, available);
    this.used += retained.length;
    return retained;
  }
}

function validLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeLimits(limits: EvaluatorLimits | undefined): NormalizedLimits {
  return Object.freeze({
    files: validLimit(limits?.files, DEFAULT_LIMITS.files, "limits.files"),
    collectionItems: validLimit(
      limits?.collectionItems,
      DEFAULT_LIMITS.collectionItems,
      "limits.collectionItems",
    ),
    resolverCalls: validLimit(
      limits?.resolverCalls,
      DEFAULT_LIMITS.resolverCalls,
      "limits.resolverCalls",
    ),
    evidence: validLimit(limits?.evidence, DEFAULT_LIMITS.evidence, "limits.evidence"),
  });
}

function cellValue(cell: Cell): unknown {
  return isTagged(cell.value, "json") ? cell.value.value : cell.value;
}

function cellSource(cell: Cell): PolicySourceReference | undefined {
  if (cell.source !== undefined) return cell.source;
  if (!isTagged(cell.value, "json") || cell.value.path === undefined) return undefined;
  const span = cell.value.document?.valueSpan(cell.value.pointer);
  return {
    path: cell.value.path,
    pointer: cell.value.pointer,
    ...(span === undefined ? {} : { span }),
  };
}

function isTagged<K extends RuntimeTagged["kind"]>(
  value: unknown,
  kind: K,
): value is Extract<RuntimeTagged, { readonly kind: K }> {
  return (
    value !== null &&
    typeof value === "object" &&
    "kind" in value &&
    (value as { readonly kind?: string }).kind === kind
  );
}

function serializable(value: unknown): SerializableValue {
  if (value === undefined || value === missing) return "<missing>";
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (value instanceof File) return { kind: "file", path: value.path };
  if (value instanceof Change) return { kind: "change", path: value.path, status: value.status };
  if (value instanceof Check) {
    return {
      kind: "check",
      name: value.name,
      status: value.status,
      conclusion: value.conclusion,
      ...(value.summary === undefined ? {} : { summary: boundedText(value.summary) }),
      ...(value.url === undefined ? {} : { url: boundedText(value.url) }),
    };
  }
  if (value instanceof ChangeSet) return [...value].map((change) => serializable(change));
  if (value instanceof FileCollection) return value.toArray().map((item) => serializable(item));
  if (value instanceof Collection) return value.toArray().map((item) => serializable(item));
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
  if (isTagged(value, "json")) return serializable((value as RuntimeJson).value);
  if (isTagged(value, "collection"))
    return (value as RuntimeCollection).items.map((item) => serializable(cellValue(item)));
  if (isTagged(value, "object")) {
    return Object.fromEntries(
      Object.entries((value as RuntimeObject).fields).map(([key, item]) => [
        key,
        serializable(cellValue(item)),
      ]),
    );
  }
  if (isTagged(value, "entity")) {
    const entity = value as RuntimeEntity;
    return {
      kind: "entity",
      type: `${entity.provider}@${entity.contractMajor}:${entity.name}`,
      contractMajor: entity.contractMajor,
      identity: { namespace: entity.identity.namespace, value: entity.identity.value },
    };
  }
  if (Array.isArray(value)) return value.map(serializable);
  if (typeof value === "object") {
    const result: Record<string, SerializableValue> = {};
    for (const [key, item] of Object.entries(value)) result[key] = serializable(item);
    return result;
  }
  return String(value);
}

function boundedText(value: string): string {
  if (value.length <= CHECK_EVIDENCE_TEXT_LIMIT) return value;
  return `${value.slice(0, CHECK_EVIDENCE_TEXT_LIMIT - 3)}...`;
}

function checkEvidenceMessage(check: Check): string {
  const details = [`Check '${check.name}' is ${check.status}.`];
  if (check.summary !== undefined && check.summary !== "")
    details.push(`Summary: ${boundedText(check.summary)}`);
  if (check.url !== undefined && check.url !== "") details.push(`URL: ${boundedText(check.url)}`);
  return details.join("\n");
}

function actualEvidence(message: string, cell: Cell, span?: SourceSpan): PolicyEvidence {
  const source = cellSource(cell);
  return {
    kind: "actual",
    message,
    value: serializable(cellValue(cell)),
    ...(span === undefined ? {} : { span }),
    ...(source === undefined ? {} : { source }),
  };
}

function rawEqualityValue(cell: Cell): unknown {
  const value = cell.value;
  if (isTagged(value, "json")) return value.value;
  if (isTagged(value, "object"))
    return Object.fromEntries(
      Object.entries(value.fields).map(([key, item]) => [key, rawEqualityValue(item)]),
    );
  if (isTagged(value, "collection")) return value.items.map(rawEqualityValue);
  return value;
}

function equalCells(left: Cell, right: Cell): boolean {
  const leftValue = left.value;
  const rightValue = right.value;
  if (isTagged(leftValue, "entity") || isTagged(rightValue, "entity")) {
    return (
      isTagged(leftValue, "entity") &&
      isTagged(rightValue, "entity") &&
      leftValue.provider === rightValue.provider &&
      leftValue.contractMajor === rightValue.contractMajor &&
      leftValue.name === rightValue.name &&
      leftValue.identity.namespace === rightValue.identity.namespace &&
      leftValue.identity.value === rightValue.identity.value
    );
  }
  return valueEquals(rawEqualityValue(left), rawEqualityValue(right));
}

function comparedIdentity(cell: Cell): SerializableValue {
  if (isTagged(cell.value, "entity")) {
    return {
      type: `${cell.value.provider}@${cell.value.contractMajor}:${cell.value.name}`,
      contractMajor: cell.value.contractMajor,
      namespace: cell.value.identity.namespace,
      value: cell.value.identity.value,
    };
  }
  const key = identityKey(cellValue(cell));
  return key ?? serializable(cellValue(cell));
}

function requirementStatus(
  requirements: readonly PolicyRequirementResult[],
): "passed" | "failed" | "error" {
  if (requirements.some((item) => item.status === "error")) return "error";
  if (requirements.some((item) => item.status === "failed")) return "failed";
  return "passed";
}

function aggregateExitCode(status: "passed" | "failed" | "error"): PolicyExitCode {
  return status === "error" ? 2 : status === "failed" ? 1 : 0;
}

class Evaluator {
  readonly compiled: CompiledPolicy;
  readonly repository: RepositorySnapshot;
  readonly hosts: Readonly<Record<string, ResolverHost>>;
  readonly limits: NormalizedLimits;
  readonly signal?: AbortSignal;
  readonly resolverTimeoutMs?: number;
  readonly diagnostics: PolicyDiagnostic[];
  private resolverCalls = 0;
  private readonly bindings = new Map<string, Promise<Cell>>();
  private readonly resources = new Map<string, Promise<Cell>>();
  private readonly lazyFields = new WeakMap<RuntimeEntity, Map<string, Promise<Cell>>>();
  private activeBindings = new Set<string>();

  constructor(compiled: CompiledPolicy, options: EvaluatePolicyOptions) {
    this.compiled = compiled;
    this.repository = options.repository;
    if (!(this.repository instanceof Object) || !("matching" in this.repository)) {
      throw new TypeError("evaluatePolicy requires a RepositorySnapshot");
    }
    if (options.resolvers !== undefined && options.providers !== undefined) {
      throw new TypeError("Specify either resolvers or providers, not both");
    }
    this.hosts = options.resolvers ?? options.providers ?? {};
    this.limits = normalizeLimits(options.limits);
    this.signal = options.signal;
    this.resolverTimeoutMs = options.resolverTimeoutMs;
    this.diagnostics = [...compiled.diagnostics];
    const bindings = compiled.pluginBindings;
    for (const imported of compiled.ir.imports) {
      const matches = bindings.filter(
        (binding) =>
          binding.name === imported.provider && binding.contractMajor === imported.apiVersion,
      );
      if (matches.length !== 1) {
        this.diagnostics.push({
          code: "PROVIDER_LOCK_REQUIRED",
          message: `Import '${imported.source}' has no unique integrity-verified plugin binding.`,
          severity: "error",
          source: "provider",
          span: imported.span,
        });
      }
    }
  }

  async evaluate(): Promise<PolicyEvaluationResult> {
    if (this.diagnostics.some((item) => item.severity === "error")) {
      return {
        kind: "policy-evaluation",
        status: "error",
        exitCode: 2,
        policies: [],
        diagnostics: this.diagnostics,
      };
    }

    const policies: PolicyResult[] = [];
    for (const policy of this.compiled.ir.policies)
      policies.push(await this.evaluatePolicy(policy));
    const status = policies.some((policy) => policy.status === "error")
      ? "error"
      : policies.some((policy) => policy.status === "failed")
        ? "failed"
        : "passed";
    return {
      kind: "policy-evaluation",
      status,
      exitCode: aggregateExitCode(status),
      policies,
      diagnostics: this.diagnostics,
    };
  }

  private async evaluatePolicy(policy: IRPolicy): Promise<PolicyResult> {
    this.bindings.clear();
    this.activeBindings = new Set();
    const bindings = new Map(policy.bindings.map((binding) => [binding.id, binding]));
    const namespaces = this.namespaces();
    const rules: PolicyRuleResult[] = [];
    for (const rule of policy.rules) {
      rules.push(await this.evaluateRule(rule, bindings, namespaces));
    }
    const status = rules.some((rule) => rule.status === "error")
      ? "error"
      : rules.some((rule) => rule.status === "failed")
        ? "failed"
        : "passed";
    return {
      name: policy.name,
      status,
      exitCode: aggregateExitCode(status),
      span: policy.span,
      rules,
    };
  }

  private namespaces(): ReadonlyMap<string, Cell> {
    const result = new Map<string, Cell>();
    for (const imported of this.compiled.ir.imports) {
      const manifest = this.compiled.manifests.find(
        (candidate) =>
          candidate.name === imported.provider && candidate.contractMajor === imported.apiVersion,
      );
      if (manifest === undefined) continue;
      result.set(imported.alias, {
        value: {
          kind: "namespace",
          alias: imported.alias,
          manifest,
          host: this.hosts[imported.alias],
        },
      });
    }
    return result;
  }

  private async evaluateRule(
    rule: IRRule,
    bindings: ReadonlyMap<string, IRBinding>,
    namespaces: ReadonlyMap<string, Cell>,
  ): Promise<PolicyRuleResult> {
    const collector: RequirementCollector = {
      requirements: [],
      evidence: new EvidenceBudget(this.limits.evidence),
    };
    const scope: EvaluationScope = { locals: new Map(), projections: new Map() };
    try {
      if (rule.condition !== undefined) {
        const condition = await this.expression(rule.condition, scope, bindings, namespaces);
        if (!this.boolean(condition, rule.condition.span, "Rule condition")) {
          return {
            name: rule.name,
            status: "skipped",
            span: rule.span,
            message: "Rule condition was false.",
            requirements: [],
            evidence: collector.evidence.take(condition.evidence ?? []),
          };
        }
      }
      await this.statements(rule.statements, scope, bindings, namespaces, collector);
      const status = requirementStatus(collector.requirements);
      const evidence = collector.requirements.flatMap((item) => item.evidence);
      return {
        name: rule.name,
        status,
        span: rule.span,
        ...(status === "failed" ? { message: "One or more requirements failed." } : {}),
        requirements: collector.requirements,
        evidence,
      };
    } catch (error) {
      const fault = this.fault(error, rule.span);
      if (rule.optional && fault instanceof MissingValueFault) {
        if (collector.requirements.some((requirement) => requirement.status === "failed")) {
          const evidence = collector.requirements.flatMap((requirement) => requirement.evidence);
          return {
            name: rule.name,
            status: "failed",
            span: rule.span,
            message: "One or more requirements failed before optional data became unavailable.",
            requirements: collector.requirements,
            evidence,
          };
        }
        const evidence = fault.evidence.slice(0, this.limits.evidence);
        return {
          name: rule.name,
          status: "skipped",
          span: rule.span,
          message: fault.message,
          requirements: [],
          evidence,
        };
      }
      this.diagnostics.push({
        code: fault.code,
        message: fault.message,
        severity: "error",
        source: fault.source,
        span: fault.span,
      });
      const evidence = collector.evidence.take(fault.evidence);
      return {
        name: rule.name,
        status: "error",
        span: rule.span,
        message: fault.message,
        requirements: collector.requirements,
        evidence,
      };
    }
  }

  private async statements(
    statements: readonly IRStatement[],
    scope: EvaluationScope,
    bindings: ReadonlyMap<string, IRBinding>,
    namespaces: ReadonlyMap<string, Cell>,
    collector: RequirementCollector,
  ): Promise<void> {
    for (const statement of statements) {
      if (statement.kind === "require") {
        const value = await this.expression(statement.expression, scope, bindings, namespaces);
        const passed = this.boolean(value, statement.expression.span, "Required expression");
        const evidence = collector.evidence.take(
          passed
            ? (value.evidence ?? [])
            : value.evidence?.length
              ? value.evidence
              : [actualEvidence("Required expression evaluated to false.", value)],
        );
        collector.requirements.push({
          status: passed ? "passed" : "failed",
          span: statement.span,
          expressionSpan: statement.expression.span,
          ...(passed ? {} : { message: "Required expression evaluated to false." }),
          evidence,
        });
        continue;
      }
      await this.forEach(statement, scope, bindings, namespaces, collector);
    }
  }

  private async forEach(
    statement: IRForEach,
    scope: EvaluationScope,
    bindings: ReadonlyMap<string, IRBinding>,
    namespaces: ReadonlyMap<string, Cell>,
    collector: RequirementCollector,
  ): Promise<void> {
    const collection = this.collection(
      await this.expression(statement.collection, scope, bindings, namespaces),
      statement.collection.span,
      "Iteration source",
    );
    const previous = scope.locals.get(statement.variableId);
    try {
      for (const item of collection.items) {
        scope.locals.set(statement.variableId, item);
        await this.statements(statement.statements, scope, bindings, namespaces, collector);
      }
    } finally {
      if (previous === undefined) scope.locals.delete(statement.variableId);
      else scope.locals.set(statement.variableId, previous);
    }
  }

  private async expression(
    expression: IRExpression,
    scope: EvaluationScope,
    bindings: ReadonlyMap<string, IRBinding>,
    namespaces: ReadonlyMap<string, Cell>,
  ): Promise<Cell> {
    switch (expression.kind) {
      case "literal":
        return { value: expression.value };
      case "reference":
        return this.reference(expression, scope, bindings, namespaces);
      case "member":
        return this.member(
          await this.expression(expression.object, scope, bindings, namespaces),
          expression.property,
          expression.span,
        );
      case "call": {
        const callee = await this.expression(expression.callee, scope, bindings, namespaces);
        const callable = this.demand(callee, expression.callee.span, "Called value");
        if (!isTagged(callable, "callable")) {
          throw new EvaluationFault(
            "EVALUATION_NOT_CALLABLE",
            "evaluator",
            "Expression is not callable.",
            expression.callee.span,
          );
        }
        const arguments_: Cell[] = [];
        for (const argument of expression.arguments) {
          arguments_.push(await this.expression(argument, scope, bindings, namespaces));
        }
        return (callable as RuntimeCallable).call(arguments_, expression.span);
      }
      case "projection": {
        const collection = this.collection(
          await this.expression(expression.collection, scope, bindings, namespaces),
          expression.collection.span,
          "Projection source",
        );
        const items: Cell[] = [];
        const previous = scope.projections.get(expression.itemId);
        try {
          for (const item of collection.items) {
            scope.projections.set(expression.itemId, item);
            items.push(await this.expression(expression.expression, scope, bindings, namespaces));
          }
        } finally {
          if (previous === undefined) scope.projections.delete(expression.itemId);
          else scope.projections.set(expression.itemId, previous);
        }
        return { value: this.makeCollection(items, collection.set, expression.span) };
      }
      case "unary": {
        const operand = await this.expression(expression.operand, scope, bindings, namespaces);
        return {
          value: !this.boolean(operand, expression.operand.span, "Operand of 'not'"),
          evidence: operand.evidence,
        };
      }
      case "binary":
        return this.binary(expression, scope, bindings, namespaces);
      case "passed": {
        const checkCell = await this.expression(expression.check, scope, bindings, namespaces);
        const checkValue = this.demand(checkCell, expression.check.span, "Check");
        if (!(checkValue instanceof Check)) {
          throw new EvaluationFault(
            "EVALUATION_EXPECTED_CHECK",
            "evaluator",
            "The 'passed' operator requires a Check.",
            expression.check.span,
          );
        }
        return {
          value: checkValue.passed,
          evidence: [
            {
              kind: "check",
              message: checkEvidenceMessage(checkValue),
              value: serializable(checkValue),
              span: expression.span,
              ...(cellSource(checkCell) === undefined ? {} : { source: cellSource(checkCell) }),
            },
          ],
        };
      }
      case "unique":
        return this.unique(expression, scope, bindings, namespaces);
      case "relation":
        return this.relation(expression, scope, bindings, namespaces);
      case "fold":
        return this.fold(expression, scope, bindings, namespaces);
    }
  }

  private async reference(
    expression: Extract<IRExpression, { kind: "reference" }>,
    scope: EvaluationScope,
    bindings: ReadonlyMap<string, IRBinding>,
    namespaces: ReadonlyMap<string, Cell>,
  ): Promise<Cell> {
    if (expression.scope === "core") {
      if (expression.name === "json") return { value: json };
      if (expression.name === "Files") {
        return {
          value: {
            kind: "callable",
            call: async (arguments_, span) => {
              if (arguments_.length !== 1) {
                throw new EvaluationFault(
                  "EVALUATION_ARGUMENT_COUNT",
                  "evaluator",
                  "Files expects one pattern argument.",
                  span,
                );
              }
              const pattern = this.string(arguments_[0]!, span, "Files pattern");
              const selected = this.repository.matching(pattern);
              this.fileLimit(selected.size, span);
              return { value: selected };
            },
          },
        };
      }
    }
    if (expression.scope === "provider") {
      const namespace = namespaces.get(expression.name);
      if (namespace !== undefined) return namespace;
    }
    if (expression.scope === "binding") {
      const binding = bindings.get(expression.id);
      if (binding !== undefined) return this.binding(binding, scope, bindings, namespaces);
    }
    if (expression.scope === "local") {
      const local = scope.locals.get(expression.id);
      if (local !== undefined) return local;
    }
    if (expression.scope === "projection") {
      for (const [itemId, item] of scope.projections) {
        if (expression.id.startsWith(`${itemId}.`)) {
          return this.member(item, expression.name, expression.span);
        }
      }
    }
    throw new EvaluationFault(
      "EVALUATION_UNKNOWN_REFERENCE",
      "evaluator",
      `No runtime value exists for '${expression.name}'.`,
      expression.span,
    );
  }

  private binding(
    binding: IRBinding,
    scope: EvaluationScope,
    bindings: ReadonlyMap<string, IRBinding>,
    namespaces: ReadonlyMap<string, Cell>,
  ): Promise<Cell> {
    const cached = this.bindings.get(binding.id);
    if (cached !== undefined) return cached;
    if (this.activeBindings.has(binding.id)) {
      throw new EvaluationFault(
        "EVALUATION_BINDING_CYCLE",
        "evaluator",
        `Binding '${binding.name}' is cyclic.`,
        binding.span,
      );
    }
    const evaluated = (async () => {
      this.activeBindings.add(binding.id);
      try {
        return await this.expression(binding.value, scope, bindings, namespaces);
      } finally {
        this.activeBindings.delete(binding.id);
      }
    })();
    this.bindings.set(binding.id, evaluated);
    return evaluated;
  }

  private async member(cell: Cell, property: string, span: SourceSpan): Promise<Cell> {
    const value = this.demand(cell, span, `Value before '.${property}'`);
    if (isTagged(value, "json")) return this.jsonMember(value, property, span);
    if (isTagged(value, "object")) return value.fields[property] ?? { value: missing };
    if (isTagged(value, "namespace")) return this.providerMember(value, property, span);
    if (isTagged(value, "entity")) return this.entityMember(value, property, span);
    if (isTagged(value, "collection") || value instanceof FileCollection) {
      if (property === "as") return this.fileCollectionAs(value, span);
    }
    if (value instanceof File) {
      if (property === "path") return { value: value.path, source: { path: value.path } };
      if (property === "content") return { value: value.content, source: { path: value.path } };
      if (property === "as") return this.fileAs(value, span);
    }
    if (value instanceof Change) {
      if (property === "path") return { value: value.path, source: { path: value.path } };
      if (property === "status") return { value: value.status };
      if (property === "previous_path")
        return {
          value: value.previousPath ?? missing,
          source: { path: value.previousPath ?? value.path },
        };
      if (property === "before")
        return value.before === undefined ? { value: missing } : { value: value.before };
      if (property === "after")
        return value.after === undefined ? { value: missing } : { value: value.after };
    }
    if (value instanceof ChangeSet) {
      if (["added", "modified", "deleted", "renamed"].includes(property)) {
        return { value: value[property as "added" | "modified" | "deleted" | "renamed"] };
      }
      if (property === "files") return this.changeSetFiles(value, span);
    }
    if (value instanceof Check) {
      if (property === "name") return { value: value.name };
      if (property === "status" || property === "conclusion") return { value: value.status };
    }
    throw new EvaluationFault(
      "EVALUATION_UNKNOWN_MEMBER",
      "evaluator",
      `Runtime value has no member '${property}'.`,
      span,
    );
  }

  private jsonMember(value: RuntimeJson, property: string, span: SourceSpan): Cell {
    if (value.value === null || typeof value.value !== "object") {
      throw new EvaluationFault(
        "EVALUATION_UNKNOWN_MEMBER",
        "evaluator",
        `JSON value has no member '${property}'.`,
        span,
      );
    }
    const key =
      Array.isArray(value.value) && /^(0|[1-9][0-9]*)$/.test(property)
        ? Number(property)
        : property;
    if (!Object.hasOwn(value.value, key)) {
      const pointer = `${value.pointer}/${escapePointerToken(property)}`;
      return {
        value: missing,
        ...(value.path === undefined ? {} : { source: { path: value.path, pointer } }),
      };
    }
    const child = (value.value as Record<string | number, JsonValue>)[key]!;
    const pointer = `${value.pointer}/${escapePointerToken(property)}`;
    return {
      value: {
        kind: "json",
        value: child,
        pointer,
        ...(value.path === undefined ? {} : { path: value.path }),
        ...(value.document === undefined ? {} : { document: value.document }),
      },
    };
  }

  private async providerMember(
    namespace: RuntimeNamespace,
    property: string,
    span: SourceSpan,
  ): Promise<Cell> {
    const definition = namespace.manifest.exports[property];
    if (definition === undefined) {
      throw new EvaluationFault(
        "EVALUATION_UNKNOWN_PROVIDER_EXPORT",
        "provider",
        `Provider '${namespace.manifest.name}' has no export '${property}'.`,
        span,
      );
    }
    if (definition.kind === "function") {
      return {
        value: {
          kind: "callable",
          call: (arguments_, callSpan) =>
            this.callProvider(namespace, definition, arguments_, callSpan),
        },
      };
    }
    const key = `${namespace.alias}.${property}`;
    let resolved = this.resources.get(key);
    if (resolved === undefined) {
      resolved = this.resolveProvider(
        namespace,
        definition.resolve,
        {},
        undefined,
        definition.type,
        span,
      );
      this.resources.set(key, resolved);
    }
    return resolved;
  }

  private async callProvider(
    namespace: RuntimeNamespace,
    definition: FunctionExport | MethodDefinition,
    arguments_: readonly Cell[],
    span: SourceSpan,
    subject?: WireValue,
  ): Promise<Cell> {
    const parameters = definition.parameters;
    if (
      arguments_.length > parameters.length ||
      parameters.slice(arguments_.length).some((parameter) => !this.parameterOptional(parameter))
    ) {
      throw new EvaluationFault(
        "EVALUATION_ARGUMENT_COUNT",
        "evaluator",
        `Resolver '${definition.resolve}' received an invalid number of arguments.`,
        span,
      );
    }
    const encoded: Record<string, WireValue> = {};
    for (let index = 0; index < parameters.length; index += 1) {
      const parameter = parameters[index]!;
      const name = parameter.name;
      const argument = arguments_[index];
      if (argument !== undefined)
        encoded[name] = this.encodeTyped(
          argument,
          parameter.type,
          namespace,
          span,
          `Argument '${name}'`,
        );
      else if (parameter.default !== undefined)
        encoded[name] = this.encodeDefault(parameter.default, parameter.type);
      else encoded[name] = { tag: "missing" };
    }
    return this.resolveProvider(
      namespace,
      definition.resolve,
      encoded,
      subject,
      definition.returns,
      span,
    );
  }

  private parameterOptional(parameter: ParameterDefinition): boolean {
    return parameter.optional === true || parameter.default !== undefined;
  }

  private async entityMember(
    entity: RuntimeEntity,
    property: string,
    span: SourceSpan,
  ): Promise<Cell> {
    const definition = this.manifestForEntity(entity).types[entity.name];
    const field = definition?.fields[property];
    if (field === undefined) {
      const method = definition?.kind === "entity" ? definition.methods?.[property] : undefined;
      if (method !== undefined) {
        return {
          value: {
            kind: "callable",
            call: (arguments_, callSpan) =>
              this.callProvider(
                {
                  kind: "namespace",
                  alias: entity.alias,
                  manifest: this.manifestForEntity(entity),
                  host: this.hosts[entity.alias],
                },
                method,
                arguments_,
                callSpan,
                entity.wire,
              ),
          },
        };
      }
      throw new EvaluationFault(
        "EVALUATION_UNKNOWN_PROVIDER_FIELD",
        "provider",
        `Entity '${entity.provider}:${entity.name}' has no field '${property}'.`,
        span,
      );
    }
    const present = entity.fields[property] ?? { value: missing };
    if (present.value !== missing || field.kind !== "set" || field.resolve === undefined) {
      return present;
    }
    let fields = this.lazyFields.get(entity);
    if (fields === undefined) {
      fields = new Map();
      this.lazyFields.set(entity, fields);
    }
    let resolved = fields.get(property);
    if (resolved === undefined) {
      const namespace: RuntimeNamespace = {
        kind: "namespace",
        alias: entity.alias,
        manifest: this.manifestForEntity(entity),
        host: this.hosts[entity.alias],
      };
      resolved = this.resolveProvider(namespace, field.resolve, {}, entity.wire, field, span);
      fields.set(property, resolved);
    }
    return resolved;
  }

  private manifestForEntity(entity: RuntimeEntity): PluginManifest {
    const manifest = this.compiled.manifests.find(
      (candidate) =>
        candidate.name === entity.provider && candidate.contractMajor === entity.contractMajor,
    );
    if (manifest === undefined) {
      throw new Error(`No manifest exists for provider '${entity.provider}'.`);
    }
    return manifest;
  }

  private fileAs(file: File, _span: SourceSpan): Cell {
    return {
      value: {
        kind: "callable",
        call: async (arguments_, callSpan) => {
          if (arguments_.length !== 1 || cellValue(arguments_[0]!) !== json) {
            throw new EvaluationFault(
              "EVALUATION_UNSUPPORTED_FORMAT",
              "evaluator",
              "File.as supports only the core json parser.",
              callSpan,
            );
          }
          const parsed = file.as(json);
          return {
            value: {
              kind: "json",
              value: parsed.value,
              path: parsed.path,
              pointer: "",
              document: parsed.document,
            },
          };
        },
      },
    };
  }

  private fileCollectionAs(value: RuntimeCollection | FileCollection, span: SourceSpan): Cell {
    return {
      value: {
        kind: "callable",
        call: async (arguments_, callSpan) => {
          if (arguments_.length !== 1 || cellValue(arguments_[0]!) !== json) {
            throw new EvaluationFault(
              "EVALUATION_UNSUPPORTED_FORMAT",
              "evaluator",
              "FileCollection.as supports only the core json parser.",
              callSpan,
            );
          }
          const files =
            value instanceof FileCollection
              ? value.toArray()
              : value.items.map((item) => this.demand(item, span, "Collection file"));
          const items: Cell[] = [];
          for (const item of files) {
            if (!(item instanceof File)) {
              throw new EvaluationFault(
                "EVALUATION_EXPECTED_FILE",
                "evaluator",
                "Collection.as requires File values.",
                span,
              );
            }
            const parsed = item.as(json);
            items.push({
              value: {
                kind: "json",
                value: parsed.value,
                path: parsed.path,
                pointer: "",
                document: parsed.document,
              },
            });
          }
          return { value: this.makeCollection(items, false, callSpan) };
        },
      },
    };
  }

  private changeSetFiles(changeSet: ChangeSet, _span: SourceSpan): Cell {
    return {
      value: {
        kind: "callable",
        call: async (arguments_, callSpan) => {
          if (arguments_.length > 1) {
            throw new EvaluationFault(
              "EVALUATION_ARGUMENT_COUNT",
              "evaluator",
              "ChangeSet.files accepts at most one pattern.",
              callSpan,
            );
          }
          const pattern =
            arguments_.length === 0
              ? "**/*"
              : this.string(arguments_[0]!, callSpan, "ChangeSet.files pattern");
          const glob = new PoliciGlob(pattern);
          const unavailable = [...changeSet].find(
            (change) =>
              change.status !== "deleted" &&
              change.materialized === undefined &&
              glob.matches(change.path),
          );
          if (unavailable !== undefined) {
            throw new MissingValueFault("Changed file content", callSpan, {
              value: missing,
              source: { path: unavailable.path },
            });
          }
          const files = changeSet.files(glob);
          this.fileLimit(files.size, callSpan);
          return { value: files };
        },
      },
    };
  }

  private async binary(
    expression: Extract<IRExpression, { kind: "binary" }>,
    scope: EvaluationScope,
    bindings: ReadonlyMap<string, IRBinding>,
    namespaces: ReadonlyMap<string, Cell>,
  ): Promise<Cell> {
    const left = await this.expression(expression.left, scope, bindings, namespaces);
    if (expression.operator === "and") {
      if (!this.boolean(left, expression.left.span, "Left operand of 'and'")) {
        return { value: false, evidence: left.evidence };
      }
      const right = await this.expression(expression.right, scope, bindings, namespaces);
      return {
        value: this.boolean(right, expression.right.span, "Right operand of 'and'"),
        evidence: [...(left.evidence ?? []), ...(right.evidence ?? [])],
      };
    }
    if (expression.operator === "or") {
      if (this.boolean(left, expression.left.span, "Left operand of 'or'")) {
        return { value: true, evidence: left.evidence };
      }
      const right = await this.expression(expression.right, scope, bindings, namespaces);
      return {
        value: this.boolean(right, expression.right.span, "Right operand of 'or'"),
        evidence: [...(left.evidence ?? []), ...(right.evidence ?? [])],
      };
    }
    const right = await this.expression(expression.right, scope, bindings, namespaces);
    this.demand(left, expression.left.span, "Left comparison operand");
    this.demand(right, expression.right.span, "Right comparison operand");
    if (expression.operator === "matches") {
      const actual = this.string(left, expression.left.span, "Matched value");
      const pattern = this.string(right, expression.right.span, "Glob pattern");
      const matched = new PoliciGlob(pattern).matches(actual);
      return {
        value: matched,
        evidence: matched
          ? []
          : [
              {
                kind: "offending-item",
                message: `${JSON.stringify(actual)} does not match ${JSON.stringify(pattern)}.`,
                value: actual,
                span: expression.span,
                ...(cellSource(left) === undefined ? {} : { source: cellSource(left) }),
              },
              {
                kind: "expected",
                message: "Expected glob pattern.",
                value: pattern,
                span: expression.right.span,
              },
            ],
      };
    }
    const equal = equalCells(left, right);
    const result = expression.operator === "==" ? equal : !equal;
    return {
      value: result,
      evidence: result
        ? []
        : [
            {
              kind: "comparison",
              message: `Compared values did not satisfy '${expression.operator}'.`,
              value: [comparedIdentity(left), comparedIdentity(right)],
              span: expression.span,
            },
          ],
    };
  }

  private async unique(
    expression: Extract<IRExpression, { kind: "unique" }>,
    scope: EvaluationScope,
    bindings: ReadonlyMap<string, IRBinding>,
    namespaces: ReadonlyMap<string, Cell>,
  ): Promise<Cell> {
    const value = await this.expression(expression.value, scope, bindings, namespaces);
    this.demand(value, expression.value.span, "Unique value");
    const collection = this.collection(
      await this.expression(expression.collection, scope, bindings, namespaces),
      expression.collection.span,
      "Uniqueness collection",
    );
    const duplicates: Cell[] = [];
    for (const item of collection.items) {
      this.demand(item, expression.collection.span, "Uniqueness item");
      if (equalCells(value, item)) duplicates.push(item);
    }
    const unique = duplicates.length === 1;
    return {
      value: unique,
      evidence: unique
        ? []
        : duplicates.length === 0
          ? [actualEvidence("Value does not occur in the collection.", value, expression.span)]
          : duplicates.map((item, index) => ({
              kind: "duplicate",
              message: `Duplicate occurrence ${index + 1} of ${JSON.stringify(serializable(cellValue(value)))}.`,
              value: serializable(cellValue(item)),
              span: expression.span,
              ...(cellSource(item) === undefined ? {} : { source: cellSource(item) }),
            })),
    };
  }

  private async relation(
    expression: Extract<IRExpression, { kind: "relation" }>,
    scope: EvaluationScope,
    bindings: ReadonlyMap<string, IRBinding>,
    namespaces: ReadonlyMap<string, Cell>,
  ): Promise<Cell> {
    const left = this.collection(
      await this.expression(expression.left, scope, bindings, namespaces),
      expression.left.span,
      "Left relation operand",
    );
    const right = this.collection(
      await this.expression(expression.right, scope, bindings, namespaces),
      expression.right.span,
      "Right relation operand",
    );
    let relevant: Cell | undefined;
    let passed = expression.quantifier !== "some";
    outer: for (const leftItem of left.items) {
      this.demand(leftItem, expression.left.span, "Left relation item");
      let found = false;
      for (const rightItem of right.items) {
        this.demand(rightItem, expression.right.span, "Right relation item");
        if (equalCells(leftItem, rightItem)) {
          found = true;
          if (expression.quantifier === "some") {
            passed = true;
            break outer;
          }
          if (expression.quantifier === "no") {
            passed = false;
            relevant = leftItem;
            break outer;
          }
          break;
        }
      }
      if (expression.quantifier === "every" && !found) {
        passed = false;
        relevant = leftItem;
        break;
      }
    }
    return {
      value: passed,
      evidence: passed
        ? []
        : [
            {
              kind: "comparison",
              message:
                expression.quantifier === "some"
                  ? "The collections have no common identity or value."
                  : expression.quantifier === "every"
                    ? "Some left-side identities or values are absent from the right side."
                    : "The collections contain common identities or values.",
              value: {
                left: left.items.map(comparedIdentity),
                right: right.items.map(comparedIdentity),
                relevant: relevant === undefined ? [] : [comparedIdentity(relevant)],
              },
              span: expression.span,
            },
          ],
    };
  }

  private async fold(
    expression: Extract<IRExpression, { kind: "fold" }>,
    scope: EvaluationScope,
    bindings: ReadonlyMap<string, IRBinding>,
    namespaces: ReadonlyMap<string, Cell>,
  ): Promise<Cell> {
    if (expression.collection.kind === "projection") {
      const projection = expression.collection;
      const source = this.collection(
        await this.expression(projection.collection, scope, bindings, namespaces),
        projection.collection.span,
        "Projection source",
      );
      const previous = scope.projections.get(projection.itemId);
      const evidence: PolicyEvidence[] = [];
      try {
        for (const item of source.items) {
          scope.projections.set(projection.itemId, item);
          const projected = await this.expression(
            projection.expression,
            scope,
            bindings,
            namespaces,
          );
          const value = this.boolean(
            projected,
            projection.expression.span,
            "Boolean projection item",
          );
          if (expression.quantifier === "some" && value) return { value: true };
          if (expression.quantifier === "every" && !value) {
            evidence.push(
              ...(projected.evidence?.length
                ? projected.evidence
                : [actualEvidence("Offending boolean projection item.", item, expression.span)]),
            );
            return { value: false, evidence };
          }
          if (expression.quantifier === "no" && value) {
            evidence.push(
              ...(projected.evidence?.length
                ? projected.evidence
                : [actualEvidence("Offending boolean projection item.", item, expression.span)]),
            );
            return { value: false, evidence };
          }
        }
      } finally {
        if (previous === undefined) scope.projections.delete(projection.itemId);
        else scope.projections.set(projection.itemId, previous);
      }
      return { value: expression.quantifier !== "some", evidence };
    }
    const collection = this.collection(
      await this.expression(expression.collection, scope, bindings, namespaces),
      expression.collection.span,
      "Boolean collection",
    );
    const relevant: Cell[] = [];
    let passed = expression.quantifier === "every" || expression.quantifier === "no";
    for (const item of collection.items) {
      const boolean = this.boolean(item, expression.collection.span, "Boolean collection item");
      if (expression.quantifier === "some" && boolean) {
        passed = true;
        break;
      }
      if (expression.quantifier === "every" && !boolean) {
        passed = false;
        relevant.push(item);
        break;
      }
      if (expression.quantifier === "no" && boolean) {
        passed = false;
        relevant.push(item);
        break;
      }
    }
    const evidence = relevant.flatMap((item) =>
      item.evidence?.length
        ? item.evidence
        : [actualEvidence("Offending boolean projection item.", item, expression.span)],
    );
    return { value: passed, evidence };
  }

  private demand(cell: Cell, span: SourceSpan, label: string): Exclude<Cell["value"], null> {
    const value = cellValue(cell);
    if (value === missing || value === null) throw new MissingValueFault(label, span, cell);
    return cell.value as Exclude<Cell["value"], null>;
  }

  private boolean(cell: Cell, span: SourceSpan, label: string): boolean {
    const demanded = this.demand(cell, span, label);
    const value = isTagged(demanded, "json") ? demanded.value : demanded;
    if (typeof value !== "boolean") {
      throw new EvaluationFault(
        "EVALUATION_EXPECTED_BOOLEAN",
        "evaluator",
        `${label} must be boolean.`,
        span,
        [actualEvidence(`${label} was not boolean.`, cell, span)],
      );
    }
    return value;
  }

  private string(cell: Cell, span: SourceSpan, label: string): string {
    const demanded = this.demand(cell, span, label);
    const value = isTagged(demanded, "json") ? demanded.value : demanded;
    if (typeof value !== "string") {
      throw new EvaluationFault(
        "EVALUATION_EXPECTED_STRING",
        "evaluator",
        `${label} must be a string.`,
        span,
        [actualEvidence(`${label} was not a string.`, cell, span)],
      );
    }
    return value;
  }

  private collection(cell: Cell, span: SourceSpan, label: string): RuntimeCollection {
    const value = this.demand(cell, span, label);
    if (isTagged(value, "collection")) return value;
    if (value instanceof ChangeSet) {
      return this.makeCollection(
        [...value].map((item) => ({ value: item })),
        false,
        span,
      );
    }
    if (value instanceof FileCollection) {
      return this.makeCollection(
        value.toArray().map((item) => ({ value: item })),
        false,
        span,
      );
    }
    if (value instanceof Collection) {
      return this.makeCollection(
        value.toArray().map((item) => ({ value: item as Cell["value"] })),
        false,
        span,
      );
    }
    throw new EvaluationFault(
      "EVALUATION_EXPECTED_COLLECTION",
      "evaluator",
      `${label} must be iterable.`,
      span,
    );
  }

  private makeCollection(
    items: readonly Cell[],
    set: boolean,
    span: SourceSpan,
  ): RuntimeCollection {
    if (items.length > this.limits.collectionItems) {
      throw new EvaluationFault(
        "EVALUATION_COLLECTION_LIMIT",
        "evaluator",
        `Collection contains ${items.length} items; limit is ${this.limits.collectionItems}.`,
        span,
      );
    }
    return Object.freeze({ kind: "collection", items: Object.freeze([...items]), set });
  }

  private fileLimit(count: number, span: SourceSpan): void {
    if (count > this.limits.files) {
      throw new EvaluationFault(
        "EVALUATION_FILE_LIMIT",
        "evaluator",
        `File selection contains ${count} files; limit is ${this.limits.files}.`,
        span,
      );
    }
    if (count > this.limits.collectionItems) {
      throw new EvaluationFault(
        "EVALUATION_COLLECTION_LIMIT",
        "evaluator",
        `File selection contains ${count} items; collection limit is ${this.limits.collectionItems}.`,
        span,
      );
    }
  }

  private async resolveProvider(
    namespace: RuntimeNamespace,
    resolver: string,
    arguments_: Readonly<Record<string, WireValue>>,
    subject: WireValue | undefined,
    expected: TypeExpression,
    span: SourceSpan,
  ): Promise<Cell> {
    const host = namespace.host;
    if (host === undefined) {
      throw new EvaluationFault(
        "PROVIDER_HOST_MISSING",
        "provider",
        `No resolver host was supplied for provider alias '${namespace.alias}'.`,
        span,
      );
    }
    const available = new Set(host.capabilities.map((capability) => capability.name));
    const denied = namespace.manifest.permissions.filter(
      (permission) => !available.has(permission),
    );
    if (denied.length > 0) {
      throw new EvaluationFault(
        "PROVIDER_PERMISSION_MISSING",
        "permission",
        `Provider alias '${namespace.alias}' is missing capabilities: ${denied.join(", ")}.`,
        span,
      );
    }
    if (this.resolverCalls >= this.limits.resolverCalls) {
      throw new EvaluationFault(
        "EVALUATION_RESOLVER_LIMIT",
        "evaluator",
        `Resolver call limit ${this.limits.resolverCalls} was exceeded.`,
        span,
      );
    }
    this.resolverCalls += 1;
    let wire: WireValue;
    try {
      wire = await host.resolve(
        assertValidResolverRequest({
          resolver,
          arguments: arguments_,
          ...(subject === undefined ? {} : { subject }),
        }),
        {
          ...(this.signal === undefined ? {} : { signal: this.signal }),
          ...(this.resolverTimeoutMs === undefined ? {} : { timeoutMs: this.resolverTimeoutMs }),
        },
      );
    } catch (error) {
      if (error instanceof ResolverFault) {
        throw new EvaluationFault(
          error.code,
          error.kind === "permission" || error.kind === "capability" ? "permission" : "runtime",
          error.message,
          span,
          [],
          error,
        );
      }
      throw new EvaluationFault(
        "PROVIDER_RUNTIME_FAULT",
        "runtime",
        error instanceof Error ? error.message : String(error),
        span,
        [],
        error,
      );
    }
    const validation = validateWireValue(wire);
    if (!validation.ok) {
      throw new EvaluationFault(
        "PROVIDER_INVALID_WIRE_VALUE",
        "runtime",
        validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
        span,
      );
    }
    return this.decode(validation.value, expected, namespace, span);
  }

  private decode(
    wire: WireValue,
    expected: TypeExpression,
    namespace: RuntimeNamespace,
    span: SourceSpan,
  ): Cell {
    if (expected.kind === "optional") {
      if (wire.tag === "missing") return { value: missing };
      if (wire.tag === "null") return { value: null };
      return this.decode(wire, expected.value, namespace, span);
    }
    if (wire.tag === "missing" && expected.kind === "set" && expected.resolve !== undefined)
      return { value: missing };
    if (wire.tag === "missing" || wire.tag === "null")
      return this.wireMismatch(expected.kind, wire, span);
    switch (expected.kind) {
      case "string":
        if (wire.tag !== "string") return this.wireMismatch(expected.kind, wire, span);
        if (
          expected.kind === "string" &&
          expected.enum !== undefined &&
          !expected.enum.includes(wire.value)
        )
          return this.wireConstraint("string enum", wire.value, span);
        if (
          expected.kind === "string" &&
          expected.pattern !== undefined &&
          !matchesSafePattern(expected.pattern, wire.value)
        )
          return this.wireConstraint("string pattern", wire.value, span);
        return { value: wire.value };
      case "glob":
        if (wire.tag !== "string") return this.wireMismatch("glob", wire, span);
        try {
          new PoliciGlob(wire.value);
        } catch {
          return this.wireConstraint("glob syntax", wire.value, span);
        }
        return { value: wire.value };
      case "id":
        if (wire.tag !== "id" || wire.namespace !== expected.namespace)
          return this.wireMismatch(`id(${expected.namespace})`, wire, span);
        return { value: wire.value };
      case "integer": {
        if (wire.tag !== "integer") return this.wireMismatch("integer", wire, span);
        const value = Number(wire.value);
        if (!Number.isSafeInteger(value)) {
          throw new EvaluationFault(
            "PROVIDER_INTEGER_RANGE",
            "runtime",
            `Wire integer ${wire.value} is outside the safe evaluator range.`,
            span,
          );
        }
        if (expected.minimum !== undefined && value < expected.minimum)
          return this.wireConstraint(`integer minimum ${expected.minimum}`, value, span);
        if (expected.maximum !== undefined && value > expected.maximum)
          return this.wireConstraint(`integer maximum ${expected.maximum}`, value, span);
        return { value };
      }
      case "boolean":
        if (wire.tag !== "boolean") return this.wireMismatch("boolean", wire, span);
        return { value: wire.value };
      case "list":
      case "set": {
        if (wire.tag !== expected.kind) return this.wireMismatch(expected.kind, wire, span);
        const items = wire.items.map((item) => this.decode(item, expected.items, namespace, span));
        return { value: this.makeCollection(items, expected.kind === "set", span) };
      }
      case "object": {
        if (wire.tag !== "map") return this.wireMismatch("object", wire, span);
        this.assertKnownFields(wire.entries, expected.fields, "object", span);
        const fields: Record<string, Cell> = {};
        for (const [name, fieldType] of Object.entries(expected.fields)) {
          fields[name] = this.decode(
            wire.entries[name] ?? { tag: "missing" },
            fieldType,
            namespace,
            span,
          );
        }
        return {
          value: {
            kind: "json",
            value: this.jsonFromFields(fields),
            pointer: "",
          },
        };
      }
      case "ref": {
        const qualifiedType = `${namespace.manifest.name}:${expected.type}`;
        const definition = namespace.manifest.types[expected.type];
        if (definition === undefined) {
          throw new EvaluationFault(
            "PROVIDER_UNKNOWN_ENTITY_TYPE",
            "runtime",
            `Provider returned unknown entity type '${expected.type}'.`,
            span,
          );
        }
        if (definition.kind === "value") {
          if (wire.tag !== "map") return this.wireMismatch(`value ${qualifiedType}`, wire, span);
          this.assertKnownFields(wire.entries, definition.fields, `value ${qualifiedType}`, span);
          const fields: Record<string, Cell> = {};
          for (const [name, fieldType] of Object.entries(definition.fields)) {
            fields[name] = this.decode(
              wire.entries[name] ?? { tag: "missing" },
              fieldType,
              namespace,
              span,
            );
          }
          return { value: Object.freeze({ kind: "object", fields: Object.freeze(fields) }) };
        }
        if (wire.tag !== "entity") return this.wireMismatch(`entity ${qualifiedType}`, wire, span);
        if (wire.type !== qualifiedType)
          return this.wireMismatch(`entity ${qualifiedType}`, wire, span);
        if (definition.kind === "entity") {
          const identityType = definition.fields[definition.identity];
          const identityField = wire.fields[definition.identity];
          if (identityType?.kind !== "id") {
            throw new EvaluationFault(
              "PROVIDER_ENTITY_IDENTITY",
              "runtime",
              `Entity '${qualifiedType}' manifest identity field is not an id.`,
              span,
            );
          }
          if (
            wire.identity.namespace !== identityType.namespace ||
            identityField?.tag !== "id" ||
            identityField.namespace !== identityType.namespace ||
            identityField.value !== wire.identity.value
          ) {
            throw new EvaluationFault(
              "PROVIDER_ENTITY_IDENTITY",
              "runtime",
              `Entity '${qualifiedType}' identity header must equal id field '${definition.identity}' in namespace '${identityType.namespace}'.`,
              span,
            );
          }
        }
        this.assertKnownFields(wire.fields, definition.fields, `entity ${qualifiedType}`, span);
        const fields: Record<string, Cell> = {};
        for (const [name, fieldType] of Object.entries(definition.fields)) {
          fields[name] = this.decode(
            wire.fields[name] ?? { tag: "missing" },
            fieldType,
            namespace,
            span,
          );
        }
        return {
          value: Object.freeze({
            kind: "entity",
            alias: namespace.alias,
            provider: namespace.manifest.name,
            contractMajor: namespace.manifest.contractMajor,
            name: expected.type,
            identity: Object.freeze({ ...wire.identity }),
            fields: Object.freeze(fields),
            wire,
          }),
        };
      }
      case "core":
        return this.decodeCore(wire, expected.type, namespace, span);
    }
  }

  private decodeCore(
    wire: WireValue,
    type: "File" | "Change" | "ChangeSet" | "Check",
    namespace: RuntimeNamespace,
    span: SourceSpan,
  ): Cell {
    if (wire.tag !== "entity") return this.wireMismatch(`core.${type}`, wire, span);
    if (wire.type !== `core:${type}`) return this.wireMismatch(`core.${type}`, wire, span);
    const identityNamespace =
      type === "ChangeSet" ? "polici:change-set" : `polici:${type.toLowerCase()}`;
    if (wire.identity.namespace !== identityNamespace || wire.identity.value === "") {
      throw new EvaluationFault(
        "PROVIDER_CORE_IDENTITY",
        "runtime",
        `core.${type} requires a non-empty identity in namespace '${identityNamespace}'.`,
        span,
      );
    }
    if (type === "Check") {
      this.assertCoreFields(
        wire.fields,
        ["name", "status", "summary", "url", "head_sha", "producer", "sources"],
        ["name", "status"],
        "Check",
        span,
      );
      const name = this.wireString(wire.fields.name, "Check.name", span);
      const rawStatus = this.wireString(wire.fields.status, "Check.status", span);
      const status = this.checkStatus(rawStatus, span);
      const summary = this.optionalWireString(wire.fields.summary, "Check.summary", span);
      const url = this.optionalWireString(wire.fields.url, "Check.url", span);
      this.optionalWireString(wire.fields.head_sha, "Check.head_sha", span);
      this.optionalWireString(wire.fields.producer, "Check.producer", span);
      if (wire.fields.sources !== undefined) this.validateCheckSources(wire.fields.sources, span);
      return {
        value: new Check(name, status, {
          ...(summary === undefined ? {} : { summary }),
          ...(url === undefined ? {} : { url }),
        }),
      };
    }
    if (type === "File") return { value: this.decodeFile(wire, span) };
    if (type === "Change") return { value: this.decodeChange(wire, span) };
    this.assertCoreFields(
      wire.fields,
      ["changes", "merge_base_sha", "base_sha", "head_sha"],
      ["changes"],
      "ChangeSet",
      span,
    );
    for (const field of ["merge_base_sha", "base_sha", "head_sha"])
      this.optionalWireString(wire.fields[field], `ChangeSet.${field}`, span);
    const changes = wire.fields.changes;
    if (changes?.tag !== "list") {
      return this.wireMismatch("core.ChangeSet.changes", changes ?? { tag: "missing" }, span);
    }
    const decoded = changes.items.map((item) => {
      const value = this.decodeCore(item, "Change", namespace, span).value;
      if (!(value instanceof Change)) throw new Error("Decoded change has the wrong runtime type");
      return value;
    });
    if (decoded.length > this.limits.collectionItems) {
      throw new EvaluationFault(
        "EVALUATION_COLLECTION_LIMIT",
        "evaluator",
        `ChangeSet contains ${decoded.length} items; collection limit is ${this.limits.collectionItems}.`,
        span,
      );
    }
    return { value: new ChangeSet(decoded) };
  }

  private decodeChange(
    wire: Extract<WireValue, { readonly tag: "entity" }>,
    span: SourceSpan,
  ): Change {
    this.assertCoreFields(
      wire.fields,
      ["path", "status", "before", "after", "additions", "deletions", "changes"],
      ["path", "status", "before", "after"],
      "Change",
      span,
    );
    const path = this.wireString(wire.fields.path, "Change.path", span);
    this.assertCanonicalPath(path, "Change.path", span);
    const rawStatus = this.wireString(wire.fields.status, "Change.status", span);
    if (!["added", "modified", "deleted", "renamed"].includes(rawStatus)) {
      throw new EvaluationFault(
        "PROVIDER_CHANGE_STATUS",
        "runtime",
        `Unknown change status ${JSON.stringify(rawStatus)}.`,
        span,
      );
    }
    const status = rawStatus as "added" | "modified" | "deleted" | "renamed";
    for (const field of ["additions", "deletions", "changes"])
      this.optionalNonNegativeWireInteger(wire.fields[field], `Change.${field}`, span);
    this.assertChangeSide(wire.fields.before, status !== "added", "before", status, span);
    this.assertChangeSide(wire.fields.after, status !== "deleted", "after", status, span);
    const previousPath = this.changeFilePath(wire.fields.before, span);
    const afterPath = this.changeFilePath(wire.fields.after, span);
    if (afterPath !== undefined && afterPath !== path) {
      throw new EvaluationFault(
        "PROVIDER_CHANGE_PATH",
        "runtime",
        `Change.after.path ${JSON.stringify(afterPath)} must equal Change.path ${JSON.stringify(path)}.`,
        span,
      );
    }
    if (previousPath !== undefined && status !== "renamed" && previousPath !== path) {
      throw new EvaluationFault(
        "PROVIDER_CHANGE_PATH",
        "runtime",
        `Change.before.path ${JSON.stringify(previousPath)} must equal Change.path ${JSON.stringify(path)}.`,
        span,
      );
    }
    const before = this.changeFile(wire.fields.before, span);
    const after = status === "deleted" ? undefined : this.repository.get(path);
    if (status === "renamed" && previousPath === undefined) {
      throw new EvaluationFault(
        "PROVIDER_CHANGE_PREVIOUS_PATH",
        "runtime",
        "A renamed wire Change requires before.path.",
        span,
      );
    }
    return new Change({
      status,
      path,
      ...(status === "renamed" ? { previousPath } : {}),
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    });
  }

  private changeFilePath(wire: WireValue | undefined, span: SourceSpan): string | undefined {
    if (wire === undefined || wire.tag === "missing") return undefined;
    if (wire.tag !== "map") return this.wireMismatch("change file version", wire, span);
    this.assertChangeFileFields(wire.entries, span);
    const path = this.wireString(wire.entries.path, "Change file path", span);
    this.assertCanonicalPath(path, "Change file path", span);
    return path;
  }

  private changeFile(wire: WireValue | undefined, span: SourceSpan): File | undefined {
    if (wire === undefined || wire.tag === "missing") return undefined;
    if (wire.tag !== "map") return this.wireMismatch("change file version", wire, span);
    this.assertChangeFileFields(wire.entries, span);
    const path = this.wireString(wire.entries.path, "Change file path", span);
    this.assertCanonicalPath(path, "Change file path", span);
    const content = wire.entries.content;
    if (content?.tag === "bytes") return new File(path, this.decodeBase64(content.value, span));
    if (content?.tag === "string") return new File(path, content.value);
    if (content !== undefined && content.tag !== "missing")
      return this.wireMismatch("change file content", content, span);
    return undefined;
  }

  private decodeFile(wire: Extract<WireValue, { readonly tag: "entity" }>, span: SourceSpan): File {
    this.assertCoreFields(wire.fields, ["path", "content"], ["path", "content"], "File", span);
    const path = this.wireString(wire.fields.path, "File.path", span);
    this.assertCanonicalPath(path, "File.path", span);
    if (wire.identity.value !== path) {
      throw new EvaluationFault(
        "PROVIDER_CORE_IDENTITY",
        "runtime",
        `core.File identity value must equal its path ${JSON.stringify(path)}.`,
        span,
      );
    }
    const content = wire.fields.content;
    if (content?.tag === "string") return new File(path, content.value);
    if (content?.tag === "bytes") return new File(path, this.decodeBase64(content.value, span));
    if (content !== undefined && content.tag !== "missing")
      return this.wireMismatch("File.content", content, span);
    const repositoryFile = this.repository.get(path);
    if (repositoryFile !== undefined) return repositoryFile;
    throw new MissingValueFault("File content", span, { value: missing, source: { path } });
  }

  private checkStatus(
    value: string,
    span: SourceSpan,
  ): "missing" | "pending" | "passed" | "failed" | "cancelled" {
    if (["missing", "pending", "passed", "failed", "cancelled"].includes(value)) {
      return value as "missing" | "pending" | "passed" | "failed" | "cancelled";
    }
    throw new EvaluationFault(
      "PROVIDER_CHECK_STATUS",
      "runtime",
      `Unknown check status ${JSON.stringify(value)}.`,
      span,
    );
  }

  private assertCoreFields(
    actual: Readonly<Record<string, WireValue>>,
    allowed: readonly string[],
    required: readonly string[],
    label: string,
    span: SourceSpan,
  ): void {
    const unknown = Object.keys(actual).find((name) => !allowed.includes(name));
    if (unknown !== undefined) {
      throw new EvaluationFault(
        "PROVIDER_UNKNOWN_WIRE_FIELD",
        "runtime",
        `Provider returned unknown field '${unknown}' for core.${label}.`,
        span,
      );
    }
    const absent = required.find((name) => !Object.hasOwn(actual, name));
    if (absent !== undefined) {
      throw new EvaluationFault(
        "PROVIDER_REQUIRED_WIRE_FIELD",
        "runtime",
        `Provider omitted required field '${absent}' for core.${label}.`,
        span,
      );
    }
  }

  private assertCanonicalPath(value: string, label: string, span: SourceSpan): void {
    let normalized: string;
    try {
      normalized = new File(value, "").path;
    } catch (error) {
      throw new EvaluationFault(
        "PROVIDER_CORE_PATH",
        "runtime",
        `${label} is not a valid non-root repository path.`,
        span,
        [],
        error,
      );
    }
    if (normalized !== value) {
      throw new EvaluationFault(
        "PROVIDER_CORE_PATH",
        "runtime",
        `${label} must already be a canonical repository path; received ${JSON.stringify(value)}.`,
        span,
      );
    }
  }

  private assertChangeSide(
    value: WireValue | undefined,
    required: boolean,
    side: "before" | "after",
    status: "added" | "modified" | "deleted" | "renamed",
    span: SourceSpan,
  ): void {
    const present = value?.tag === "map";
    const absent = value?.tag === "missing";
    if ((required && !present) || (!required && !absent)) {
      throw new EvaluationFault(
        "PROVIDER_CHANGE_SIDE",
        "runtime",
        `A ${status} Change requires '${side}' to be ${required ? "a file-version map" : "missing"}.`,
        span,
      );
    }
  }

  private assertChangeFileFields(
    fields: Readonly<Record<string, WireValue>>,
    span: SourceSpan,
  ): void {
    this.assertCoreFields(
      fields,
      ["path", "content", "commit_sha", "sha"],
      ["path"],
      "Change.file-version",
      span,
    );
    this.optionalWireString(fields.commit_sha, "Change file commit_sha", span);
    this.optionalWireString(fields.sha, "Change file sha", span);
  }

  private optionalNonNegativeWireInteger(
    value: WireValue | undefined,
    label: string,
    span: SourceSpan,
  ): number | undefined {
    if (value === undefined) return undefined;
    if (value.tag !== "integer") return this.wireMismatch(label, value, span);
    const decoded = Number(value.value);
    if (!Number.isSafeInteger(decoded) || decoded < 0) {
      throw new EvaluationFault(
        "PROVIDER_WIRE_CONSTRAINT",
        "runtime",
        `${label} must be a non-negative safe integer.`,
        span,
      );
    }
    return decoded;
  }

  private validateCheckSources(value: WireValue, span: SourceSpan): void {
    if (value.tag === "missing") return;
    if (value.tag !== "list") return this.wireMismatch("Check.sources", value, span);
    for (const item of value.items) {
      if (item.tag !== "map") return this.wireMismatch("Check source", item, span);
      this.assertCoreFields(
        item.entries,
        [
          "kind",
          "id",
          "name",
          "producer",
          "producer_name",
          "status",
          "raw_state",
          "timestamp",
          "url",
        ],
        [
          "kind",
          "id",
          "name",
          "producer",
          "producer_name",
          "status",
          "raw_state",
          "timestamp",
          "url",
        ],
        "Check.source",
        span,
      );
      const kind = this.wireString(item.entries.kind, "Check source kind", span);
      if (kind !== "check-run" && kind !== "status")
        this.wireConstraint('Check source kind "check-run" or "status"', kind, span);
      this.wireString(item.entries.id, "Check source id", span);
      this.wireString(item.entries.name, "Check source name", span);
      this.wireString(item.entries.producer, "Check source producer", span);
      this.optionalWireString(item.entries.producer_name, "Check source producer_name", span);
      this.checkStatus(this.wireString(item.entries.status, "Check source status", span), span);
      this.wireString(item.entries.raw_state, "Check source raw_state", span);
      this.optionalWireString(item.entries.timestamp, "Check source timestamp", span);
      this.optionalWireString(item.entries.url, "Check source url", span);
    }
  }

  private wireString(wire: WireValue | undefined, label: string, span: SourceSpan): string {
    if (wire?.tag !== "string") {
      throw new EvaluationFault(
        "PROVIDER_WIRE_TYPE",
        "runtime",
        `${label} must be a wire string.`,
        span,
      );
    }
    return wire.value;
  }

  private optionalWireString(
    wire: WireValue | undefined,
    label: string,
    span: SourceSpan,
  ): string | undefined {
    if (wire === undefined || wire.tag === "missing") return undefined;
    return this.wireString(wire, label, span);
  }

  private wireMismatch(expected: string, wire: WireValue, span: SourceSpan): never {
    throw new EvaluationFault(
      "PROVIDER_WIRE_TYPE",
      "runtime",
      `Expected ${expected}, but provider returned wire tag '${wire.tag}'.`,
      span,
    );
  }

  private wireConstraint(expected: string, value: unknown, span: SourceSpan): never {
    throw new EvaluationFault(
      "PROVIDER_WIRE_CONSTRAINT",
      "runtime",
      `Provider value ${JSON.stringify(value)} does not satisfy ${expected}.`,
      span,
    );
  }

  private assertKnownFields(
    actual: Readonly<Record<string, WireValue>>,
    expected: Readonly<Record<string, TypeExpression>>,
    label: string,
    span: SourceSpan,
  ): void {
    const known = Object.keys(expected);
    const unknown = Object.keys(actual).find((name) => !known.includes(name));
    if (unknown !== undefined) {
      throw new EvaluationFault(
        "PROVIDER_UNKNOWN_WIRE_FIELD",
        "runtime",
        `Provider returned unknown field '${unknown}' for ${label}.`,
        span,
      );
    }
  }

  private jsonFromFields(fields: Readonly<Record<string, Cell>>): JsonValue {
    const result: Record<string, JsonValue> = {};
    for (const [name, cell] of Object.entries(fields)) {
      if (cell.value === missing) continue;
      result[name] = this.jsonValue(cell);
    }
    return result;
  }

  private jsonValue(cell: Cell): JsonValue {
    const value = cellValue(cell);
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return value;
    if (isTagged(value, "collection")) return value.items.map((item) => this.jsonValue(item));
    if (isTagged(value, "object")) return this.jsonFromFields(value.fields);
    throw new TypeError("Provider object contains a non-JSON value");
  }

  private encodeTyped(
    cell: Cell,
    expected: TypeExpression,
    namespace: RuntimeNamespace,
    span: SourceSpan,
    label: string,
  ): WireValue {
    const raw = cellValue(cell);
    if (expected.kind === "optional") {
      if (raw === missing) return wire.missing();
      if (raw === null) return wire.null();
      return this.encodeTyped(cell, expected.value, namespace, span, label);
    }
    const value = this.demand(cell, span, label);
    switch (expected.kind) {
      case "string": {
        const string = this.typedString(value, label, span);
        if (expected.enum !== undefined && !expected.enum.includes(string))
          return this.argumentConstraint(label, "the declared string enum", span);
        if (expected.pattern !== undefined && !matchesSafePattern(expected.pattern, string))
          return this.argumentConstraint(label, "the declared string pattern", span);
        return wire.string(string);
      }
      case "glob": {
        const pattern = this.typedString(value, label, span);
        try {
          new PoliciGlob(pattern);
        } catch (error) {
          throw new EvaluationFault(
            "EVALUATION_ARGUMENT_CONSTRAINT",
            "evaluator",
            `${label} is not a valid Polici glob.`,
            span,
            [],
            error,
          );
        }
        return wire.string(pattern);
      }
      case "id":
        return wire.id(expected.namespace, this.typedString(value, label, span));
      case "integer": {
        const integer = this.typedInteger(value, label, span);
        if (expected.minimum !== undefined && integer < expected.minimum)
          return this.argumentConstraint(label, `minimum ${expected.minimum}`, span);
        if (expected.maximum !== undefined && integer > expected.maximum)
          return this.argumentConstraint(label, `maximum ${expected.maximum}`, span);
        return wire.integer(integer);
      }
      case "boolean":
        if (isTagged(value, "json")) {
          if (typeof value.value !== "boolean") return this.argumentType(label, "boolean", span);
          return wire.boolean(value.value);
        }
        if (typeof value !== "boolean") return this.argumentType(label, "boolean", span);
        return wire.boolean(value);
      case "list":
      case "set": {
        const collection = this.collection(cell, span, label);
        const expectsSet = expected.kind === "set";
        if (collection.set !== expectsSet)
          return this.argumentType(label, expectsSet ? "set" : "list", span);
        const items = collection.items.map((item) =>
          this.encodeTyped(item, expected.items, namespace, span, `${label} item`),
        );
        try {
          return expectsSet ? wire.set(items) : wire.list(items);
        } catch (error) {
          throw new EvaluationFault(
            "EVALUATION_ARGUMENT_CONSTRAINT",
            "evaluator",
            `${label} contains duplicate set values or identities.`,
            span,
            [],
            error,
          );
        }
      }
      case "object": {
        const fields = this.argumentFields(value, label, span);
        this.assertArgumentFields(fields, expected.fields, label, span);
        const entries: Record<string, WireValue> = {};
        for (const [name, field] of Object.entries(expected.fields)) {
          const item = fields[name];
          entries[name] =
            item === undefined
              ? wire.missing()
              : this.encodeTyped(item, field, namespace, span, `${label}.${name}`);
        }
        return wire.map(entries);
      }
      case "ref": {
        const definition = namespace.manifest.types[expected.type];
        if (definition === undefined)
          throw new EvaluationFault(
            "PROVIDER_UNKNOWN_ENTITY_TYPE",
            "runtime",
            `Manifest references unknown type '${expected.type}'.`,
            span,
          );
        if (definition.kind === "entity") {
          if (
            !isTagged(value, "entity") ||
            value.provider !== namespace.manifest.name ||
            value.contractMajor !== namespace.manifest.contractMajor ||
            value.name !== expected.type
          ) {
            return this.argumentType(label, `${namespace.manifest.name}.${expected.type}`, span);
          }
          return value.wire;
        }
        const fields = this.argumentFields(value, label, span);
        this.assertArgumentFields(fields, definition.fields, label, span);
        const entries: Record<string, WireValue> = {};
        for (const [name, field] of Object.entries(definition.fields)) {
          const item = fields[name];
          entries[name] =
            item === undefined
              ? wire.missing()
              : this.encodeTyped(item, field, namespace, span, `${label}.${name}`);
        }
        return wire.map(entries);
      }
      case "core":
        return this.encodeCoreArgument(value, expected.type, span, label);
    }
  }

  private typedString(value: Cell["value"], label: string, span: SourceSpan): string {
    const raw = isTagged(value, "json") ? value.value : value;
    if (typeof raw !== "string") return this.argumentType(label, "string", span);
    return raw;
  }

  private typedInteger(value: Cell["value"], label: string, span: SourceSpan): number {
    const raw = isTagged(value, "json") ? value.value : value;
    if (typeof raw !== "number" || !Number.isSafeInteger(raw))
      return this.argumentType(label, "safe integer", span);
    return raw;
  }

  private argumentFields(
    value: Cell["value"],
    label: string,
    span: SourceSpan,
  ): Readonly<Record<string, Cell>> {
    if (isTagged(value, "object")) return value.fields;
    if (
      isTagged(value, "json") &&
      value.value !== null &&
      !Array.isArray(value.value) &&
      typeof value.value === "object"
    ) {
      return Object.fromEntries(
        Object.entries(value.value).map(([name, item]) => [
          name,
          { value: { kind: "json", value: item, pointer: "" } },
        ]),
      );
    }
    return this.argumentType(label, "object", span);
  }

  private assertArgumentFields(
    actual: Readonly<Record<string, Cell>>,
    expected: Readonly<Record<string, TypeExpression>>,
    label: string,
    span: SourceSpan,
  ): void {
    const unknown = Object.keys(actual).find((name) => !Object.hasOwn(expected, name));
    if (unknown !== undefined) this.argumentConstraint(label, `no field '${unknown}'`, span);
    const missingField = Object.entries(expected).find(
      ([name, field]) => !Object.hasOwn(actual, name) && field.kind !== "optional",
    );
    if (missingField !== undefined)
      this.argumentConstraint(label, `required field '${missingField[0]}'`, span);
  }

  private encodeCoreArgument(
    value: Cell["value"],
    type: "File" | "Change" | "ChangeSet" | "Check",
    span: SourceSpan,
    label: string,
  ): WireValue {
    if (type === "File" && value instanceof File) {
      return wire.entity("core:File", "polici:file", value.path, {
        path: wire.string(value.path),
        content: wire.bytes(this.encodeBase64(value.bytes)),
      });
    }
    if (type === "Change" && value instanceof Change) return this.encodeChangeArgument(value);
    if (type === "ChangeSet" && value instanceof ChangeSet) {
      return wire.entity("core:ChangeSet", "polici:change-set", "argument", {
        changes: wire.list([...value].map((change) => this.encodeChangeArgument(change))),
      });
    }
    if (type === "Check" && value instanceof Check) {
      return wire.entity("core:Check", "polici:check", `${value.name}:${value.status}`, {
        name: wire.string(value.name),
        status: wire.string(value.status),
        ...(value.summary === undefined ? {} : { summary: wire.string(value.summary) }),
        ...(value.url === undefined ? {} : { url: wire.string(value.url) }),
      });
    }
    return this.argumentType(label, `core.${type}`, span);
  }

  private encodeChangeArgument(change: Change): WireValue {
    const fileVersion = (file: File | undefined): WireValue =>
      file === undefined
        ? wire.missing()
        : wire.map({
            path: wire.string(file.path),
            content: wire.bytes(this.encodeBase64(file.bytes)),
          });
    return wire.entity(
      "core:Change",
      "polici:change",
      `${change.status}:${change.previousPath ?? ""}:${change.path}`,
      {
        path: wire.string(change.path),
        status: wire.string(change.status),
        before: fileVersion(change.before),
        after: fileVersion(change.after),
      },
    );
  }

  private argumentType(label: string, expected: string, span: SourceSpan): never {
    throw new EvaluationFault(
      "EVALUATION_ARGUMENT_TYPE",
      "evaluator",
      `${label} must be ${expected}.`,
      span,
    );
  }

  private argumentConstraint(label: string, expected: string, span: SourceSpan): never {
    throw new EvaluationFault(
      "EVALUATION_ARGUMENT_CONSTRAINT",
      "evaluator",
      `${label} does not satisfy ${expected}.`,
      span,
    );
  }

  private encodeJson(value: JsonValue): WireValue {
    if (value === null) return { tag: "null" };
    if (typeof value === "string") return { tag: "string", value };
    if (typeof value === "boolean") return { tag: "boolean", value };
    if (typeof value === "number")
      return Number.isSafeInteger(value)
        ? { tag: "integer", value: String(value) }
        : { tag: "number", value };
    if (Array.isArray(value))
      return { tag: "list", items: value.map((item) => this.encodeJson(item)) };
    return {
      tag: "map",
      entries: Object.fromEntries(
        Object.entries(value).map(([name, item]) => [name, this.encodeJson(item)]),
      ),
    };
  }

  private encodeDefault(value: JsonValue, expected: TypeExpression): WireValue {
    if (expected.kind === "optional") {
      return value === null ? { tag: "null" } : this.encodeDefault(value, expected.value);
    }
    if (expected.kind === "id") {
      if (typeof value !== "string") throw new TypeError("Validated id default is not a string");
      return { tag: "id", namespace: expected.namespace, value };
    }
    if (expected.kind === "set") {
      if (!Array.isArray(value)) throw new TypeError("Validated set default is not an array");
      return wire.set(value.map((item) => this.encodeDefault(item, expected.items)));
    }
    if (expected.kind === "list") {
      if (!Array.isArray(value)) throw new TypeError("Validated list default is not an array");
      return { tag: "list", items: value.map((item) => this.encodeDefault(item, expected.items)) };
    }
    if (expected.kind === "object") {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new TypeError("Validated object default is not an object");
      const objectValue = value as { readonly [key: string]: JsonValue };
      const entries: Record<string, WireValue> = {};
      for (const [name, field] of Object.entries(expected.fields)) {
        const item = objectValue[name];
        if (item !== undefined) entries[name] = this.encodeDefault(item, field);
      }
      return { tag: "map", entries };
    }
    return this.encodeJson(value);
  }

  private encodeBase64(bytes: Uint8Array): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let result = "";
    for (let index = 0; index < bytes.length; index += 3) {
      const first = bytes[index] ?? 0;
      const second = bytes[index + 1] ?? 0;
      const third = bytes[index + 2] ?? 0;
      const value = first * 65_536 + second * 256 + third;
      result += alphabet.charAt(Math.floor(value / 262_144) % 64);
      result += alphabet.charAt(Math.floor(value / 4_096) % 64);
      result += index + 1 < bytes.length ? alphabet.charAt(Math.floor(value / 64) % 64) : "=";
      result += index + 2 < bytes.length ? alphabet.charAt(value % 64) : "=";
    }
    return result;
  }

  private decodeBase64(value: string, span: SourceSpan): Uint8Array {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const validation = validateWireValue({ tag: "bytes", encoding: "base64", value });
    if (!validation.ok) return this.wireMismatch("base64 bytes", { tag: "string", value }, span);
    const bytes: number[] = [];
    for (let index = 0; index < value.length; index += 4) {
      const a = alphabet.indexOf(value.charAt(index));
      const b = alphabet.indexOf(value.charAt(index + 1));
      const c = value.charAt(index + 2) === "=" ? 0 : alphabet.indexOf(value.charAt(index + 2));
      const d = value.charAt(index + 3) === "=" ? 0 : alphabet.indexOf(value.charAt(index + 3));
      if (a < 0 || b < 0 || c < 0 || d < 0)
        return this.wireMismatch("base64 bytes", { tag: "string", value }, span);
      const number = a * 262_144 + b * 4_096 + c * 64 + d;
      bytes.push(Math.floor(number / 65_536) % 256);
      if (value.charAt(index + 2) !== "=") bytes.push(Math.floor(number / 256) % 256);
      if (value.charAt(index + 3) !== "=") bytes.push(number % 256);
    }
    return new Uint8Array(bytes);
  }

  private fault(error: unknown, span: SourceSpan): EvaluationFault {
    if (error instanceof EvaluationFault) return error;
    if (error instanceof JsonParseError) {
      return new EvaluationFault(error.code, "runtime", error.message, span, [], error);
    }
    return new EvaluationFault(
      "EVALUATION_RUNTIME_FAULT",
      "runtime",
      error instanceof Error ? error.message : String(error),
      span,
      [],
      error,
    );
  }
}

export async function evaluatePolicy(
  compiled: CompiledPolicy,
  options: EvaluatePolicyOptions,
): Promise<PolicyEvaluationResult> {
  if (!isCompiledPolicy(compiled))
    throw new TypeError("evaluatePolicy requires compiler-produced IR");
  const evaluator = new Evaluator(compiled, options);
  return evaluator.evaluate();
}
