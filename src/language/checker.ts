import type {
  CompilationResult,
  DeclarationInfo,
  Diagnostic,
  Expression,
  ExpressionTypeInfo,
  IRBinding,
  IRExpression,
  IRForEach,
  IRImport,
  IRPolicy,
  IRProgram,
  IRRule,
  IRStatement,
  PolicyDeclaration,
  Program,
  ProviderManifest,
  SourceSpan,
  Statement,
  StaticSymbol,
  StaticType,
  TypeCheckResult,
  TypeMember,
  UsingDeclaration,
} from "./model.ts";
import { parse } from "./parser.ts";
import {
  areTypesComparable,
  BooleanType,
  collectionOf,
  core,
  errorType,
  getProviderApiVersion,
  getTypeMember,
  IntegerType,
  isTypeAssignable,
  iterableElement,
  JsonType,
  nullType,
  NumberType,
  resolveProviderManifest,
  StringType,
  typeToString,
  type ResolvedProvider,
} from "./types.ts";

interface CheckedExpression {
  type: StaticType;
  ir: IRExpression;
  symbol?: StaticSymbol;
}

class Scope {
  private readonly symbols = new Map<string, StaticSymbol>();
  readonly parent: Scope | undefined;
  private readonly dynamicProjectionId: string | undefined;

  constructor(parent?: Scope, dynamicProjectionId?: string) {
    this.parent = parent;
    this.dynamicProjectionId = dynamicProjectionId;
  }

  declare(symbol: StaticSymbol): StaticSymbol | undefined {
    const previous = this.symbols.get(symbol.name);
    if (!previous) this.symbols.set(symbol.name, symbol);
    return previous;
  }

  set(symbol: StaticSymbol): void {
    this.symbols.set(symbol.name, symbol);
  }

  lookup(name: string): StaticSymbol | undefined {
    const declared = this.symbols.get(name) ?? this.parent?.lookup(name);
    if (declared || !name || this.dynamicProjectionId === undefined) return declared;
    return { id: `${this.dynamicProjectionId}.${name}`, name, kind: "projection", type: JsonType };
  }

  local(name: string): StaticSymbol | undefined {
    return this.symbols.get(name);
  }
}

interface ProviderImport {
  declaration: UsingDeclaration;
  resolved: ResolvedProvider;
  requestedVersion: number;
}

function symbolForMember(owner: StaticSymbol | undefined, member: TypeMember): StaticSymbol {
  return {
    id: owner ? `${owner.id}.${member.name}` : `member:${member.name}`,
    name: member.name,
    kind: member.kind,
    type: member.type,
    ...(member.documentation === undefined ? {} : { documentation: member.documentation }),
  };
}

class Analyzer {
  private readonly ast: Program;
  private readonly diagnostics: Diagnostic[] = [];
  private readonly expressions: ExpressionTypeInfo[] = [];
  private readonly declarations: DeclarationInfo[] = [];
  private readonly global = new Scope();
  private readonly providersByName = new Map<string, ProviderManifest[]>();
  private readonly imports = new Map<string, ProviderImport>();
  private serial = 0;

  constructor(ast: Program, manifests: readonly ProviderManifest[]) {
    this.ast = ast;
    for (const item of core.globals) {
      this.global.declare({
        id: `core:${item.name}`,
        name: item.name,
        kind: item.name === "json" ? "parser" : item.kind,
        type: item.type,
        ...(item.documentation === undefined ? {} : { documentation: item.documentation }),
      });
    }
    for (const manifest of manifests) {
      const providers = this.providersByName.get(manifest.name);
      if (providers === undefined) this.providersByName.set(manifest.name, [manifest]);
      else providers.push(manifest);
    }
  }

  analyze(): TypeCheckResult {
    const imports = this.bindImports();
    const policyNames = new Map<string, SourceSpan>();
    for (const policy of this.ast.policies) {
      const previous = policyNames.get(policy.name);
      if (previous)
        this.reportDuplicate(
          "BIND_DUPLICATE_POLICY",
          `Duplicate policy '${policy.name}'.`,
          policy.nameSpan,
          previous,
        );
      else policyNames.set(policy.name, policy.nameSpan);
    }
    const policies = this.ast.policies.map((policy, index) => this.checkPolicy(policy, index));
    const ir: IRProgram = { kind: "program", span: this.ast.span, imports, policies };
    return {
      diagnostics: this.diagnostics,
      expressions: this.expressions,
      declarations: this.declarations,
      ir,
    };
  }

