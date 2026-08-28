import type {
  Diagnostic,
  LexResult,
  SourcePosition,
  SourceSpan,
  Token,
  TokenKind,
} from "./model.ts";

const keywords: Readonly<Record<string, TokenKind>> = {
  using: "Using",
  as: "As",
  policy: "Policy",
  rule: "Rule",
  when: "When",
  optional: "Optional",
  require: "Require",
  for: "For",
  each: "Each",
  in: "In",
  some: "Some",
  every: "Every",
  no: "No",
  unique: "Unique",
  matches: "Matches",
  passed: "Passed",
  and: "And",
  or: "Or",
  not: "Not",
  true: "True",
  false: "False",
  null: "Null",
};

function position(offset: number, line: number, column: number): SourcePosition {
  return { offset, line, column };
}

function span(start: SourcePosition, end: SourcePosition): SourceSpan {
  return { start, end };
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isIdentifierStart(code: number): boolean {
  return code === 95 || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code >= 128;
}

function isIdentifierPart(code: number): boolean {
  return isIdentifierStart(code) || isDigit(code);
}

export function positionAt(source: string, requestedOffset: number): SourcePosition {
  const target = Math.max(0, Math.min(source.length, requestedOffset));
  let offset = 0;
  let line = 0;
  let column = 0;
  while (offset < target) {
    const code = source.charCodeAt(offset);
    if (code === 13) {
      if (offset + 1 < target && source.charCodeAt(offset + 1) === 10) offset++;
      line++;
      column = 0;
    } else if (code === 10 || code === 0x2028 || code === 0x2029) {
      line++;
      column = 0;
    } else {
      column++;
    }
    offset++;
  }
  return position(target, line, column);
}

export function spanAt(source: string, startOffset: number, endOffset = startOffset): SourceSpan {
  return span(positionAt(source, startOffset), positionAt(source, endOffset));
}

class Scanner {
  private readonly source: string;
  private offset = 0;
  private line = 0;
  private column = 0;
  private readonly tokens: Token[] = [];
  private readonly diagnostics: Diagnostic[] = [];

  constructor(source: string) {
    this.source = source;
  }

  scan(): LexResult {
    while (this.offset < this.source.length) {
      const code = this.code();
      if (this.isWhitespace(code)) this.scanWhitespace();
      else if (code === 47 && this.code(1) === 47) this.scanLineComment();
      else if (code === 47 && this.code(1) === 42) this.scanBlockComment();
      else if (code === 34) this.scanString();
      else if (isDigit(code) || (code === 45 && isDigit(this.code(1)))) this.scanNumber();
      else if (isIdentifierStart(code)) this.scanIdentifier();
      else this.scanPunctuation();
    }

    const atEnd = this.currentPosition();
    this.tokens.push({ kind: "EndOfFile", text: "", span: span(atEnd, atEnd) });
    return { source: this.source, tokens: this.tokens, diagnostics: this.diagnostics };
  }

  private code(ahead = 0): number {
    return this.source.charCodeAt(this.offset + ahead);
  }

  private currentPosition(): SourcePosition {
    return position(this.offset, this.line, this.column);
  }

  private advance(): void {
    const code = this.code();
    if (code === 13) {
      this.offset++;
      if (this.code() === 10) this.offset++;
      this.line++;
      this.column = 0;
      return;
    }
    this.offset++;
    if (code === 10 || code === 0x2028 || code === 0x2029) {
      this.line++;
      this.column = 0;
    } else {
      this.column++;
    }
  }

  private emit(kind: TokenKind, start: SourcePosition, value?: string | number): void {
    const end = this.currentPosition();
    const token: Token = {
      kind,
      text: this.source.slice(start.offset, end.offset),
      span: span(start, end),
    };
    if (value !== undefined) token.value = value;
    this.tokens.push(token);
  }

  private report(
    code: string,
    message: string,
    start: SourcePosition,
    end = this.currentPosition(),
  ): void {
    this.diagnostics.push({
      code,
      message,
      severity: "error",
      source: "lexer",
      span: span(start, end),
    });
  }

  private isWhitespace(code: number): boolean {
    return (
      code === 9 ||
      code === 10 ||
      code === 11 ||
      code === 12 ||
      code === 13 ||
      code === 32 ||
      code === 0xa0 ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0xfeff
    );
  }

  private scanWhitespace(): void {
    const start = this.currentPosition();
    while (this.offset < this.source.length && this.isWhitespace(this.code())) this.advance();
    this.emit("Whitespace", start);
  }

  private scanLineComment(): void {
    const start = this.currentPosition();
    this.advance();
    this.advance();
    while (
      this.offset < this.source.length &&
      this.code() !== 10 &&
      this.code() !== 13 &&
      this.code() !== 0x2028 &&
      this.code() !== 0x2029
    )
      this.advance();
    this.emit("LineComment", start);
  }

  private scanBlockComment(): void {
    const start = this.currentPosition();
    this.advance();
    this.advance();
    while (this.offset < this.source.length && !(this.code() === 42 && this.code(1) === 47))
      this.advance();
    if (this.offset >= this.source.length) {
      this.report("LEX_UNTERMINATED_COMMENT", "Unterminated block comment.", start);
    } else {
      this.advance();
      this.advance();
    }
    this.emit("BlockComment", start);
  }

  private scanString(): void {
    const start = this.currentPosition();
    this.advance();
    let terminated = false;
    while (this.offset < this.source.length) {
      const code = this.code();
      if (code === 34) {
        this.advance();
        terminated = true;
        break;
      }
      if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) break;
      if (code === 92) {
        this.advance();
        if (this.offset < this.source.length) this.advance();
      } else {
        this.advance();
      }
    }

    const raw = this.source.slice(start.offset, this.offset);
    let value = raw.length >= 2 ? raw.slice(1, -1) : "";
    if (!terminated) {
      this.report("LEX_UNTERMINATED_STRING", "Unterminated JSON string literal.", start);
    } else {
      try {
        const decoded: unknown = JSON.parse(raw);
        if (typeof decoded === "string") value = decoded;
      } catch {
        this.report("LEX_INVALID_STRING", "Invalid escape sequence in JSON string literal.", start);
      }
    }
    this.emit("String", start, value);
  }

  private scanNumber(): void {
    const start = this.currentPosition();
    if (this.code() === 45) this.advance();

    if (this.code() === 48) {
      this.advance();
      if (isDigit(this.code())) {
        while (isDigit(this.code())) this.advance();
        this.report("LEX_INVALID_NUMBER", "JSON numbers cannot contain leading zeroes.", start);
      }
    } else {
      while (isDigit(this.code())) this.advance();
    }

    if (this.code() === 46) {
      this.advance();
      if (!isDigit(this.code()))
        this.report("LEX_INVALID_NUMBER", "Expected a digit after the decimal point.", start);
      while (isDigit(this.code())) this.advance();
    }

    if (this.code() === 69 || this.code() === 101) {
      this.advance();
      if (this.code() === 43 || this.code() === 45) this.advance();
      if (!isDigit(this.code()))
        this.report("LEX_INVALID_NUMBER", "Expected a digit in the number exponent.", start);
      while (isDigit(this.code())) this.advance();
    }

    const raw = this.source.slice(start.offset, this.offset);
    const value = Number(raw);
    if (!Number.isFinite(value)) this.report("LEX_INVALID_NUMBER", "Number must be finite.", start);
    else if (Number.isInteger(value) && !Number.isSafeInteger(value))
      this.report(
        "LEX_INTEGER_OUT_OF_RANGE",
        `Integer literal must be between ${Number.MIN_SAFE_INTEGER} and ${Number.MAX_SAFE_INTEGER}.`,
        start,
      );
    this.emit("Number", start, value);
  }

  private scanIdentifier(): void {
    const start = this.currentPosition();
    while (this.offset < this.source.length && isIdentifierPart(this.code())) this.advance();
    const text = this.source.slice(start.offset, this.offset);
    this.emit(keywords[text] ?? "Identifier", start);
  }

  private scanPunctuation(): void {
    const start = this.currentPosition();
    const code = this.code();
    this.advance();
    switch (code) {
      case 123:
        this.emit("LeftBrace", start);
        return;
      case 125:
        this.emit("RightBrace", start);
        return;
      case 40:
        this.emit("LeftParen", start);
        return;
      case 41:
        this.emit("RightParen", start);
        return;
      case 46:
        this.emit("Dot", start);
        return;
      case 44:
        this.emit("Comma", start);
        return;
      case 59:
        this.emit("Semicolon", start);
        return;
      case 61:
        if (this.code() === 61) {
          this.advance();
          this.emit("EqualsEquals", start);
        } else this.emit("Equals", start);
        return;
      case 33:
        if (this.code() === 61) {
          this.advance();
          this.emit("BangEquals", start);
          return;
        }
    }
    this.emit("Unknown", start);
    this.report(
      "LEX_UNKNOWN_CHARACTER",
      `Unexpected character ${JSON.stringify(this.source.slice(start.offset, this.offset))}.`,
      start,
    );
  }
}

/** Produces a lossless token stream: concatenating token text (except EOF) recreates `source`. */
export function lex(source: string): LexResult {
  return new Scanner(source).scan();
}

export const tokenize = lex;
