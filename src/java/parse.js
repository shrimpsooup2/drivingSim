/**
 * A recursive-descent parser for the Java an FTC op-mode is written in.
 *
 * ## What it covers
 *
 * Classes and enums, fields, methods and constructors; every statement form
 * except `assert` (stripped) and labelled `continue` into a nested loop; the
 * full expression grammar with Java's precedence, including casts, `instanceof`
 * with a pattern variable, array creation and initialisers, lambdas and
 * `Foo.class`. Generic type arguments are parsed and then thrown away, which is
 * what the JVM does to them too.
 *
 * ## The two places Java's grammar fights back
 *
 * **`<` is ambiguous.** `a < b` is a comparison and `List<Double> a` is a
 * declaration, and you cannot tell which without arbitrary lookahead. So the
 * statement parser *speculates*: it tries to read a local variable declaration
 * and, if that fails anywhere, rewinds the token cursor and reads an expression
 * instead. Cheap, and it never has to guess.
 *
 * **`>>` is ambiguous.** `List<List<Double>>` ends in two closing brackets and
 * `x >> 2` is a shift. The tokenizer refuses to decide and emits two `>`
 * tokens; the shift level of the expression parser glues adjacent ones back
 * together, where it knows it is in an expression. That is why tokens carry a
 * column.
 *
 * Anything outside the subset raises a `JavaSyntaxError` naming the construct
 * and the line, because a compiler that silently mistranslates is worse than
 * one that says no.
 *
 * @module
 */
import { JavaSyntaxError, PRIMITIVES, tokenize } from './tokenize.js';

const MODIFIERS = new Set([
  'public', 'protected', 'private', 'static', 'final', 'abstract',
  'synchronized', 'native', 'transient', 'volatile', 'strictfp', 'default',
  'sealed', 'non-sealed',
]);

const ASSIGN_OPS = new Set([
  '=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=',
]);

/**
 * @param {string} source
 * @returns {{package: string|null, imports: string[], types: any[]}}
 */
export function parseJava(source) {
  return new Parser(tokenize(source)).parseFile();
}

class Parser {
  /** @param {import('./tokenize.js').Token[]} tokens */
  constructor(tokens) {
    this.tokens = tokens;
    this.i = 0;
  }

  // ------------------------------------------------------------- the cursor

  peek(offset = 0) {
    return this.tokens[Math.min(this.i + offset, this.tokens.length - 1)];
  }

  get line() {
    return this.peek().line;
  }

  is(kind, value) {
    const t = this.peek();
    return t.kind === kind && (value === undefined || t.value === value);
  }

  isOp(...values) {
    const t = this.peek();
    return t.kind === 'op' && values.includes(t.value);
  }

  isKeyword(...values) {
    const t = this.peek();
    return t.kind === 'keyword' && values.includes(t.value);
  }

  next() {
    return this.tokens[this.i++];
  }

  eatOp(value) {
    if (!this.isOp(value)) return false;
    this.i++;
    return true;
  }

  eatKeyword(value) {
    if (!this.isKeyword(value)) return false;
    this.i++;
    return true;
  }

  expectOp(value) {
    if (!this.eatOp(value)) this.fail(`expected '${value}'`);
    return true;
  }

  expectName() {
    const t = this.peek();
    // A handful of keywords are legal identifiers in the places we accept them
    // (`yield` most of all, which is a method name in the SDK's world and a
    // contextual keyword in Java's).
    if (t.kind === 'name' || (t.kind === 'keyword' && (t.value === 'yield' || t.value === 'record' || t.value === 'permits' || t.value === 'sealed'))) {
      this.i++;
      return t.value;
    }
    this.fail('expected a name');
    return '';
  }

  fail(message) {
    const t = this.peek();
    const found = t.kind === 'eof' ? 'end of file' : `'${t.value}'`;
    throw new JavaSyntaxError(`${message}, found ${found}`, t.line, t.column);
  }

  /**
   * A construct this compiler does not handle.
   *
   * Marked `fatal`, which `speculate` respects. Without that, hitting an
   * anonymous inner class inside a local variable declaration would make the
   * speculative declaration parse fail, the cursor rewind, and the whole thing
   * be re-read as an expression -- reporting "expected ';'" for code whose real
   * problem is a construct we do not support. Naming the construct is the whole
   * value of refusing it.
   */
  unsupported(what) {
    const t = this.peek();
    const error = new JavaSyntaxError(`${what} is not supported`, t.line, t.column);
    error.fatal = true;
    throw error;
  }

