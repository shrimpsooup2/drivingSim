import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/config/Config.js';
import { Field } from '../src/field/Field.js';
import { Robot } from '../src/robot/Robot.js';
import { Ball } from '../src/physics/Ball.js';
import { BallWorld } from '../src/physics/BallWorld.js';
import { Intake } from '../src/robot/biobuzz/Intake.js';
import { Launcher } from '../src/robot/biobuzz/Launcher.js';
import { BiobuzzField } from '../src/field/biobuzz/BiobuzzField.js';
import { Flower } from '../src/field/biobuzz/Flower.js';
import {
  FLOWER_AXIS_OFFSET,
  NECTAR_MASS,
  NECTAR_RADIUS,
  POLLEN_MASS,
  POLLEN_RADIUS,
} from '../src/field/biobuzz/constants.js';
import { INCH } from '../src/math/MathUtil.js';

let n = 0;
const pollen = () =>
  new Ball({ id: `p${n++}`, kind: 'pollen', radius: POLLEN_RADIUS, mass: POLLEN_MASS });
const nectar = (alliance = 'red') =>
  new Ball({ id: `n${n++}`, kind: 'nectar', alliance, radius: NECTAR_RADIUS, mass: NECTAR_MASS });

function buildRobot() {
  const config = new Config().values;
  const robot = new Robot(config);
  robot.reset(0, 0, 0);
  return robot;
}

function withIntake() {
  const robot = buildRobot();
  const world = new BallWorld({ fieldSize: 144 * INCH, wallHeight: 12 * INCH });
  const intake = robot.addSubsystem(new Intake());
  intake.ballWorld = world;
  return { robot, intake, world };
}

/** Put a ball on the tiles a given distance straight ahead of the bumper. */
function placeAhead(robot, ball, ahead, lateral = 0) {
  const { cos, sin } = robot.body.rotation;
  const d = robot.halfLength + ahead;
  ball.setPosition(
    robot.body.position.x + cos * d - sin * lateral,
    robot.body.position.y + sin * d + cos * lateral,
    ball.radius,
  );
  ball.stop();
  return ball;
}

const runIntake = (intake, seconds = 0.5, dt = 1 / 200) => {
  for (let i = 0; i < seconds / dt; i++) intake.applyForces(dt, 12.5);
};

// ----------------------------------------------------------------- intake

test('the intake picks up an element in front of the bumper', () => {
  const { robot, intake, world } = withIntake();
  const ball = placeAhead(robot, pollen(), 2 * INCH);
  world.add(ball);

  intake.command = 1;
  runIntake(intake);

  assert.equal(intake.count, 1);
  assert.equal(ball.container?.kind, 'intake');
});

test('the intake ignores what is not in front of it', () => {
  const { robot, intake, world } = withIntake();
  const behind = placeAhead(robot, pollen(), -robot.halfLength * 2 - 4 * INCH);
  const beside = placeAhead(robot, pollen(), 1 * INCH, 14 * INCH);
  const high = placeAhead(robot, pollen(), 2 * INCH);
  high.setPosition(high.x, high.y, 20 * INCH);
  for (const b of [behind, beside, high]) world.add(b);

  intake.command = 1;
  runIntake(intake);

  assert.equal(intake.count, 0, 'behind, wide and overhead are all misses');
});

test('backing away from an element faster than the roller pulls loses it', () => {
  const { robot, intake, world } = withIntake();
  const ball = placeAhead(robot, pollen(), 3 * INCH);
  world.add(ball);

  // Reversing: the mouth is retreating from the ball.
  robot.body.velocity.set(-1.5, 0);
  intake.command = 1;
  runIntake(intake);
  assert.equal(intake.count, 0);

  // Same geometry, driving into it instead.
  robot.body.velocity.set(0.6, 0);
  runIntake(intake);
  assert.equal(intake.count, 1);
});

test('the intake fills to capacity and then stops taking', () => {
  const { robot, intake, world } = withIntake();
  intake.capacity = 2;
  for (let i = 0; i < 4; i++) {
    const ball = placeAhead(robot, pollen(), 2 * INCH, (i - 1.5) * 0.5 * INCH);
    world.add(ball);
  }
  intake.command = 1;
  runIntake(intake);
  assert.equal(intake.count, 2);
  assert.ok(intake.full);
});

