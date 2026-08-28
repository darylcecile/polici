import { lex } from "./lexer.ts";
import type {
  Diagnostic,
  Expression,
  ForEachStatement,
  ParseResult,
  PolicyBinding,
  PolicyDeclaration,
  PolicyMember,
  Program,
  Quantifier,
  RequireStatement,
  RuleDeclaration,
  SourcePosition,
  SourceSpan,
  Statement,
  Token,
  TokenKind,
  UsingDeclaration,
} from "./model.ts";

const trivia = new Set<TokenKind>(["Whitespace", "LineComment", "BlockComment"]);
const memberNames = new Set<TokenKind>([
  "Identifier",
  "Using",
  "As",
  "Policy",
  "Rule",
  "When",
  "Optional",
  "Require",
  "For",
  "Each",
  "In",
  "Some",
  "Every",
  "No",
  "Unique",
  "Matches",
  "Passed",
  "And",
  "Or",
  "Not",
  "True",
  "False",
  "Null",
]);

function clonePosition(value: SourcePosition): SourcePosition {
  return { offset: value.offset, line: value.line, column: value.column };
}

function sourceSpan(start: SourcePosition, end: SourcePosition): SourceSpan {
  return { start: clonePosition(start), end: clonePosition(end) };
}

function joinSpan(first: SourceSpan, last: SourceSpan): SourceSpan {
  return sourceSpan(first.start, last.end);
}

class Parser {
  private readonly significant: Token[];
  private readonly diagnostics: Diagnostic[] = [];
  private index = 0;

  constructor(tokens: readonly Token[]) {
    this.significant = tokens.filter((token) => !trivia.has(token.kind));
  }

  parse(): { ast: Program; diagnostics: readonly Diagnostic[] } {
    const start = this.current().span.start;
    const usings: UsingDeclaration[] = [];
    const policies: PolicyDeclaration[] = [];

    while (!this.at("EndOfFile")) {
      const before = this.index;
      if (this.at("Using")) usings.push(this.parseUsing());
      else if (this.at("Policy")) policies.push(this.parsePolicy());
      else {
        this.report(
          "PARSE_EXPECTED_DECLARATION",
          "Expected a 'using' or 'policy' declaration.",
          this.current().span,
        );
        this.synchronize(["Using", "Policy", "EndOfFile"]);
      }
      if (this.index === before) this.advance();
    }

    return {
      ast: { kind: "Program", span: sourceSpan(start, this.current().span.end), usings, policies },
      diagnostics: this.diagnostics,
    };
  }

  private parseUsing(): UsingDeclaration {
    const start = this.consume("Using");
    const provider = this.expect(
      "String",
      "Expected a JSON string containing the provider and API version.",
    );
    this.expect("As", "Expected 'as' after the provider source.");
    const alias = this.expect("Identifier", "Expected a provider alias after 'as'.");
    const end = this.consumeOptionalSemicolon() ?? alias;
    return {
      kind: "UsingDeclaration",
      span: joinSpan(start.span, end.span),
      source: typeof provider.value === "string" ? provider.value : "",
      sourceSpan: provider.span,
      alias: alias.text,
      aliasSpan: alias.span,
    };
  }

  private parsePolicy(): PolicyDeclaration {
    const start = this.consume("Policy");
    const name = this.expect("String", "Expected a JSON string containing the policy name.");
    const open = this.expect("LeftBrace", "Expected '{' to start the policy body.");
    const members: PolicyMember[] = [];
    while (!this.at("RightBrace") && !this.at("EndOfFile")) {
      const before = this.index;
      if (this.at("Rule")) members.push(this.parseRule());
      else if (this.at("Identifier")) members.push(this.parseBinding());
      else {
        this.report(
          "PARSE_EXPECTED_POLICY_MEMBER",
          "Expected a policy binding or rule declaration.",
          this.current().span,
        );
        this.synchronize(["Rule", "Identifier", "RightBrace", "EndOfFile"]);
      }
      if (this.index === before) this.advance();
    }
    const close = this.expect("RightBrace", "Expected '}' to close the policy body.");
    const end = this.consumeOptionalSemicolon() ?? close;
    return {
      kind: "PolicyDeclaration",
      span: joinSpan(start.span, end.span),
      name: typeof name.value === "string" ? name.value : "",
      nameSpan: name.span,
      members,
      bodySpan: joinSpan(open.span, close.span),
    };
  }