  private bindImports(): IRImport[] {
    const imports: IRImport[] = [];
    for (const declaration of this.ast.usings) {
      const parsed = /^([^@\s]+)@([1-9][0-9]*)$/.exec(declaration.source);
      if (!parsed) {
        this.report(
          "BIND_INVALID_PROVIDER_SOURCE",
          "Provider source must have the form 'name@major'.",
          declaration.sourceSpan,
          "binder",
        );
        continue;
      }
      const providerName = parsed[1]!;
      const requestedVersion = Number(parsed[2]);
      const candidates = this.providersByName.get(providerName);
      if (candidates === undefined) {
        this.report(
          "BIND_UNKNOWN_PROVIDER",
          `No static manifest was supplied for provider '${providerName}'.`,
          declaration.sourceSpan,
          "binder",
        );
        continue;
      }
      const matching = candidates.filter(
        (candidate) => getProviderApiVersion(candidate) === requestedVersion,
      );
      if (matching.length === 0) {
        const availableVersions = candidates
          .map((candidate) => getProviderApiVersion(candidate))
          .filter((version, index, versions) => versions.indexOf(version) === index)
          .sort((left, right) => left - right)
          .join(", ");
        this.report(
          "BIND_PROVIDER_VERSION_MISMATCH",
          `Provider '${providerName}' exposes API ${availableVersions}, not requested API ${requestedVersion}.`,
          declaration.sourceSpan,
          "binder",
        );
        continue;
      }
      if (matching.length > 1) {
        this.report(
          "BIND_DUPLICATE_MANIFEST",
          `Multiple static manifests were supplied for provider '${providerName}' API ${requestedVersion}.`,
          declaration.sourceSpan,
          "binder",
        );
      }
      const manifest = matching[0]!;
      if (manifest.policiApi !== 1) {
        this.report(
          "BIND_UNSUPPORTED_MANIFEST_API",
          `Provider '${providerName}' uses unsupported Polici manifest API ${manifest.policiApi}; expected 1.`,
          declaration.sourceSpan,
          "binder",
        );
        continue;
      }
      if (this.global.local(declaration.alias)) {
        const previous = this.global.local(declaration.alias)!;
        this.reportDuplicate(
          "BIND_DUPLICATE_ALIAS",
          `Duplicate provider alias '${declaration.alias}'.`,
          declaration.aliasSpan,
          previous.declarationSpan,
        );
        continue;
      }
      const resolved = resolveProviderManifest(manifest);
      for (const message of resolved.errors)
        this.report("BIND_INVALID_MANIFEST", message, declaration.sourceSpan, "binder");
      const symbol: StaticSymbol = {
        id: `provider:${declaration.alias}`,
        name: declaration.alias,
        kind: "provider",
        type: resolved.namespace,
        ...(resolved.namespace.documentation === undefined
          ? {}
          : { documentation: resolved.namespace.documentation }),
        declarationSpan: declaration.aliasSpan,
      };
      this.global.declare(symbol);
      this.declarations.push({
        name: declaration.alias,
        span: declaration.aliasSpan,
        type: symbol.type,
        symbol,
      });
      this.imports.set(declaration.alias, { declaration, resolved, requestedVersion });
      imports.push({
        kind: "import",
        span: declaration.span,
        source: declaration.source,
        alias: declaration.alias,
        provider: providerName,
        apiVersion: requestedVersion,
      });
    }
    return imports;
  }