test('the intake draws current from the same bus as the drivetrain', () => {
  const { intake } = withIntake();
  intake.command = 1;
  runIntake(intake, 0.4);
  assert.ok(intake.current > 0.2, `expected real current, got ${intake.current}`);
  assert.ok(intake.current < 40, 'and not an absurd amount');

  intake.command = 0;
  runIntake(intake, 1);
  assert.ok(intake.current < 0.5, 'an idle roller costs almost nothing');
});

test('carried elements add their mass to the robot', () => {
  const { robot, intake, world } = withIntake();
  const before = robot.body.mass;
  for (let i = 0; i < 3; i++) {
    const ball = placeAhead(robot, pollen(), 2 * INCH, (i - 1) * 0.4 * INCH);
    world.add(ball);
  }
  intake.command = 1;
  runIntake(intake);
  robot.updateMassProperties();
  assert.ok(robot.body.mass > before, 'three POLLEN is not nothing');
  assert.ok(Math.abs(robot.body.mass - before - 3 * POLLEN_MASS) < 1e-9);
});

test('the intake pulls POLLEN from a FLOWER but never NECTAR', () => {
  const { robot, intake } = withIntake();
  const flower = new Flower({ id: 'F', x: 0, y: -FLOWER_AXIS_OFFSET, facing: Math.PI / 2 });
  intake.flowers = [flower];
  for (let i = 0; i < 3; i++) flower.add(pollen());

  // Square up to the flower.
  robot.reset(0, -FLOWER_AXIS_OFFSET + robot.halfLength + 2 * INCH, -Math.PI / 2);
  intake.command = 1;
  runIntake(intake, 0.3);
  assert.ok(intake.count >= 1, 'collected from the retrieval opening');
  assert.ok(flower.stack.length < 3);

  // A NECTAR at the bottom blocks everything.
  const plugged = new Flower({ id: 'G', x: 0, y: -FLOWER_AXIS_OFFSET, facing: Math.PI / 2 });
  plugged.add(nectar('blue'));
  plugged.add(pollen());
  intake.flowers = [plugged];
  intake.held.length = 0;
  runIntake(intake, 0.3);
  assert.equal(intake.count, 0);
  assert.equal(plugged.stack.length, 2);
});

test('ejecting puts an element back on the tiles in front of the robot', () => {
  const { robot, intake, world } = withIntake();
  const ball = placeAhead(robot, pollen(), 2 * INCH);
  world.add(ball);
  intake.command = 1;
  runIntake(intake);
  assert.equal(intake.count, 1);

  intake.command = -1;
  runIntake(intake, 0.5);
  assert.equal(intake.count, 0);
  assert.ok(ball.free);
  const ahead = (ball.x - robot.body.position.x) * robot.body.rotation.cos;
  assert.ok(ahead > 0, 'it comes out the front');
});

// --------------------------------------------------------------- launcher

function withLauncher(opts = {}) {
  const robot = buildRobot();
  const launcher = robot.addSubsystem(new Launcher(opts));
  return { robot, launcher };
}

/**
 * How far back to shoot from. The up CELL is only 9.4 in off the field centre,
 * so anything much beyond this puts the robot through the perimeter wall.
 */
const STANDOFF = 1.5;

const spin = (launcher, seconds, dt = 1 / 1000) => {
  for (let i = 0; i < seconds / dt; i++) launcher.applyForces(dt, 12.5);
};

test('the flywheel reaches its target and holds it', () => {
  const { launcher } = withLauncher();
  launcher.spinning = true;
  spin(launcher, 4);
  assert.ok(
    Math.abs(launcher.rpm - launcher.targetRpm) < launcher.targetRpm * 0.02,
    `expected to settle on target, got ${launcher.rpm.toFixed(0)}`,
  );
  assert.ok(launcher.ready);
});