  /**
   * Run `fn`, rewinding the cursor and returning null if it throws.
   *
   * A `fatal` error is not a failed guess, so it goes straight up.
   */
  speculate(fn) {
    const mark = this.i;
    try {
      return fn();
    } catch (err) {
      if (!(err instanceof JavaSyntaxError) || err.fatal) throw err;
      this.i = mark;
      return null;
    }
  }

  // --------------------------------------------------------------- the file

  parseFile() {
    /** @type {string|null} */
    let pkg = null;
    /** @type {string[]} */
    const imports = [];
    const types = [];

    // Annotations may precede a `package` declaration -- and may equally be the
    // `@Autonomous` on the class, in a file with no package line. Speculating
    // keeps the class's annotations out of the bin, which is where an
    // unconditional `parseAnnotations()` here put them.
    this.speculate(() => {
      this.parseAnnotations();
      if (!this.isKeyword('package')) throw new JavaSyntaxError('not a package', this.line);
      return true;
    });
    if (this.eatKeyword('package')) {
      pkg = this.parseQualifiedName();
      this.expectOp(';');
    }
    while (this.isKeyword('import')) {
      this.next();
      this.eatKeyword('static');
      imports.push(this.parseQualifiedName(true));
      this.expectOp(';');
    }
    while (!this.is('eof')) {
      if (this.eatOp(';')) continue;
      types.push(this.parseTypeDeclaration());
    }
    return { package: pkg, imports, types };
  }

  parseQualifiedName(allowStar = false) {
    let name = this.expectName();
    while (this.isOp('.')) {
      this.next();
      if (allowStar && this.eatOp('*')) return `${name}.*`;
      name += `.${this.expectName()}`;
    }
    return name;
  }

  parseAnnotations() {
    const out = [];
    while (this.isOp('@')) {
      this.next();
      const name = this.parseQualifiedName();
      /** @type {Record<string, any>} */
      const values = {};
      if (this.isOp('(')) {
        this.next();
        if (!this.isOp(')')) {
          do {
            // `@Autonomous(name = "X", group = "Y")` or `@Disabled` or a single
            // unnamed value.
            if (this.is('name') && this.peek(1).kind === 'op' && this.peek(1).value === '=') {
              const key = this.expectName();
              this.next();
              values[key] = this.parseExpression();
            } else {
              values.value = this.parseExpression();
            }
          } while (this.eatOp(','));
        }
        this.expectOp(')');
      }
      out.push({ name, values });
    }
    return out;
  }

  parseModifiers() {
    const out = new Set();
    for (;;) {
      this.parseAnnotations().forEach(() => {});
      const t = this.peek();
      if (t.kind === 'keyword' && MODIFIERS.has(t.value)) {
        out.add(t.value);
        this.i++;
        continue;
      }
      break;
    }
    return out;
  }

  parseTypeDeclaration() {
    const annotations = this.parseAnnotations();
    const modifiers = this.parseModifiers();
    if (this.isKeyword('interface') || this.isKeyword('record')) {
      this.unsupported(`a ${this.peek().value} declaration`);
    }
    if (this.eatKeyword('enum')) return this.parseEnum(annotations, modifiers);
    if (!this.eatKeyword('class')) this.fail('expected a class declaration');
    return this.parseClassBody(annotations, modifiers);
  }

  parseClassBody(annotations, modifiers) {
    const name = this.expectName();
    this.skipTypeParameters();
    let superName = null;
    /** @type {string[]} */
    const interfaces = [];
    if (this.eatKeyword('extends')) superName = this.parseType().name;
    if (this.eatKeyword('implements')) {
      do {
        interfaces.push(this.parseType().name);
      } while (this.eatOp(','));
    }
    this.expectOp('{');
    const members = [];
    while (!this.isOp('}')) {
      if (this.is('eof')) this.fail('unterminated class body');
      if (this.eatOp(';')) continue;
      members.push(...this.parseMember(name));
    }
    this.expectOp('}');
    return { kind: 'Class', name, superName, interfaces, members, annotations, modifiers };
  }