  private checkPolicy(policy: PolicyDeclaration, policyIndex: number): IRPolicy {
    const policyScope = new Scope(this.global);
    const bindings: IRBinding[] = [];
    const rules: IRRule[] = [];
    const ruleNames = new Map<string, SourceSpan>();
    const policyId = `policy:${policyIndex}`;

    for (const member of policy.members) {
      if (member.kind !== "PolicyBinding") continue;
      const checked = this.checkExpression(member.value, policyScope);
      const symbol: StaticSymbol = {
        id: `${policyId}:binding:${member.name}`,
        name: member.name,
        kind: "binding",
        type: checked.type,
        declarationSpan: member.nameSpan,
      };
      const previous = policyScope.declare(symbol);
      if (previous)
        this.reportDuplicate(
          "BIND_DUPLICATE_BINDING",
          `Duplicate binding '${member.name}'.`,
          member.nameSpan,
          previous.declarationSpan,
        );
      else
        this.declarations.push({
          name: member.name,
          span: member.nameSpan,
          type: symbol.type,
          symbol,
        });
      bindings.push({
        kind: "binding",
        span: member.span,
        id: symbol.id,
        name: member.name,
        type: typeToString(checked.type),
        value: checked.ir,
      });
    }

    for (const member of policy.members) {
      if (member.kind !== "RuleDeclaration") continue;
      const previousRule = ruleNames.get(member.name);
      if (previousRule)
        this.reportDuplicate(
          "BIND_DUPLICATE_RULE",
          `Duplicate rule '${member.name}'.`,
          member.nameSpan,
          previousRule,
        );
      else ruleNames.set(member.name, member.nameSpan);
      let condition: IRExpression | undefined;
      if (member.condition) {
        const checked = this.checkExpression(member.condition, policyScope);
        this.expectType(checked.type, BooleanType, member.condition.span, "Rule 'when' condition");
        condition = checked.ir;
      }
      const statements = member.statements.map((statement) =>
        this.checkStatement(statement, new Scope(policyScope), policyId),
      );
      const rule: IRRule = {
        kind: "rule",
        span: member.span,
        name: member.name,
        optional: member.optional,
        statements,
      };
      if (condition !== undefined) rule.condition = condition;
      rules.push(rule);
    }

    return { kind: "policy", span: policy.span, name: policy.name, bindings, rules };
  }

  private checkStatement(statement: Statement, scope: Scope, prefix: string): IRStatement {
    if (statement.kind === "RequireStatement") {
      const checked = this.checkExpression(statement.expression, scope);
      this.expectType(checked.type, BooleanType, statement.expression.span, "Required expression");
      return { kind: "require", span: statement.span, expression: checked.ir };
    }

    const collection = this.checkExpression(statement.collection, scope);
    const element = iterableElement(collection.type);
    if (!element)
      this.report(
        "TYPE_NOT_ITERABLE",
        `Cannot iterate over ${typeToString(collection.type)}.`,
        statement.collection.span,
        "type",
      );
    const variableType = element ?? errorType;
    const variableId = `${prefix}:local:${statement.variable}:${this.serial++}`;
    const child = new Scope(scope);
    const symbol: StaticSymbol = {
      id: variableId,
      name: statement.variable,
      kind: "local",
      type: variableType,
      declarationSpan: statement.variableSpan,
    };
    const previous = child.declare(symbol);
    if (previous)
      this.reportDuplicate(
        "BIND_DUPLICATE_LOCAL",
        `Duplicate local '${statement.variable}'.`,
        statement.variableSpan,
        previous.declarationSpan,
      );
    this.declarations.push({
      name: statement.variable,
      span: statement.variableSpan,
      type: variableType,
      symbol,
    });
    const result: IRForEach = {
      kind: "for-each",
      span: statement.span,
      variableId,
      variable: statement.variable,
      elementType: typeToString(variableType),
      collection: collection.ir,
      statements: statement.statements.map((nested) => this.checkStatement(nested, child, prefix)),
    };
    return result;
  }

