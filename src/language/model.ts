/** Zero-based UTF-16 source position. `offset` and `column` count code units. */
export interface SourcePosition {
  offset: number;
  line: number;
  column: number;
}

export interface SourceSpan {
  start: SourcePosition;
  end: SourcePosition;
}

export type TokenKind =
  | "Whitespace"
  | "LineComment"
  | "BlockComment"
  | "Identifier"
  | "String"
  | "Number"
  | "Using"
  | "As"
  | "Policy"
  | "Rule"
  | "When"
  | "Optional"
  | "Require"
  | "For"
  | "Each"
  | "In"
  | "Some"
  | "Every"
  | "No"
  | "Unique"
  | "Matches"
  | "Passed"
  | "And"
  | "Or"
  | "Not"
  | "True"
  | "False"
  | "Null"
  | "LeftBrace"
  | "RightBrace"
  | "LeftParen"
  | "RightParen"
  | "Dot"
  | "Comma"
  | "Semicolon"
  | "Equals"
  | "EqualsEquals"
  | "BangEquals"
  | "Unknown"
  | "EndOfFile";

export interface Token {
  kind: TokenKind;
  text: string;
  span: SourceSpan;
  /** Decoded value for JSON strings and numbers. */
  value?: string | number;
  /** Parser-created missing tokens are zero-width and are not part of lexer output. */
  synthetic?: boolean;
}

export type DiagnosticSeverity = "error" | "warning" | "information";
export type DiagnosticSource = "lexer" | "parser" | "binder" | "type";

export interface DiagnosticRelatedInformation {
  message: string;
  span: SourceSpan;
}

export interface Diagnostic {
  code: string;
  message: string;
  severity: DiagnosticSeverity;
  source: DiagnosticSource;
  span: SourceSpan;
  related?: readonly DiagnosticRelatedInformation[];
}

export interface LexResult {
  source: string;
  tokens: readonly Token[];
  diagnostics: readonly Diagnostic[];
}

export interface AstNode {
  kind: string;
  span: SourceSpan;
}

export interface Program extends AstNode {
  kind: "Program";
  usings: readonly UsingDeclaration[];
  policies: readonly PolicyDeclaration[];
}

export interface UsingDeclaration extends AstNode {
  kind: "UsingDeclaration";
  source: string;
  sourceSpan: SourceSpan;
  alias: string;
  aliasSpan: SourceSpan;
}

export interface PolicyDeclaration extends AstNode {
  kind: "PolicyDeclaration";
  name: string;
  nameSpan: SourceSpan;
  members: readonly PolicyMember[];
  bodySpan: SourceSpan;
}

export type PolicyMember = PolicyBinding | RuleDeclaration;

export interface PolicyBinding extends AstNode {
  kind: "PolicyBinding";
  name: string;
  nameSpan: SourceSpan;
  value: Expression;
}

export interface RuleDeclaration extends AstNode {
  kind: "RuleDeclaration";
  name: string;
  nameSpan: SourceSpan;
  condition?: Expression;
  optional: boolean;
  statements: readonly Statement[];
  bodySpan: SourceSpan;
}

export type Statement = RequireStatement | ForEachStatement;

export interface RequireStatement extends AstNode {
  kind: "RequireStatement";
  expression: Expression;
}

export interface ForEachStatement extends AstNode {
  kind: "ForEachStatement";
  variable: string;
  variableSpan: SourceSpan;
  collection: Expression;
  statements: readonly Statement[];
  bodySpan: SourceSpan;
}

export type Expression =
  | IdentifierExpression
  | StringLiteralExpression
  | NumberLiteralExpression
  | BooleanLiteralExpression
  | NullLiteralExpression
  | ParenthesizedExpression
  | CallExpression
  | MemberExpression
  | ProjectionExpression
  | UnaryExpression
  | LogicalExpression
  | EqualityExpression
  | MatchesExpression
  | PassedExpression
  | UniqueExpression
  | QuantifiedRelationExpression
  | FoldExpression;

export interface IdentifierExpression extends AstNode {
  kind: "IdentifierExpression";
  name: string;
  nameSpan: SourceSpan;
}

export interface StringLiteralExpression extends AstNode {
  kind: "StringLiteralExpression";
  value: string;
  raw: string;
}

export interface NumberLiteralExpression extends AstNode {
  kind: "NumberLiteralExpression";
  value: number;
  raw: string;
}

export interface BooleanLiteralExpression extends AstNode {
  kind: "BooleanLiteralExpression";
  value: boolean;
}

export interface NullLiteralExpression extends AstNode {
  kind: "NullLiteralExpression";
}

export interface ParenthesizedExpression extends AstNode {
  kind: "ParenthesizedExpression";
  expression: Expression;
}

export interface CallExpression extends AstNode {
  kind: "CallExpression";
  callee: Expression;
  arguments: readonly Expression[];
}

export interface MemberExpression extends AstNode {
  kind: "MemberExpression";
  object: Expression;
  property: string;
  propertySpan: SourceSpan;
}