  parseEnum(annotations, modifiers) {
    const name = this.expectName();
    if (this.isKeyword('implements')) {
      this.next();
      do {
        this.parseType();
      } while (this.eatOp(','));
    }
    this.expectOp('{');
    const constants = [];
    while (!this.isOp(';') && !this.isOp('}')) {
      this.parseAnnotations();
      const constant = this.expectName();
      /** @type {any[]} */
      let args = [];
      if (this.isOp('(')) args = this.parseArguments();
      if (this.isOp('{')) this.unsupported('a constant body in an enum');
      constants.push({ name: constant, args });
      if (!this.eatOp(',')) break;
    }
    const members = [];
    if (this.eatOp(';')) {
      while (!this.isOp('}')) {
        if (this.eatOp(';')) continue;
        members.push(...this.parseMember(name));
      }
    }
    this.expectOp('}');
    return { kind: 'Enum', name, constants, members, annotations, modifiers };
  }

  /**
   * One member, which may declare several fields at once.
   * @param {string} className
   */
  parseMember(className) {
    const annotations = this.parseAnnotations();
    const modifiers = this.parseModifiers();

    if (this.isKeyword('class') || this.isKeyword('enum') || this.isKeyword('interface')) {
      // A nested type. Parsed and hoisted: Java scopes it inside the class and
      // we flatten it, which is fine as long as nobody relies on the nesting.
      this.i--;
      // Rewind is not possible for the consumed keyword list, so re-dispatch.
      this.i++;
      if (this.eatKeyword('enum')) {
        return [{ ...this.parseEnum(annotations, modifiers), nested: true }];
      }
      if (this.eatKeyword('class')) {
        return [{ ...this.parseClassBody(annotations, modifiers), nested: true }];
      }
      this.unsupported('a nested interface');
    }

    // An initialiser block: `static { ... }` or `{ ... }`.
    if (this.isOp('{')) {
      return [{ kind: 'Initialiser', static: modifiers.has('static'), body: this.parseBlock() }];
    }

    this.skipTypeParameters();

    // A constructor has no return type and its name is the class's.
    if (this.is('name', className) && this.peek(1).kind === 'op' && this.peek(1).value === '(') {
      const ctorName = this.expectName();
      const params = this.parseParameters();
      this.skipThrows();
      const body = this.parseBlock();
      return [{ kind: 'Constructor', name: ctorName, params, body, annotations, modifiers }];
    }

    const type = this.parseType();
    const name = this.expectName();

    if (this.isOp('(')) {
      const params = this.parseParameters();
      // `int[] f()[]` is legal and nobody writes it; the extra dims go here.
      while (this.isOp('[')) {
        this.next();
        this.expectOp(']');
      }
      this.skipThrows();
      if (this.eatOp(';')) {
        return [{ kind: 'Method', name, params, body: null, type, annotations, modifiers }];
      }
      const body = this.parseBlock();
      return [{ kind: 'Method', name, params, body, type, annotations, modifiers }];
    }

    // Fields, one or more.
    const fields = [];
    let first = name;
    for (;;) {
      let dims = 0;
      while (this.isOp('[')) {
        this.next();
        this.expectOp(']');
        dims++;
      }
      let init = null;
      if (this.eatOp('=')) init = this.parseVariableInitialiser();
      fields.push({
        kind: 'Field',
        name: first,
        type: { ...type, dims: type.dims + dims },
        init,
        annotations,
        modifiers,
      });
      if (!this.eatOp(',')) break;
      first = this.expectName();
    }
    this.expectOp(';');
    return fields;
  }

  parseParameters() {
    this.expectOp('(');
    const params = [];
    if (!this.isOp(')')) {
      do {
        this.parseAnnotations();
        this.eatKeyword('final');
        const type = this.parseType();
        let variadic = false;
        if (this.eatOp('...')) variadic = true;
        const name = this.expectName();
        let dims = 0;
        while (this.isOp('[')) {
          this.next();
          this.expectOp(']');
          dims++;
        }
        params.push({ name, type: { ...type, dims: type.dims + dims }, variadic });
      } while (this.eatOp(','));
    }
    this.expectOp(')');
    return params;
  }

  skipThrows() {
    if (!this.eatKeyword('throws')) return;
    do {
      this.parseType();
    } while (this.eatOp(','));
  }

  /** `<T extends Foo>` on a class or method. Recorded nowhere; erased. */
  skipTypeParameters() {
    if (!this.isOp('<')) return;
    let depth = 0;
    do {
      if (this.isOp('<')) depth++;
      else if (this.isOp('>')) depth--;
      else if (this.is('eof')) this.fail('unterminated type parameters');
      this.i++;
    } while (depth > 0);
  }

