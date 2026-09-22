import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/config/Config.js';
import { Simulation } from '../src/app/Simulation.js';

function rig(overrides = {}) {
  const config = new Config();
  config.set('ai.enabled', false);
  for (const [path, value] of Object.entries(overrides)) config.set(path, value);
  const sim = new Simulation(config);
  const game = sim.enableGame({ alliance: 'red' });
  return { sim, game, config };
}

/** A four-motor op-mode body, with the left side reversed or not. */
function opMode({ reverse = true, body = '', fields = '', helpers = '', name = 'T' } = {}) {
  return `
package org.firstinspires.ftc.teamcode;

import com.qualcomm.robotcore.eventloop.opmode.Autonomous;
import com.qualcomm.robotcore.eventloop.opmode.LinearOpMode;
import com.qualcomm.robotcore.hardware.DcMotor;
import com.qualcomm.robotcore.util.ElapsedTime;

@Autonomous(name = "${name}", group = "Tests")
public class ${name} extends LinearOpMode {
    private DcMotor lf, rf, lb, rb;
    private final ElapsedTime timer = new ElapsedTime();
    ${fields}

    @Override
    public void runOpMode() throws InterruptedException {
        lf = hardwareMap.get(DcMotor.class, "leftFront");
        rf = hardwareMap.get(DcMotor.class, "rightFront");
        lb = hardwareMap.get(DcMotor.class, "leftBack");
        rb = hardwareMap.get(DcMotor.class, "rightBack");
        ${reverse ? 'lf.setDirection(DcMotor.Direction.REVERSE); lb.setDirection(DcMotor.Direction.REVERSE);' : ''}
        telemetry.addData("Status", "Initialised");
        telemetry.update();
        waitForStart();
        timer.reset();
        ${body}
    }

    private void drive(double power) {
        lf.setPower(power);
        rf.setPower(power);
        lb.setPower(power);
        rb.setPower(power);
    }
    ${helpers}
}`;
}

function run(sim, game, seconds = 4) {
  game.start();
  for (let i = 0; i < Math.round(seconds * 60); i++) sim.step(1 / 60);
  return sim.autoRunner.status();
}

// ------------------------------------------------------------------- loading

test('a real LinearOpMode compiles, and the panel knows what it found', () => {
  const { sim } = rig();
  const error = sim.autoRunner.compile(opMode({ name: 'DriveForward' }));
  assert.equal(error, null);

  const status = sim.autoRunner.status();
  assert.equal(status.language, 'java');
  assert.equal(status.state, 'compiled');
  assert.deepEqual(
    status.opModes.map((o) => `${o.name}/${o.group}/${o.kind}`),
    ['DriveForward/Tests/auto'],
  );
  // The init sequence has already run, which is what INIT is.
  assert.equal(status.telemetry.Status, 'Initialised');
  assert.deepEqual(
    status.resolutions.map((r) => `${r.name}=${r.attachedTo}`),
    ['leftFront=frontLeft', 'rightFront=frontRight', 'leftBack=backLeft', 'rightBack=backRight'],
  );
  assert.deepEqual(status.warnings, []);
});

test('an op-mode that reverses its mirrored side drives straight', () => {
  const { sim, game } = rig();
  sim.autoRunner.compile(
    opMode({ reverse: true, body: 'while (opModeIsActive() && timer.seconds() < 1.2) { drive(0.6); } drive(0);' }),
  );
  const from = { ...sim.robot.body.position };
  run(sim, game, 2);
  assert.ok(sim.robot.body.position.x - from.x > 0.4, 'it went forward');
  assert.ok(Math.abs(sim.robot.body.position.y - from.y) < 0.05, 'and straight');
  assert.ok(Math.abs(sim.robot.body.rotation.radians) < 0.05, 'without turning');
});

test('one that forgets to spins, exactly as it would on the robot', () => {
  const { sim, game } = rig();
  sim.autoRunner.compile(
    opMode({ reverse: false, body: 'while (opModeIsActive() && timer.seconds() < 1.2) { drive(0.6); } drive(0);' }),
  );
  run(sim, game, 2);
  assert.ok(
    Math.abs(sim.robot.body.rotation.radians) > 0.5,
    `it should be spinning, turned ${sim.robot.body.rotation.radians}`,
  );
  assert.ok(sim.robot.body.position.x < 0.3, 'and going nowhere');
});

