/**
 * Java AST to JavaScript, with the blocking calls turned into generators.
 *
 * ## The problem this exists to solve
 *
 * A `LinearOpMode` blocks. `waitForStart()` sits there until the match starts;
 * `sleep(500)` sits there for half a second; `while (opModeIsActive())` runs
 * until somebody presses stop. On a Control Hub that is fine, because the
 * op-mode has its own thread and the rest of the robot carries on around it.
 *
 * Nothing in a browser can block. A frame has to return. So every place the
 * Java would have blocked is emitted as a `yield`, which hands control back to
 * the simulator, and every method that can reach a `yield` is emitted as a
 * `function*`. Calls to those become `yield*`. The routine then reads top to
 * bottom exactly as written and still steps on the simulated clock.
 *
 * Which methods block is worked out by a fixpoint over the call graph: a method
 * blocks if it sleeps, waits for the start, idles, or contains a loop (a loop
 * needs a scheduling point or the world never advances inside it), or if it
 * calls a method that does. Two passes are not enough -- `a` calling `b`
 * calling `c` needs the answer propagated -- so it iterates until nothing
 * changes.
 *
 * ## What is faithfully different from Java
 *
 * Recorded here rather than left to be discovered:
 *
 *  - **Integer division truncates**, and knowing when needs types. Declared
 *    types of fields, parameters and locals are tracked, so `int a / int b`
 *    truncates; where the type is not known the division is left alone, which
 *    is JavaScript's behaviour and Java's for doubles.
 *  - **`char` is a number**, which is what Java does too, so `'A' + 1` is 66
 *    and not `"A1"`.
 *  - **Integers do not overflow.** A 32-bit wrap is not modelled; a value that
 *    would wrap in Java keeps growing here.
 *  - **`assert` is stripped**, which is what happens on a Control Hub, where
 *    assertions are off.
 *
 * @module
 */
import { INTEGRAL, JavaSyntaxError, PRIMITIVES } from './tokenize.js';

/**
 * Methods inherited from `OpMode` / `LinearOpMode` that block.
 *
 * `opModeIsActive` and `isStopRequested` are deliberately *not* here: they read
 * a flag and return, and treating them as blocking would put a scheduling point
 * in the middle of the loop condition rather than at the top of the body.
 */
const BLOCKING_INHERITED = new Set(['sleep', 'waitForStart', 'idle', 'waitForNextHardwareCycle']);

/** Everything else `OpMode` and `LinearOpMode` give a subclass. */
const INHERITED_MEMBERS = new Set([
  'hardwareMap', 'telemetry', 'gamepad1', 'gamepad2', 'time', 'msStuckDetectInit',
  'msStuckDetectInitLoop', 'msStuckDetectStart', 'msStuckDetectLoop', 'msStuckDetectStop',
]);

const INHERITED_METHODS = new Set([
  ...BLOCKING_INHERITED,
  'opModeIsActive', 'opModeInInit', 'isStopRequested', 'isStarted',
  'getRuntime', 'resetRuntime', 'requestOpModeStop', 'terminateOpModeNow',
  'init', 'init_loop', 'start', 'loop', 'stop', 'runOpMode', 'updateTelemetry',
]);

/** Reserved in JavaScript but legal in Java, so they get a suffix. */
const JS_RESERVED = new Set([
  'arguments', 'await', 'debugger', 'delete', 'export', 'function', 'in', 'let',
  'typeof', 'with', 'eval', 'undefined', 'NaN', 'Infinity',
]);

/**
 * Compile parsed files into one JavaScript module body.
 *
 * Several files at once, because a real op-mode references the team's own
 * helper classes and a compiler that could only see one file would be useless
 * on an actual repository.
 *
 * @param {Array<{name: string, ast: any}>} files
 * @returns {{code: string, classes: string[], opModes: any[], warnings: string[]}}
 */
export function emitProgram(files) {
  const program = new Program(files);
  return program.emit();
}

class Program {
  constructor(files) {
    this.files = files;
    /** @type {Map<string, any>} */
    this.types = new Map();
    /** @type {string[]} */
    this.warnings = [];

    for (const file of files) {
      for (const type of file.ast.types) this.register(type, file.name);
    }
  }

  register(type, fileName) {
    if (this.types.has(type.name)) {
      this.warnings.push(
        `${fileName} declares ${type.name}, which is already declared in ` +
          `${this.types.get(type.name).file}; the first one wins`,
      );
      return;
    }
    this.types.set(type.name, { ...type, file: fileName });
    // Nested types are hoisted to the top level, which is safe as long as the
    // code does not depend on the nesting for access.
    for (const member of type.members ?? []) {
      if (member.kind === 'Class' || member.kind === 'Enum') this.register(member, fileName);
    }
  }

