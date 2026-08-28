import { Evidence, type EvidenceInput, type SerializedEvidence } from "./provenance.js";

export type RuleStatus = "passed" | "failed" | "skipped" | "error";
export type ReportExitCode = 0 | 1 | 2;

export interface RuleResultInput {
  readonly name: string;
  readonly status: RuleStatus;
  readonly message?: string;
  readonly evidence?: Iterable<Evidence | EvidenceInput>;
}

export interface SerializedRuleResult {
  readonly name: string;
  readonly status: RuleStatus;
  readonly message?: string;
  readonly evidence: readonly SerializedEvidence[];
}

export class RuleResult {
  readonly name: string;
  readonly status: RuleStatus;
  readonly message?: string;
  readonly evidence: readonly Evidence[];

  constructor(input: RuleResultInput) {
    if (typeof input.name !== "string" || input.name.trim() === "")
      throw new TypeError("Rule name must be a non-empty string");
    if (
      input.status !== "passed" &&
      input.status !== "failed" &&
      input.status !== "skipped" &&
      input.status !== "error"
    ) {
      throw new TypeError(`Unknown rule status ${JSON.stringify(input.status)}`);
    }
    this.name = input.name;
    this.status = input.status;
    this.message = input.message;
    this.evidence = Object.freeze(
      Array.from(input.evidence ?? [], (item) => {
        return item instanceof Evidence ? item : new Evidence(item);
      }),
    );
    Object.freeze(this);
  }

  toJSON(): SerializedRuleResult {
    const result: {
      name: string;
      status: RuleStatus;
      message?: string;
      evidence: readonly SerializedEvidence[];
    } = {
      name: this.name,
      status: this.status,
      evidence: this.evidence.map((item) => item.toJSON()),
    };
    if (this.message !== undefined) result.message = this.message;
    return result;
  }
}

export interface EvaluationReportInput {
  readonly policy: string;
  readonly rules?: Iterable<RuleResult | RuleResultInput>;
}

export interface SerializedEvaluationReport {
  readonly kind: "evaluation-report";
  readonly policy: string;
  readonly status: "passed" | "failed" | "error";
  readonly exitCode: ReportExitCode;
  readonly rules: readonly SerializedRuleResult[];
}

export class EvaluationReport {
  readonly policy: string;
  readonly rules: readonly RuleResult[];

  constructor(input: EvaluationReportInput) {
    if (typeof input.policy !== "string" || input.policy.trim() === "")
      throw new TypeError("Policy name must be a non-empty string");
    this.policy = input.policy;
    this.rules = Object.freeze(
      Array.from(input.rules ?? [], (rule) => {
        return rule instanceof RuleResult ? rule : new RuleResult(rule);
      }),
    );
    Object.freeze(this);
  }

  get status(): "passed" | "failed" | "error" {
    if (this.rules.some((rule) => rule.status === "error")) return "error";
    if (this.rules.some((rule) => rule.status === "failed")) return "failed";
    return "passed";
  }

  get exitCode(): ReportExitCode {
    if (this.status === "error") return 2;
    return this.status === "failed" ? 1 : 0;
  }

  toJSON(): SerializedEvaluationReport {
    return {
      kind: "evaluation-report",
      policy: this.policy,
      status: this.status,
      exitCode: this.exitCode,
      rules: this.rules.map((rule) => rule.toJSON()),
    };
  }
}

export { EvaluationReport as Report };