  private checkExpression(expression: Expression, scope: Scope): CheckedExpression {
    let result: CheckedExpression;
    switch (expression.kind) {
      case "StringLiteralExpression":
        result = {
          type: StringType,
          ir: { kind: "literal", span: expression.span, type: "string", value: expression.value },
        };
        break;
      case "NumberLiteralExpression": {
        const type = Number.isInteger(expression.value) ? IntegerType : NumberType;
        result = {
          type,
          ir: {
            kind: "literal",
            span: expression.span,
            type: typeToString(type),
            value: expression.value,
          },
        };
        break;
      }
      case "BooleanLiteralExpression":
        result = {
          type: BooleanType,
          ir: { kind: "literal", span: expression.span, type: "boolean", value: expression.value },
        };
        break;
      case "NullLiteralExpression":
        result = {
          type: nullType,
          ir: { kind: "literal", span: expression.span, type: "null", value: null },
        };
        break;
      case "IdentifierExpression":
        result = this.checkIdentifier(expression, scope);
        break;
      case "ParenthesizedExpression":
        result = this.checkExpression(expression.expression, scope);
        break;
      case "MemberExpression":
        result = this.checkMember(expression, scope);
        break;
      case "CallExpression":
        result = this.checkCall(expression, scope);
        break;
      case "ProjectionExpression":
        result = this.checkProjection(expression, scope);
        break;
      case "UnaryExpression": {
        const operand = this.checkExpression(expression.operand, scope);
        this.expectType(operand.type, BooleanType, expression.operand.span, "Operand of 'not'");
        result = {
          type: BooleanType,
          ir: {
            kind: "unary",
            span: expression.span,
            type: "boolean",
            operator: "not",
            operand: operand.ir,
          },
        };
        break;
      }
      case "LogicalExpression": {
        const left = this.checkExpression(expression.left, scope);
        const right = this.checkExpression(expression.right, scope);
        this.expectType(
          left.type,
          BooleanType,
          expression.left.span,
          `Left operand of '${expression.operator}'`,
        );
        this.expectType(
          right.type,
          BooleanType,
          expression.right.span,
          `Right operand of '${expression.operator}'`,
        );
        result = {
          type: BooleanType,
          ir: {
            kind: "binary",
            span: expression.span,
            type: "boolean",
            operator: expression.operator,
            left: left.ir,
            right: right.ir,
          },
        };
        break;
      }
      case "EqualityExpression": {
        const left = this.checkExpression(expression.left, scope);
        const right = this.checkExpression(expression.right, scope);
        if (!areTypesComparable(left.type, right.type))
          this.report(
            "TYPE_INCOMPARABLE",
            `Cannot compare ${typeToString(left.type)} with ${typeToString(right.type)}.`,
            expression.span,
            "type",
          );
        result = {
          type: BooleanType,
          ir: {
            kind: "binary",
            span: expression.span,
            type: "boolean",
            operator: expression.operator,
            left: left.ir,
            right: right.ir,
          },
        };
        break;
      }
      case "MatchesExpression": {
        const value = this.checkExpression(expression.value, scope);
        const pattern = this.checkExpression(expression.pattern, scope);
        this.expectType(value.type, StringType, expression.value.span, "Value before 'matches'");
        this.expectType(
          pattern.type,
          StringType,
          expression.pattern.span,
          "Pattern after 'matches'",
        );
        result = {
          type: BooleanType,
          ir: {
            kind: "binary",
            span: expression.span,
            type: "boolean",
            operator: "matches",
            left: value.ir,
            right: pattern.ir,
          },
        };
        break;
      }
      case "PassedExpression": {
        const check = this.checkExpression(expression.check, scope);
        this.expectType(check.type, core.types.Check, expression.check.span, "Operand of 'passed'");
        result = {
          type: BooleanType,
          ir: { kind: "passed", span: expression.span, type: "boolean", check: check.ir },
        };
        break;
      }
      case "UniqueExpression": {
        const value = this.checkExpression(expression.value, scope);
        const collection = this.checkExpression(expression.collection, scope);
        const element = iterableElement(collection.type);
        if (!element)
          this.report(
            "TYPE_NOT_ITERABLE",
            `Right operand of 'unique in' must be a collection, not ${typeToString(collection.type)}.`,
            expression.collection.span,
            "type",
          );
        else if (!areTypesComparable(value.type, element))
          this.report(
            "TYPE_INCOMPARABLE",
            `${typeToString(value.type)} cannot be searched in ${typeToString(collection.type)}.`,
            expression.span,
            "type",
          );
        result = {
          type: BooleanType,
          ir: {
            kind: "unique",
            span: expression.span,
            type: "boolean",
            value: value.ir,
            collection: collection.ir,
          },
        };
        break;
      }
      case "QuantifiedRelationExpression": {
        const left = this.checkExpression(expression.left, scope);
        const right = this.checkExpression(expression.right, scope);
        const leftElement = iterableElement(left.type);
        const rightElement = iterableElement(right.type);
        if (!leftElement)
          this.report(
            "TYPE_NOT_ITERABLE",
            `Left operand of '${expression.quantifier} ... in' must be a collection.`,
            expression.left.span,
            "type",
          );
        if (!rightElement)
          this.report(
            "TYPE_NOT_ITERABLE",
            `Right operand of '${expression.quantifier} ... in' must be a collection.`,
            expression.right.span,
            "type",
          );
        if (leftElement && rightElement && !areTypesComparable(leftElement, rightElement))
          this.report(
            "TYPE_INCOMPARABLE",
            `Collection elements ${typeToString(leftElement)} and ${typeToString(rightElement)} are not comparable.`,
            expression.span,
            "type",
          );
        result = {
          type: BooleanType,
          ir: {
            kind: "relation",
            span: expression.span,
            type: "boolean",
            quantifier: expression.quantifier,
            left: left.ir,
            right: right.ir,
          },
        };
        break;
      }
      case "FoldExpression": {
        const collection = this.checkExpression(expression.collection, scope);
        const element = iterableElement(collection.type);
        if (!element)
          this.report(
            "TYPE_NOT_ITERABLE",
            `Operand of '${expression.quantifier}' must be a collection.`,
            expression.collection.span,
            "type",
          );
        else
          this.expectType(
            element,
            BooleanType,
            expression.collection.span,
            `Elements folded by '${expression.quantifier}'`,
          );
        result = {
          type: BooleanType,
          ir: {
            kind: "fold",
            span: expression.span,
            type: "boolean",
            quantifier: expression.quantifier,
            collection: collection.ir,
          },
        };
        break;
      }
    }
    this.expressions.push({
      node: expression,
      type: result.type,
      ...(result.symbol === undefined ? {} : { symbol: result.symbol }),
    });
    return result;
  }

