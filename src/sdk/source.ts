import type { JsonValue } from "../plugin/json.js";
import type { Documentation, PluginManifest, TypeExpression } from "../plugin/manifest.js";
import { core, type } from "./builders.js";
import { definePlugin, type PluginDefinition } from "./define.js";

type TokenKind = "identifier" | "string" | "number" | "punctuation" | "eof";

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
  readonly offset: number;
}

type Expression =
  | { readonly kind: "literal"; readonly value: JsonValue; readonly offset: number }
  | { readonly kind: "array"; readonly items: readonly Expression[]; readonly offset: number }
  | {
      readonly kind: "object";
      readonly entries: readonly { readonly name: string; readonly value: Expression }[];
      readonly offset: number;
    }
  | { readonly kind: "reference"; readonly path: readonly string[]; readonly offset: number }
  | {
      readonly kind: "call";
      readonly path: readonly string[];
      readonly arguments: readonly Expression[];
      readonly offset: number;
    };

/**
 * Parses the declarative TypeScript plugin-authoring subset without executing
 * the module. Arbitrary JavaScript expressions and non-SDK imports are rejected.
 */
export function parsePluginDefinitionSource(source: string): PluginManifest {
  return new ContractParser(source).parse();
}

class ContractParser {
  private readonly tokens: readonly Token[];
  private index = 0;

  constructor(private readonly source: string) {
    this.tokens = lex(source);
  }

  parse(): PluginManifest {
    while (this.atIdentifier("import")) this.parseImport();
    this.expectIdentifier("export");
    this.expectIdentifier("default");
    const expression = this.parseExpression();
    this.consume(";");
    this.expect("eof");
    if (expression.kind !== "call" || expression.path.join(".") !== "definePlugin")
      this.fail(expression.offset, "default export must be definePlugin({...})");
    if (expression.arguments.length !== 1)
      this.fail(expression.offset, "definePlugin requires exactly one object argument");
    const definition = evaluateExpression(expression.arguments[0]!, this.source);
    if (!isRecord(definition))
      this.fail(expression.offset, "definePlugin argument must be an object literal");
    return definePlugin(definition as unknown as PluginDefinition);
  }

  private parseImport(): void {
    const start = this.take();
    let module: string | undefined;
    let foundFrom = false;
    while (!this.at("eof") && !this.atPunctuation(";")) {
      const token = this.take();
      if (token.kind === "identifier" && token.value === "from") foundFrom = true;
      else if (foundFrom && token.kind === "string") {
        module = token.value;
        foundFrom = false;
      }
    }
    this.expectPunctuation(";");
    if (module !== "polici/plugin-sdk")
      this.fail(start.offset, 'contract imports may only reference "polici/plugin-sdk"');
  }

  private parseExpression(): Expression {
    const token = this.current();
    if (token.kind === "string") {
      this.index++;
      return { kind: "literal", value: token.value, offset: token.offset };
    }
    if (token.kind === "number") {
      this.index++;
      const value = Number(token.value);
      if (!Number.isFinite(value)) this.fail(token.offset, "number literal must be finite");
      return { kind: "literal", value, offset: token.offset };
    }
    if (token.kind === "identifier") {
      if (token.value === "true" || token.value === "false" || token.value === "null") {
        this.index++;
        return {
          kind: "literal",
          value: token.value === "null" ? null : token.value === "true",
          offset: token.offset,
        };
      }
      return this.parseReferenceOrCall();
    }
    if (this.consume("[")) return this.parseArray(token.offset);
    if (this.consume("{")) return this.parseObject(token.offset);
    if (this.consume("-")) {
      const number = this.expect("number");
      const value = -Number(number.value);
      if (!Number.isFinite(value)) this.fail(number.offset, "number literal must be finite");
      return { kind: "literal", value, offset: token.offset };
    }
    this.fail(token.offset, "expected a JSON literal, object, array, or SDK helper call");
  }

  private parseReferenceOrCall(): Expression {
    const first = this.expect("identifier");
    const path = [first.value];
    while (this.consume(".")) path.push(this.expect("identifier").value);
    if (!this.consume("(")) return { kind: "reference", path, offset: first.offset };
    const arguments_: Expression[] = [];
    if (!this.atPunctuation(")")) {
      do arguments_.push(this.parseExpression());
      while (this.consume(",") && !this.atPunctuation(")"));
    }
    this.expectPunctuation(")");
    return { kind: "call", path, arguments: arguments_, offset: first.offset };
  }