  // --------------------------------------------------------------- types

  /**
   * A type: a name (possibly qualified), optional type arguments, optional
   * array dimensions. Type arguments are consumed and dropped.
   */
  parseType() {
    const t = this.peek();
    let name;
    if (t.kind === 'keyword' && PRIMITIVES.has(t.value)) {
      this.i++;
      name = t.value;
    } else if (this.isOp('?')) {
      this.i++;
      if (this.eatKeyword('extends') || this.eatKeyword('super')) this.parseType();
      return { name: 'Object', dims: 0 };
    } else {
      name = this.expectName();
      this.parseTypeArguments();
      while (this.isOp('.')) {
        // `Map.Entry`, `DcMotor.RunMode`, `a.b.C`.
        this.i++;
        name += `.${this.expectName()}`;
        this.parseTypeArguments();
      }
    }
    let dims = 0;
    while (this.isOp('[') && this.peek(1).kind === 'op' && this.peek(1).value === ']') {
      this.i += 2;
      dims++;
    }
    return { name, dims };
  }

  /**
   * `<A, B<C>>` if it is there.
   *
   * Speculative, because `a < b` looks identical at this point. If the contents
   * are not a comma-separated list of types closed by `>`, the cursor rewinds
   * and the caller carries on as if there were no type arguments at all.
   */
  parseTypeArguments() {
    if (!this.isOp('<')) return;
    const mark = this.i;
    this.i++;
    if (this.eatOp('>')) return; // the diamond
    try {
      do {
        this.parseType();
      } while (this.eatOp(','));
      if (!this.eatOp('>')) throw new JavaSyntaxError('not type arguments', this.line);
    } catch (err) {
      if (!(err instanceof JavaSyntaxError)) throw err;
      this.i = mark;
    }
  }

  // ---------------------------------------------------------- statements

  parseBlock() {
    const line = this.line;
    this.expectOp('{');
    const body = [];
    while (!this.isOp('}')) {
      if (this.is('eof')) this.fail('unterminated block');
      body.push(this.parseStatement());
    }
    this.expectOp('}');
    return { kind: 'Block', body, line };
  }

  parseStatement() {
    const line = this.line;

    if (this.isOp('{')) return this.parseBlock();
    if (this.eatOp(';')) return { kind: 'Empty', line };

    if (this.isKeyword('if')) return this.parseIf();
    if (this.isKeyword('while')) return this.parseWhile();
    if (this.isKeyword('do')) return this.parseDoWhile();
    if (this.isKeyword('for')) return this.parseFor();
    if (this.isKeyword('switch')) return this.parseSwitch();
    if (this.isKeyword('try')) return this.parseTry();
    if (this.isKeyword('synchronized')) {
      this.next();
      this.expectOp('(');
      this.parseExpression();
      this.expectOp(')');
      // There is one thread here, so the lock is a no-op and the body stands.
      return this.parseBlock();
    }
    if (this.isKeyword('assert')) {
      // Assertions are off by default on a Control Hub, so they are dropped --
      // which is what actually happens on the robot.
      while (!this.isOp(';') && !this.is('eof')) this.i++;
      this.eatOp(';');
      return { kind: 'Empty', line };
    }
    if (this.isKeyword('return')) {
      this.next();
      const value = this.isOp(';') ? null : this.parseExpression();
      this.expectOp(';');
      return { kind: 'Return', value, line };
    }
    if (this.isKeyword('throw')) {
      this.next();
      const value = this.parseExpression();
      this.expectOp(';');
      return { kind: 'Throw', value, line };
    }
    if (this.isKeyword('break') || this.isKeyword('continue')) {
      const which = this.next().value;
      const label = this.is('name') ? this.expectName() : null;
      this.expectOp(';');
      return { kind: which === 'break' ? 'Break' : 'Continue', label, line };
    }
    if (this.isKeyword('class') || this.isKeyword('enum')) {
      this.unsupported('a class declared inside a method');
    }

    // `label:` before a loop.
    if (this.is('name') && this.peek(1).kind === 'op' && this.peek(1).value === ':') {
      const label = this.expectName();
      this.next();
      return { kind: 'Labeled', label, body: this.parseStatement(), line };
    }

    // A local variable declaration, or an expression. `<` makes these
    // indistinguishable without lookahead, so try the declaration and rewind.
    const declaration = this.speculate(() => this.parseLocalDeclaration(line));
    if (declaration) return declaration;

    const expr = this.parseExpression();
    this.expectOp(';');
    return { kind: 'ExpressionStatement', expr, line };
  }

