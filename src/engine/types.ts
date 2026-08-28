import type {
  Diagnostic as LanguageDiagnostic,
  DiagnosticRelatedInformation,
  IRProgram,
  ParseResult,
  Program,
  SourceSpan,
  Token,
  TypeCheckResult,
} from "../language/model.ts";
import type { RepositorySnapshot } from "../core/repository.js";
import type { PluginManifest } from "../plugin/manifest.js";
import type { LockedPlugin, PluginLockfile, PluginSourceCoordinate } from "../plugin/lockfile.js";
import type { ResolverHost } from "../plugin/resolver.js";

export type PolicyDiagnosticSource =
  | LanguageDiagnostic["source"]
  | "provider"
  | "permission"
  | "runtime"
  | "evaluator";

export interface PolicyDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: "error" | "warning" | "information";
  readonly source: PolicyDiagnosticSource;
  readonly span: SourceSpan;
  readonly related?: readonly DiagnosticRelatedInformation[];
}

export interface ParsedPolicy extends ParseResult {}

export interface CompiledPolicy {
  readonly kind: "compiled-policy";
  readonly source: string;
  readonly tokens: readonly Token[];
  readonly ast: Program;
  readonly diagnostics: readonly PolicyDiagnostic[];
  readonly analysis: TypeCheckResult;
  readonly ir: IRProgram;
  /** Validated static manifests used to compile the policy. No runtime code is loaded. */
  readonly manifests: readonly PluginManifest[];
  /** Integrity provenance for every imported provider manifest. */
  readonly pluginBindings: readonly CompiledPluginBinding[];
  /** Internal integrity digest checked again by evaluatePolicy. */
  readonly integrity: string;
}

export interface LockedPluginInput {
  readonly lock: LockedPlugin;
  readonly manifest: PluginManifest;
  readonly artifact: Uint8Array;
}

export interface TrustedBuiltinPluginInput {
  readonly manifest: PluginManifest;
  readonly source: PluginSourceCoordinate & { readonly kind: "builtin" };
}

export interface CompiledPluginBinding {
  readonly name: string;
  readonly contractMajor: number;
  readonly version: string;
  readonly source: PluginSourceCoordinate;
  readonly manifestSha256?: string;
  readonly artifactSha256?: string;
  readonly trustedBuiltin: boolean;
}

export interface CompilePolicyOptions {
  readonly lockfile?: PluginLockfile;
  readonly lockedPlugins?: readonly LockedPluginInput[];
  /** Explicit escape hatch for host-implemented providers that have no external artifact. */
  readonly trustedBuiltins?: readonly TrustedBuiltinPluginInput[];
}

export interface EvaluatorLimits {
  /** Maximum files selected by one expression. */
  readonly files?: number;
  /** Maximum values in any evaluated collection. */
  readonly collectionItems?: number;
  /** Maximum runtime resolver calls for the complete evaluation. */
  readonly resolverCalls?: number;
  /** Maximum evidence records retained by one rule. */
  readonly evidence?: number;
}

export interface EvaluatePolicyOptions {
  readonly repository: RepositorySnapshot;
  /** Resolver hosts keyed by the alias in the policy's `using` declaration. */
  readonly resolvers?: Readonly<Record<string, ResolverHost>>;
  /** Alias for `resolvers`. */
  readonly providers?: Readonly<Record<string, ResolverHost>>;
  readonly limits?: EvaluatorLimits;
  readonly signal?: AbortSignal;
  readonly resolverTimeoutMs?: number;
}

export interface CheckPolicyOptions extends EvaluatePolicyOptions, CompilePolicyOptions {}

export type PolicyStatus = "passed" | "failed" | "skipped" | "error";
export type PolicyExitCode = 0 | 1 | 2;

export type SerializableValue =
  | null
  | boolean
  | number
  | string
  | readonly SerializableValue[]
  | { readonly [key: string]: SerializableValue };

export interface PolicySourceReference {
  readonly path: string;
  readonly pointer?: string;
  readonly span?: SourceSpan;
}

export type PolicyEvidenceKind =
  | "actual"
  | "expected"
  | "offending-item"
  | "duplicate"
  | "comparison"
  | "check"
  | "missing"
  | "context";

export interface PolicyEvidence {
  readonly kind: PolicyEvidenceKind;
  readonly message: string;
  readonly value?: SerializableValue;
  readonly span?: SourceSpan;
  readonly source?: PolicySourceReference;
}

export interface PolicyRequirementResult {
  readonly status: PolicyStatus;
  readonly span: SourceSpan;
  readonly expressionSpan: SourceSpan;
  readonly message?: string;
  readonly evidence: readonly PolicyEvidence[];
}

export interface PolicyRuleResult {
  readonly name: string;
  readonly status: PolicyStatus;
  readonly span: SourceSpan;
  readonly message?: string;
  readonly requirements: readonly PolicyRequirementResult[];
  readonly evidence: readonly PolicyEvidence[];
}

export interface PolicyResult {
  readonly name: string;
  readonly status: "passed" | "failed" | "error";
  readonly exitCode: PolicyExitCode;
  readonly span: SourceSpan;
  readonly rules: readonly PolicyRuleResult[];
}

export interface PolicyEvaluationResult {
  readonly kind: "policy-evaluation";
  readonly status: "passed" | "failed" | "error";
  readonly exitCode: PolicyExitCode;
  readonly policies: readonly PolicyResult[];
  readonly diagnostics: readonly PolicyDiagnostic[];
}

export type PolicyCheckResult = PolicyEvaluationResult;

export type EvaluationResult = PolicyEvaluationResult;
export type RuleEvaluationResult = PolicyRuleResult;
export type RequirementEvaluationResult = PolicyRequirementResult;