  emit() {
    this.analyseBlocking();

    const chunks = [];
    const classNames = [];
    const opModes = [];

    // Enums first. A class's static initialiser runs when the class is defined,
    // and one that names an enum constant would hit a temporal dead zone if the
    // enum were declared below it.
    const ordered = [...this.types.values()].sort(
      (a, b) => (a.kind === 'Enum' ? 0 : 1) - (b.kind === 'Enum' ? 0 : 1),
    );
    for (const type of ordered) {
      if (type.kind === 'Enum') {
        chunks.push(this.emitEnum(type));
      } else {
        const emitter = new ClassEmitter(this, type);
        chunks.push(emitter.emit());
      }
      classNames.push(type.name);
      const descriptor = this.opModeDescriptor(type);
      if (descriptor) opModes.push(descriptor);
    }

    const registry = `const __classes = { ${classNames.join(', ')} };`;
    return {
      code: `${chunks.join('\n\n')}\n\n${registry}\nreturn __classes;`,
      classes: classNames,
      opModes,
      warnings: this.warnings,
    };
  }

  /**
   * Is this class an op-mode, and what does the Driver Station call it?
   *
   * The same two questions the SDK's annotation scanner asks, answered the same
   * way: `@Autonomous` or `@TeleOp` with an optional name and group, `@Disabled`
   * hides it, and the class has to actually extend one of the op-mode bases.
   */
  opModeDescriptor(type) {
    if (type.kind !== 'Class') return null;
    const annotations = type.annotations ?? [];
    const named = annotations.find((a) => a.name === 'Autonomous' || a.name === 'TeleOp');
    const base = this.baseKind(type);
    if (!base) return null;
    const stringOf = (expr) => (expr && expr.kind === 'Literal' ? String(expr.value) : null);
    return {
      className: type.name,
      file: type.file,
      kind: named?.name === 'TeleOp' ? 'teleop' : named?.name === 'Autonomous' ? 'auto' : 'auto',
      annotated: Boolean(named),
      name: stringOf(named?.values?.name) ?? stringOf(named?.values?.value) ?? type.name,
      group: stringOf(named?.values?.group) ?? '',
      disabled: annotations.some((a) => a.name === 'Disabled'),
      linear: base === 'linear',
    };
  }

  /**
   * 'linear' for a `LinearOpMode`, 'iterative' for an `OpMode`, null for
   * neither -- following `extends` through the team's own classes, because
   * plenty of teams have an abstract `AutoBase extends LinearOpMode`.
   */
  baseKind(type, seen = new Set()) {
    let current = type;
    while (current) {
      const parent = current.superName;
      if (!parent) return null;
      const simple = parent.split('.').pop();
      if (simple === 'LinearOpMode') return 'linear';
      if (simple === 'OpMode') return 'iterative';
      if (seen.has(simple)) return null;
      seen.add(simple);
      current = this.types.get(simple) ?? null;
    }
    return null;
  }

  /** Every method of a class and its own superclasses, by name. */
  methodsOf(type) {
    /** @type {Map<string, any>} */
    const out = new Map();
    const chain = [];
    let current = type;
    const seen = new Set();
    while (current && !seen.has(current.name)) {
      seen.add(current.name);
      chain.unshift(current);
      const parent = current.superName?.split('.').pop();
      current = parent ? this.types.get(parent) ?? null : null;
    }
    for (const link of chain) {
      for (const member of link.members ?? []) {
        if (member.kind === 'Method') out.set(member.name, member);
      }
    }
    return out;
  }

  /** Field names visible in a class, its superclasses included. */
  fieldsOf(type) {
    /** @type {Map<string, any>} */
    const out = new Map();
    let current = type;
    const seen = new Set();
    while (current && !seen.has(current.name)) {
      seen.add(current.name);
      for (const member of current.members ?? []) {
        if (member.kind === 'Field' && !out.has(member.name)) out.set(member.name, member);
      }
      const parent = current.superName?.split('.').pop();
      current = parent ? this.types.get(parent) ?? null : null;
    }
    return out;
  }

  /**
   * Work out which methods have to be generators.
   *
   * A fixpoint, because blocking is transitive through the call graph and one
   * pass would miss `a` -> `b` -> `sleep`.
   */
  analyseBlocking() {
    /** @type {Map<string, Set<string>>} class -> blocking method names */
    this.blocking = new Map();
    for (const name of this.types.keys()) this.blocking.set(name, new Set());

    // Seed: a method that sleeps, waits, idles or contains a loop.
    for (const [name, type] of this.types) {
      if (type.kind !== 'Class') continue;
      for (const member of type.members ?? []) {
        if (member.kind !== 'Method' || !member.body) continue;
        if (seedBlocks(member.body)) this.blocking.get(name).add(member.name);
      }
    }

    // Propagate through calls to methods of the same class hierarchy.
    let changed = true;
    let rounds = 0;
    while (changed && rounds++ < 50) {
      changed = false;
      for (const [name, type] of this.types) {
        if (type.kind !== 'Class') continue;
        const set = this.blocking.get(name);
        const methods = this.methodsOf(type);
        for (const member of type.members ?? []) {
          if (member.kind !== 'Method' || !member.body || set.has(member.name)) continue;
          if (callsBlocking(member.body, (called) => this.methodBlocks(type, called, methods))) {
            set.add(member.name);
            changed = true;
          }
        }
        // A constructor that blocks cannot be expressed, so it is an error
        // rather than a silent difference.
        for (const member of type.members ?? []) {
          if (member.kind !== 'Constructor' || !member.body) continue;
          if (
            seedBlocks(member.body) ||
            callsBlocking(member.body, (called) => this.methodBlocks(type, called, methods))
          ) {
            throw new JavaSyntaxError(
              `${name}'s constructor sleeps or loops over hardware, which cannot be run here -- ` +
                'move that work into runOpMode or init',
              member.body.line ?? 0,
            );
          }
        }
      }
    }
  }

