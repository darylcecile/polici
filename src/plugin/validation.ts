export interface ValidationIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

export class ContractValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(subject: string, issues: readonly ValidationIssue[]) {
    super(
      `${subject} is invalid:\n${issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n")}`,
    );
    this.name = "ContractValidationError";
    this.issues = issues;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
  });
}

function isDataArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (key === "length") return true;
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
    const index = Number(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      Number.isSafeInteger(index) &&
      index < value.length &&
      descriptor !== undefined &&
      "value" in descriptor &&
      descriptor.enumerable
    );
  });
}

export class ValidationContext {
  readonly issues: ValidationIssue[] = [];

  issue(path: string, code: string, message: string): void {
    this.issues.push({ path, code, message });
  }

  record(value: unknown, path: string): value is Record<string, unknown> {
    if (!isRecord(value)) {
      this.issue(path, "type", "expected a plain data object");
      return false;
    }
    return true;
  }

  array(value: unknown, path: string): value is unknown[] {
    if (!isDataArray(value)) {
      this.issue(path, "type", "expected a plain data array");
      return false;
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        this.issue(childPath(path, index), "sparse", "arrays cannot be sparse");
        return false;
      }
    }
    return true;
  }

  string(value: unknown, path: string, pattern?: RegExp): value is string {
    if (typeof value !== "string") {
      this.issue(path, "type", "expected a string");
      return false;
    }
    if (pattern && !pattern.test(value)) {
      this.issue(path, "format", `invalid value ${JSON.stringify(value)}`);
      return false;
    }
    return true;
  }

  boolean(value: unknown, path: string): value is boolean {
    if (typeof value !== "boolean") {
      this.issue(path, "type", "expected a boolean");
      return false;
    }
    return true;
  }

  integer(value: unknown, path: string, minimum?: number): value is number {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      this.issue(path, "type", "expected a safe integer");
      return false;
    }
    if (minimum !== undefined && value < minimum) {
      this.issue(path, "range", `expected a value greater than or equal to ${minimum}`);
      return false;
    }
    return true;
  }

  keys(value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
    const allowedKeys = new Set(allowed);
    for (const key of Object.keys(value)) {
      if (!allowedKeys.has(key)) {
        this.issue(childPath(path, key), "unknown_key", "unknown property");
      }
    }
  }

  required(value: Record<string, unknown>, path: string, keys: readonly string[]): void {
    const actual = Object.keys(value);
    for (const key of keys) {
      if (!actual.includes(key)) {
        this.issue(childPath(path, key), "required", "required property is missing");
      }
    }
  }

  result<T>(value: T): ValidationResult<T> {
    return this.issues.length === 0 ? { ok: true, value } : { ok: false, issues: this.issues };
  }
}

export function childPath(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

export function assertValid<T>(subject: string, result: ValidationResult<T>): T {
  if (!result.ok) throw new ContractValidationError(subject, result.issues);
  return result.value;
}