  /**
   * `final double x = 1, y;`
   *
   * Throws rather than returning null when it is not one, so `speculate` can
   * rewind. The trailing `;` is part of the test: `a < b` parses as a type and
   * a name and then fails here, which is exactly the rewind we want.
   */
  parseLocalDeclaration(line) {
    this.parseAnnotations();
    this.eatKeyword('final');
    const type = this.parseType();
    const decls = [];
    do {
      const name = this.expectName();
      let dims = 0;
      while (this.isOp('[')) {
        this.next();
        this.expectOp(']');
        dims++;
      }
      let init = null;
      if (this.eatOp('=')) init = this.parseVariableInitialiser();
      decls.push({ name, type: { ...type, dims: type.dims + dims }, init });
    } while (this.eatOp(','));
    this.expectOp(';');
    return { kind: 'LocalVar', type, decls, line };
  }

  /** An initialiser is an expression, or `{1, 2, 3}` for an array. */
  parseVariableInitialiser() {
    if (this.isOp('{')) return this.parseArrayInitialiser();
    return this.parseExpression();
  }

  parseArrayInitialiser() {
    const line = this.line;
    this.expectOp('{');
    const elements = [];
    while (!this.isOp('}')) {
      elements.push(this.parseVariableInitialiser());
      if (!this.eatOp(',')) break;
    }
    this.expectOp('}');
    return { kind: 'ArrayLiteral', elements, line };
  }

  parseIf() {
    const line = this.line;
    this.next();
    this.expectOp('(');
    const test = this.parseExpression();
    this.expectOp(')');
    const then = this.parseStatement();
    const otherwise = this.eatKeyword('else') ? this.parseStatement() : null;
    return { kind: 'If', test, then, else: otherwise, line };
  }

  parseWhile() {
    const line = this.line;
    this.next();
    this.expectOp('(');
    const test = this.parseExpression();
    this.expectOp(')');
    return { kind: 'While', test, body: this.parseStatement(), line };
  }

  parseDoWhile() {
    const line = this.line;
    this.next();
    const body = this.parseStatement();
    if (!this.eatKeyword('while')) this.fail("expected 'while' after a do block");
    this.expectOp('(');
    const test = this.parseExpression();
    this.expectOp(')');
    this.expectOp(';');
    return { kind: 'DoWhile', body, test, line };
  }

  parseFor() {
    const line = this.line;
    this.next();
    this.expectOp('(');

    // `for (Type name : iterable)`
    const each = this.speculate(() => {
      this.eatKeyword('final');
      const type = this.parseType();
      const name = this.expectName();
      if (!this.eatOp(':')) throw new JavaSyntaxError('not a for-each', this.line);
      const iterable = this.parseExpression();
      this.expectOp(')');
      return { type, name, iterable };
    });
    if (each) {
      return { kind: 'ForEach', ...each, body: this.parseStatement(), line };
    }

    /** @type {any} */
    let init = null;
    if (!this.isOp(';')) {
      const declaration = this.speculate(() => this.parseLocalDeclaration(line));
      if (declaration) init = declaration;
      else {
        const exprs = [this.parseExpression()];
        while (this.eatOp(',')) exprs.push(this.parseExpression());
        this.expectOp(';');
        init = { kind: 'ExpressionList', exprs, line };
      }
    } else {
      this.expectOp(';');
    }
    const test = this.isOp(';') ? null : this.parseExpression();
    this.expectOp(';');
    const update = [];
    if (!this.isOp(')')) {
      do {
        update.push(this.parseExpression());
      } while (this.eatOp(','));
    }
    this.expectOp(')');
    return { kind: 'For', init, test, update, body: this.parseStatement(), line };
  }