  private checkIdentifier(
    expression: Extract<Expression, { kind: "IdentifierExpression" }>,
    scope: Scope,
  ): CheckedExpression {
    const symbol = scope.lookup(expression.name);
    if (!symbol) {
      if (expression.name !== "")
        this.report(
          "BIND_UNKNOWN_NAME",
          `Unknown name '${expression.name}'.`,
          expression.nameSpan,
          "binder",
        );
      return {
        type: errorType,
        ir: {
          kind: "reference",
          span: expression.span,
          type: "<error>",
          id: `unknown:${expression.name}`,
          name: expression.name,
          scope: "local",
        },
      };
    }
    const referenceScope =
      symbol.kind === "provider"
        ? "provider"
        : symbol.kind === "binding"
          ? "binding"
          : symbol.kind === "projection"
            ? "projection"
            : symbol.kind === "local"
              ? "local"
              : "core";
    return {
      type: symbol.type,
      symbol,
      ir: {
        kind: "reference",
        span: expression.span,
        type: typeToString(symbol.type),
        id: symbol.id,
        name: symbol.name,
        scope: referenceScope,
      },
    };
  }

  private checkMember(
    expression: Extract<Expression, { kind: "MemberExpression" }>,
    scope: Scope,
  ): CheckedExpression {
    const object = this.checkExpression(expression.object, scope);
    if (object.type.kind === "json") {
      const symbol: StaticSymbol = {
        id: `json:${expression.property}`,
        name: expression.property,
        kind: "field",
        type: JsonType,
      };
      return {
        type: JsonType,
        symbol,
        ir: {
          kind: "member",
          span: expression.span,
          type: "Json",
          object: object.ir,
          property: expression.property,
        },
      };
    }
    const member = getTypeMember(object.type, expression.property);
    if (!member) {
      if (expression.property !== "")
        this.report(
          "TYPE_UNKNOWN_MEMBER",
          `Type ${typeToString(object.type)} has no member '${expression.property}'.`,
          expression.propertySpan,
          "type",
        );
      return {
        type: errorType,
        ir: {
          kind: "member",
          span: expression.span,
          type: "<error>",
          object: object.ir,
          property: expression.property,
        },
      };
    }
    const symbol = symbolForMember(object.symbol, member);
    return {
      type: member.type,
      symbol,
      ir: {
        kind: "member",
        span: expression.span,
        type: typeToString(member.type),
        object: object.ir,
        property: expression.property,
      },
    };
  }