  private parseArray(offset: number): Expression {
    const items: Expression[] = [];
    if (!this.atPunctuation("]")) {
      do items.push(this.parseExpression());
      while (this.consume(",") && !this.atPunctuation("]"));
    }
    this.expectPunctuation("]");
    return { kind: "array", items, offset };
  }

  private parseObject(offset: number): Expression {
    const entries: { name: string; value: Expression }[] = [];
    const names = new Set<string>();
    if (!this.atPunctuation("}")) {
      do {
        const name = this.take();
        if (name.kind !== "identifier" && name.kind !== "string")
          this.fail(name.offset, "object keys must be identifiers or string literals");
        if (names.has(name.value))
          this.fail(name.offset, `duplicate object key ${JSON.stringify(name.value)}`);
        names.add(name.value);
        this.expectPunctuation(":");
        entries.push({ name: name.value, value: this.parseExpression() });
      } while (this.consume(",") && !this.atPunctuation("}"));
    }
    this.expectPunctuation("}");
    return { kind: "object", entries, offset };
  }

  private current(): Token {
    return this.tokens[this.index]!;
  }

  private take(): Token {
    return this.tokens[this.index++]!;
  }

  private at(kind: TokenKind): boolean {
    return this.current().kind === kind;
  }

  private atIdentifier(value: string): boolean {
    const token = this.current();
    return token.kind === "identifier" && token.value === value;
  }

  private atPunctuation(value: string): boolean {
    const token = this.current();
    return token.kind === "punctuation" && token.value === value;
  }

  private consume(value: string): boolean {
    if (!this.atPunctuation(value)) return false;
    this.index++;
    return true;
  }

  private expect(kind: TokenKind): Token {
    const token = this.take();
    if (token.kind !== kind) this.fail(token.offset, `expected ${kind}`);
    return token;
  }

  private expectIdentifier(value: string): void {
    const token = this.take();
    if (token.kind !== "identifier" || token.value !== value)
      this.fail(token.offset, `expected ${value}`);
  }

  private expectPunctuation(value: string): void {
    const token = this.take();
    if (token.kind !== "punctuation" || token.value !== value)
      this.fail(token.offset, `expected ${JSON.stringify(value)}`);
  }

  private fail(offset: number, message: string): never {
    const position = sourcePosition(this.source, offset);
    throw new SyntaxError(`Plugin contract ${position.line}:${position.column}: ${message}`);
  }
}

