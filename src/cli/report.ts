import type {
  CompiledPolicy,
  PolicyCheckResult,
  PolicyDiagnostic,
  PolicyEvidence,
  PolicyRuleResult,
  PolicyStatus,
} from "../engine/types.js";
import type { SourceSpan } from "../language/model.js";

export function validationResult(compiled: CompiledPolicy): PolicyCheckResult {
  const hasErrors = compiled.diagnostics.some((diagnostic) => diagnostic.severity === "error");
  return {
    kind: "policy-evaluation",
    status: hasErrors ? "error" : "passed",
    exitCode: hasErrors ? 2 : 0,
    policies: [],
    diagnostics: compiled.diagnostics,
  };
}

export function renderHumanReport(result: PolicyCheckResult, policyPath: string): string {
  const lines: string[] = [`Policy ${result.status} (exit ${result.exitCode})`];
  for (const diagnostic of result.diagnostics) {
    lines.push(
      `${location(policyPath, diagnostic.span)}: ${diagnostic.severity} ${diagnostic.code} [${diagnostic.source}]: ${diagnostic.message}`,
    );
    for (const related of diagnostic.related ?? [])
      lines.push(`  related ${location(policyPath, related.span)}: ${related.message}`);
  }
  for (const policy of result.policies) {
    lines.push(
      `${statusLabel(policy.status)} policy ${JSON.stringify(policy.name)} ${location(policyPath, policy.span)}`,
    );
    for (const rule of policy.rules) renderRule(lines, rule, policyPath);
  }
  return `${lines.join("\n")}\n`;
}

function renderRule(lines: string[], rule: PolicyRuleResult, policyPath: string): void {
  lines.push(
    `  ${statusLabel(rule.status)} rule ${JSON.stringify(rule.name)} ${location(policyPath, rule.span)}${rule.message ? `: ${rule.message}` : ""}`,
  );
  for (const requirement of rule.requirements) {
    lines.push(
      `    ${statusLabel(requirement.status)} require ${location(policyPath, requirement.expressionSpan)}${requirement.message ? `: ${requirement.message}` : ""}`,
    );
    for (const evidence of requirement.evidence)
      renderEvidence(lines, evidence, policyPath, "      ");
  }
  if (rule.requirements.length === 0) {
    for (const evidence of rule.evidence) renderEvidence(lines, evidence, policyPath, "    ");
  }
}

function renderEvidence(
  lines: string[],
  evidence: PolicyEvidence,
  policyPath: string,
  indent: string,
): void {
  const source = evidence.source;
  const sourceLocation =
    source === undefined
      ? evidence.span === undefined
        ? ""
        : ` ${location(policyPath, evidence.span)}`
      : ` ${location(source.path, source.span)}${source.pointer === undefined ? "" : ` ${source.pointer}`}`;
  const value = evidence.value === undefined ? "" : ` value=${JSON.stringify(evidence.value)}`;
  lines.push(`${indent}evidence ${evidence.kind}${sourceLocation}: ${evidence.message}${value}`);
}

function statusLabel(status: PolicyStatus): string {
  switch (status) {
    case "passed":
      return "PASS";
    case "failed":
      return "FAIL";
    case "skipped":
      return "SKIP";
    case "error":
      return "ERROR";
  }
}

function location(filePath: string, span: SourceSpan | undefined): string {
  if (span === undefined) return filePath;
  return `${filePath}:${span.start.line + 1}:${span.start.column + 1}`;
}

export function operationalDiagnostic(message: string): PolicyDiagnostic {
  return {
    code: "CLI_ERROR",
    message,
    severity: "error",
    source: "evaluator",
    span: {
      start: { offset: 0, line: 0, column: 0 },
      end: { offset: 0, line: 0, column: 0 },
    },
  };
}