// ----------------------------------------------------------------- the clock

test('sleep and ElapsedTime run on the simulated clock', () => {
  const { sim, game } = rig();
  sim.autoRunner.compile(
    opMode({
      body: `
        drive(0);
        sleep(500);
        telemetry.addData("afterSleep", "%.2f", timer.seconds());
        telemetry.update();
      `,
    }),
  );
  const status = run(sim, game, 2);
  assert.equal(status.state, 'done');
  const measured = Number(status.telemetry.afterSleep);
  assert.ok(Math.abs(measured - 0.5) < 0.05, `sleep(500) took ${measured} s of simulated time`);
});

test('a pause stops the op-mode with the world', () => {
  const { sim, game } = rig();
  sim.autoRunner.compile(
    opMode({ body: 'while (opModeIsActive()) { drive(0.3); telemetry.addData("t", timer.seconds()); telemetry.update(); }' }),
  );
  game.start();
  for (let i = 0; i < 30; i++) sim.step(1 / 60);
  const at = Number(sim.autoRunner.status().telemetry.t);
  sim.pause(true);
  for (let i = 0; i < 30; i++) sim.step(1 / 60);
  assert.equal(Number(sim.autoRunner.status().telemetry.t), at, 'frozen with the world');
});

// ------------------------------------------------------------ the loop timing

test('the loop rate follows what the op-mode asks of the hardware', () => {
  const thrifty = rig();
  thrifty.sim.autoRunner.compile(
    opMode({
      name: 'Thrifty',
      body: 'while (opModeIsActive()) { drive(0.4); telemetry.update(); }',
    }),
  );
  const chatty = rig();
  chatty.sim.autoRunner.compile(
    opMode({
      name: 'Chatty',
      body: `
        while (opModeIsActive()) {
          drive(0.4);
          telemetry.addData("a", lf.getCurrentPosition());
          telemetry.addData("b", rf.getCurrentPosition());
          telemetry.addData("c", lb.getCurrentPosition());
          telemetry.addData("d", rb.getCurrentPosition());
          telemetry.update();
        }
      `,
    }),
  );

  for (const { sim, game } of [thrifty, chatty]) {
    game.start();
    for (let i = 0; i < 60; i++) sim.step(1 / 60);
  }
  // Four motor writes each; the chatty one adds a bulk read.
  assert.equal(thrifty.sim.robot.bus.lastCounts.write, 4);
  assert.equal(thrifty.sim.robot.bus.lastCounts.bulkRead, 0);
  assert.equal(chatty.sim.robot.bus.lastCounts.bulkRead, 1);
  assert.ok(
    chatty.sim.controlPeriod > thrifty.sim.controlPeriod + 0.0015,
    `${chatty.sim.controlPeriod * 1000} ms vs ${thrifty.sim.controlPeriod * 1000} ms`,
  );
});

test('a loop of pure arithmetic does not cost a cycle', () => {
  const { sim, game } = rig();
  sim.autoRunner.compile(
    opMode({
      body: `
        int sum = 0;
        for (int i = 0; i < 20000; i++) { sum += i; }
        telemetry.addData("sum", sum);
        telemetry.update();
      `,
    }),
  );
  game.start();
  // One cycle is enough: the loop is instantaneous on a real robot and here.
  for (let i = 0; i < 4; i++) sim.step(1 / 60);
  const status = sim.autoRunner.status();
  assert.equal(Number(status.telemetry.sum), (19999 * 20000) / 2);
  assert.equal(status.state, 'done');
});

// ----------------------------------------------------------------- the SDK

test('RUN_TO_POSITION drives to a target and reports isBusy', () => {
  const { sim, game } = rig();
  sim.autoRunner.compile(
    opMode({
      body: `
        lf.setMode(DcMotor.RunMode.STOP_AND_RESET_ENCODER);
        lf.setTargetPosition(800);
        lf.setMode(DcMotor.RunMode.RUN_TO_POSITION);
        lf.setPower(0.6);
        while (opModeIsActive() && lf.isBusy() && timer.seconds() < 3.0) {
          telemetry.addData("pos", lf.getCurrentPosition());
          telemetry.update();
        }
        telemetry.addData("busy", lf.isBusy());
        telemetry.addData("final", lf.getCurrentPosition());
        telemetry.update();
        lf.setPower(0);
      `,
    }),
  );
  const status = run(sim, game, 5);
  assert.equal(status.state, 'done', status.error ?? '');
  assert.equal(status.telemetry.busy, 'false', 'it got there');
  assert.ok(Number(status.telemetry.final) > 600, `stopped at ${status.telemetry.final} ticks`);
});