  private parseBinding(): PolicyBinding {
    const name = this.consume("Identifier");
    this.expect("Equals", "Expected '=' after the binding name.");
    const value = this.parseExpression();
    const end = this.consumeOptionalSemicolon();
    const endPosition = end === undefined ? value.span.end : end.span.end;
    return {
      kind: "PolicyBinding",
      span: sourceSpan(name.span.start, endPosition),
      name: name.text,
      nameSpan: name.span,
      value,
    };
  }

  private parseRule(): RuleDeclaration {
    const start = this.consume("Rule");
    const name = this.expect("String", "Expected a JSON string containing the rule name.");
    let condition: Expression | undefined;
    let optional = false;
    let sawWhen = false;
    while (this.at("When") || this.at("Optional")) {
      if (this.at("When")) {
        const when = this.advance();
        if (sawWhen)
          this.report(
            "PARSE_DUPLICATE_WHEN",
            "A rule can only have one 'when' condition.",
            when.span,
          );
        const nextCondition = this.parseExpression();
        if (!sawWhen) condition = nextCondition;
        sawWhen = true;
      } else {
        const token = this.advance();
        if (optional)
          this.report(
            "PARSE_DUPLICATE_OPTIONAL",
            "A rule can only be marked optional once.",
            token.span,
          );
        optional = true;
      }
    }
    const open = this.expect("LeftBrace", "Expected '{' to start the rule body.");
    const statements = this.parseStatements();
    const close = this.expect("RightBrace", "Expected '}' to close the rule body.");
    const end = this.consumeOptionalSemicolon() ?? close;
    return {
      kind: "RuleDeclaration",
      span: joinSpan(start.span, end.span),
      name: typeof name.value === "string" ? name.value : "",
      nameSpan: name.span,
      ...(condition === undefined ? {} : { condition }),
      optional,
      statements,
      bodySpan: joinSpan(open.span, close.span),
    };
  }

  private parseStatements(): Statement[] {
    const statements: Statement[] = [];
    while (!this.at("RightBrace") && !this.at("EndOfFile")) {
      const before = this.index;
      if (this.at("Require")) statements.push(this.parseRequire());
      else if (this.at("For")) statements.push(this.parseForEach());
      else {
        this.report(
          "PARSE_EXPECTED_STATEMENT",
          "Expected a 'require' or 'for each' statement.",
          this.current().span,
        );
        this.synchronize(["Require", "For", "RightBrace", "EndOfFile"]);
      }
      if (this.index === before) this.advance();
    }
    return statements;
  }

  private parseRequire(): RequireStatement {
    const start = this.consume("Require");
    const expression = this.parseExpression();
    const end = this.consumeOptionalSemicolon();
    const endPosition = end === undefined ? expression.span.end : end.span.end;
    return {
      kind: "RequireStatement",
      span: sourceSpan(start.span.start, endPosition),
      expression,
    };
  }

  private parseForEach(): ForEachStatement {
    const start = this.consume("For");
    this.expect("Each", "Expected 'each' after 'for'.");
    const variable = this.expect("Identifier", "Expected an iteration variable after 'for each'.");
    this.expect("In", "Expected 'in' after the iteration variable.");
    const collection = this.parseExpression();
    const open = this.expect("LeftBrace", "Expected '{' to start the loop body.");
    const statements = this.parseStatements();
    const close = this.expect("RightBrace", "Expected '}' to close the loop body.");
    this.consumeOptionalSemicolon();
    return {
      kind: "ForEachStatement",
      span: joinSpan(start.span, close.span),
      variable: variable.text,
      variableSpan: variable.span,
      collection,
      statements,
      bodySpan: joinSpan(open.span, close.span),
    };
  }

