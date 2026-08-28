import { canonicalJson, type JsonValue } from "./serializable.js";

export type EntityId = string | number;

export interface EntityIdentity {
  readonly type: string;
  readonly id: EntityId;
}

export interface SerializedEntity {
  readonly kind: "entity";
  readonly identity: EntityIdentity;
  readonly fields: Readonly<Record<string, unknown>>;
}

function validEntityId(id: EntityId): boolean {
  return typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
}

export class Entity<
  TFields extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  readonly identity: EntityIdentity;
  readonly fields: TFields;

  constructor(type: string, id: EntityId, fields: TFields) {
    if (typeof type !== "string" || type.trim() === "")
      throw new TypeError("Entity type must be a non-empty string");
    if (!validEntityId(id)) throw new TypeError("Entity ID must be a string or finite number");
    if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
      throw new TypeError("Entity fields must be an object");
    }
    this.identity = Object.freeze({ type, id });
    this.fields = Object.freeze({ ...fields }) as TFields;
    Object.freeze(this);
  }

  get type(): string {
    return this.identity.type;
  }

  get id(): EntityId {
    return this.identity.id;
  }

  equals(other: unknown): boolean {
    return other instanceof Entity && identityEquals(this, other);
  }

  toJSON(): SerializedEntity {
    return { kind: "entity", identity: this.identity, fields: this.fields };
  }
}

interface IdentityBearing {
  readonly identity: EntityIdentity;
}

interface EqualityBearing {
  equals(other: unknown): boolean;
}

function isIdentityBearing(value: unknown): value is IdentityBearing {
  if (value === null || typeof value !== "object") return false;
  const identity = (value as { identity?: unknown }).identity;
  if (identity === null || typeof identity !== "object") return false;
  const candidate = identity as { type?: unknown; id?: unknown };
  return (
    typeof candidate.type === "string" &&
    (typeof candidate.id === "string" ||
      (typeof candidate.id === "number" && Number.isFinite(candidate.id)))
  );
}

function isEqualityBearing(value: unknown): value is EqualityBearing {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { equals?: unknown }).equals === "function"
  );
}

export function identityKey(value: unknown): string | undefined {
  if (!isIdentityBearing(value)) return undefined;
  return canonicalJson([value.identity.type, value.identity.id]);
}

export function identityEquals(left: unknown, right: unknown): boolean {
  if (!isIdentityBearing(left) || !isIdentityBearing(right)) return false;
  return left.identity.type === right.identity.type && left.identity.id === right.identity.id;
}

function deepValueEquals(left: unknown, right: unknown, seen: Map<object, object[]>): boolean {
  if (left === right) return true;
  if (
    typeof left === "number" &&
    typeof right === "number" &&
    Number.isNaN(left) &&
    Number.isNaN(right)
  )
    return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object")
    return false;
  if (isIdentityBearing(left) || isIdentityBearing(right)) return identityEquals(left, right);
  if (isEqualityBearing(left)) return left.equals(right);
  if (isEqualityBearing(right)) return right.equals(left);

  const known = seen.get(left);
  if (known?.includes(right)) return true;
  if (known === undefined) seen.set(left, [right]);
  else known.push(right);

  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    if (
      !(left instanceof Uint8Array) ||
      !(right instanceof Uint8Array) ||
      left.byteLength !== right.byteLength
    )
      return false;
    for (let index = 0; index < left.byteLength; index += 1) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!deepValueEquals(left[index], right[index], seen)) return false;
    }
    return true;
  }

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index += 1) {
    const key = leftKeys[index];
    if (key === undefined || key !== rightKeys[index]) return false;
    if (
      !deepValueEquals(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
        seen,
      )
    )
      return false;
  }
  return true;
}

/** Value equality is structural, except entities and other identity values compare by typed identity. */
export function valueEquals(left: unknown, right: unknown): boolean {
  return deepValueEquals(left, right, new Map<object, object[]>());
}

export type Equality<T> = (left: T, right: T) => boolean;

export class Collection<T> implements Iterable<T> {
  private readonly items: readonly T[];

  constructor(values: Iterable<T> = []) {
    this.items = Object.freeze(Array.from(values));
    Object.freeze(this);
  }