  parseSwitch() {
    const line = this.line;
    this.next();
    this.expectOp('(');
    const disc = this.parseExpression();
    this.expectOp(')');
    this.expectOp('{');
    const cases = [];
    while (!this.isOp('}')) {
      if (this.is('eof')) this.fail('unterminated switch');
      /** @type {any[]} */
      const tests = [];
      let arrow = false;
      for (;;) {
        if (this.eatKeyword('default')) {
          tests.push(null);
        } else if (this.eatKeyword('case')) {
          do {
            tests.push(this.parseExpression());
          } while (this.eatOp(','));
        } else {
          break;
        }
        if (this.eatOp('->')) {
          arrow = true;
          break;
        }
        this.expectOp(':');
        if (!this.isKeyword('case') && !this.isKeyword('default')) break;
      }
      if (tests.length === 0) this.fail("expected 'case' or 'default'");
      const body = [];
      if (arrow) {
        // `case X -> statement;` -- one statement, and it never falls through.
        body.push(this.isOp('{') ? this.parseBlock() : this.parseStatement());
      } else {
        while (!this.isOp('}') && !this.isKeyword('case') && !this.isKeyword('default')) {
          body.push(this.parseStatement());
        }
      }
      cases.push({ tests, body, arrow });
    }
    this.expectOp('}');
    return { kind: 'Switch', disc, cases, line };
  }

  parseTry() {
    const line = this.line;
    this.next();
    if (this.isOp('(')) this.unsupported('try-with-resources');
    const body = this.parseBlock();
    const catches = [];
    while (this.isKeyword('catch')) {
      this.next();
      this.expectOp('(');
      this.eatKeyword('final');
      const types = [this.parseType().name];
      while (this.eatOp('|')) types.push(this.parseType().name);
      const name = this.expectName();
      this.expectOp(')');
      catches.push({ types, name, body: this.parseBlock() });
    }
    const fin = this.eatKeyword('finally') ? this.parseBlock() : null;
    if (catches.length === 0 && !fin) this.fail('a try needs a catch or a finally');
    return { kind: 'Try', body, catches, finally: fin, line };
  }

  // --------------------------------------------------------- expressions

  parseExpression() {
    return this.parseAssignment();
  }

  parseAssignment() {
    const line = this.line;
    const left = this.parseConditional();
    const t = this.peek();
    if (t.kind === 'op' && ASSIGN_OPS.has(t.value)) {
      this.i++;
      const value = this.parseAssignment();
      return { kind: 'Assign', op: t.value, target: left, value, line };
    }
    // `>>=` written as `>` `>=` never happens, but `>>` `=` could if a future
    // tokenizer change split it; fold that here rather than mis-parsing.
    return left;
  }

  parseConditional() {
    const line = this.line;
    const test = this.parseBinary(0);
    if (!this.isOp('?')) return test;
    this.next();
    const then = this.parseAssignment();
    this.expectOp(':');
    const otherwise = this.parseAssignment();
    return { kind: 'Conditional', test, then, else: otherwise, line };
  }

  /**
   * Java's binary precedence, lowest first. `instanceof` sits with the
   * relational operators, which is where the language puts it.
   */
  parseBinary(level) {
    const LEVELS = [
      ['||'],
      ['&&'],
      ['|'],
      ['^'],
      ['&'],
      ['==', '!='],
      ['<', '>', '<=', '>=', 'instanceof'],
      ['<<', '>>', '>>>'],
      ['+', '-'],
      ['*', '/', '%'],
    ];
    if (level >= LEVELS.length) return this.parseUnary();
    let left = this.parseBinary(level + 1);
    for (;;) {
      const op = this.matchBinary(LEVELS[level]);
      if (!op) return left;
      if (op === 'instanceof') {
        const type = this.parseType();
        // `x instanceof Foo f` binds a variable; record it.
        const name = this.is('name') ? this.expectName() : null;
        left = { kind: 'InstanceOf', arg: left, type, name, line: this.line };
        continue;
      }
      const right = this.parseBinary(level + 1);
      left = { kind: 'Binary', op, left, right, line: this.line };
    }
  }

