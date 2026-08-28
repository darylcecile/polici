import { compile } from "../language/checker.ts";
import { parse } from "../language/parser.ts";
import { typeToString } from "../language/types.ts";
import type {
  CallExpression,
  Expression,
  FunctionType,
  ProviderManifest,
  Statement,
} from "./types.ts";
import type { StaticPlugin } from "./metadata.ts";
import { findPluginFunction, pluginFunctionSignature } from "./plugin-features.ts";

export interface SignatureParameter {
  readonly label: string;
  readonly documentation?: string;
}

export interface SignatureInformation {
  readonly label: string;
  readonly documentation?: string;
  readonly parameters: readonly SignatureParameter[];
}

export interface SignatureHelpResult {
  readonly signatures: readonly SignatureInformation[];
  readonly activeSignature: number;
  readonly activeParameter: number;
}

function contains(expression: Expression, offset: number): boolean {
  return offset >= expression.span.start.offset && offset <= expression.span.end.offset;
}

function children(expression: Expression): readonly Expression[] {
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

function visitExpression(expression: Expression, visit: (item: Expression) => void): void {
  visit(expression);
  for (const child of children(expression)) visitExpression(child, visit);
}

function visitStatements(
  statements: readonly Statement[],
  visit: (item: Expression) => void,
): void {
  for (const statement of statements) {
    if (statement.kind === "RequireStatement") visitExpression(statement.expression, visit);
    else {
      visitExpression(statement.collection, visit);
      visitStatements(statement.statements, visit);
    }
  }
}

function callsAt(source: string, offset: number): CallExpression[] {
  const parsed = parse(source);
  const calls: CallExpression[] = [];
  const visit = (expression: Expression): void => {
    if (expression.kind === "CallExpression" && contains(expression, offset))
      calls.push(expression);
  };
  for (const policy of parsed.ast.policies) {
    for (const member of policy.members) {
      if (member.kind === "PolicyBinding") visitExpression(member.value, visit);
      else {
        if (member.condition !== undefined) visitExpression(member.condition, visit);
        visitStatements(member.statements, visit);
      }
    }
  }
  return calls.sort(
    (left, right) =>
      left.span.end.offset -
      left.span.start.offset -
      (right.span.end.offset - right.span.start.offset),
  );
}

function languageSignature(name: string, type: FunctionType): SignatureInformation {
  const parameters = type.parameters.map((parameter) => ({
    label: `${parameter.name}${parameter.optional ? "?" : ""}: ${typeToString(parameter.type)}`,
    ...(parameter.documentation === undefined ? {} : { documentation: parameter.documentation }),
  }));
  return {
    label: `${name}(${parameters.map((item) => item.label).join(", ")}): ${typeToString(type.returns)}`,
    parameters,
    ...(type.documentation === undefined ? {} : { documentation: type.documentation }),
  };
}

function activeParameter(source: string, call: CallExpression, offset: number): number | undefined {
  const parsed = parse(source);
  const opening = parsed.tokens.find(
    (token) =>
      token.kind === "LeftParen" &&
      token.span.start.offset >= call.callee.span.end.offset &&
      token.span.start.offset <= call.span.end.offset,
  );
  if (opening === undefined || offset <= opening.span.start.offset) return undefined;
  let depth = 0;
  let active = 0;
  for (const token of parsed.tokens) {
    if (token.span.start.offset < opening.span.start.offset) continue;
    if (token.span.start.offset >= offset) break;
    if (token.kind === "LeftParen") depth++;
    else if (token.kind === "RightParen") depth--;
    else if (token.kind === "Comma" && depth === 1) active++;
  }
  return active;
}

/** Computes signature help from normalized manifest ordering and the recovered call AST. */
export function getSignatureHelp(
  source: string,
  offset: number,
  languageManifests: readonly ProviderManifest[],
  plugins: readonly StaticPlugin[],
): SignatureHelpResult | undefined {
  for (const call of callsAt(source, offset)) {
    const active = activeParameter(source, call, offset);
    if (active === undefined) continue;
    const plugin = findPluginFunction(
      source,
      call.callee.span.start.offset,
      call.callee.span.end.offset,
      plugins,
    );
    // Recovered calls can contain a zero-width missing member at the cursor.
    const pluginBeforeParen =
      plugin ??
      findPluginFunction(
        source,
        call.callee.span.start.offset,
        source.indexOf("(", call.callee.span.start.offset),
        plugins,
      );
    let signature: SignatureInformation | undefined;
    const information = compile(source, languageManifests).analysis.expressions.find(
      (item) =>
        item.node.kind === call.callee.kind &&
        item.node.span.start.offset === call.callee.span.start.offset &&
        item.node.span.end.offset === call.callee.span.end.offset,
    );
    if (information?.type.kind === "function") {
      const name =
        call.callee.kind === "IdentifierExpression"
          ? call.callee.name
          : call.callee.kind === "MemberExpression"
            ? call.callee.property
            : "call";
      signature = languageSignature(name, information.type);
      if (pluginBeforeParen !== undefined) {
        const enriched = pluginFunctionSignature(pluginBeforeParen.item);
        if (enriched.parameters.length === signature.parameters.length) {
          const parameters = signature.parameters.map((parameter, index) => {
            const extra = enriched.parameters[index]!;
            const defaultValue = extra.label.includes(" = ")
              ? ` = ${extra.label.split(" = ").slice(1).join(" = ")}`
              : "";
            return {
              label: `${parameter.label}${defaultValue}`,
              documentation: parameter.documentation,
            };
          });
          const label = `${name}(${parameters.map((parameter) => parameter.label).join(", ")}): ${typeToString(information.type.returns)}`;
          signature = { label, parameters, documentation: signature.documentation };
        }
      }
    }
    if (signature === undefined) continue;
    return {
      signatures: [signature],
      activeSignature: 0,
      activeParameter: Math.min(active, Math.max(0, signature.parameters.length - 1)),
    };
  }
  return undefined;
}
