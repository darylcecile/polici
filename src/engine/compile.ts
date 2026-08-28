import { compile } from "../language/checker.ts";
import type { IRExpression, IRProgram, IRStatement, SourceSpan } from "../language/model.ts";
import { parse } from "../language/parser.ts";
import {
  validatePluginManifest,
  type MethodDefinition,
  type ParameterDefinition,
  type PluginManifest,
} from "../plugin/manifest.js";
import {
  assertLockedPluginIntegrity,
  canonicalPluginLockfile,
  validatePluginLockfile,
  type LockedPlugin,
} from "../plugin/lockfile.js";
import { sha256 } from "../core/hash.js";
import { canonicalJson } from "../core/serializable.js";
import { adaptPluginManifest } from "./manifest.ts";
import type {
  CompiledPluginBinding,
  CompiledPolicy,
  CompilePolicyOptions,
  LockedPluginInput,
  ParsedPolicy,
  PolicyDiagnostic,
  TrustedBuiltinPluginInput,
} from "./types.ts";

const compiledPolicies = new WeakSet<object>();

export function parsePolicy(source: string): ParsedPolicy {
  return parse(source);
}

function pointSpan(span: SourceSpan): SourceSpan {
  return { start: { ...span.start }, end: { ...span.start } };
}

export function compilePolicy(source: string, options: CompilePolicyOptions = {}): CompiledPolicy {
  const parsed = parsePolicy(source);
  const manifestDiagnostics: PolicyDiagnostic[] = [];
  const valid: PluginManifest[] = [];
  const bindings: CompiledPluginBinding[] = [];
  const lockfile = options.lockfile;
  if (lockfile !== undefined) {
    const validation = validatePluginLockfile(lockfile);
    if (!validation.ok) {
      for (const issue of validation.issues) {
        manifestDiagnostics.push(pluginDiagnostic(issue.path, issue.message, parsed.ast.span));
      }
    }
  }
  const canonicalLockfile =
    lockfile === undefined || manifestDiagnostics.length > 0
      ? undefined
      : canonicalPluginLockfile(lockfile);

  for (const input of options.lockedPlugins ?? []) {
    const manifest = input.manifest;
    const validation = validatePluginManifest(manifest);
    if (validation.ok) {
      try {
        assertLockfileContains(canonicalLockfile, input.lock);
        assertLockedPluginIntegrity(input.lock, validation.value, input.artifact);
        valid.push(validation.value);
        bindings.push(lockedBinding(input));
      } catch (error) {
        manifestDiagnostics.push(
          pluginDiagnostic(
            "$lockedPlugin",
            error instanceof Error ? error.message : String(error),
            parsed.ast.span,
          ),
        );
      }
      continue;
    }
    for (const issue of validation.issues) {
      manifestDiagnostics.push(pluginDiagnostic(issue.path, issue.message, parsed.ast.span));
    }
  }
  for (const input of options.trustedBuiltins ?? []) {
    const validation = validatePluginManifest(input.manifest);
    if (validation.ok) {
      valid.push(validation.value);
      bindings.push(trustedBinding(input));
    } else {
      for (const issue of validation.issues)
        manifestDiagnostics.push(pluginDiagnostic(issue.path, issue.message, parsed.ast.span));
    }
  }

  const compiled = compile(source, valid.map(adaptPluginManifest));
  const diagnostics: PolicyDiagnostic[] = [
    ...compiled.diagnostics,
    ...manifestDiagnostics,
    ...strictCollectionDiagnostics(compiled.ir, valid),
  ];
  for (const imported of parsed.ast.usings) {
    const coordinate = /^([^@\s]+)@([1-9][0-9]*)$/.exec(imported.source);
    if (coordinate === null) continue;
    const provider = coordinate[1]!;
    const contractMajor = Number(coordinate[2]);
    const matches = bindings.filter(
      (binding) => binding.name === provider && binding.contractMajor === contractMajor,
    );
    if (matches.length !== 1) {
      diagnostics.push({
        code: "PROVIDER_LOCK_REQUIRED",
        message: `Import '${imported.source}' must resolve to exactly one integrity-verified locked plugin or explicit trusted built-in.`,
        severity: "error",
        source: "provider",
        span: imported.sourceSpan,
      });
    }
  }
  if (
    compiled.ast.policies.length === 0 &&
    !diagnostics.some((item) => item.severity === "error")
  ) {
    diagnostics.push({
      code: "POLICY_NO_DECLARATION",
      message: "The source does not declare a policy.",
      severity: "error",
      source: "evaluator",
      span: pointSpan(compiled.ast.span),
    });
  }
  for (const policy of compiled.ast.policies) {
    if (policy.members.filter((member) => member.kind === "RuleDeclaration").length === 0) {
      diagnostics.push({
        code: "POLICY_NO_RULES",
        message: `Policy '${policy.name}' must contain at least one rule.`,
        severity: "error",
        source: "evaluator",
        span: policy.span,
      });
    }
    for (const member of policy.members) {
      if (member.kind === "RuleDeclaration" && !hasRequirement(member.statements)) {
        diagnostics.push({
          code: "POLICY_RULE_NO_REQUIREMENT",
          message: `Rule '${member.name}' must contain at least one require statement.`,
          severity: "error",
          source: "evaluator",
          span: member.span,
        });
      }
    }
  }
  const manifests = valid.map((manifest) => cloneJson(manifest));
  const pluginBindings = bindings.map((binding) => cloneJson(binding));
  const integrity = compiledIntegrity(source, compiled.ir, manifests, pluginBindings, diagnostics);
  const result: CompiledPolicy = {
    kind: "compiled-policy",
    source,
    tokens: deepFreeze(compiled.tokens),
    ast: deepFreeze(compiled.ast),
    diagnostics: deepFreeze(diagnostics),
    analysis: deepFreeze(compiled.analysis),
    ir: deepFreeze(compiled.ir),
    manifests: deepFreeze(manifests),
    pluginBindings: deepFreeze(pluginBindings),
    integrity,
  };
  deepFreeze(result);
  compiledPolicies.add(result);
  return result;
}