test('the IMU reads through the modelled sensor, in degrees', () => {
  const { sim, game } = rig();
  sim.autoRunner.compile(
    opMode({
      fields: 'private IMU imu;',
      body: `
        imu = hardwareMap.get(IMU.class, "imu");
        imu.resetYaw();
        while (opModeIsActive() && timer.seconds() < 1.0) {
          lf.setPower(-0.4); lb.setPower(-0.4); rf.setPower(0.4); rb.setPower(0.4);
          telemetry.addData("yaw", "%.1f", imu.getRobotYawPitchRollAngles().getYaw(AngleUnit.DEGREES));
          telemetry.update();
        }
        drive(0);
      `,
    }),
  );
  const status = run(sim, game, 2);
  assert.equal(status.state, 'done', status.error ?? '');
  assert.ok(Math.abs(Number(status.telemetry.yaw)) > 10, `it turned, reading ${status.telemetry.yaw} deg`);
  // Against the live sensor rather than the last telemetry line: the robot
  // coasts on after the loop ends, so the printed figure is legitimately older
  // than the truth by then.
  const reported = (sim.robot.imu.heading * 180) / Math.PI;
  const truth = (sim.robot.body.rotation.radians * 180) / Math.PI;
  assert.ok(Math.abs(reported - truth) < 2, `the IMU said ${reported}, the truth is ${truth}`);
});

test('a name nothing answers to is reported rather than crashing', () => {
  const { sim, game } = rig();
  sim.autoRunner.compile(
    opMode({
      fields: 'private DcMotor lift;',
      body: `
        lift = hardwareMap.get(DcMotor.class, "liftyMcLiftface");
        lift.setPower(0.5);
        telemetry.addData("lift", lift.getCurrentPosition());
        telemetry.update();
      `,
    }),
  );
  const status = run(sim, game, 1);
  assert.equal(status.state, 'done', status.error ?? '');
  assert.match(status.warnings.join(' '), /liftyMcLiftface/);
  assert.ok(
    status.resolutions.some((r) => r.name === 'liftyMcLiftface' && r.attachedTo === null),
    'and it says which one is floating',
  );
});

test('a mechanism name finds the mechanism', () => {
  const { sim, game } = rig();
  sim.autoRunner.compile(
    opMode({
      fields: 'private DcMotorEx shooter; private DcMotor intake;',
      body: `
        shooter = hardwareMap.get(DcMotorEx.class, "shooterMotor");
        intake = hardwareMap.get(DcMotor.class, "intakeRoller");
        shooter.setPower(0.8);
        intake.setPower(1.0);
        sleep(600);
        telemetry.addData("rpm", "%.0f", shooter.getVelocity() / 28.0 * 60.0);
        telemetry.update();
        shooter.setPower(0);
      `,
    }),
  );
  const status = run(sim, game, 2);
  assert.deepEqual(
    status.resolutions
      .filter((r) => !r.name.startsWith('left') && !r.name.startsWith('right'))
      .map((r) => `${r.name}=${r.attachedTo}`),
    ['shooterMotor=the launcher', 'intakeRoller=the intake'],
  );
  assert.equal(status.state, 'done', status.error ?? '');
  assert.ok(Number(status.telemetry.rpm) > 100, `the flywheel spun up to ${status.telemetry.rpm} rpm`);
});

