/**
 * A Java tokenizer, big enough for an FTC op-mode.
 *
 * ## Why we are writing one of these
 *
 * Because the useful thing to be able to paste into a driving simulator is the
 * AUTO you actually wrote, in the language you actually wrote it in. A
 * teammate's JVM simulator runs unmodified op-modes against the real SDK jars,
 * which is the right way to do it and needs a JVM. This page has no JVM and no
 * dependencies, so the alternative is to read the Java ourselves.
 *
 * That is less mad than it sounds. An FTC op-mode uses a small, very
 * recognisable slice of Java: a class, some fields, `hardwareMap.get`, a while
 * loop, some arithmetic and `telemetry.addData`. A tokenizer and a
 * recursive-descent parser for that slice is a few hundred lines, and the
 * result is that your own file runs rather than a rewrite of it.
 *
 * ## Scope
 *
 * Everything the lexer needs to be honest about: all Java literal forms
 * including underscores in numbers, hex and binary, the type suffixes, escape
 * sequences, both comment forms, annotations, and the operators. Text blocks
 * (`"""`) are the one thing left out, and they are called out rather than
 * mis-lexed.
 *
 * @module
 */

/** @typedef {{kind: string, value: string, line: number, column: number}} Token */

/** Reserved words. `var` is in here; so are the ones we reject later. */
export const KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char',
  'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
  'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements',
  'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new',
  'package', 'private', 'protected', 'public', 'return', 'short', 'static',
  'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws',
  'transient', 'try', 'void', 'volatile', 'while', 'record', 'sealed',
  'permits', 'yield', 'var',
]);

/** The primitive type names, which the emitter treats specially. */
export const PRIMITIVES = new Set([
  'boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double', 'void',
]);

/** Integral primitives: division truncates and `char` is a number. */
export const INTEGRAL = new Set(['byte', 'char', 'short', 'int', 'long']);

/**
 * Operators, longest first so that `>>>=` is not read as `>>` then `>=`.
 *
 * `>>` and `>>>` are deliberately *absent*: they collide with the closing
 * angle brackets of nested generics (`Map<String, List<Double>>`), and a
 * tokenizer cannot tell which it is looking at. The parser assembles shifts
 * from consecutive `>` tokens instead, where it knows whether it is in a type
 * or an expression.
 */
const OPERATORS = [
  '>>>=', '<<=', '>>=', '...', '->', '::',
  '++', '--', '&&', '||', '==', '!=', '<=', '>=',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<',
  '+', '-', '*', '/', '%', '=', '<', '>', '!', '~', '?', ':',
  '&', '|', '^', '(', ')', '{', '}', '[', ']', ';', ',', '.', '@',
];

export class JavaSyntaxError extends Error {
  /**
   * @param {string} message
   * @param {number} line
   * @param {number} [column]
   */
  constructor(message, line, column = 0) {
    super(`line ${line}: ${message}`);
    this.name = 'JavaSyntaxError';
    this.line = line;
    this.column = column;
    this.detail = message;
  }
}

/**
 * @param {string} source
 * @returns {Token[]} with a trailing `eof` token, so the parser never has to
 *   check for the end of the array
 */
export function tokenize(source) {
  /** @type {Token[]} */
  const out = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const n = source.length;
  const at = () => ({ line, column: i - lineStart + 1 });
  const push = (kind, value, start) => {
    out.push({ kind, value, line: start.line, column: start.column });
  };

  while (i < n) {
    const ch = source[i];

    // --- whitespace
    if (ch === '\n') {
      i++;
      line++;
      lineStart = i;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f') {
      i++;
      continue;
    }

    // --- comments
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const start = at();
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') {
          line++;
          lineStart = i + 1;
        }
        i++;
      }
      if (i >= n) throw new JavaSyntaxError('unterminated /* comment', start.line, start.column);
      i += 2;
      continue;
    }

    // --- strings
    if (ch === '"') {
      const start = at();
      if (source.startsWith('"""', i)) {
        throw new JavaSyntaxError(
          'text blocks (""") are not supported; use a normal string',
          start.line,
          start.column,
        );
      }
      const { text, next } = readString(source, i + 1, '"', start);
      push('string', text, start);
      i = next;
      continue;
    }

    // --- chars, which Java treats as numbers and so do we
    if (ch === "'") {
      const start = at();
      const { text, next } = readString(source, i + 1, "'", start);
      if ([...text].length !== 1) {
        throw new JavaSyntaxError(`a char literal holds one character, not ${[...text].length}`, start.line, start.column);
      }
      push('char', String(text.codePointAt(0)), start);
      i = next;
      continue;
    }

    // --- numbers
    if (isDigit(ch) || (ch === '.' && isDigit(source[i + 1]))) {
      const start = at();
      const { value, kind, next } = readNumber(source, i, start);
      push(kind, value, start);
      i = next;
      continue;
    }

    // --- identifiers and keywords
    if (isIdentStart(ch)) {
      const start = at();
      let j = i + 1;
      while (j < n && isIdentPart(source[j])) j++;
      const word = source.slice(i, j);
      push(KEYWORDS.has(word) ? 'keyword' : 'name', word, start);
      i = j;
      continue;
    }

    // --- operators
    const start = at();
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (!op) {
      throw new JavaSyntaxError(`unexpected character ${JSON.stringify(ch)}`, start.line, start.column);
    }
    push('op', op, start);
    i += op.length;
  }

  out.push({ kind: 'eof', value: '', line, column: i - lineStart + 1 });
  return out;
}

