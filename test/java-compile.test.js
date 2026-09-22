import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/java/tokenize.js';
import { parseJava } from '../src/java/parse.js';
import { compileJava, looksLikeJava } from '../src/java/compile.js';
import { format, makeEnum } from '../src/ftc/lang.js';
import { matchWheelName } from '../src/ftc/hardware.js';

/** Compile a snippet inside a minimal op-mode and return the JavaScript. */
function emit(body, extra = '') {
  const source = `
@Autonomous(name = "T")
public class T extends LinearOpMode {
  ${extra}
  public void runOpMode() {
    ${body}
  }
}`;
  return compileJava([{ name: 'T.java', source }]).code;
}

// ------------------------------------------------------------- the tokenizer

test('every numeric literal form comes out as the right JavaScript', () => {
  const cases = [
    ['0x3F_F', '0x3FF', 'int'],
    ['0b1010', '0b1010', 'int'],
    ['1_000_000', '1000000', 'int'],
    ['537.7', '537.7', 'double'],
    ['1.5e-3', '1.5e-3', 'double'],
    ['20L', '20', 'long'],
    ['0.5f', '0.5', 'double'],
    ['1.', '1.', 'double'],
    ['012', '10', 'int'],
  ];
  for (const [source, value, kind] of cases) {
    const [token] = tokenize(source);
    assert.equal(token.value, value, source);
    assert.equal(token.kind, kind, source);
  }
});

test('a char is a number, as it is in Java', () => {
  const [token] = tokenize("'A'");
  assert.equal(token.kind, 'char');
  assert.equal(token.value, '65');
  // ... so 'A' + 1 is 66 and not "A1".
  assert.match(emit('int c = \'A\' + 1;'), /let c = \(65 \+ 1\)/);
});

test('strings keep their escapes', () => {
  const [token] = tokenize('"a\\tb\\n\\u0041"');
  assert.equal(token.value, 'a\tb\nA');
});

test('a text block says so rather than being mis-read', () => {
  assert.throws(() => tokenize('String s = """\nhi""";'), /text block/);
});

// ---------------------------------------------------------------- the parser

test('a package, imports, annotations and a class all parse', () => {
  const ast = parseJava(`
    package org.firstinspires.ftc.teamcode;
    import com.qualcomm.robotcore.hardware.DcMotor;
    import static java.lang.Math.abs;
    @Autonomous(name = "Go", group = "A")
    @Disabled
    public class Go extends LinearOpMode implements Runnable {
      public void runOpMode() {}
    }`);
  assert.equal(ast.package, 'org.firstinspires.ftc.teamcode');
  assert.equal(ast.imports.length, 2);
  const cls = ast.types[0];
  assert.equal(cls.name, 'Go');
  assert.equal(cls.superName, 'LinearOpMode');
  assert.deepEqual(cls.annotations.map((a) => a.name), ['Autonomous', 'Disabled']);
});

test('nested generics do not swallow the shift operators', () => {
  const code = emit(`
    java.util.Map<String, java.util.List<Double>> m = new java.util.HashMap<>();
    int a = 32;
    int shifted = a >> 2;
    int wide = a >>> 1;
    int up = a << 1;
    boolean cmp = a > 3;
  `);
  assert.match(code, /let shifted = \(a >> 2\)/);
  assert.match(code, /let wide = \(a >>> 1\)/);
  assert.match(code, /let up = \(a << 1\)/);
  assert.match(code, /let cmp = \(a > 3\)/);
});

