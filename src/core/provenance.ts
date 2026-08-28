import type { SourceSpan } from "./json.js";
import { normalizeRepositoryPath, type RepositoryPath } from "./path.js";
import type { JsonObject, JsonValue } from "./serializable.js";

export type ProvenanceKind = "repository" | "change" | "provider" | "policy" | "generated";

export interface SourceReferenceInput {
  readonly path: string;
  readonly pointer?: string;
  readonly span?: SourceSpan;
}

export interface SerializedSourceReference {
  readonly path: RepositoryPath;
  readonly pointer?: string;
  readonly span?: SourceSpan;
}

export class SourceReference {
  readonly path: RepositoryPath;
  readonly pointer?: string;
  readonly span?: SourceSpan;

  constructor(input: SourceReferenceInput) {
    this.path = normalizeRepositoryPath(input.path);
    if (this.path === "")
      throw new TypeError("A source reference path cannot be the repository root");
    if (input.pointer !== undefined && input.pointer !== "" && !input.pointer.startsWith("/")) {
      throw new TypeError("A JSON Pointer must be empty or start with '/'");
    }
    this.pointer = input.pointer;
    this.span = input.span;
    Object.freeze(this);
  }

  toJSON(): SerializedSourceReference {
    const result: { path: RepositoryPath; pointer?: string; span?: SourceSpan } = {
      path: this.path,
    };
    if (this.pointer !== undefined) result.pointer = this.pointer;
    if (this.span !== undefined) result.span = this.span;
    return result;
  }
}

export interface ProvenanceInput {
  readonly kind: ProvenanceKind;
  readonly source?: string;
  readonly revision?: string;
  readonly location?: SourceReference | SourceReferenceInput;
  readonly details?: JsonObject;
}

export interface SerializedProvenance {
  readonly kind: ProvenanceKind;
  readonly source?: string;
  readonly revision?: string;
  readonly location?: SerializedSourceReference;
  readonly details?: JsonObject;
}

export class Provenance {
  readonly kind: ProvenanceKind;
  readonly source?: string;
  readonly revision?: string;
  readonly location?: SourceReference;
  readonly details?: JsonObject;

  constructor(input: ProvenanceInput) {
    if (
      input.kind !== "repository" &&
      input.kind !== "change" &&
      input.kind !== "provider" &&
      input.kind !== "policy" &&
      input.kind !== "generated"
    ) {
      throw new TypeError(`Unknown provenance kind ${JSON.stringify(input.kind)}`);
    }
    this.kind = input.kind;
    this.source = input.source;
    this.revision = input.revision;
    this.location =
      input.location === undefined
        ? undefined
        : input.location instanceof SourceReference
          ? input.location
          : new SourceReference(input.location);
    this.details = input.details === undefined ? undefined : Object.freeze({ ...input.details });
    Object.freeze(this);
  }

  toJSON(): SerializedProvenance {
    const result: {
      kind: ProvenanceKind;
      source?: string;
      revision?: string;
      location?: SerializedSourceReference;
      details?: JsonObject;
    } = { kind: this.kind };
    if (this.source !== undefined) result.source = this.source;
    if (this.revision !== undefined) result.revision = this.revision;
    if (this.location !== undefined) result.location = this.location.toJSON();
    if (this.details !== undefined) result.details = this.details;
    return result;
  }
}

export type EvidenceKind = "actual" | "expected" | "related" | "context";

export interface EvidenceInput {
  readonly kind: EvidenceKind;
  readonly message?: string;
  readonly value?: JsonValue;
  readonly provenance?: Provenance | ProvenanceInput;
}

export interface SerializedEvidence {
  readonly kind: EvidenceKind;
  readonly message?: string;
  readonly value?: JsonValue;
  readonly provenance?: SerializedProvenance;
}

export class Evidence {
  readonly kind: EvidenceKind;
  readonly message?: string;
  readonly value?: JsonValue;
  readonly provenance?: Provenance;

  constructor(input: EvidenceInput) {
    if (
      input.kind !== "actual" &&
      input.kind !== "expected" &&
      input.kind !== "related" &&
      input.kind !== "context"
    ) {
      throw new TypeError(`Unknown evidence kind ${JSON.stringify(input.kind)}`);
    }
    this.kind = input.kind;
    this.message = input.message;
    this.value = input.value;
    this.provenance =
      input.provenance === undefined
        ? undefined
        : input.provenance instanceof Provenance
          ? input.provenance
          : new Provenance(input.provenance);
    Object.freeze(this);
  }

  toJSON(): SerializedEvidence {
    const result: {
      kind: EvidenceKind;
      message?: string;
      value?: JsonValue;
      provenance?: SerializedProvenance;
    } = { kind: this.kind };
    if (this.message !== undefined) result.message = this.message;
    if (this.value !== undefined) result.value = this.value;
    if (this.provenance !== undefined) result.provenance = this.provenance.toJSON();
    return result;
  }
}