export interface ProjectionExpression extends AstNode {
  kind: "ProjectionExpression";
  collection: Expression;
  expression: Expression;
  bodySpan: SourceSpan;
}

export interface UnaryExpression extends AstNode {
  kind: "UnaryExpression";
  operator: "not";
  operand: Expression;
}

export interface LogicalExpression extends AstNode {
  kind: "LogicalExpression";
  operator: "and" | "or";
  left: Expression;
  right: Expression;
}

export interface EqualityExpression extends AstNode {
  kind: "EqualityExpression";
  operator: "==" | "!=";
  left: Expression;
  right: Expression;
}

export interface MatchesExpression extends AstNode {
  kind: "MatchesExpression";
  value: Expression;
  pattern: Expression;
}

export interface PassedExpression extends AstNode {
  kind: "PassedExpression";
  check: Expression;
}

export interface UniqueExpression extends AstNode {
  kind: "UniqueExpression";
  value: Expression;
  collection: Expression;
}

export type Quantifier = "some" | "every" | "no";

export interface QuantifiedRelationExpression extends AstNode {
  kind: "QuantifiedRelationExpression";
  quantifier: Quantifier;
  left: Expression;
  right: Expression;
}

export interface FoldExpression extends AstNode {
  kind: "FoldExpression";
  quantifier: Quantifier;
  collection: Expression;
}

export interface ParseResult {
  source: string;
  tokens: readonly Token[];
  ast: Program;
  diagnostics: readonly Diagnostic[];
}

export type PrimitiveTypeName = "boolean" | "number" | "integer" | "string" | "glob";

export interface PrimitiveType {
  kind: "primitive";
  name: PrimitiveTypeName;
}

export interface NullType {
  kind: "null";
}

export interface DynamicJsonType {
  kind: "json";
}

export interface ParserType {
  kind: "parser";
  name: "json";
}

export interface ErrorType {
  kind: "error";
}

export interface UnknownType {
  kind: "unknown";
}

export interface CollectionType {
  kind: "collection";
  element: StaticType;
  /** Sets use entity identity or value equality and have no duplicates. */
  set: boolean;
}

export interface FunctionParameterType {
  name: string;
  type: StaticType;
  optional: boolean;
  documentation?: string;
}

export interface FunctionType {
  kind: "function";
  parameters: readonly FunctionParameterType[];
  returns: StaticType;
  documentation?: string;
}

export interface TypeMember {
  name: string;
  kind: "field" | "method" | "resource" | "function";
  type: StaticType;
  documentation?: string;
}

export interface NamedType {
  kind: "named";
  name: string;
  provider: string;
  /** Provider contract major. Core types use zero. */
  contractMajor: number;
  identity?: string;
  members: readonly TypeMember[];
  documentation?: string;
}

export interface NamespaceType {
  kind: "namespace";
  name: string;
  members: readonly TypeMember[];
  documentation?: string;
}

export type StaticType =
  | PrimitiveType
  | NullType
  | DynamicJsonType
  | ParserType
  | ErrorType
  | UnknownType
  | CollectionType
  | FunctionType
  | NamedType
  | NamespaceType;

export type ManifestTypeSpec =
  | string
  | { kind: "ref"; name: string; type?: never }
  | { kind: "collection"; element: ManifestTypeSpec; type?: never }
  | { kind: "set"; element: ManifestTypeSpec; type?: never }
  | { kind: "json"; type?: never };

export interface ManifestFieldDefinition {
  type: ManifestTypeSpec;
  documentation?: string;
}

export interface ManifestParameterDefinition {
  type: ManifestTypeSpec;
  optional?: boolean;
  default?: string | number | boolean | null;
  documentation?: string;
}

export interface ManifestNamedParameterDefinition extends ManifestParameterDefinition {
  name: string;
}

export interface ManifestFunctionDefinition {
  kind: "function";
  parameters?:
    | Readonly<Record<string, ManifestTypeSpec | ManifestParameterDefinition>>
    | readonly ManifestNamedParameterDefinition[];
  returns: ManifestTypeSpec;
  documentation?: string;
  resolve?: string;
}

export interface ManifestResourceDefinition {
  kind: "resource";
  type: ManifestTypeSpec;
  documentation?: string;
  resolve?: string;
}

export interface ManifestTypeDefinition {
  kind: "entity" | "value";
  identity?: string;
  fields?: Readonly<Record<string, ManifestTypeSpec | ManifestFieldDefinition>>;
  methods?: Readonly<
    Record<string, Omit<ManifestFunctionDefinition, "kind"> | ManifestFunctionDefinition>
  >;
  documentation?: string;
}

/** Static provider data. It must be safe to deserialize without loading provider code. */
export interface ProviderManifest {
  name: string;
  version: string;
  /** Language/plugin manifest ABI. Version 1 is supported by this subsystem. */
  policiApi: number;
  /** Provider contract major; defaults to `policiApi` when omitted. */
  apiVersion?: number;
  types?: Readonly<Record<string, ManifestTypeDefinition>>;
  exports?: Readonly<Record<string, ManifestResourceDefinition | ManifestFunctionDefinition>>;
  documentation?: string;
  permissions?: readonly string[];
}