function evaluateExpression(expression: Expression, source: string): unknown {
  if (expression.kind === "literal") return expression.value;
  if (expression.kind === "array")
    return expression.items.map((item) => evaluateExpression(item, source));
  if (expression.kind === "object")
    return Object.fromEntries(
      expression.entries.map(({ name, value }) => [name, evaluateExpression(value, source)]),
    );
  const name = expression.path.join(".");
  if (expression.kind === "reference") {
    if (name === "core.File") return core.File;
    if (name === "core.Change") return core.Change;
    if (name === "core.ChangeSet") return core.ChangeSet;
    if (name === "core.Check") return core.Check;
    return sourceError(source, expression.offset, `unsupported reference ${name}`);
  }
  const arguments_ = expression.arguments.map((argument) => evaluateExpression(argument, source));
  if (name === "definePlugin") return arguments_[0];
  const method =
    expression.path.length === 2 && expression.path[0] === "type" ? expression.path[1] : undefined;
  if (method === undefined || !TYPE_HELPERS.has(method))
    return sourceError(source, expression.offset, `unsupported call ${name}`);
  try {
    return invokeTypeHelper(method, arguments_);
  } catch (error) {
    return sourceError(
      source,
      expression.offset,
      `${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const TYPE_HELPERS = new Set([
  "string",
  "integer",
  "boolean",
  "glob",
  "id",
  "ref",
  "list",
  "set",
  "optional",
  "object",
  "entity",
  "value",
  "parameter",
  "resource",
  "function",
  "method",
]);

function invokeTypeHelper(method: string, arguments_: readonly unknown[]): unknown {
  switch (method) {
    case "string":
    case "integer":
    case "boolean":
    case "glob":
      assertArguments(method, arguments_, 0, 1);
      return type[method](arguments_[0] as never);
    case "id":
    case "ref":
    case "list":
    case "optional":
      assertArguments(method, arguments_, 1, 2);
      return type[method](arguments_[0] as never, arguments_[1] as never);
    case "set":
    case "object":
      assertArguments(method, arguments_, 1, 2);
      return type[method](arguments_[0] as never, arguments_[1] as never);
    case "entity":
    case "value":
    case "function":
    case "method":
      assertArguments(method, arguments_, 1, 1);
      return type[method](arguments_[0] as never);
    case "parameter":
      assertArguments(method, arguments_, 2, 3);
      return type.parameter(
        arguments_[0] as string,
        arguments_[1] as TypeExpression,
        arguments_[2] as Documentation,
      );
    case "resource":
      assertArguments(method, arguments_, 2, 2);
      return type.resource(arguments_[0] as TypeExpression, arguments_[1] as never);
    default:
      throw new TypeError(`unsupported helper ${method}`);
  }
}

function assertArguments(
  name: string,
  arguments_: readonly unknown[],
  minimum: number,
  maximum: number,
): void {
  if (arguments_.length < minimum || arguments_.length > maximum)
    throw new TypeError(
      `${name} expects ${minimum === maximum ? minimum : `${minimum}-${maximum}`} arguments`,
    );
}

function lex(source: string): readonly Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  while (offset < source.length) {
    const code = source.charCodeAt(offset);
    if (isWhitespace(code)) {
      offset++;
      continue;
    }
    if (source.startsWith("//", offset)) {
      offset += 2;
      while (
        offset < source.length &&
        source.charCodeAt(offset) !== 10 &&
        source.charCodeAt(offset) !== 13
      )
        offset++;
      continue;
    }
    if (source.startsWith("/*", offset)) {
      const end = source.indexOf("*/", offset + 2);
      if (end < 0) throw sourceError(source, offset, "unterminated block comment");
      offset = end + 2;
      continue;
    }
    const start = offset;
    const character = source[offset]!;
    if (isIdentifierStart(code)) {
      offset++;
      while (offset < source.length && isIdentifierPart(source.charCodeAt(offset))) offset++;
      tokens.push({ kind: "identifier", value: source.slice(start, offset), offset: start });
      continue;
    }
    if (code >= 48 && code <= 57) {
      offset++;
      while (offset < source.length && /[0-9.eE+-]/.test(source[offset]!)) offset++;
      const value = source.slice(start, offset);
      if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(value))
        throw sourceError(source, start, "invalid number literal");
      tokens.push({ kind: "number", value, offset: start });
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      offset++;
      let value = "";
      while (offset < source.length && source[offset] !== quote) {
        const next = source[offset++]!;
        if (next === "\n" || next === "\r")
          throw sourceError(source, start, "unterminated string literal");
        if (next !== "\\") {
          value += next;
          continue;
        }
        if (offset >= source.length) throw sourceError(source, start, "unterminated string escape");
        const escaped = source[offset++]!;
        const simple: Record<string, string> = {
          "\\": "\\",
          '"': '"',
          "'": "'",
          n: "\n",
          r: "\r",
          t: "\t",
          b: "\b",
          f: "\f",
        };
        if (simple[escaped] !== undefined) value += simple[escaped];
        else if (escaped === "u") {
          const hex = source.slice(offset, offset + 4);
          if (!/^[0-9A-Fa-f]{4}$/.test(hex))
            throw sourceError(source, offset, "invalid Unicode escape");
          value += String.fromCharCode(Number.parseInt(hex, 16));
          offset += 4;
        } else throw sourceError(source, offset - 1, `unsupported string escape \\${escaped}`);
      }
      if (source[offset] !== quote) throw sourceError(source, start, "unterminated string literal");
      offset++;
      tokens.push({ kind: "string", value, offset: start });
      continue;
    }
    if ("{}[]():,.;-".includes(character)) {
      tokens.push({ kind: "punctuation", value: character, offset: start });
      offset++;
      continue;
    }
    throw sourceError(source, start, `unsupported token ${JSON.stringify(character)}`);
  }
  tokens.push({ kind: "eof", value: "", offset: source.length });
  return tokens;
}

function sourceError(source: string, offset: number, message: string): never {
  const position = sourcePosition(source, offset);
  throw new SyntaxError(`Plugin contract ${position.line}:${position.column}: ${message}`);
}

function sourcePosition(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index++) {
    if (source.charCodeAt(index) === 10) {
      line++;
      column = 1;
    } else column++;
  }
  return { line, column };
}

function isWhitespace(code: number): boolean {
  return code === 9 || code === 10 || code === 13 || code === 32;
}

function isIdentifierStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36;
}

function isIdentifierPart(code: number): boolean {
  return isIdentifierStart(code) || (code >= 48 && code <= 57);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