test('a declaration and a comparison starting the same way are told apart', () => {
  // `a < b` is a comparison; `List<Double> c` is a declaration. Both here.
  const code = emit(`
    int a = 1, b = 2;
    boolean less = a < b;
    java.util.List<Double> c = new java.util.ArrayList<>();
  `);
  assert.match(code, /let less = \(a < b\)/);
  assert.match(code, /let c = __rt\.construct\("java\.util\.ArrayList"/);
});

test('an unsupported construct is named, with its line', () => {
  assert.throws(
    () => emit('Runnable r = new Runnable() { public void run() {} };'),
    (err) => /anonymous inner class/.test(err.message) && err.line > 0,
  );
  assert.throws(() => emit('int[] a = new int[2]; java.util.Arrays.stream(a);', 'interface Q {}'), /interface/);
});

// --------------------------------------------------------------- the emitter

test('integer division truncates and double division does not', () => {
  const code = emit(`
    int t = 5;
    int half = t / 2;
    double frac = t / 2.0;
    double also = ((double) t) / 2;
  `);
  assert.match(code, /let half = Math\.trunc\(t \/ 2\)/);
  assert.match(code, /let frac = \(t \/ 2\.0\)/);
  assert.match(code, /let also = \(t \/ 2\)/);
});

test('a cast to an integral type truncates toward zero', () => {
  const code = emit('int ticks = (int) (24.0 * 1.5); long l = (long) -2.7;');
  assert.match(code, /Math\.trunc\(\(24\.0 \* 1\.5\)\)/);
  assert.match(code, /Math\.trunc\(\(-2\.7\)\)/);
});

test('a method that sleeps or loops becomes a generator, transitively', () => {
  const source = `
@Autonomous(name = "T")
public class T extends LinearOpMode {
  public void runOpMode() { a(); }
  private void a() { b(); }
  private void b() { c(); }
  private void c() { sleep(10); }
  private double pure(double x) { return x * 2; }
}`;
  const code = compileJava([{ name: 'T.java', source }]).code;
  for (const name of ['runOpMode', 'a', 'b', 'c']) {
    assert.match(code, new RegExp(`\\*${name}\\(`), `${name} should be a generator`);
  }
  assert.match(code, /\n {2}pure\(x\)/, 'pure arithmetic stays a plain method');
  assert.match(code, /\(yield\* this\.a\(\)\)/);
});

test('a loop gets a scheduling point and a bare block does not', () => {
  const code = emit('while (opModeIsActive()) { telemetry.update(); } { int x = 1; }');
  assert.match(code, /while \(.*\) \{\n\s*yield 0;/);
  assert.equal((code.match(/yield 0;/g) ?? []).length, 1);
});

test('a class with no superclass does not call super', () => {
  const source = `
public class Helper {
  private int n = 3;
  public Helper(int n) { this.n = n; }
  public int get() { return n; }
}
@Autonomous(name = "T")
public class T extends LinearOpMode {
  public void runOpMode() { Helper h = new Helper(4); telemetry.addData("n", h.get()); }
}`;
  const { code } = compileJava([{ name: 'T.java', source }]);
  const helper = code.slice(code.indexOf('class Helper'), code.indexOf('class T'));
  assert.doesNotMatch(helper, /super\(/, 'a class that extends nothing cannot call super');
  assert.match(code, /class T extends __rt\.LinearOpMode/);
});

test('an explicit super call stays first', () => {
  const source = `
public class Base { public Base(int a) {} }
public class Sub extends Base {
  private int b = 1;
  public Sub(int a) { super(a); b = a; }
}
@Autonomous(name = "T")
public class T extends LinearOpMode { public void runOpMode() { Sub s = new Sub(1); } }`;
  const { code } = compileJava([{ name: 'T.java', source }]);
  const sub = code.slice(code.indexOf('class Sub'), code.indexOf('Sub.__blocking'));
  const superAt = sub.indexOf('super(');
  const fieldAt = sub.indexOf('this.b =');
  assert.ok(superAt >= 0 && superAt < fieldAt, 'super comes before the field initialisers');
  assert.equal((sub.match(/super\(/g) ?? []).length, 1, 'and only once');
});

test('the op-modes found are the annotated ones, minus the disabled', () => {
  const source = `
@Autonomous(name = "Red Far", group = "Red") public class A extends LinearOpMode { public void runOpMode() {} }
@Autonomous(name = "Red Near", group = "Red") public class B extends LinearOpMode { public void runOpMode() {} }
@TeleOp(name = "Drive") public class C extends OpMode { public void loop() {} }
@Autonomous(name = "Old") @Disabled public class D extends LinearOpMode { public void runOpMode() {} }
public class NotAnOpMode { }`;
  const { opModes } = compileJava([{ name: 'All.java', source }]);
  const live = opModes.filter((o) => !o.disabled);
  assert.deepEqual(live.map((o) => o.name).sort(), ['Drive', 'Red Far', 'Red Near']);
  assert.equal(opModes.find((o) => o.name === 'Drive').kind, 'teleop');
  assert.equal(opModes.find((o) => o.name === 'Drive').linear, false);
  assert.equal(opModes.find((o) => o.name === 'Old').disabled, true);
  assert.equal(opModes.length, 4, 'and a class that is not an op-mode is not one');
});

test('an abstract base that extends LinearOpMode still makes an op-mode', () => {
  const source = `
public abstract class AutoBase extends LinearOpMode {
  protected void go() { sleep(10); }
}
@Autonomous(name = "Real") public class Real extends AutoBase {
  public void runOpMode() { waitForStart(); go(); }
}`;
  const { opModes } = compileJava([{ name: 'A.java', source }]);
  const real = opModes.find((o) => o.className === 'Real');
  assert.ok(real, 'the subclass is an op-mode');
  assert.equal(real.linear, true);
});

// ------------------------------------------------------------- the detection

test('Java and JavaScript are told apart', () => {
  assert.equal(looksLikeJava('@Autonomous\npublic class A extends LinearOpMode {}'), true);
  assert.equal(looksLikeJava('package org.x;\nclass A {}'), true);
  assert.equal(looksLikeJava('import com.qualcomm.Foo;'), true);
  assert.equal(looksLikeJava('function* auto(robot) { yield 1; }'), false);
  assert.equal(looksLikeJava('const a = 1;\nfunction loop(robot, dt) {}'), false);
});

// ----------------------------------------------------------------- the shims

test('String.format does the conversions telemetry uses', () => {
  assert.equal(format('%.2f', 12.3456), '12.35');
  assert.equal(format('%d ticks', 537.9), '537 ticks');
  assert.equal(format('%-6s|', 'ab'), 'ab    |');
  assert.equal(format('%05.1f', 3.14159), '003.1');
  assert.equal(format('%s and %b', 'x', true), 'x and true');
  assert.equal(format('100%%'), '100%');
});

test('an enum is an object, so == and switch work', () => {
  const State = makeEnum('State', ['DRIVE', 'TURN']);
  assert.equal(State.DRIVE, State.valueOf('DRIVE'));
  assert.notEqual(State.DRIVE, State.TURN);
  assert.equal(State.TURN.ordinal(), 1);
  assert.equal(State.TURN.name(), 'TURN');
  assert.equal(State.values().length, 2);
});

test('a configuration name finds the right drive port', () => {
  const cases = [
    ['leftFront', 'frontLeft'],
    ['left_front', 'frontLeft'],
    ['frontLeftMotor', 'frontLeft'],
    ['lf', 'frontLeft'],
    ['leftBack', 'backLeft'],
    ['left_back', 'backLeft'],
    ['rearLeft', 'backLeft'],
    ['rr', 'backRight'],
    ['rb', 'backRight'],
    ['motor3', 'backRight'],
  ];
  for (const [name, port] of cases) {
    assert.equal(matchWheelName(name)?.port, port, name);
  }
  // A two-motor name drives both wheels on that side.
  assert.deepEqual(matchWheelName('leftDrive'), { port: 'frontLeft', also: ['backLeft'], strong: false });
  assert.equal(matchWheelName('shooter'), null);
});