  /** Does a call to `name` from inside `type` reach a blocking call? */
  methodBlocks(type, name, methods = this.methodsOf(type)) {
    if (BLOCKING_INHERITED.has(name)) return true;
    const owner = this.ownerOf(type, name);
    if (owner) return this.blocking.get(owner)?.has(name) ?? false;
    return methods.has(name) ? this.blocking.get(type.name)?.has(name) ?? false : false;
  }

  /** Which class in the chain declares `name`. */
  ownerOf(type, name) {
    let current = type;
    const seen = new Set();
    while (current && !seen.has(current.name)) {
      seen.add(current.name);
      if ((current.members ?? []).some((m) => m.kind === 'Method' && m.name === name)) {
        return current.name;
      }
      const parent = current.superName?.split('.').pop();
      current = parent ? this.types.get(parent) ?? null : null;
    }
    return null;
  }

  /** `enum State { DRIVE, TURN }` -- common in a state-machine auto. */
  emitEnum(type) {
    const lines = [`const ${type.name} = __rt.makeEnum(${JSON.stringify(type.name)}, [`];
    for (const constant of type.constants) lines.push(`  ${JSON.stringify(constant.name)},`);
    lines.push(']);');
    return lines.join('\n');
  }
}

/** A method blocks on its own account if it sleeps, waits, idles or loops. */
function seedBlocks(node) {
  let found = false;
  walk(node, (n) => {
    if (found) return false;
    if (n.kind === 'While' || n.kind === 'DoWhile' || n.kind === 'For' || n.kind === 'ForEach') {
      found = true;
      return false;
    }
    if (n.kind === 'Call') {
      const name = calleeName(n);
      if (name && BLOCKING_INHERITED.has(name)) {
        found = true;
        return false;
      }
      if (n.callee.kind === 'Member' && n.callee.name === 'sleep' && n.callee.object?.name === 'Thread') {
        found = true;
        return false;
      }
    }
    // A lambda body runs later, on somebody else's terms, so what it does does
    // not make the enclosing method blocking.
    return n.kind !== 'Lambda';
  });
  return found;
}

/** ... or if it calls something that does. */
function callsBlocking(node, blocks) {
  let found = false;
  walk(node, (n) => {
    if (found) return false;
    if (n.kind === 'Call') {
      const name = calleeName(n);
      if (name && blocks(name)) {
        found = true;
        return false;
      }
    }
    return n.kind !== 'Lambda';
  });
  return found;
}

/** The bare name being called, for `foo()`, `this.foo()` and `super.foo()`. */
function calleeName(call) {
  const callee = call.callee;
  if (callee.kind === 'Name') return callee.name;
  if (callee.kind === 'Member' && (callee.object.kind === 'This' || callee.object.kind === 'Super')) {
    return callee.name;
  }
  return null;
}

/** Depth-first walk. `visit` returns false to stop descending. */
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!node.kind) {
    for (const value of Object.values(node)) walk(value, visit);
    return;
  }
  if (visit(node) === false) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'kind' || key === 'line' || key === 'type') continue;
    walk(value, visit);
  }
}

// ---------------------------------------------------------------------------

class ClassEmitter {
  /**
   * @param {Program} program
   * @param {any} type
   */
  constructor(program, type) {
    this.program = program;
    this.type = type;
    this.blocking = program.blocking.get(type.name) ?? new Set();
    this.methods = program.methodsOf(type);
    this.fields = program.fieldsOf(type);
    this.statics = new Set(
      [...this.fields.values()].filter((f) => f.modifiers?.has('static')).map((f) => f.name),
    );
    /** Declared types by name, innermost scope last. */
    this.scopes = [new Map()];
    for (const [name, field] of this.fields) this.scopes[0].set(name, field.type);
    this.indent = 0;
  }