export function isCompiledPolicy(value: CompiledPolicy): boolean {
  return (
    compiledPolicies.has(value) &&
    value.integrity ===
      compiledIntegrity(
        value.source,
        value.ir,
        value.manifests,
        value.pluginBindings,
        value.diagnostics,
      )
  );
}

function hasRequirement(statements: readonly import("../language/model.ts").Statement[]): boolean {
  return statements.some(
    (statement) =>
      statement.kind === "RequireStatement" ||
      (statement.kind === "ForEachStatement" && hasRequirement(statement.statements)),
  );
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) deepFreeze(item, seen);
  return Object.freeze(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function compiledIntegrity(
  source: string,
  ir: IRProgram,
  manifests: readonly PluginManifest[],
  bindings: readonly CompiledPluginBinding[],
  diagnostics: readonly PolicyDiagnostic[],
): string {
  return sha256(canonicalJson({ source, ir, manifests, bindings, diagnostics }));
}

function strictCollectionDiagnostics(
  program: IRProgram,
  manifests: readonly PluginManifest[],
): PolicyDiagnostic[] {
  const diagnostics: PolicyDiagnostic[] = [];
  const imports = new Map(
    program.imports.map((imported) => [
      imported.alias,
      manifests.find(
        (manifest) =>
          manifest.name === imported.provider && manifest.contractMajor === imported.apiVersion,
      ),
    ]),
  );
  const aliasOf = (expression: IRExpression): string | undefined => {
    if (expression.kind === "reference" && expression.scope === "provider") return expression.name;
    if (expression.kind === "reference" && expression.scope === "binding") {
      for (const policy of program.policies) {
        const binding = policy.bindings.find((candidate) => candidate.id === expression.id);
        if (binding !== undefined) return aliasOf(binding.value);
      }
    }
    if (expression.kind === "member") return aliasOf(expression.object);
    if (expression.kind === "call") return aliasOf(expression.callee);
    return undefined;
  };
  const visit = (expression: IRExpression): void => {
    if (expression.kind === "call" && expression.callee.kind === "member") {
      const alias = aliasOf(expression.callee.object);
      const manifest = alias === undefined ? undefined : imports.get(alias);
      let parameters: readonly ParameterDefinition[] | undefined;
      if (manifest !== undefined) {
        if (
          expression.callee.object.kind === "reference" &&
          expression.callee.object.scope === "provider"
        ) {
          const exported = manifest.exports[expression.callee.property] as
            | { readonly kind: string; readonly parameters?: readonly ParameterDefinition[] }
            | undefined;
          if (exported !== undefined && exported.kind === "function")
            parameters = exported.parameters;
        } else if (expression.callee.object.type.startsWith(`${manifest.name}.`)) {
          const typeName = expression.callee.object.type.slice(manifest.name.length + 1);
          const definition = manifest.types[typeName] as
            | {
                readonly kind: string;
                readonly methods?: Readonly<Record<string, MethodDefinition>>;
              }
            | undefined;
          const method: MethodDefinition | undefined =
            definition?.methods?.[expression.callee.property];
          parameters = method?.parameters;
        }
      }
      if (parameters !== undefined) {
        for (
          let index = 0;
          index < Math.min(parameters.length, expression.arguments.length);
          index++
        ) {
          const expected = parameters[index]!.type;
          const actual = expression.arguments[index]!;
          if (
            (expected.kind === "list" && actual.type.startsWith("Set<")) ||
            (expected.kind === "set" && actual.type.startsWith("Collection<"))
          ) {
            diagnostics.push({
              code: "TYPE_MISMATCH",
              message: `Argument '${parameters[index]!.name}' must be ${expected.kind}, not ${expected.kind === "list" ? "set" : "list"}.`,
              severity: "error",
              source: "type",
              span: actual.span,
            });
          }
        }
      }
    }
    switch (expression.kind) {
      case "member":
        visit(expression.object);
        return;
      case "call":
        visit(expression.callee);
        expression.arguments.forEach(visit);
        return;
      case "projection":
        visit(expression.collection);
        visit(expression.expression);
        return;
      case "unary":
        visit(expression.operand);
        return;
      case "binary":
        visit(expression.left);
        visit(expression.right);
        return;
      case "passed":
        visit(expression.check);
        return;
      case "unique":
        visit(expression.value);
        visit(expression.collection);
        return;
      case "relation":
        visit(expression.left);
        visit(expression.right);
        return;
      case "fold":
        visit(expression.collection);
        return;
      default:
        return;
    }
  };
  for (const policy of program.policies) {
    policy.bindings.forEach((binding) => visit(binding.value));
    policy.rules.forEach((rule) => {
      if (rule.condition !== undefined) visit(rule.condition);
    });
    const visitStatements = (values: readonly IRStatement[]): void => {
      for (const statement of values) {
        if (statement.kind === "require") visit(statement.expression);
        else {
          visit(statement.collection);
          visitStatements(statement.statements);
        }
      }
    };
    policy.rules.forEach((rule) => visitStatements(rule.statements));
  }
  return diagnostics;
}

function pluginDiagnostic(path: string, message: string, span: SourceSpan): PolicyDiagnostic {
  return {
    code: "PROVIDER_INVALID_MANIFEST",
    message: `${path}: ${message}`,
    severity: "error",
    source: "provider",
    span: pointSpan(span),
  };
}

function sameLock(left: LockedPlugin, right: LockedPlugin): boolean {
  return (
    left.name === right.name &&
    left.version === right.version &&
    left.contractMajor === right.contractMajor &&
    left.source.kind === right.source.kind &&
    left.source.locator === right.source.locator &&
    left.manifest.value === right.manifest.value &&
    left.artifact.value === right.artifact.value &&
    left.runtime.kind === right.runtime.kind &&
    left.runtime.protocol === right.runtime.protocol &&
    left.runtime.entrypoint === right.runtime.entrypoint &&
    left.runtime.transport === right.runtime.transport &&
    left.runtime.capabilities.length === right.runtime.capabilities.length &&
    left.runtime.capabilities.every((value) => right.runtime.capabilities.includes(value))
  );
}

function assertLockfileContains(
  lockfile: Readonly<{ readonly plugins: readonly LockedPlugin[] }> | undefined,
  locked: LockedPlugin,
): void {
  if (lockfile === undefined)
    throw new TypeError("A validated lockfile is required for external plugins");
  const matches = lockfile.plugins.filter((candidate) => sameLock(candidate, locked));
  if (matches.length !== 1)
    throw new TypeError(
      `Lockfile must contain the exact ${locked.name}@${locked.contractMajor} source and digests`,
    );
}

function lockedBinding(input: LockedPluginInput): CompiledPluginBinding {
  return {
    name: input.lock.name,
    contractMajor: input.lock.contractMajor,
    version: input.lock.version,
    source: input.lock.source,
    manifestSha256: input.lock.manifest.value,
    artifactSha256: input.lock.artifact.value,
    trustedBuiltin: false,
  };
}

function trustedBinding(input: TrustedBuiltinPluginInput): CompiledPluginBinding {
  return {
    name: input.manifest.name,
    contractMajor: input.manifest.contractMajor,
    version: input.manifest.version,
    source: input.source,
    trustedBuiltin: true,
  };
}