  /**
   * Take one of `ops` if it is next.
   *
   * The shift operators are assembled here from consecutive `>` tokens, since
   * the tokenizer cannot tell `>>` from the end of `List<List<X>>`. Adjacency
   * is checked by column so that `a > > b` is still a syntax error.
   */
  matchBinary(ops) {
    const t = this.peek();
    if (t.kind === 'keyword' && t.value === 'instanceof' && ops.includes('instanceof')) {
      this.i++;
      return 'instanceof';
    }
    if (t.kind !== 'op') return null;

    if (t.value === '>' && (ops.includes('>>') || ops.includes('>>>'))) {
      const b = this.peek(1);
      const c = this.peek(2);
      const adjacent = (x, y) => x.line === y.line && x.column + 1 === y.column;
      if (b.kind === 'op' && b.value === '>' && adjacent(t, b)) {
        if (c.kind === 'op' && c.value === '>' && adjacent(b, c) && ops.includes('>>>')) {
          this.i += 3;
          return '>>>';
        }
        if (ops.includes('>>')) {
          this.i += 2;
          return '>>';
        }
      }
      return null;
    }
    // A lone `>` that is really the start of a shift must not be taken as a
    // comparison, or `x >> 2` parses as `x > (> 2)`.
    if (t.value === '>' && ops.includes('>')) {
      const b = this.peek(1);
      if (b.kind === 'op' && b.value === '>' && b.line === t.line && t.column + 1 === b.column) {
        return null;
      }
    }
    if (ops.includes(t.value)) {
      this.i++;
      return t.value;
    }
    return null;
  }

  parseUnary() {
    const line = this.line;
    if (this.isOp('+', '-', '!', '~')) {
      const op = this.next().value;
      return { kind: 'Unary', op, arg: this.parseUnary(), line };
    }
    if (this.isOp('++', '--')) {
      const op = this.next().value;
      return { kind: 'Prefix', op, arg: this.parseUnary(), line };
    }

    // A cast, maybe. `(int) x` is one and `(a) - b` is not, so this is the
    // standard heuristic: a primitive type always means a cast, and a
    // class-looking name means one when what follows it could start a value.
    if (this.isOp('(')) {
      const cast = this.speculate(() => {
        this.expectOp('(');
        const type = this.parseType();
        // Intersection casts, `(A & B) x`.
        while (this.eatOp('&')) this.parseType();
        this.expectOp(')');
        const t = this.peek();
        const primitive = PRIMITIVES.has(type.name);
        const startsValue =
          t.kind === 'name' ||
          t.kind === 'string' ||
          t.kind === 'char' ||
          t.kind === 'int' ||
          t.kind === 'long' ||
          t.kind === 'double' ||
          (t.kind === 'keyword' && ['new', 'this', 'super'].includes(t.value)) ||
          (t.kind === 'op' && ['(', '!', '~'].includes(t.value));
        const unaryOk = primitive && t.kind === 'op' && ['+', '-'].includes(t.value);
        if (!startsValue && !unaryOk) throw new JavaSyntaxError('not a cast', t.line, t.column);
        if (!primitive && /^[a-z]/.test(type.name) && type.dims === 0) {
          // `(x) y` where x starts lowercase is far more likely a variable than
          // a class, and treating it as a cast would swallow real code.
          throw new JavaSyntaxError('not a cast', t.line, t.column);
        }
        return { kind: 'Cast', type, arg: this.parseUnary(), line };
      });
      if (cast) return cast;
    }
    return this.parsePostfix();
  }

  parsePostfix() {
    let expr = this.parsePrimary();
    for (;;) {
      const line = this.line;
      if (this.isOp('.')) {
        this.next();
        this.parseTypeArguments();
        if (this.eatKeyword('class')) {
          expr = { kind: 'ClassLiteral', target: expr, line };
          continue;
        }
        if (this.isKeyword('new')) this.unsupported('an inner class creation');
        if (this.eatKeyword('this')) {
          expr = { kind: 'Member', object: expr, name: 'this', line };
          continue;
        }
        const name = this.expectName();
        if (this.isOp('(')) {
          expr = { kind: 'Call', callee: { kind: 'Member', object: expr, name, line }, args: this.parseArguments(), line };
        } else {
          expr = { kind: 'Member', object: expr, name, line };
        }
        continue;
      }
      if (this.isOp('[')) {
        this.next();
        const index = this.parseExpression();
        this.expectOp(']');
        expr = { kind: 'Index', object: expr, index, line };
        continue;
      }
      if (this.isOp('++', '--')) {
        const op = this.next().value;
        expr = { kind: 'Postfix', op, arg: expr, line };
        continue;
      }
      if (this.isOp('::')) this.unsupported('a method reference (::)');
      return expr;
    }
  }

  parseArguments() {
    this.expectOp('(');
    const args = [];
    if (!this.isOp(')')) {
      do {
        args.push(this.parseExpression());
      } while (this.eatOp(','));
    }
    this.expectOp(')');
    return args;
  }