  private parseExpression(): Expression {
    return this.parseOr();
  }

  private parseOr(): Expression {
    let expression = this.parseAnd();
    while (this.at("Or")) {
      this.advance();
      const right = this.parseAnd();
      expression = {
        kind: "LogicalExpression",
        operator: "or",
        left: expression,
        right,
        span: joinSpan(expression.span, right.span),
      };
    }
    return expression;
  }

  private parseAnd(): Expression {
    let expression = this.parseUnary();
    while (this.at("And")) {
      this.advance();
      const right = this.parseUnary();
      expression = {
        kind: "LogicalExpression",
        operator: "and",
        left: expression,
        right,
        span: joinSpan(expression.span, right.span),
      };
    }
    return expression;
  }

  private parseUnary(): Expression {
    if (this.at("Not")) {
      const operator = this.advance();
      const operand = this.parseUnary();
      return {
        kind: "UnaryExpression",
        operator: "not",
        operand,
        span: sourceSpan(operator.span.start, operand.span.end),
      };
    }
    if (this.at("Some") || this.at("Every") || this.at("No")) return this.parseQuantifier();
    return this.parseComparison();
  }

  private parseQuantifier(): Expression {
    const token = this.advance();
    const quantifier = token.text as Quantifier;
    const left = this.parseComparison();
    if (this.at("In")) {
      this.advance();
      const right = this.parseComparison();
      return {
        kind: "QuantifiedRelationExpression",
        quantifier,
        left,
        right,
        span: sourceSpan(token.span.start, right.span.end),
      };
    }
    return {
      kind: "FoldExpression",
      quantifier,
      collection: left,
      span: sourceSpan(token.span.start, left.span.end),
    };
  }

  private parseComparison(): Expression {
    let expression = this.parsePostfix();
    while (true) {
      if (this.at("Passed")) {
        const passed = this.advance();
        expression = {
          kind: "PassedExpression",
          check: expression,
          span: sourceSpan(expression.span.start, passed.span.end),
        };
        continue;
      }
      if (this.at("Matches")) {
        this.advance();
        const pattern = this.parsePostfix();
        expression = {
          kind: "MatchesExpression",
          value: expression,
          pattern,
          span: joinSpan(expression.span, pattern.span),
        };
        continue;
      }
      if (this.at("Unique")) {
        this.advance();
        this.expect("In", "Expected 'in' after 'unique'.");
        const collection = this.parsePostfix();
        expression = {
          kind: "UniqueExpression",
          value: expression,
          collection,
          span: joinSpan(expression.span, collection.span),
        };
        continue;
      }
      if (this.at("EqualsEquals") || this.at("BangEquals")) {
        const operator = this.advance();
        const right = this.parsePostfix();
        expression = {
          kind: "EqualityExpression",
          operator: operator.kind === "EqualsEquals" ? "==" : "!=",
          left: expression,
          right,
          span: joinSpan(expression.span, right.span),
        };
        continue;
      }
      return expression;
    }
  }

  private parsePostfix(): Expression {
    let expression = this.parsePrimary();
    while (true) {
      if (this.at("LeftParen")) {
        this.advance();
        const args: Expression[] = [];
        while (!this.at("RightParen") && !this.at("EndOfFile")) {
          args.push(this.parseExpression());
          if (!this.at("Comma")) break;
          this.advance();
        }
        const close = this.expect("RightParen", "Expected ')' after the function arguments.");
        expression = {
          kind: "CallExpression",
          callee: expression,
          arguments: args,
          span: sourceSpan(expression.span.start, close.span.end),
        };
        continue;
      }
      if (this.at("Dot")) {
        this.advance();
        if (this.at("LeftBrace")) {
          const open = this.advance();
          const body = this.parseExpression();
          const close = this.expect("RightBrace", "Expected '}' after the projection expression.");
          expression = {
            kind: "ProjectionExpression",
            collection: expression,
            expression: body,
            bodySpan: joinSpan(open.span, close.span),
            span: sourceSpan(expression.span.start, close.span.end),
          };
        } else {
          const property = this.expectMemberName();
          expression = {
            kind: "MemberExpression",
            object: expression,
            property: property.text,
            propertySpan: property.span,
            span: sourceSpan(expression.span.start, property.span.end),
          };
        }
        continue;
      }
      return expression;
    }
  }