/**
 * Read a quoted literal, resolving escapes.
 * @param {string} source
 * @param {number} from index just past the opening quote
 * @param {string} quote
 * @param {{line: number, column: number}} start
 */
function readString(source, from, quote, start) {
  let text = '';
  let i = from;
  while (i < source.length) {
    const ch = source[i];
    if (ch === quote) return { text, next: i + 1 };
    if (ch === '\n') break;
    if (ch !== '\\') {
      text += ch;
      i++;
      continue;
    }
    const escape = source[i + 1];
    i += 2;
    switch (escape) {
      case 'n': text += '\n'; break;
      case 't': text += '\t'; break;
      case 'r': text += '\r'; break;
      case 'b': text += '\b'; break;
      case 'f': text += '\f'; break;
      case 's': text += ' '; break;
      case '0': text += '\0'; break;
      case '\\': text += '\\'; break;
      case "'": text += "'"; break;
      case '"': text += '"'; break;
      case 'u': {
        // \\uXXXX, and Java allows a run of u's.
        while (source[i] === 'u') i++;
        const hex = source.slice(i, i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new JavaSyntaxError('bad \\u escape', start.line, start.column);
        }
        text += String.fromCharCode(parseInt(hex, 16));
        i += 4;
        break;
      }
      default:
        throw new JavaSyntaxError(`unknown escape \\${escape}`, start.line, start.column);
    }
  }
  throw new JavaSyntaxError('unterminated literal', start.line, start.column);
}

/**
 * Read a numeric literal.
 *
 * All the forms, because a constant in somebody's op-mode is quite likely to be
 * `537.7`, `0x3FF`, `1_000` or `20L`, and mis-reading one of those silently is
 * worse than not reading it at all. The token's value is normalised JavaScript:
 * the suffix and the underscores are gone, and `kind` says whether it was an
 * integer so the emitter knows where truncating division applies.
 */
function readNumber(source, from, start) {
  let i = from;
  const n = source.length;
  const eat = (test) => {
    while (i < n && (test(source[i]) || source[i] === '_')) i++;
  };

  if (source[i] === '0' && (source[i + 1] === 'x' || source[i + 1] === 'X')) {
    i += 2;
    const digitsFrom = i;
    eat(isHexDigit);
    const digits = source.slice(digitsFrom, i).replace(/_/g, '');
    if (!digits) throw new JavaSyntaxError('0x with no digits', start.line, start.column);
    const suffix = eatSuffix();
    return { value: `0x${digits}`, kind: suffix === 'long' ? 'long' : 'int', next: i };
  }
  if (source[i] === '0' && (source[i + 1] === 'b' || source[i + 1] === 'B')) {
    i += 2;
    const digitsFrom = i;
    eat((c) => c === '0' || c === '1');
    const digits = source.slice(digitsFrom, i).replace(/_/g, '');
    if (!digits) throw new JavaSyntaxError('0b with no digits', start.line, start.column);
    eatSuffix();
    return { value: `0b${digits}`, kind: 'int', next: i };
  }

  eat(isDigit);
  let float = false;
  if (source[i] === '.' && isDigit(source[i + 1])) {
    float = true;
    i++;
    eat(isDigit);
  } else if (source[i] === '.' && !isIdentStart(source[i + 1] ?? '')) {
    // `1.` is a valid double in Java.
    float = true;
    i++;
  }
  if (source[i] === 'e' || source[i] === 'E') {
    float = true;
    i++;
    if (source[i] === '+' || source[i] === '-') i++;
    eat(isDigit);
  }
  const suffix = eatSuffix();
  if (suffix === 'float' || suffix === 'double') float = true;

  const text = source.slice(from, i).replace(/_/g, '').replace(/[lLfFdD]$/, '');
  // A leading zero on an integer is octal in Java and a syntax error in strict
  // JavaScript, so it is converted rather than passed through.
  let value = text;
  if (!float && /^0[0-7]+$/.test(text)) value = String(parseInt(text, 8));
  return { value, kind: float ? 'double' : suffix === 'long' ? 'long' : 'int', next: i };

  function eatSuffix() {
    const ch = source[i];
    if (ch === 'l' || ch === 'L') {
      i++;
      return 'long';
    }
    if (ch === 'f' || ch === 'F') {
      i++;
      return 'float';
    }
    if (ch === 'd' || ch === 'D') {
      i++;
      return 'double';
    }
    return null;
  }
}

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

function isHexDigit(ch) {
  return isDigit(ch) || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

function isIdentStart(ch) {
  return /[A-Za-z_$]/.test(ch ?? '');
}

function isIdentPart(ch) {
  return /[A-Za-z0-9_$]/.test(ch ?? '');
}