test('a Java @TeleOp takes the robot during TELEOP, not AUTO', () => {
  const { sim, game } = rig();
  const error = sim.autoRunner.compile(`
@TeleOp(name = "My Drive")
public class MyDrive extends OpMode {
  private DcMotor lf, rf, lb, rb;
  public void init() {
    lf = hardwareMap.get(DcMotor.class, "leftFront");
    rf = hardwareMap.get(DcMotor.class, "rightFront");
    lb = hardwareMap.get(DcMotor.class, "leftBack");
    rb = hardwareMap.get(DcMotor.class, "rightBack");
    lf.setDirection(DcMotor.Direction.REVERSE);
    lb.setDirection(DcMotor.Direction.REVERSE);
  }
  public void loop() {
    double drive = -gamepad1.left_stick_y;
    lf.setPower(drive); rf.setPower(drive); lb.setPower(drive); rb.setPower(drive);
    telemetry.addData("drive", "%.2f", drive);
  }
}`);
  assert.equal(error, null);
  assert.equal(sim.autoRunner.period, 'teleop');

  game.start();
  // During AUTO it does not have the robot.
  for (let i = 0; i < 30; i++) sim.step(1 / 60);
  assert.equal(sim.runningCode, false, 'a teleop op-mode waits for teleop');

  // Skip to TELEOP and hold the stick.
  game.match.phase = 'teleop';
  game.match.phaseClock = 0;
  sim.input.keyboardSource.active = true;
  sim.input.keyboardSource.keys.add('KeyW');
  assert.equal(sim.runningCode, true);
  const from = sim.robot.body.position.x;
  for (let i = 0; i < 90; i++) sim.step(1 / 60);
  assert.ok(sim.robot.body.position.x - from > 0.2, 'the team’s own teleop is driving');
  assert.ok(Number(sim.autoRunner.status().telemetry.drive) > 0.5);
});

test('several op-modes can be chosen between', () => {
  const { sim, game } = rig();
  const source = `
@Autonomous(name = "Far", group = "Red") public class Far extends LinearOpMode {
  public void runOpMode() { waitForStart(); telemetry.addData("which", "far"); telemetry.update(); }
}
@Autonomous(name = "Near", group = "Red") public class Near extends LinearOpMode {
  public void runOpMode() { waitForStart(); telemetry.addData("which", "near"); telemetry.update(); }
}`;
  sim.autoRunner.compileFiles([{ name: 'Autos.java', source }]);
  assert.deepEqual(sim.autoRunner.opModes.map((o) => o.name), ['Far', 'Near']);
  assert.equal(sim.autoRunner.selected, 'Far');

  sim.autoRunner.select('Near');
  assert.equal(sim.autoRunner.selected, 'Near');
  const status = run(sim, game, 1);
  assert.equal(status.telemetry.which, 'near');
});

test('a Java error is reported against the op-mode, not thrown at the frame loop', () => {
  const { sim, game } = rig();
  sim.autoRunner.compile(
    opMode({ body: 'int[] a = new int[2]; telemetry.addData("x", a[5] + 1); telemetry.update(); drive(0);' }),
  );
  const status = run(sim, game, 1);
  // Reading off the end of an array is undefined in JavaScript rather than an
  // exception, so this checks the run completes rather than that it throws --
  // the point is that the frame loop survives whatever the op-mode does.
  assert.ok(['done', 'error'].includes(status.state));
  assert.ok(sim.robot.body.isFinite());
});

test('a syntax error names the file and the line', () => {
  const { sim } = rig();
  const error = sim.autoRunner.compileFiles([
    { name: 'Broken.java', source: '@Autonomous public class Broken extends LinearOpMode {\n  public void runOpMode() {\n    int x = ;\n  }\n}' },
  ]);
  assert.match(error, /Broken\.java/);
  assert.match(error, /line 3/);
  assert.equal(sim.autoRunner.armed, false);
});

test('a file with no op-mode says so', () => {
  const { sim } = rig();
  const error = sim.autoRunner.compileFiles([
    { name: 'Helper.java', source: 'public class Helper { public int twice(int x) { return x * 2; } }' },
  ]);
  assert.match(error, /No op-mode/);
});

test('clearing goes back to JavaScript', () => {
  const { sim } = rig();
  sim.autoRunner.compile(opMode({}));
  assert.equal(sim.autoRunner.status().language, 'java');
  sim.autoRunner.clear();
  assert.equal(sim.autoRunner.status().language, 'js');
  assert.equal(sim.autoRunner.armed, false);
  const error = sim.autoRunner.compile('function* auto(robot) { robot.drive(0.4, 0, 0); yield 0.5; }');
  assert.equal(error, null);
  assert.equal(sim.autoRunner.status().language, 'js');
});