  emit() {
    const parent = this.type.superName?.split('.').pop();
    const base = parent && this.program.types.has(parent) ? parent : `__rt.${parent}`;
    this.hasParent = Boolean(parent);
    const heritage = parent ? ` extends ${base}` : '';
    const out = [];
    out.push(`class ${this.type.name}${heritage} {`);
    this.indent = 1;

    // Static fields first: another static's initialiser may refer to one.
    for (const field of this.fields.values()) {
      if (!field.modifiers?.has('static')) continue;
      if (![...(this.type.members ?? [])].includes(field)) continue;
      const init = field.init ? this.expr(field.init, field.type) : this.defaultFor(field.type);
      out.push(this.line(`static ${this.id(field.name)} = ${init};`));
    }

    out.push(...this.emitConstructor());

    for (const member of this.type.members ?? []) {
      if (member.kind !== 'Method' || !member.body) continue;
      out.push(...this.emitMethod(member));
    }

    this.indent = 0;
    out.push('}');

    // What the runner needs to know without re-deriving it.
    const blocking = [...this.blocking];
    out.push(`${this.type.name}.__blocking = ${JSON.stringify(blocking)};`);
    const descriptor = this.program.opModeDescriptor(this.type);
    if (descriptor) out.push(`${this.type.name}.__opMode = ${JSON.stringify(descriptor)};`);
    return out.filter(Boolean).join('\n');
  }

  emitConstructor() {
    const ctor = (this.type.members ?? []).find((m) => m.kind === 'Constructor');
    const instanceFields = (this.type.members ?? []).filter(
      (m) => m.kind === 'Field' && !m.modifiers?.has('static'),
    );
    const initialisers = (this.type.members ?? []).filter(
      (m) => m.kind === 'Initialiser' && !m.static,
    );
    if (!ctor && instanceFields.length === 0 && initialisers.length === 0) return [];

    const out = [];
    const params = (ctor?.params ?? []).map((p) => this.id(p.name));
    out.push(this.line(`constructor(${params.join(', ')}) {`));
    this.indent++;

    this.pushScope();
    for (const param of ctor?.params ?? []) this.declare(param.name, param.type);

    // Java's explicit `super(...)` or `this(...)` has to be the first
    // statement, and JavaScript demands the same -- so if there is one it is
    // emitted here and taken off the body. A class with no superclass gets no
    // call at all, which is what tripped this up: `super(...arguments)` in a
    // class that extends nothing is a syntax error, and the compiler reported
    // it against the team's file.
    const body = [...(ctor?.body?.body ?? [])];
    const first = body[0];
    const explicitSuper =
      first?.kind === 'ExpressionStatement' &&
      first.expr.kind === 'Call' &&
      first.expr.callee.kind === 'Name' &&
      (first.expr.callee.name === 'super' || first.expr.callee.name === 'this');
    if (explicitSuper) {
      out.push(...this.statement(body.shift()));
    } else if (this.hasParent) {
      out.push(this.line('super(...arguments);'));
    }

    // Java runs field initialisers in declaration order, before the
    // constructor body -- so a field that reads another field sees the one
    // above it and not the one below.
    for (const field of instanceFields) {
      const value = field.init ? this.expr(field.init, field.type) : this.defaultFor(field.type);
      out.push(this.line(`this.${this.id(field.name)} = ${value};`));
    }
    for (const block of initialisers) out.push(...this.statements(block.body.body));
    out.push(...this.statements(body));
    this.popScope();

    this.indent--;
    out.push(this.line('}'));
    return out;
  }

  emitMethod(member) {
    const generator = this.blocking.has(member.name);
    const params = member.params.map((p, index) =>
      p.variadic ? `...${this.id(p.name)}` : this.id(p.name),
    );
    const out = [];
    const prefix = member.modifiers?.has('static') ? 'static ' : '';
    out.push(this.line(`${prefix}${generator ? '*' : ''}${this.id(member.name)}(${params.join(', ')}) {`));
    this.indent++;
    this.pushScope();
    for (const param of member.params) this.declare(param.name, param.type);
    this.generator = generator;
    out.push(...this.statements(member.body.body));
    this.popScope();
    this.indent--;
    out.push(this.line('}'));
    return out;
  }

  // --------------------------------------------------------------- scopes

  pushScope() {
    this.scopes.push(new Map());
  }

  popScope() {
    this.scopes.pop();
  }

  declare(name, type) {
    this.scopes[this.scopes.length - 1].set(name, type);
  }

