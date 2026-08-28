export type CheckStatus = "missing" | "pending" | "passed" | "failed" | "cancelled";

export interface CheckInput {
  readonly name: string;
  readonly status: CheckStatus;
  readonly summary?: string;
  readonly url?: string;
}

export interface SerializedCheck {
  readonly kind: "check";
  readonly name: string;
  readonly status: CheckStatus;
  readonly conclusion: CheckStatus;
  readonly summary?: string;
  readonly url?: string;
}

export class Check {
  readonly name: string;
  readonly status: CheckStatus;
  readonly summary?: string;
  readonly url?: string;

  constructor(
    name: string,
    status: CheckStatus,
    options: Omit<CheckInput, "name" | "status"> = {},
  ) {
    if (typeof name !== "string" || name.trim() === "")
      throw new TypeError("Check name must be a non-empty string");
    if (
      status !== "missing" &&
      status !== "pending" &&
      status !== "passed" &&
      status !== "failed" &&
      status !== "cancelled"
    ) {
      throw new TypeError(`Unknown check status ${JSON.stringify(status)}`);
    }
    if (options.summary !== undefined && typeof options.summary !== "string")
      throw new TypeError("Check summary must be a string");
    if (options.url !== undefined && typeof options.url !== "string")
      throw new TypeError("Check URL must be a string");
    this.name = name;
    this.status = status;
    this.summary = options.summary;
    this.url = options.url;
    Object.freeze(this);
  }

  get passed(): boolean {
    return this.status === "passed";
  }

  get conclusion(): CheckStatus {
    return this.status;
  }

  equals(other: unknown): boolean {
    return (
      other instanceof Check &&
      this.name === other.name &&
      this.status === other.status &&
      this.summary === other.summary &&
      this.url === other.url
    );
  }

  toJSON(): SerializedCheck {
    const result: {
      kind: "check";
      name: string;
      status: CheckStatus;
      conclusion: CheckStatus;
      summary?: string;
      url?: string;
    } = {
      kind: "check",
      name: this.name,
      status: this.status,
      conclusion: this.conclusion,
    };
    if (this.summary !== undefined) result.summary = this.summary;
    if (this.url !== undefined) result.url = this.url;
    return result;
  }
}

export function check(
  name: string,
  status: CheckStatus,
  options: Omit<CheckInput, "name" | "status"> = {},
): Check {
  return new Check(name, status, options);
}

export function passed(checkValue: Check): boolean {
  return checkValue.passed;
}