export type SymbolKind =
  | "core"
  | "provider"
  | "resource"
  | "function"
  | "field"
  | "method"
  | "binding"
  | "local"
  | "projection"
  | "parser";

export interface StaticSymbol {
  id: string;
  name: string;
  kind: SymbolKind;
  type: StaticType;
  documentation?: string;
  declarationSpan?: SourceSpan;
}

export interface ExpressionTypeInfo {
  node: Expression;
  type: StaticType;
  symbol?: StaticSymbol;
}

export interface DeclarationInfo {
  name: string;
  span: SourceSpan;
  type: StaticType;
  symbol: StaticSymbol;
}

export interface IRNode {
  kind: string;
  span: SourceSpan;
}

export interface IRProgram extends IRNode {
  kind: "program";
  imports: readonly IRImport[];
  policies: readonly IRPolicy[];
}

export interface IRImport extends IRNode {
  kind: "import";
  source: string;
  alias: string;
  provider: string;
  apiVersion: number;
}

export interface IRPolicy extends IRNode {
  kind: "policy";
  name: string;
  bindings: readonly IRBinding[];
  rules: readonly IRRule[];
}

export interface IRBinding extends IRNode {
  kind: "binding";
  id: string;
  name: string;
  type: string;
  value: IRExpression;
}

export interface IRRule extends IRNode {
  kind: "rule";
  name: string;
  optional: boolean;
  condition?: IRExpression;
  statements: readonly IRStatement[];
}

export type IRStatement = IRRequire | IRForEach;

export interface IRRequire extends IRNode {
  kind: "require";
  expression: IRExpression;
}

export interface IRForEach extends IRNode {
  kind: "for-each";
  variableId: string;
  variable: string;
  elementType: string;
  collection: IRExpression;
  statements: readonly IRStatement[];
}

export interface IRExpressionBase extends IRNode {
  type: string;
}

export type IRExpression =
  | IRLiteral
  | IRReference
  | IRMember
  | IRCall
  | IRProjection
  | IRUnary
  | IRBinary
  | IRPassed
  | IRUnique
  | IRRelation
  | IRFold;

export interface IRLiteral extends IRExpressionBase {
  kind: "literal";
  value: string | number | boolean | null;
}

export interface IRReference extends IRExpressionBase {
  kind: "reference";
  id: string;
  name: string;
  scope: "core" | "provider" | "binding" | "local" | "projection";
}

export interface IRMember extends IRExpressionBase {
  kind: "member";
  object: IRExpression;
  property: string;
}

export interface IRCall extends IRExpressionBase {
  kind: "call";
  callee: IRExpression;
  arguments: readonly IRExpression[];
}

export interface IRProjection extends IRExpressionBase {
  kind: "projection";
  collection: IRExpression;
  itemId: string;
  expression: IRExpression;
}

export interface IRUnary extends IRExpressionBase {
  kind: "unary";
  operator: "not";
  operand: IRExpression;
}

export interface IRBinary extends IRExpressionBase {
  kind: "binary";
  operator: "and" | "or" | "==" | "!=" | "matches";
  left: IRExpression;
  right: IRExpression;
}

export interface IRPassed extends IRExpressionBase {
  kind: "passed";
  check: IRExpression;
}

export interface IRUnique extends IRExpressionBase {
  kind: "unique";
  value: IRExpression;
  collection: IRExpression;
}

export interface IRRelation extends IRExpressionBase {
  kind: "relation";
  quantifier: Quantifier;
  left: IRExpression;
  right: IRExpression;
}

export interface IRFold extends IRExpressionBase {
  kind: "fold";
  quantifier: Quantifier;
  collection: IRExpression;
}

export interface TypeCheckResult {
  diagnostics: readonly Diagnostic[];
  expressions: readonly ExpressionTypeInfo[];
  declarations: readonly DeclarationInfo[];
  ir: IRProgram;
}

export interface CompilationResult {
  source: string;
  tokens: readonly Token[];
  ast: Program;
  diagnostics: readonly Diagnostic[];
  analysis: TypeCheckResult;
  ir: IRProgram;
}

export type CompletionItemKind =
  | "keyword"
  | "variable"
  | "field"
  | "method"
  | "function"
  | "resource"
  | "module"
  | "value";

export interface CompletionItem {
  label: string;
  kind: CompletionItemKind;
  detail?: string;
  documentation?: string;
  insertText?: string;
}

export interface CompletionResult {
  items: readonly CompletionItem[];
  replaceSpan: SourceSpan;
}

export interface Hover {
  span: SourceSpan;
  contents: string;
}

export type SemanticTokenType =
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "operator"
  | "namespace"
  | "function"
  | "method"
  | "property"
  | "variable"
  | "parameter";

export interface SemanticToken {
  line: number;
  startCharacter: number;
  length: number;
  tokenType: SemanticTokenType;
  modifiers: readonly ("declaration" | "readonly")[];
}