test('spin-up takes real time, set by motor torque against flywheel inertia', () => {
  const { launcher } = withLauncher();
  launcher.spinning = true;
  let t = 0;
  const dt = 1 / 1000;
  while (!launcher.ready && t < 10) {
    launcher.applyForces(dt, 12.5);
    t += dt;
  }
  assert.ok(t > 0.5, 'a flywheel does not come up instantly');
  assert.ok(t < 4, `and it should not crawl either, took ${t.toFixed(2)} s`);

  // Two motors on the shaft is the usual fix, and it should roughly halve it.
  const twin = withLauncher({ motorCount: 2 }).launcher;
  twin.spinning = true;
  let t2 = 0;
  while (!twin.ready && t2 < 10) {
    twin.applyForces(dt, 12.5);
    t2 += dt;
  }
  assert.ok(t2 < t * 0.75, `two motors should be much quicker: ${t2.toFixed(2)} vs ${t.toFixed(2)}`);
});

test('each shot takes speed out of the wheel, and NECTAR takes nearly twice as much', () => {
  const { launcher } = withLauncher();
  launcher.spinning = true;
  spin(launcher, 4);

  const before = launcher.rpm;
  launcher.launch(pollen());
  const dropPollen = before - launcher.rpm;
  assert.ok(dropPollen > 0, 'the wheel slows down');

  launcher.omega = (before * 2 * Math.PI) / 60;
  launcher.launch(nectar());
  const dropNectar = before - launcher.rpm;

  assert.ok(
    dropNectar > dropPollen * 1.5,
    `NECTAR is nearly twice the mass: ${dropNectar.toFixed(0)} vs ${dropPollen.toFixed(0)} rpm`,
  );
});

test('flywheel inertia sets the per-shot droop, which is why teams add it', () => {
  // Each shot takes angular momentum out of the wheel, and the fraction it
  // loses is J / (J + k*m*R^2). More inertia means a smaller bite, so a heavy
  // wheel gives more repeatable shots -- paid for in spin-up time.
  const measure = (inertia) => {
    const { launcher } = withLauncher({ inertia });
    launcher.spinning = true;
    spin(launcher, 20);
    const before = launcher.exitSpeed;
    launcher.launch(pollen());
    return { drop: 1 - launcher.lastExitSpeed / before, launcher };
  };

  const light = measure(8.3e-4);
  const heavy = measure(8.3e-4 * 4);

  assert.ok(light.drop > 0, 'a shot always costs the wheel something');
  assert.ok(
    heavy.drop < light.drop / 2,
    `four times the inertia should bite far less: ${(heavy.drop * 100).toFixed(1)}% vs ${(light.drop * 100).toFixed(1)}%`,
  );

  // NECTAR is nearly twice the mass of POLLEN, so it takes nearly twice as much.
  const { launcher } = withLauncher();
  launcher.spinning = true;
  spin(launcher, 20);
  const nominal = launcher.exitSpeed;
  const at = (omega) => {
    launcher.omega = omega;
  };
  const start = launcher.omega;
  launcher.launch(pollen());
  const dropPollen = 1 - launcher.lastExitSpeed / nominal;
  at(start);
  launcher.launch(nectar());
  const dropNectar = 1 - launcher.lastExitSpeed / nominal;
  assert.ok(dropNectar > dropPollen * 1.5, 'NECTAR costs nearly twice as much');
});

test('a feeder quicker than the wheel can recover throws the later shots short', () => {
  // The stock feeder takes 0.35 s and the stock wheel is back inside 0.25 s, so
  // the default robot cannot outrun itself. Speed the feeder up past recovery
  // and the shots walk downward.
  const { launcher } = withLauncher({ feedInterval: 0.08 });
  launcher.spinning = true;
  spin(launcher, 20);

  const speeds = [];
  for (let i = 0; i < 5; i++) {
    launcher.launch(pollen());
    speeds.push(launcher.lastExitSpeed);
    spin(launcher, launcher.feedInterval);
  }
  assert.ok(
    speeds[4] < speeds[0] * 0.95,
    `the fifth shot should be well short: ${speeds[4].toFixed(2)} vs ${speeds[0].toFixed(2)}`,
  );
  for (let i = 1; i < speeds.length; i++) {
    assert.ok(speeds[i] <= speeds[i - 1] + 1e-6, 'and each one is slower than the last');
  }

  // Waiting for `ready` instead holds them all together.
  spin(launcher, 4);
  const paced = [];
  for (let i = 0; i < 5; i++) {
    while (!launcher.ready) launcher.applyForces(1 / 1000, 12.5);
    launcher.launch(pollen());
    paced.push(launcher.lastExitSpeed);
  }
  const spread = Math.max(...paced) - Math.min(...paced);
  // A shot can fire anywhere inside the ready band, so that band is the floor
  // on how tight paced shots can be.
  const band = (1 - launcher.readyTolerance) * Math.max(...paced);
  assert.ok(
    spread <= band * 1.2,
    `paced spread ${spread.toFixed(3)} should sit inside the ready band ${band.toFixed(3)} m/s`,
  );
  assert.ok(Math.min(...paced) > Math.min(...speeds), 'and they beat rapid fire');
});

