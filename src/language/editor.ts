import { compile } from "./checker.ts";
import { positionAt } from "./lexer.ts";
import type {
  CompilationResult,
  CompletionItem,
  CompletionItemKind,
  CompletionResult,
  DeclarationInfo,
  Expression,
  ExpressionTypeInfo,
  Hover,
  PolicyDeclaration,
  ProviderManifest,
  RuleDeclaration,
  SemanticToken,
  SemanticTokenType,
  SourceSpan,
  Statement,
  StaticSymbol,
  Token,
  TokenKind,
  TypeMember,
} from "./model.ts";
import { core, getTypeMembers, typeToString } from "./types.ts";

const keywordKinds = new Set<TokenKind>([
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

const operatorKinds = new Set<TokenKind>(["Equals", "EqualsEquals", "BangEquals"]);

function contains(span: SourceSpan, offset: number, includeEnd = false): boolean {
  return (
    offset >= span.start.offset &&
    (includeEnd
      ? offset <= span.end.offset
      : offset < span.end.offset ||
        (span.start.offset === span.end.offset && offset === span.start.offset))
  );
}

function spanSize(span: SourceSpan): number {
  return span.end.offset - span.start.offset;
}

function expressionInfo(
  compilation: CompilationResult,
  expression: Expression,
): ExpressionTypeInfo | undefined {
  for (const info of compilation.analysis.expressions) if (info.node === expression) return info;
  return undefined;
}

function expressionChildren(expression: Expression): readonly Expression[] {
  switch (expression.kind) {
    case "ParenthesizedExpression":
      return [expression.expression];
    case "CallExpression":
      return [expression.callee, ...expression.arguments];
    case "MemberExpression":
      return [expression.object];
    case "ProjectionExpression":
      return [expression.collection, expression.expression];
    case "UnaryExpression":
      return [expression.operand];
    case "LogicalExpression":
    case "EqualityExpression":
      return [expression.left, expression.right];
    case "MatchesExpression":
      return [expression.value, expression.pattern];
    case "PassedExpression":
      return [expression.check];
    case "UniqueExpression":
      return [expression.value, expression.collection];
    case "QuantifiedRelationExpression":
      return [expression.left, expression.right];
    case "FoldExpression":
      return [expression.collection];
    default:
      return [];
  }
}

function visitExpression(expression: Expression, visit: (node: Expression) => void): void {
  visit(expression);
  for (const child of expressionChildren(expression)) visitExpression(child, visit);
}

function visitStatements(
  statements: readonly Statement[],
  visit: (node: Expression) => void,
): void {
  for (const statement of statements) {
    if (statement.kind === "RequireStatement") visitExpression(statement.expression, visit);
    else {
      visitExpression(statement.collection, visit);
      visitStatements(statement.statements, visit);
    }
  }
}

function visitAllExpressions(
  compilation: CompilationResult,
  visit: (node: Expression) => void,
): void {
  for (const policy of compilation.ast.policies) {
    for (const member of policy.members) {
      if (member.kind === "PolicyBinding") visitExpression(member.value, visit);
      else {
        if (member.condition) visitExpression(member.condition, visit);
        visitStatements(member.statements, visit);
      }
    }
  }
}

function expressionAt(compilation: CompilationResult, offset: number): Expression | undefined {
  let found: Expression | undefined;
  visitAllExpressions(compilation, (node) => {
    if (
      contains(node.span, offset, true) &&
      (!found || spanSize(node.span) <= spanSize(found.span))
    )
      found = node;
  });
  return found;
}

function memberAt(
  compilation: CompilationResult,
  offset: number,
): Extract<Expression, { kind: "MemberExpression" }> | undefined {
  let found: Extract<Expression, { kind: "MemberExpression" }> | undefined;
  visitAllExpressions(compilation, (node) => {
    if (node.kind !== "MemberExpression") return;
    const incompleteAtCursor =
      node.property === "" &&
      node.object.span.end.offset <= offset &&
      /^\.\s*$/.test(compilation.source.slice(node.object.span.end.offset, offset));
    if (
      (contains(node.propertySpan, offset, true) || incompleteAtCursor) &&
      (!found || spanSize(node.span) <= spanSize(found.span))
    )
      found = node;
  });
  return found;
}

function currentWordSpan(source: string, offset: number): SourceSpan {
  let start = Math.max(0, Math.min(source.length, offset));
  let end = start;
  while (start > 0) {
    const code = source.charCodeAt(start - 1);
    if (
      !(
        code === 95 ||
        (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        code >= 128
      )
    )
      break;
    start--;
  }
  while (end < source.length) {
    const code = source.charCodeAt(end);
    if (
      !(
        code === 95 ||
        (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        code >= 128
      )
    )
      break;
    end++;
  }
  return { start: positionAt(source, start), end: positionAt(source, end) };
}

function completionKind(kind: StaticSymbol["kind"] | TypeMember["kind"]): CompletionItemKind {
  switch (kind) {
    case "provider":
      return "module";
    case "function":
    case "core":
      return "function";
    case "method":
      return "method";
    case "field":
    case "projection":
      return "field";
    case "resource":
    case "parser":
      return "resource";
    default:
      return "variable";
  }
}

function itemFromSymbol(symbol: StaticSymbol): CompletionItem {
  return {
    label: symbol.name,
    kind: completionKind(symbol.kind),
    detail: typeToString(symbol.type),
    ...(symbol.documentation === undefined ? {} : { documentation: symbol.documentation }),
    ...(symbol.type.kind === "function" ? { insertText: `${symbol.name}(` } : {}),
  };
}

function itemFromMember(member: TypeMember): CompletionItem {
  return {
    label: member.name,
    kind: completionKind(member.kind),
    detail: typeToString(member.type),
    ...(member.documentation === undefined ? {} : { documentation: member.documentation }),
    ...(member.type.kind === "function" ? { insertText: `${member.name}(` } : {}),
  };
}

function containingPolicy(
  compilation: CompilationResult,
  offset: number,
): PolicyDeclaration | undefined {
  return compilation.ast.policies.find((policy) => contains(policy.span, offset, true));
}

function collectActiveLocals(
  statements: readonly Statement[],
  offset: number,
  declarations: readonly DeclarationInfo[],
  output: StaticSymbol[],
): void {
  for (const statement of statements) {
    if (statement.kind !== "ForEachStatement" || !contains(statement.bodySpan, offset, true))
      continue;
    const declaration = declarations.find(
      (candidate) =>
        candidate.span === statement.variableSpan ||
        (candidate.span.start.offset === statement.variableSpan.start.offset &&
          candidate.span.end.offset === statement.variableSpan.end.offset),
    );
    if (declaration) output.push(declaration.symbol);
    collectActiveLocals(statement.statements, offset, declarations, output);
  }
}

function containingRule(policy: PolicyDeclaration, offset: number): RuleDeclaration | undefined {
  for (const member of policy.members)
    if (member.kind === "RuleDeclaration" && contains(member.span, offset, true)) return member;
  return undefined;
}

function symbolItemsAt(compilation: CompilationResult, offset: number): CompletionItem[] {
  const symbols: StaticSymbol[] = core.globals.map((member) => ({
    id: `core:${member.name}`,
    name: member.name,
    kind: member.name === "json" ? "parser" : member.kind,
    type: member.type,
    ...(member.documentation === undefined ? {} : { documentation: member.documentation }),
  }));
  for (const declaration of compilation.analysis.declarations) {
    if (declaration.symbol.kind === "provider") symbols.push(declaration.symbol);
  }
  const policy = containingPolicy(compilation, offset);
  if (policy) {
    for (const member of policy.members) {
      if (member.kind !== "PolicyBinding") continue;
      const declaration = compilation.analysis.declarations.find(
        (candidate) =>
          candidate.span.start.offset === member.nameSpan.start.offset &&
          candidate.span.end.offset === member.nameSpan.end.offset,
      );
      if (declaration) symbols.push(declaration.symbol);
    }
    const rule = containingRule(policy, offset);
    if (rule)
      collectActiveLocals(rule.statements, offset, compilation.analysis.declarations, symbols);
  }

  visitAllExpressions(compilation, (node) => {
    if (node.kind !== "ProjectionExpression" || !contains(node.bodySpan, offset, true)) return;
    const collectionInfo = expressionInfo(compilation, node.collection);
    if (collectionInfo === undefined) return;
    const elementType = collectionInfo.type;
    if (elementType.kind === "collection" && elementType.element.kind === "named") {
      for (const member of elementType.element.members) {
        symbols.push({
          id: `projection:${member.name}`,
          name: member.name,
          kind: "projection",
          type: member.type,
          ...(member.documentation === undefined ? {} : { documentation: member.documentation }),
        });
      }
    }
  });

  const byName = new Map<string, StaticSymbol>();
  for (const symbol of symbols) byName.set(symbol.name, symbol);
  return [...byName.values()].map(itemFromSymbol);
}

/** Computes completions from a recovered AST plus core and supplied static manifests. */
export function getCompletions(
  source: string,
  offset: number,
  manifests: readonly ProviderManifest[] = [],
): CompletionResult {
  const safeOffset = Math.max(0, Math.min(source.length, offset));
  const compilation = compile(source, manifests);
  const wordSpan = currentWordSpan(source, safeOffset);
  const member = memberAt(compilation, safeOffset);
  let items: CompletionItem[];
  if (member) {
    const objectType = expressionInfo(compilation, member.object)?.type;
    items = objectType ? getTypeMembers(objectType).map(itemFromMember) : [];
  } else {
    items = symbolItemsAt(compilation, safeOffset);
    items.push(
      ...[
        "using",
        "policy",
        "rule",
        "when",
        "optional",
        "require",
        "for each",
        "some",
        "every",
        "no",
        "not",
        "true",
        "false",
        "null",
      ].map((label): CompletionItem => ({ label, kind: "keyword" })),
    );
  }
  const prefix = source.slice(wordSpan.start.offset, safeOffset).toLowerCase();
  const unique = new Map<string, CompletionItem>();
  for (const item of items)
    if (!prefix || item.label.toLowerCase().startsWith(prefix))
      unique.set(`${item.kind}:${item.label}`, item);
  return {
    items: [...unique.values()].sort((left, right) => left.label.localeCompare(right.label)),
    replaceSpan: wordSpan,
  };
}

function symbolHover(symbol: StaticSymbol): string {
  const signature = `${symbol.name}: ${typeToString(symbol.type)}`;
  return symbol.documentation ? `${signature}\n\n${symbol.documentation}` : signature;
}

/** Returns static type/signature documentation at a UTF-16 source offset. */
export function getHover(
  source: string,
  offset: number,
  manifests: readonly ProviderManifest[] = [],
): Hover | undefined {
  const safeOffset = Math.max(0, Math.min(source.length, offset));
  const compilation = compile(source, manifests);
  const declaration = compilation.analysis.declarations
    .filter((candidate) => contains(candidate.span, safeOffset, true))
    .sort((left, right) => spanSize(left.span) - spanSize(right.span))[0];
  if (declaration) return { span: declaration.span, contents: symbolHover(declaration.symbol) };

  const member = memberAt(compilation, safeOffset);
  if (member) {
    const info = expressionInfo(compilation, member);
    if (info?.symbol) return { span: member.propertySpan, contents: symbolHover(info.symbol) };
    if (info)
      return {
        span: member.propertySpan,
        contents: `${member.property}: ${typeToString(info.type)}`,
      };
  }
  const expression = expressionAt(compilation, safeOffset);
  const info = expression === undefined ? undefined : expressionInfo(compilation, expression);
  if (!expression || !info) return undefined;
  return {
    span: expression.kind === "IdentifierExpression" ? expression.nameSpan : expression.span,
    contents: info.symbol ? symbolHover(info.symbol) : typeToString(info.type),
  };
}

function semanticTypeForSymbol(symbol: StaticSymbol): SemanticTokenType {
  switch (symbol.kind) {
    case "provider":
      return "namespace";
    case "function":
    case "core":
      return "function";
    case "method":
      return "method";
    case "field":
    case "projection":
    case "resource":
    case "parser":
      return "property";
    case "local":
      return "parameter";
    default:
      return "variable";
  }
}

function lexicalType(token: Token): SemanticTokenType | undefined {
  if (token.kind === "LineComment" || token.kind === "BlockComment") return "comment";
  if (token.kind === "String") return "string";
  if (token.kind === "Number") return "number";
  if (keywordKinds.has(token.kind)) return "keyword";
  if (operatorKinds.has(token.kind)) return "operator";
  return undefined;
}

function splitToken(
  source: string,
  span: SourceSpan,
  tokenType: SemanticTokenType,
  modifiers: SemanticToken["modifiers"],
): SemanticToken[] {
  const result: SemanticToken[] = [];
  let offset = span.start.offset;
  let line = span.start.line;
  let column = span.start.column;
  while (offset < span.end.offset) {
    const startOffset = offset;
    const startColumn = column;
    while (offset < span.end.offset) {
      const code = source.charCodeAt(offset);
      if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) break;
      offset++;
      column++;
    }
    if (offset > startOffset)
      result.push({
        line,
        startCharacter: startColumn,
        length: offset - startOffset,
        tokenType,
        modifiers,
      });
    if (offset < span.end.offset) {
      if (source.charCodeAt(offset) === 13 && source.charCodeAt(offset + 1) === 10) offset += 2;
      else offset++;
      line++;
      column = 0;
    }
  }
  return result;
}

/** Emits semantic tokens from lexer/AST classifications and resolved static symbols. */
export function getSemanticTokens(
  source: string,
  manifests: readonly ProviderManifest[] = [],
): readonly SemanticToken[] {
  const compilation = compile(source, manifests);
  const classifications = new Map<
    string,
    { span: SourceSpan; type: SemanticTokenType; modifiers: SemanticToken["modifiers"] }
  >();
  for (const token of compilation.tokens) {
    const type = lexicalType(token);
    if (type)
      classifications.set(`${token.span.start.offset}:${token.span.end.offset}`, {
        span: token.span,
        type,
        modifiers: [],
      });
  }
  for (const declaration of compilation.analysis.declarations) {
    classifications.set(`${declaration.span.start.offset}:${declaration.span.end.offset}`, {
      span: declaration.span,
      type: semanticTypeForSymbol(declaration.symbol),
      modifiers: ["declaration", "readonly"],
    });
  }
  visitAllExpressions(compilation, (expression) => {
    const info = expressionInfo(compilation, expression);
    if (!info?.symbol) return;
    const span =
      expression.kind === "IdentifierExpression"
        ? expression.nameSpan
        : expression.kind === "MemberExpression"
          ? expression.propertySpan
          : undefined;
    if (span && span.end.offset > span.start.offset)
      classifications.set(`${span.start.offset}:${span.end.offset}`, {
        span,
        type: semanticTypeForSymbol(info.symbol),
        modifiers: ["readonly"],
      });
  });
  const result: SemanticToken[] = [];
  for (const value of classifications.values())
    result.push(...splitToken(source, value.span, value.type, value.modifiers));
  return result.sort(
    (left, right) =>
      left.line - right.line ||
      left.startCharacter - right.startCharacter ||
      left.length - right.length,
  );
}

export const complete = getCompletions;
export const hover = getHover;
export const semanticTokens = getSemanticTokens;