  get size(): number {
    return this.items.length;
  }

  get length(): number {
    return this.items.length;
  }

  at(index: number): T | undefined {
    return this.items.at(index);
  }

  toArray(): readonly T[] {
    return Object.freeze([...this.items]);
  }

  [Symbol.iterator](): Iterator<T> {
    return this.items[Symbol.iterator]();
  }

  map<U>(project: (value: T, index: number) => U): Collection<U> {
    return new Collection(this.items.map(project));
  }

  project<U>(project: (value: T, index: number) => U): Collection<U> {
    return this.map(project);
  }

  filter(predicate: (value: T, index: number) => boolean): Collection<T> {
    return new Collection(this.items.filter(predicate));
  }

  some(predicate: (value: T, index: number) => boolean): boolean {
    return this.items.some(predicate);
  }

  every(predicate: (value: T, index: number) => boolean): boolean {
    return this.items.every(predicate);
  }

  none(predicate: (value: T, index: number) => boolean): boolean {
    return !this.items.some(predicate);
  }

  contains(value: T, equal: Equality<T> = valueEquals): boolean {
    return this.items.some((item) => equal(item, value));
  }

  count(value: T, equal: Equality<T> = valueEquals): number {
    let result = 0;
    for (const item of this.items) if (equal(item, value)) result += 1;
    return result;
  }

  unique(value: T, equal: Equality<T> = valueEquals): boolean {
    return this.count(value, equal) === 1;
  }

  intersects(other: Iterable<T>, equal: Equality<T> = valueEquals): boolean {
    const right = Array.from(other);
    return this.items.some((left) => right.some((value) => equal(left, value)));
  }

  isSubsetOf(other: Iterable<T>, equal: Equality<T> = valueEquals): boolean {
    const right = Array.from(other);
    return this.items.every((left) => right.some((value) => equal(left, value)));
  }

  isDisjointFrom(other: Iterable<T>, equal: Equality<T> = valueEquals): boolean {
    return !this.intersects(other, equal);
  }

  equals(other: unknown): boolean {
    if (!(other instanceof Collection) || this.size !== other.size) return false;
    const right = other.toArray();
    for (let index = 0; index < this.items.length; index += 1) {
      if (!valueEquals(this.items[index], right[index])) return false;
    }
    return true;
  }

  toJSON(): readonly unknown[] {
    return this.items;
  }
}

export function collection<T>(values: Iterable<T> = []): Collection<T> {
  return new Collection(values);
}

export function entity<TFields extends Readonly<Record<string, unknown>>>(
  type: string,
  id: EntityId,
  fields: TFields,
): Entity<TFields> {
  return new Entity(type, id, fields);
}

export function uniqueIn<T>(
  value: T,
  values: Iterable<T>,
  equal: Equality<T> = valueEquals,
): boolean {
  return new Collection(values).unique(value, equal);
}

export function someIn<T>(
  left: Iterable<T>,
  right: Iterable<T>,
  equal: Equality<T> = valueEquals,
): boolean {
  return new Collection(left).intersects(right, equal);
}

export function everyIn<T>(
  left: Iterable<T>,
  right: Iterable<T>,
  equal: Equality<T> = valueEquals,
): boolean {
  return new Collection(left).isSubsetOf(right, equal);
}

export function noneIn<T>(
  left: Iterable<T>,
  right: Iterable<T>,
  equal: Equality<T> = valueEquals,
): boolean {
  return new Collection(left).isDisjointFrom(right, equal);
}

export function isJsonValue(value: unknown): value is JsonValue {
  const ancestors = new Set<object>();
  const visit = (item: unknown): boolean => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object" || ancestors.has(item)) return false;

    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) return false;
    ancestors.add(item);
    let result = true;
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index += 1) {
        if (!(index in item) || !visit(item[index])) {
          result = false;
          break;
        }
      }
    } else {
      for (const key of Object.keys(item)) {
        if (!visit((item as Record<string, unknown>)[key])) {
          result = false;
          break;
        }
      }
    }
    ancestors.delete(item);
    return result;
  };
  return visit(value);
}