  lookup(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(name)) return this.scopes[i].get(name);
    }
    return null;
  }

  /** Is `name` a local or a parameter here, rather than a field? */
  isLocal(name) {
    for (let i = this.scopes.length - 1; i >= 1; i--) {
      if (this.scopes[i].has(name)) return true;
    }
    return false;
  }

  id(name) {
    return JS_RESERVED.has(name) ? `${name}$` : name;
  }

  line(text) {
    return `${'  '.repeat(this.indent)}${text}`;
  }

  defaultFor(type) {
    if (!type || type.dims > 0) return 'null';
    if (type.name === 'boolean') return 'false';
    if (PRIMITIVES.has(type.name) && type.name !== 'void') return '0';
    return 'null';
  }

  // ------------------------------------------------------------ statements

  statements(list) {
    const out = [];
    for (const statement of list) out.push(...this.statement(statement));
    return out;
  }

  /** @returns {string[]} */
  statement(node) {
    switch (node.kind) {
      case 'Block': {
        const out = [this.line('{')];
        this.indent++;
        this.pushScope();
        out.push(...this.statements(node.body));
        this.popScope();
        this.indent--;
        out.push(this.line('}'));
        return out;
      }
      case 'Empty':
        return [];
      case 'LocalVar': {
        const out = [];
        for (const decl of node.decls) {
          const value = decl.init ? this.expr(decl.init, decl.type) : this.defaultFor(decl.type);
          out.push(this.line(`let ${this.id(decl.name)} = ${value};`));
          this.declare(decl.name, decl.type);
        }
        return out;
      }
      case 'ExpressionStatement':
        return [this.line(`${this.expr(node.expr)};`)];
      case 'ExpressionList':
        return node.exprs.map((e) => this.line(`${this.expr(e)};`));
      case 'If': {
        const out = [this.line(`if (${this.truthy(node.test)}) {`)];
        this.indent++;
        this.pushScope();
        out.push(...this.body(node.then));
        this.popScope();
        this.indent--;
        if (node.else) {
          out.push(this.line('} else {'));
          this.indent++;
          this.pushScope();
          out.push(...this.body(node.else));
          this.popScope();
          this.indent--;
        }
        out.push(this.line('}'));
        return out;
      }
      case 'While': {
        const out = [this.line(`while (${this.truthy(node.test)}) {`)];
        this.indent++;
        this.pushScope();
        out.push(this.schedule());
        out.push(...this.body(node.body));
        this.popScope();
        this.indent--;
        out.push(this.line('}'));
        return out;
      }
      case 'DoWhile': {
        const out = [this.line('do {')];
        this.indent++;
        this.pushScope();
        out.push(this.schedule());
        out.push(...this.body(node.body));
        this.popScope();
        this.indent--;
        out.push(this.line(`} while (${this.truthy(node.test)});`));
        return out;
      }
      case 'For': {
        this.pushScope();
        const init = node.init
          ? node.init.kind === 'LocalVar'
            ? this.forInit(node.init)
            : node.init.exprs.map((e) => this.expr(e)).join(', ')
          : '';
        const test = node.test ? this.truthy(node.test) : '';
        const update = node.update.map((e) => this.expr(e)).join(', ');
        const out = [this.line(`for (${init}; ${test}; ${update}) {`)];
        this.indent++;
        this.pushScope();
        out.push(this.schedule());
        out.push(...this.body(node.body));
        this.popScope();
        this.indent--;
        out.push(this.line('}'));
        this.popScope();
        return out;
      }
      case 'ForEach': {
        this.pushScope();
        this.declare(node.name, node.type);
        const out = [
          this.line(`for (const ${this.id(node.name)} of __rt.iterate(${this.expr(node.iterable)})) {`),
        ];
        this.indent++;
        this.pushScope();
        out.push(this.schedule());
        out.push(...this.body(node.body));
        this.popScope();
        this.indent--;
        out.push(this.line('}'));
        this.popScope();
        return out;
      }
      case 'Switch': {
        const out = [this.line(`switch (__rt.key(${this.expr(node.disc)})) {`)];
        this.indent++;
        for (const branch of node.cases) {
          for (const test of branch.tests) {
            out.push(this.line(test === null ? 'default:' : `case __rt.key(${this.expr(test)}):`));
          }
          this.indent++;
          this.pushScope();
          out.push(...this.statements(branch.body));
          // An arrow case never falls through.
          if (branch.arrow) out.push(this.line('break;'));
          this.popScope();
          this.indent--;
        }
        this.indent--;
        out.push(this.line('}'));
        return out;
      }
      case 'Break':
        return [this.line(node.label ? `break ${this.id(node.label)};` : 'break;')];
      case 'Continue':
        return [this.line(node.label ? `continue ${this.id(node.label)};` : 'continue;')];
      case 'Labeled': {
        const out = [this.line(`${this.id(node.label)}:`)];
        out.push(...this.statement(node.body));
        return out;
      }
      case 'Return':
        return [this.line(node.value ? `return ${this.expr(node.value)};` : 'return;')];
      case 'Throw':
        return [this.line(`throw ${this.expr(node.value)};`)];
      case 'Try': {
        const out = [this.line('try {')];
        this.indent++;
        this.pushScope();
        out.push(...this.statements(node.body.body));
        this.popScope();
        this.indent--;
        if (node.catches.length > 0) {
          out.push(this.line('} catch (__e) {'));
          this.indent++;
          // One JavaScript catch, dispatching on the exception's Java class so
          // that a `catch (InterruptedException e)` does not swallow everything.
          let first = true;
          for (const clause of node.catches) {
            const types = JSON.stringify(clause.types.map((t) => t.split('.').pop()));
            out.push(this.line(`${first ? 'if' : '} else if'} (__rt.caught(__e, ${types})) {`));
            this.indent++;
            this.pushScope();
            this.declare(clause.name, { name: 'Exception', dims: 0 });
            out.push(this.line(`const ${this.id(clause.name)} = __e;`));
            out.push(...this.statements(clause.body.body));
            this.popScope();
            this.indent--;
            first = false;
          }
          out.push(this.line('} else {'));
          this.indent++;
          out.push(this.line('throw __e;'));
          this.indent--;
          out.push(this.line('}'));
          this.indent--;
        }
        if (node.finally) {
          out.push(this.line('} finally {'));
          this.indent++;
          this.pushScope();
          out.push(...this.statements(node.finally.body));
          this.popScope();
          this.indent--;
        }
        out.push(this.line('}'));
        return out;
      }
      default:
        throw new JavaSyntaxError(`cannot compile a ${node.kind}`, node.line ?? 0);
    }
  }

  forInit(node) {
    const parts = [];
    for (const decl of node.decls) {
      const value = decl.init ? this.expr(decl.init, decl.type) : this.defaultFor(decl.type);
      parts.push(`${this.id(decl.name)} = ${value}`);
      this.declare(decl.name, decl.type);
    }
    return `let ${parts.join(', ')}`;
  }

  /** A statement used as a loop or branch body, without doubling the braces. */
  body(node) {
    if (node.kind === 'Block') return this.statements(node.body);
    return this.statement(node);
  }

  /**
   * The scheduling point at the top of every loop body.
   *
   * Without one, a `while (opModeIsActive())` loop would spin for ever inside a
   * single frame: the op-mode has the thread and nothing else can run. `yield 0`
   * hands control back, and the runner decides whether enough of the cycle has
   * been used to advance the world -- which, with hub latency charged, is
   * exactly the question a real robot's thread scheduler answers.
   */
  schedule() {
    if (!this.generator) return '';
    return this.line('yield 0;');
  }

  // ----------------------------------------------------------- expressions

  /**
   * @param {any} node
   * @param {{name: string, dims: number}} [hint] the declared type it is being
   *   assigned to, which is how an array initialiser knows its element default
   */
  expr(node, hint) {
    switch (node.kind) {
      case 'Literal':
        return this.literal(node);
      case 'Name':
        return this.name(node);
      case 'This':
        return 'this';
      case 'Super':
        return 'super';
      case 'Member':
        return this.member(node);
      case 'Index':
        return `${this.expr(node.object)}[${this.expr(node.index)}]`;
      case 'Call':
        return this.call(node);
      case 'New':
        return this.construct(node);
      case 'NewArray':
        return this.newArray(node);
      case 'ArrayLiteral': {
        const elements = node.elements.map((e) => this.expr(e, hint));
        return `[${elements.join(', ')}]`;
      }
      case 'Assign':
        return this.assign(node);
      case 'Conditional':
        return `(${this.truthy(node.test)} ? ${this.expr(node.then)} : ${this.expr(node.else)})`;
      case 'Binary':
        return this.binary(node);
      case 'Unary':
        if (node.op === '!') return `(!${this.truthy(node.arg)})`;
        return `(${node.op}${this.expr(node.arg)})`;
      case 'Prefix':
        return `(${node.op}${this.expr(node.arg)})`;
      case 'Postfix':
        return `(${this.expr(node.arg)}${node.op})`;
      case 'Cast':
        return this.cast(node);
      case 'InstanceOf': {
        const check = `__rt.isA(${this.expr(node.arg)}, ${JSON.stringify(node.type.name.split('.').pop())})`;
        if (!node.name) return check;
        // `x instanceof Foo f` binds f. Emitted as a comma expression so it
        // works inside a condition, which is the only place it appears.
        this.declare(node.name, node.type);
        return `(${check} && (${this.id(node.name)} = ${this.expr(node.arg)}, true))`;
      }
      case 'Lambda': {
        const params = node.params.map((p) => this.id(p.name)).join(', ');
        if (node.body.kind === 'Block') {
          // Emitted on one line: a lambda body is short in practice and this
          // keeps the emitter from having to track indentation inside an
          // expression.
          const saved = this.indent;
          this.indent = 0;
          this.pushScope();
          for (const p of node.params) this.declare(p.name, { name: 'Object', dims: 0 });
          const body = this.statements(node.body.body).join(' ');
          this.popScope();
          this.indent = saved;
          return `((${params}) => { ${body} })`;
        }
        this.pushScope();
        for (const p of node.params) this.declare(p.name, { name: 'Object', dims: 0 });
        const value = this.expr(node.body);
        this.popScope();
        return `((${params}) => ${value})`;
      }
      case 'ClassLiteral':
        return `__rt.classOf(${JSON.stringify(this.flatten(node.target))})`;
      default:
        throw new JavaSyntaxError(`cannot compile a ${node.kind}`, node.line ?? 0);
    }
  }

  literal(node) {
    switch (node.type) {
      case 'string':
        return JSON.stringify(node.value);
      case 'null':
        return 'null';
      case 'boolean':
        return node.value;
      default:
        return node.value;
    }
  }

  /**
   * A bare name: a local, a field of this class, a static, an enum constant,
   * or another class.
   */
  name(node) {
    const raw = node.name;
    if (raw === 'true' || raw === 'false' || raw === 'null') return raw;
    if (this.isLocal(raw)) return this.id(raw);
    if (this.statics.has(raw)) return `${this.staticOwner(raw)}.${this.id(raw)}`;
    if (this.fields.has(raw) || INHERITED_MEMBERS.has(raw)) return `this.${this.id(raw)}`;
    if (this.program.types.has(raw)) return raw;
    // Anything else is an SDK class, a java.* class, or a static import. The
    // runtime resolves it by name and says so clearly if it does not know it.
    return `__rt.ref(${JSON.stringify(raw)})`;
  }

  staticOwner(name) {
    let current = this.type;
    const seen = new Set();
    while (current && !seen.has(current.name)) {
      seen.add(current.name);
      if ((current.members ?? []).some((m) => m.kind === 'Field' && m.name === name)) {
        return current.name;
      }
      const parent = current.superName?.split('.').pop();
      current = parent ? this.program.types.get(parent) ?? null : null;
    }
    return this.type.name;
  }

  member(node) {
    // `Math.PI`, `DcMotor.Direction.REVERSE`, `this.x`, `a.b`
    const flat = this.flatten(node);
    if (flat) {
      const head = flat.split('.')[0];
      const known = this.isLocal(head) || this.fields.has(head) || INHERITED_MEMBERS.has(head) || this.program.types.has(head) || this.statics.has(head);
      if (!known) return `__rt.ref(${JSON.stringify(flat)})`;
    }
    return `${this.expr(node.object)}.${this.id(node.name)}`;
  }

  /** `a.b.c` as a string, or null if it is not a plain dotted chain. */
  flatten(node) {
    if (node.kind === 'Name') return node.name;
    if (node.kind === 'Member') {
      const head = this.flatten(node.object);
      return head ? `${head}.${node.name}` : null;
    }
    return null;
  }

  call(node) {
    const callee = node.callee;
    const args = node.args.map((a) => this.expr(a));

    // `this()` / `super()` in a constructor.
    if (callee.kind === 'Name' && (callee.name === 'this' || callee.name === 'super')) {
      return `super(${args.join(', ')})`;
    }

    // A bare call: a method of this class, or one inherited from OpMode.
    if (callee.kind === 'Name') {
      const name = callee.name;
      const blocks = this.program.methodBlocks(this.type, name, this.methods);
      if (!this.methods.has(name) && !INHERITED_METHODS.has(name) && !BLOCKING_INHERITED.has(name)) {
        this.program.warnings.push(
          `${this.type.name}: nothing here defines ${name}(), so the call will fail at run time`,
        );
      }
      const target = this.methods.get(name)?.modifiers?.has('static') ? this.type.name : 'this';
      const call = `${target}.${this.id(name)}(${args.join(', ')})`;
      return blocks ? `(yield* ${call})` : call;
    }

    if (callee.kind === 'Member') {
      const object = callee.object;
      const flat = this.flatten(callee);

      // `Thread.sleep(ms)` is `sleep(ms)`.
      if (flat === 'Thread.sleep') return `(yield* this.sleep(${args.join(', ')}))`;

      // A static call on a class the runtime knows: `Math.abs`, `String.format`,
      // `Range.clip`, `AngleUnit.DEGREES.fromUnit(...)`.
      if (flat) {
        const head = flat.split('.')[0];
        const known =
          this.isLocal(head) ||
          this.fields.has(head) ||
          INHERITED_MEMBERS.has(head) ||
          this.statics.has(head) ||
          this.program.types.has(head);
        if (!known) {
          const path = flat.split('.');
          const method = path.pop();
          return `__rt.callStatic(${JSON.stringify(path.join('.'))}, ${JSON.stringify(method)}, [${args.join(', ')}])`;
        }
      }

      // `this.foo()` / `super.foo()` on our own hierarchy.
      if (object.kind === 'This' || object.kind === 'Super') {
        const name = callee.name;
        const blocks = this.program.methodBlocks(this.type, name, this.methods);
        const call = `${object.kind === 'Super' ? 'super' : 'this'}.${this.id(name)}(${args.join(', ')})`;
        return blocks ? `(yield* ${call})` : call;
      }

      // An ordinary instance call. Whether it blocks depends on the receiver's
      // declared type, which is why declared types are tracked at all.
      const receiverType = this.typeOf(object);
      const owner = receiverType ? this.program.types.get(receiverType.name.split('.').pop()) : null;
      const blocks = owner ? this.program.blocking.get(owner.name)?.has(callee.name) : false;
      const call = `${this.expr(object)}.${this.id(callee.name)}(${args.join(', ')})`;
      return blocks ? `(yield* ${call})` : call;
    }

    throw new JavaSyntaxError('cannot compile this call', node.line ?? 0);
  }

  construct(node) {
    const simple = node.type.name.split('.').pop();
    const args = node.args.map((a) => this.expr(a)).join(', ');
    if (this.program.types.has(simple)) return `new ${simple}(${args})`;
    return `__rt.construct(${JSON.stringify(node.type.name)}, [${args}])`;
  }

  newArray(node) {
    if (node.init) return this.expr(node.init, node.type);
    const fill =
      node.type.name === 'boolean'
        ? 'false'
        : PRIMITIVES.has(node.type.name)
          ? '0'
          : 'null';
    if (node.sizes.length === 0) return '[]';
    const sizes = node.sizes.map((s) => this.expr(s)).join(', ');
    return `__rt.newArray([${sizes}], ${fill})`;
  }

  assign(node) {
    const target = this.expr(node.target);
    if (node.op === '=') return `(${target} = ${this.expr(node.value)})`;
    // Compound assignment on integers truncates in Java: `int i; i /= 2`.
    if (node.op === '/=' && this.isIntegral(this.typeOf(node.target))) {
      return `(${target} = Math.trunc(${target} / (${this.expr(node.value)})))`;
    }
    return `(${target} ${node.op} ${this.expr(node.value)})`;
  }

  binary(node) {
    const left = this.expr(node.left);
    const right = this.expr(node.right);
    if (node.op === '&&' || node.op === '||') {
      return `(${this.truthy(node.left)} ${node.op} ${this.truthy(node.right)})`;
    }
    if (node.op === '/' && this.isIntegral(this.typeOf(node.left)) && this.isIntegral(this.typeOf(node.right))) {
      // Java's integer division truncates toward zero, and getting this wrong
      // silently is the sort of bug that makes an encoder target 2.5 ticks.
      return `Math.trunc(${left} / ${right})`;
    }
    if (node.op === '==' || node.op === '!=') {
      // Java compares object references with == and Strings are objects, but
      // nobody who wrote `s == "x"` meant reference identity. Strict equality
      // does the right thing for numbers, booleans, null and our enums.
      return `(${left} ${node.op}= ${right})`;
    }
    return `(${left} ${node.op} ${right})`;
  }

  /** Wrap a condition so a `Boolean` object or a null is handled. */
  truthy(node) {
    const type = this.typeOf(node);
    if (type && type.name === 'boolean' && type.dims === 0) return this.expr(node);
    if (node.kind === 'Binary' && ['==', '!=', '<', '>', '<=', '>=', '&&', '||', 'instanceof'].includes(node.op)) {
      return this.expr(node);
    }
    if (node.kind === 'Unary' && node.op === '!') return this.expr(node);
    if (node.kind === 'Literal' && node.type === 'boolean') return node.value;
    if (node.kind === 'InstanceOf') return this.expr(node);
    return `__rt.bool(${this.expr(node)})`;
  }

  cast(node) {
    const name = node.type.name;
    const arg = this.expr(node.arg);
    if (node.type.dims > 0) return arg;
    if (name === 'int' || name === 'long' || name === 'short' || name === 'byte' || name === 'char') {
      return `Math.trunc(${arg})`;
    }
    if (name === 'float') return `Math.fround(${arg})`;
    if (name === 'double' || name === 'boolean') return arg;
    // A reference cast is a run-time check in Java and a no-op here.
    return arg;
  }

  /** The declared type of an expression, where it can be known cheaply. */
  typeOf(node) {
    if (!node) return null;
    switch (node.kind) {
      case 'Literal':
        if (node.type === 'int' || node.type === 'long' || node.type === 'char') {
          return { name: 'int', dims: 0 };
        }
        if (node.type === 'double') return { name: 'double', dims: 0 };
        if (node.type === 'boolean') return { name: 'boolean', dims: 0 };
        if (node.type === 'string') return { name: 'String', dims: 0 };
        return null;
      case 'Name': {
        if (this.isLocal(node.name)) return this.lookup(node.name);
        const field = this.fields.get(node.name);
        return field ? field.type : null;
      }
      case 'Member': {
        const flat = this.flatten(node);
        if (flat && this.isLocal(flat)) return this.lookup(flat);
        return null;
      }
      case 'Cast':
        return node.type;
      case 'New':
        return node.type;
      case 'Unary':
        return node.op === '!' ? { name: 'boolean', dims: 0 } : this.typeOf(node.arg);
      case 'Prefix':
      case 'Postfix':
        return this.typeOf(node.arg);
      case 'Binary': {
        if (['==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(node.op)) {
          return { name: 'boolean', dims: 0 };
        }
        const left = this.typeOf(node.left);
        const right = this.typeOf(node.right);
        if (!left || !right) return null;
        if (left.name === 'String' || right.name === 'String') return { name: 'String', dims: 0 };
        if (this.isIntegral(left) && this.isIntegral(right)) return { name: 'int', dims: 0 };
        return { name: 'double', dims: 0 };
      }
      case 'Conditional': {
        const then = this.typeOf(node.then);
        return then ?? this.typeOf(node.else);
      }
      case 'Assign':
        return this.typeOf(node.target);
      case 'InstanceOf':
        return { name: 'boolean', dims: 0 };
      case 'Index': {
        const array = this.typeOf(node.object);
        return array && array.dims > 0 ? { ...array, dims: array.dims - 1 } : null;
      }
      default:
        return null;
    }
  }

  isIntegral(type) {
    return Boolean(type) && type.dims === 0 && INTEGRAL.has(type.name);
  }
}

export { JavaSyntaxError };