  private checkCall(
    expression: Extract<Expression, { kind: "CallExpression" }>,
    scope: Scope,
  ): CheckedExpression {
    const callee = this.checkExpression(expression.callee, scope);
    const args = expression.arguments.map((argument) => this.checkExpression(argument, scope));
    if (callee.type.kind !== "function") {
      this.report(
        "TYPE_NOT_CALLABLE",
        `Type ${typeToString(callee.type)} is not callable.`,
        expression.callee.span,
        "type",
      );
      return {
        type: errorType,
        ir: {
          kind: "call",
          span: expression.span,
          type: "<error>",
          callee: callee.ir,
          arguments: args.map((argument) => argument.ir),
        },
      };
    }
    const required = callee.type.parameters.filter((parameter) => !parameter.optional).length;
    if (args.length < required || args.length > callee.type.parameters.length) {
      const range =
        required === callee.type.parameters.length
          ? `${required}`
          : `${required}-${callee.type.parameters.length}`;
      this.report(
        "TYPE_ARGUMENT_COUNT",
        `Expected ${range} argument${callee.type.parameters.length === 1 ? "" : "s"}, but received ${args.length}.`,
        expression.span,
        "type",
      );
    }
    for (let index = 0; index < Math.min(args.length, callee.type.parameters.length); index++) {
      const argument = args[index]!;
      const parameter = callee.type.parameters[index]!;
      this.expectType(
        argument.type,
        parameter.type,
        expression.arguments[index]!.span,
        `Argument '${parameter.name}'`,
      );
    }
    return {
      type: callee.type.returns,
      ...(callee.symbol === undefined ? {} : { symbol: callee.symbol }),
      ir: {
        kind: "call",
        span: expression.span,
        type: typeToString(callee.type.returns),
        callee: callee.ir,
        arguments: args.map((argument) => argument.ir),
      },
    };
  }

  private checkProjection(
    expression: Extract<Expression, { kind: "ProjectionExpression" }>,
    scope: Scope,
  ): CheckedExpression {
    const collection = this.checkExpression(expression.collection, scope);
    const element = iterableElement(collection.type);
    if (!element)
      this.report(
        "TYPE_NOT_ITERABLE",
        `Cannot project over ${typeToString(collection.type)}.`,
        expression.collection.span,
        "type",
      );
    const itemType = element ?? errorType;
    const itemId = `projection:${this.serial++}`;
    const child = new Scope(scope, itemType.kind === "json" ? itemId : undefined);
    if (itemType.kind === "named") {
      for (const member of itemType.members) {
        child.declare({
          id: `${itemId}.${member.name}`,
          name: member.name,
          kind: "projection",
          type: member.type,
          ...(member.documentation === undefined ? {} : { documentation: member.documentation }),
        });
      }
    }
    const body = this.checkExpression(expression.expression, child);
    const resultType = collectionOf(
      body.type,
      collection.type.kind === "collection" && collection.type.set,
    );
    return {
      type: resultType,
      ir: {
        kind: "projection",
        span: expression.span,
        type: typeToString(resultType),
        collection: collection.ir,
        itemId,
        expression: body.ir,
      },
    };
  }

  private expectType(
    actual: StaticType,
    expected: StaticType,
    span: SourceSpan,
    label: string,
  ): void {
    if (!isTypeAssignable(actual, expected))
      this.report(
        "TYPE_MISMATCH",
        `${label} must be ${typeToString(expected)}, not ${typeToString(actual)}.`,
        span,
        "type",
      );
  }

  private report(code: string, message: string, span: SourceSpan, source: "binder" | "type"): void {
    this.diagnostics.push({ code, message, severity: "error", source, span });
  }

  private reportDuplicate(
    code: string,
    message: string,
    span: SourceSpan,
    previous?: SourceSpan,
  ): void {
    this.diagnostics.push({
      code,
      message,
      severity: "error",
      source: "binder",
      span,
      ...(previous === undefined
        ? {}
        : { related: [{ message: "First declaration is here.", span: previous }] }),
    });
  }
}

export function typeCheck(
  ast: Program,
  manifests: readonly ProviderManifest[] = [],
): TypeCheckResult {
  return new Analyzer(ast, manifests).analyze();
}

export const bindAndTypeCheck = typeCheck;

export function compile(
  source: string,
  manifests: readonly ProviderManifest[] = [],
): CompilationResult {
  const parsed = parse(source);
  const analysis = typeCheck(parsed.ast, manifests);
  return {
    source,
    tokens: parsed.tokens,
    ast: parsed.ast,
    diagnostics: [...parsed.diagnostics, ...analysis.diagnostics],
    analysis,
    ir: analysis.ir,
  };
}