test('the ballistics solver agrees with the simulated flight', () => {
  const field = new Field(new Config().values);
  const bb = new BiobuzzField({ field });
  const { robot, launcher } = withLauncher();
  launcher.ballWorld = bb.ballWorld;

  const target = bb.hiveTarget('red');
  robot.reset(target.x, target.y - STANDOFF, Math.PI / 2);

  // A CELL faces up, so the shot has to arrive descending; `aimAt` picks a
  // hood angle where it does.
  assert.ok(launcher.aimAt(target), 'the shot is makeable from this standoff');
  launcher.spinning = true;
  while (!launcher.ready) launcher.applyForces(1 / 1000, 12.5);

  const ball = bb.pollen.find((b) => b.container?.kind === 'preload');
  ball.release();
  launcher.launch(ball);

  let landed = false;
  for (let i = 0; i < 1500 && !landed; i++) {
    bb.update(1 / 500, { inAuto: false });
    landed = ball.container?.kind === 'cell';
  }
  assert.ok(landed, 'the shot the solver called for actually goes in');
});

test('shooting on the move misses, because the ball keeps the robot velocity', () => {
  const field = new Field(new Config().values);
  const bb = new BiobuzzField({ field });
  const { robot, launcher } = withLauncher();
  launcher.ballWorld = bb.ballWorld;

  const target = bb.hiveTarget('red');
  /** @returns {string|null} which CELL took the shot, if any */
  const fireFrom = (vx) => {
    robot.reset(target.x, target.y - STANDOFF, Math.PI / 2);
    robot.body.velocity.set(vx, 0);
    assert.ok(launcher.aimAt(target));
    launcher.spinning = true;
    launcher.omega = (launcher.targetRpm * 2 * Math.PI) / 60;

    const ball = bb.pollen.find((b) => b.container?.kind === 'preload');
    ball.release();
    launcher.launch(ball);
    for (let i = 0; i < 1500; i++) {
      bb.update(1 / 500, { inAuto: false });
      if (ball.container?.kind === 'cell') return ball.container.ref.alliance;
    }
    return null;
  };

  assert.equal(fireFrom(0), 'red', 'stopped, it goes in');

  bb.setup();
  assert.notEqual(
    fireFrom(1.6),
    'red',
    'sliding sideways at 1.6 m/s, the same shot does not score for you',
  );
});