  parsePrimary() {
    const t = this.peek();
    const line = t.line;

    if (t.kind === 'int' || t.kind === 'long' || t.kind === 'double' || t.kind === 'char') {
      this.i++;
      return { kind: 'Literal', type: t.kind, value: t.value, line };
    }
    if (t.kind === 'string') {
      this.i++;
      return { kind: 'Literal', type: 'string', value: t.value, line };
    }
    if (t.kind === 'name' && t.value === 'true') {
      this.i++;
      return { kind: 'Literal', type: 'boolean', value: 'true', line };
    }
    if (t.kind === 'name' && t.value === 'false') {
      this.i++;
      return { kind: 'Literal', type: 'boolean', value: 'false', line };
    }
    if (t.kind === 'name' && t.value === 'null') {
      this.i++;
      return { kind: 'Literal', type: 'null', value: 'null', line };
    }

    if (this.isKeyword('this')) {
      this.i++;
      if (this.isOp('(')) {
        return { kind: 'Call', callee: { kind: 'Name', name: 'this', line }, args: this.parseArguments(), line };
      }
      return { kind: 'This', line };
    }
    if (this.isKeyword('super')) {
      this.i++;
      if (this.isOp('(')) {
        return { kind: 'Call', callee: { kind: 'Name', name: 'super', line }, args: this.parseArguments(), line };
      }
      return { kind: 'Super', line };
    }
    if (this.isKeyword('new')) return this.parseNew();

    if (this.isOp('(')) {
      // A parenthesised expression, or a lambda's parameter list.
      const lambda = this.speculate(() => this.parseLambda());
      if (lambda) return lambda;
      this.next();
      const inner = this.parseExpression();
      this.expectOp(')');
      return inner;
    }

    // A primitive class literal: `int.class`, `double[].class`.
    if (t.kind === 'keyword' && PRIMITIVES.has(t.value)) {
      const type = this.parseType();
      this.expectOp('.');
      if (!this.eatKeyword('class')) this.fail("expected '.class'");
      return { kind: 'ClassLiteral', target: { kind: 'Name', name: type.name, line }, line };
    }

    if (t.kind === 'name' || (t.kind === 'keyword' && t.value === 'yield')) {
      // A single-parameter lambda without brackets: `x -> x + 1`.
      if (this.peek(1).kind === 'op' && this.peek(1).value === '->') {
        const name = this.expectName();
        this.next();
        return { kind: 'Lambda', params: [{ name }], body: this.parseLambdaBody(), line };
      }
      const name = this.expectName();
      if (this.isOp('(')) {
        return { kind: 'Call', callee: { kind: 'Name', name, line }, args: this.parseArguments(), line };
      }
      return { kind: 'Name', name, line };
    }

    this.fail('expected a value');
    return null;
  }

  parseLambda() {
    const params = this.parseParameters();
    if (!this.eatOp('->')) throw new JavaSyntaxError('not a lambda', this.line);
    return { kind: 'Lambda', params, body: this.parseLambdaBody(), line: this.line };
  }

  parseLambdaBody() {
    if (this.isOp('{')) return this.parseBlock();
    return this.parseExpression();
  }

  parseNew() {
    const line = this.line;
    this.next();
    this.parseTypeArguments();
    const t = this.peek();
    let name;
    if (t.kind === 'keyword' && PRIMITIVES.has(t.value)) {
      this.i++;
      name = t.value;
    } else {
      name = this.expectName();
      this.parseTypeArguments();
      while (this.isOp('.')) {
        this.i++;
        name += `.${this.expectName()}`;
        this.parseTypeArguments();
      }
    }

    // `new int[4]`, `new int[]{1, 2}`, `new int[2][3]`
    if (this.isOp('[')) {
      const sizes = [];
      let dims = 0;
      while (this.isOp('[')) {
        this.next();
        if (this.isOp(']')) {
          this.next();
          dims++;
        } else {
          sizes.push(this.parseExpression());
          this.expectOp(']');
        }
      }
      const init = this.isOp('{') ? this.parseArrayInitialiser() : null;
      return { kind: 'NewArray', type: { name, dims }, sizes, init, line };
    }

    const args = this.parseArguments();
    if (this.isOp('{')) this.unsupported('an anonymous inner class');
    return { kind: 'New', type: { name, dims: 0 }, args, line };
  }
}

export { JavaSyntaxError };