  private parsePrimary(): Expression {
    const token = this.current();
    if (this.at("Identifier")) {
      this.advance();
      return {
        kind: "IdentifierExpression",
        name: token.text,
        nameSpan: token.span,
        span: token.span,
      };
    }
    if (this.at("String")) {
      this.advance();
      return {
        kind: "StringLiteralExpression",
        value: typeof token.value === "string" ? token.value : "",
        raw: token.text,
        span: token.span,
      };
    }
    if (this.at("Number")) {
      this.advance();
      return {
        kind: "NumberLiteralExpression",
        value: typeof token.value === "number" ? token.value : 0,
        raw: token.text,
        span: token.span,
      };
    }
    if (this.at("True") || this.at("False")) {
      this.advance();
      return { kind: "BooleanLiteralExpression", value: token.kind === "True", span: token.span };
    }
    if (this.at("Null")) {
      this.advance();
      return { kind: "NullLiteralExpression", span: token.span };
    }
    if (this.at("LeftParen")) {
      const open = this.advance();
      const expression = this.parseExpression();
      const close = this.expect("RightParen", "Expected ')' after the expression.");
      return {
        kind: "ParenthesizedExpression",
        expression,
        span: sourceSpan(open.span.start, close.span.end),
      };
    }

    this.report("PARSE_EXPECTED_EXPRESSION", "Expected an expression.", token.span);
    if (!this.isExpressionBoundary(token.kind)) this.advance();
    const point = token.span.start;
    const missing = sourceSpan(point, point);
    return { kind: "IdentifierExpression", name: "", nameSpan: missing, span: missing };
  }

  private isExpressionBoundary(kind: TokenKind): boolean {
    return (
      kind === "RightParen" ||
      kind === "RightBrace" ||
      kind === "Comma" ||
      kind === "Semicolon" ||
      kind === "EndOfFile"
    );
  }

  private current(): Token {
    return this.significant[Math.min(this.index, this.significant.length - 1)]!;
  }

  private at(kind: TokenKind): boolean {
    return this.current().kind === kind;
  }

  private advance(): Token {
    const current = this.current();
    if (current.kind !== "EndOfFile") this.index++;
    return current;
  }

  private consume(kind: TokenKind): Token {
    return this.at(kind) ? this.advance() : this.expect(kind, `Expected ${kind}.`);
  }

  private expect(kind: TokenKind, message: string): Token {
    if (this.at(kind)) return this.advance();
    const current = this.current();
    this.report("PARSE_EXPECTED_TOKEN", message, current.span);
    const point = clonePosition(current.span.start);
    return { kind, text: "", span: sourceSpan(point, point), synthetic: true };
  }

  private expectMemberName(): Token {
    if (memberNames.has(this.current().kind)) return this.advance();
    return this.expect("Identifier", "Expected a field or method name after '.'.");
  }

  private consumeOptionalSemicolon(): Token | undefined {
    return this.at("Semicolon") ? this.advance() : undefined;
  }

  private synchronize(kinds: readonly TokenKind[]): void {
    while (!kinds.includes(this.current().kind) && !this.at("EndOfFile")) this.advance();
  }

  private report(code: string, message: string, span: SourceSpan): void {
    this.diagnostics.push({ code, message, severity: "error", source: "parser", span });
  }
}

export function parse(source: string): ParseResult {
  const lexical = lex(source);
  const parsed = new Parser(lexical.tokens).parse();
  return {
    source,
    tokens: lexical.tokens,
    ast: parsed.ast,
    diagnostics: [...lexical.diagnostics, ...parsed.diagnostics],
  };
}

export const parsePolicy = parse;