test('sideways speed walks the shot off target in proportion', () => {
  const field = new Field(new Config().values);
  const bb = new BiobuzzField({ field });
  const { robot, launcher } = withLauncher();
  launcher.ballWorld = bb.ballWorld;
  const target = bb.hiveTarget('red');

  /**
   * Furthest the ball strays sideways during its flight, and whether the CELL
   * took it. Sampled only while the ball is still free: once a CELL catches it,
   * the HIVE restacks it inside and its position no longer means anything about
   * the shot.
   */
  const shoot = (vx) => {
    bb.setup();
    robot.reset(target.x, target.y - STANDOFF, Math.PI / 2);
    robot.body.velocity.set(vx, 0);
    assert.ok(launcher.aimAt(target), 'the shot is makeable');
    launcher.spinning = true;
    launcher.omega = (launcher.targetRpm * 2 * Math.PI) / 60;

    const ball = bb.pollen.find((b) => b.container?.kind === 'preload');
    ball.release();
    launcher.launch(ball);

    let drift = 0;
    for (let i = 0; i < 900; i++) {
      bb.update(1 / 500, { inAuto: false });
      if (!ball.free) {
        // Whose CELL matters: the two HIVES are 25.4 in apart on one crossbar,
        // so a drifting shot can land in the opponent's and tip it for them.
        return {
          drift,
          scored: ball.container.kind === 'cell' && ball.container.ref.alliance === 'red',
          landedIn: ball.container.kind === 'cell' ? ball.container.ref.alliance : ball.container.kind,
        };
      }
      drift = Math.max(drift, Math.abs(ball.x - target.x));
      if (ball.z <= ball.radius + 1e-6 && i > 10) break;
    }
    return { drift, scored: false };
  };

  const still = shoot(0);
  const nudge = shoot(0.4);
  const slow = shoot(0.8);
  const fast = shoot(1.6);

  assert.ok(still.scored, 'stopped, the shot goes in');
  assert.ok(still.drift < 0.01, `and it flies dead straight: ${still.drift.toFixed(4)} m`);

  // The opening is 20 in wide, so a small drift is survivable -- which is
  // worth knowing, because it means the failure is not gradual.
  assert.ok(nudge.drift > still.drift + 0.05, 'drifting pushes it off line');
  assert.ok(nudge.scored, 'but 0.4 m/s is still inside a 20 in aperture');

  assert.ok(slow.drift > nudge.drift * 1.8, 'twice the speed, far more than twice the miss');
  assert.ok(!slow.scored, 'and 0.8 m/s is already outside it');
  assert.ok(fast.drift > slow.drift, 'faster still is further off');
  assert.ok(!fast.scored);
});

test('a CELL only accepts a descending ball, so close shots need a steep hood', () => {
  const field = new Field(new Config().values);
  const bb = new BiobuzzField({ field });
  const { robot, launcher } = withLauncher();
  const target = bb.hiveTarget('red');
  robot.reset(target.x, target.y - STANDOFF, Math.PI / 2);

  // A flat shot can reach the CELL, but it gets there still climbing.
  const flat = launcher.solutionFor(target, (45 * Math.PI) / 180);
  assert.ok(flat, 'reachable at 45 degrees');
  assert.equal(flat.descending, false, 'but arriving on the way up');

  // The threshold is tan(hood) > 2 * rise / range, and the solver agrees.
  const needed = Math.atan((2 * flat.rise) / flat.range);
  const justUnder = launcher.solutionFor(target, needed - 0.02);
  const justOver = launcher.solutionFor(target, needed + 0.02);
  assert.equal(justUnder.descending, false);
  assert.equal(justOver.descending, true);

  const aimed = launcher.aimFor(target);
  assert.ok(aimed && aimed.descending);
  assert.ok(aimed.angle > needed, 'the chosen hood clears the threshold');
  assert.ok(aimed.rpm <= launcher.maxRpm);
});

test('there is a minimum standoff below which the CELL cannot be hit at all', () => {
  const field = new Field(new Config().values);
  const bb = new BiobuzzField({ field });
  const { robot, launcher } = withLauncher();
  const target = bb.hiveTarget('red');

  // Right under the HIVE you would have to shoot almost straight up.
  robot.reset(target.x, target.y - 0.7, Math.PI / 2);
  assert.equal(launcher.aimFor(target), null, 'too close to make the shot');

  robot.reset(target.x, target.y - 1.2, Math.PI / 2);
  assert.ok(launcher.aimFor(target), 'backing off a little makes it possible');
});

test('the launcher draws current and reports what a driver needs to see', () => {
  const { launcher } = withLauncher();
  launcher.spinning = true;
  let peak = 0;
  for (let i = 0; i < 2000; i++) {
    peak = Math.max(peak, launcher.applyForces(1 / 1000, 12.5));
  }
  assert.ok(peak > 1, 'spinning a flywheel up costs current');
  const t = launcher.telemetry();
  assert.ok('Shooter RPM' in t && 'Hood angle' in t && 'Shooter ready' in t);
});
