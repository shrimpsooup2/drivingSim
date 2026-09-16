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
  // Measured on the *wheel*, not on the ball.
  //
  // This used to compare `launcher.exitSpeed` before the shot against
  // `lastExitSpeed` after it, and those two are the same expression -- both
  // are `k * R * J * omega / (J + k * m * R^2)`, written in a different order.
  // So it was asserting the sign of a floating-point rounding difference, and
  // it passed for two years because that rounding happened to come out
  // positive at the old masses. Correcting them made it come out zero, which
  // is how a test that never measured anything got found.
  //
  // What the droop actually is: the wheel's own speed loss when the ball takes
  // angular momentum away.
  const measure = (inertia) => {
    const { launcher } = withLauncher({ inertia });
    launcher.spinning = true;
    spin(launcher, 20);
    const before = launcher.omega;
    launcher.launch(pollen());
    return { drop: 1 - launcher.omega / before, launcher };
  };

  const light = measure(8.3e-4);
  const heavy = measure(8.3e-4 * 4);

  assert.ok(
    light.drop > 0.01,
    `a shot has to cost the wheel real speed, got ${(light.drop * 100).toFixed(3)}%`,
  );
  assert.ok(
    heavy.drop < light.drop / 2,
    `four times the inertia should bite far less: ${(heavy.drop * 100).toFixed(1)}% vs ${(light.drop * 100).toFixed(1)}%`,
  );

  // NECTAR is two thirds again the mass of POLLEN, so it takes that much more.
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

  // A flat shot gets there still climbing, and the geometry of *how* flat is
  // the point. At 45 degrees from 1.5 m the CELL is nearly as high as it is far,
  // so the arc has to be so shallow that it needs 14 m/s -- more than the wheel
  // can produce -- and the solver says so rather than offering an RPM the
  // mechanism does not have.
  const flat = launcher.freeSolutionFor(target, (45 * Math.PI) / 180);
  assert.ok(flat, 'the geometry has a 45 degree answer');
  assert.equal(flat.descending, false, 'but it arrives on the way up');
  assert.ok(flat.rpm > launcher.maxRpm, `and it wants ${flat.rpm.toFixed(0)} rpm`);
  assert.equal(launcher.solutionFor(target, (45 * Math.PI) / 180), null);

  // The bare geometry puts the threshold at tan(hood) = 2 * rise / range --
  // where the apex lands exactly on the target -- and the solver wants more
  // than that, because an arc peaking *at* the aperture arrives level and
  // clips the lower lip of the tilted opening on the way in. So just under is
  // refused, just over is *still* refused, and a hood a few degrees steeper
  // than the bare threshold is where a shot actually exists. See
  // `Launcher.apexMargin`: without it a perfectly aimed shot went in 55% of
  // the time instead of 62%.
  //
  // Where exactly that lands depends on the drag, and correcting the element
  // masses moved it: air now takes about twice as much out of a shot, which
  // brings the apex forward, so a descending arrival exists at a shallower
  // hood than it used to. The boundary is between +0.01 and +0.02 rad past the
  // bare geometric threshold, where it was between +0.02 and +0.06.
  const needed = Math.atan((2 * flat.rise) / flat.range);
  assert.equal(launcher.solutionFor(target, needed - 0.02).descending, false);
  assert.equal(
    launcher.solutionFor(target, needed + 0.01).descending,
    false,
    'peaking on the target is not enough: the lip reaches toward the shooter',
  );
  const clear = launcher.solutionFor(target, needed + 0.02);
  assert.equal(clear.descending, true);
  assert.ok(
    clear.range - clear.apexRange >= launcher.apexMargin,
    `apex ${(clear.range - clear.apexRange).toFixed(3)} m before the target, ` +
      `against a ${launcher.apexMargin.toFixed(3)} m lip`,
  );

  // Drag makes every one of those shots need more speed than free flight
  // would. Not much at this range -- a few percent -- but it is the right
  // sign, and it is the same integration the ball world runs, so the guide and
  // the shot cannot disagree.
  const withDrag = launcher.solutionFor(target, needed + 0.05);
  const withoutDrag = launcher.freeSolutionFor(target, needed + 0.05);
  assert.ok(
    withDrag.speed > withoutDrag.speed,
    `drag needs ${withDrag.speed.toFixed(2)} against ${withoutDrag.speed.toFixed(2)} m/s in vacuum`,
  );
  assert.ok(withDrag.speed < withoutDrag.speed * 1.2, 'but not absurdly more');

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

test('nothing stops you firing early -- it just throws short', () => {
  // The gate used to refuse the shot, which made the whole recovery model
  // invisible: you could not throw one short, so there was nothing to learn
  // from the bar and "wait for the wheel" was enforced rather than taught. A
  // real robot has no idea whether its flywheel is up to speed.
  const launcher = new Launcher();
  const intake = new Intake();
  const robot = new Robot(new Config().values);
  robot.addSubsystem(intake);
  robot.addSubsystem(launcher);
  launcher.intake = intake;
  robot.reset(0, 0, 0);

  const speeds = [];
  for (const fraction of [0.4, 0.7, 1]) {
    intake.give(pollen(`p${fraction}`));
    launcher.spinning = true;
    launcher.omega = (launcher.targetRpm * fraction * 2 * Math.PI) / 60;
    const wasReady = launcher.ready;
    launcher.fire();
    launcher.applyForces(1 / 1000, 12.5);
    assert.equal(launcher.shots, speeds.length + 1, `a ${fraction} shot should have fired`);
    if (fraction < 0.97) assert.equal(wasReady, false, 'and it was not ready');
    speeds.push(launcher.lastExitSpeed);
    launcher._feedTimer = 0;
  }

  // Slower wheel, slower ball, monotonically.
  assert.ok(speeds[0] < speeds[1] && speeds[1] < speeds[2], speeds.join(' < '));
  assert.ok(
    speeds[0] < speeds[2] * 0.5,
    `a 40 percent wheel should throw at well under half speed, got ${speeds[0].toFixed(2)} vs ${speeds[2].toFixed(2)}`,
  );
});

test('the feeder still limits the cycle, because that is mechanical', () => {
  const launcher = new Launcher({ feedInterval: 0.4 });
  const intake = new Intake();
  const robot = new Robot(new Config().values);
  robot.addSubsystem(intake);
  robot.addSubsystem(launcher);
  launcher.intake = intake;
  robot.reset(0, 0, 0);
  intake.give(pollen('a'));
  intake.give(pollen('b'));
  launcher.spinning = true;
  launcher.omega = 250;

  launcher.fire();
  launcher.applyForces(1 / 1000, 12.5);
  assert.equal(launcher.shots, 1);
  launcher.fire();
  launcher.applyForces(1 / 1000, 12.5);
  assert.equal(launcher.shots, 1, 'the feeder has not come round yet');
  for (let i = 0; i < 500; i++) launcher.applyForces(1 / 1000, 12.5);
  launcher.fire();
  launcher.applyForces(1 / 1000, 12.5);
  assert.equal(launcher.shots, 2);
});

test('the flywheel spins up and idles like a real one', () => {
  // Calibrated against the two numbers a team can actually read: how long it
  // takes to come up, and what it draws holding speed. A single bare 5202
  // direct-driving a 4 in wheel with a flywheel mass on it is about two
  // seconds and under an amp. The drag used to be 2.5e-5, which idled at
  // 0.13 A -- a frictionless wheel, and the reason recovery cost nothing.
  const launcher = new Launcher();
  launcher.robot = { config: {} };
  launcher.spinning = true;

  let time = 0;
  let peak = 0;
  let ready = null;
  const dt = 1 / 2000;
  for (let i = 0; i < 2000 * 6; i++) {
    launcher.applyForces(dt, 12.8);
    time += dt;
    peak = Math.max(peak, launcher.current);
    if (ready === null && launcher.rpm >= launcher.targetRpm * launcher.readyTolerance) {
      ready = time;
    }
  }
  assert.ok(ready > 1.5 && ready < 3, `spin-up took ${ready.toFixed(2)} s, expected about 2`);
  assert.ok(peak > 8 && peak < 12, `peak draw ${peak.toFixed(1)} A, expected near the 9.2 A stall`);
  assert.ok(
    launcher.current > 0.4 && launcher.current < 2,
    `idles at ${launcher.current.toFixed(2)} A holding ${launcher.rpm.toFixed(0)} rpm`,
  );

  // The rotors are part of what has to be accelerated.
  assert.ok(launcher.effectiveInertia > launcher.inertia);
  const geared = new Launcher({ gearRatio: 2 });
  assert.ok(
    geared.effectiveInertia - geared.inertia < launcher.effectiveInertia - launcher.inertia,
    'gearing up shrinks the reflected rotor inertia as its square',
  );
});

test('a flywheel coasting down from a higher setting is not ready', () => {
  const launcher = new Launcher({ targetRpm: 1400 });
  launcher.spinning = true;
  launcher.omega = (1400 * 2 * Math.PI) / 60;
  assert.ok(launcher.ready, 'on target');

  // Fourteen percent fast. Exit speed goes with RPM and range with its square,
  // so this puts the element a third of a metre past a 20 in aperture -- and
  // the old one-sided test called it ready, so two thirds of an AI robot's
  // shots were fired over the commanded speed and sailed over the CELL.
  launcher.omega = (1600 * 2 * Math.PI) / 60;
  assert.equal(launcher.ready, false, 'over the commanded speed is not ready');
  assert.ok(launcher.overSpeed);

  launcher.omega = (1100 * 2 * Math.PI) / 60;
  assert.equal(launcher.ready, false, 'and neither is under it');

  // A wheel that is not spinning is never ready, whatever it reads.
  launcher.spinning = false;
  launcher.omega = (1400 * 2 * Math.PI) / 60;
  assert.equal(launcher.ready, false);
});

test('aimAt can aim for a shot from somewhere the ROBOT has not got to yet', () => {
  const field = new BiobuzzField({ field: new Field(new Config().values) });
  const launcher = new Launcher();
  const robot = new Robot(new Config().values);
  robot.addSubsystem(launcher);
  robot.reset(-1.6, 0, 0);
  const target = field.hiveTarget('red');

  // Aimed from where it stands.
  assert.ok(launcher.aimAt(target));
  const here = { rpm: launcher.targetRpm, angle: launcher.hoodAngle };

  // Aimed for a spot half a metre further out, which is where it is driving
  // to. A
  // flywheel has no brake, so arriving already at the right speed is the
  // difference between shooting on arrival and waiting seconds to coast down.
  // Not closer than about 0.9 m, where no hood angle arrives descending at
  // all and there is no shot to aim.
  const spot = { x: -1.5, y: 0.9 };
  assert.ok(launcher.aimAt(target, undefined, spot));
  assert.notEqual(launcher.targetRpm, here.rpm, 'a different range needs a different shot');
  const solution = launcher.aimFor(target, undefined, spot);
  assert.ok(solution);
  assert.ok(Math.abs(launcher.targetRpm - solution.rpm) < 1e-6);
  assert.ok(Math.abs(launcher.hoodAngle - solution.angle) < 1e-6);

  // And it is genuinely a different shot from the one it is standing on.
  assert.ok(
    Math.abs(solution.rpm - here.rpm) > 20,
    `${solution.rpm.toFixed(0)} rpm from the spot against ${here.rpm.toFixed(0)} from here`,
  );
});

test('a FLOWER-filling intake does not empty the FLOWER it is filling', () => {
  const field = new BiobuzzField({ field: new Field(new Config().values) });
  const intake = new Intake({ placeOnly: true, capacity: 4 });
  const robot = new Robot(new Config().values);
  robot.addSubsystem(intake);
  intake.ballWorld = field.ballWorld;
  intake.flowers = field.flowers;

  const flower = field.flowers[0];
  const before = flower.stack.length;
  assert.ok(before > 0, 'the FLOWER starts with POLLEN in it (Section 10.3.1)');

  // Parked right against the tube with the roller running, which is exactly
  // where a FLOWER robot spends its MATCH. It used to pull POLLEN back out of
  // the bottom of the tube it had just filled.
  const len = Math.hypot(flower.x, flower.y) || 1;
  const standoff = robot.halfLength + 0.05;
  robot.reset(
    flower.x - (flower.x / len) * standoff,
    flower.y - (flower.y / len) * standoff,
    Math.atan2(flower.y, flower.x),
  );
  intake.command = 1;
  for (let i = 0; i < 200; i++) {
    intake.applyForces(1 / 200, 12);
    field.ballWorld.step(1 / 200);
  }
  assert.equal(flower.stack.length, before, 'the tube is untouched');

  // A cycler, which is allowed to (G418 permits POLLEN from the bottom), still
  // gets one.
  const cycler = new Intake({ capacity: 4 });
  const other = new Robot(new Config().values);
  other.addSubsystem(cycler);
  cycler.ballWorld = field.ballWorld;
  cycler.flowers = field.flowers;
  other.reset(robot.body.position.x, robot.body.position.y, Math.atan2(flower.y, flower.x));
  cycler.command = 1;
  for (let i = 0; i < 200; i++) {
    cycler.applyForces(1 / 200, 12);
    field.ballWorld.step(1 / 200);
  }
  assert.ok(flower.stack.length < before, 'and a CELL robot may take one from the bottom');
});

test('the trajectory follows the element actually in the magazine', () => {
  // The guide used to assume POLLEN whatever the robot held, which is a guide
  // that is wrong exactly when it matters.
  const field = new Field(new Config().values);
  const bb = new BiobuzzField({ field });
  const { robot, launcher } = withLauncher();
  const intake = robot.addSubsystem(new Intake());
  launcher.intake = intake;
  const target = bb.hiveTarget('red');
  robot.reset(target.x, target.y - STANDOFF, Math.PI / 2);
  launcher.spinning = true;
  spin(launcher, 6);

  const arcFor = (ball) => {
    intake.held.length = 0;
    if (ball) intake.held.push(ball);
    const next = launcher.nextShot;
    const arc = launcher.trajectory({});
    const last = arc.points[arc.points.length - 1];
    return {
      next,
      range: Math.hypot(last.x - arc.origin.x, last.y - arc.origin.y),
      flight: arc.flightTime,
    };
  };

  const empty = arcFor(null);
  assert.equal(empty.next.kind, 'pollen', 'an empty magazine assumes a POLLEN');

  const withPollen = arcFor(pollen());
  assert.equal(withPollen.next.kind, 'pollen');
  assert.equal(withPollen.next.mass, POLLEN_MASS);
  assert.ok(
    Math.abs(withPollen.range - empty.range) < 1e-9,
    'holding a POLLEN is the same as the default',
  );

  const withNectar = arcFor(nectar());
  assert.equal(withNectar.next.kind, 'nectar');
  assert.equal(withNectar.next.mass, NECTAR_MASS);
  assert.equal(withNectar.next.radius, NECTAR_RADIUS, 'and its own radius, for the drag area');

  // A NECTAR is two thirds again the mass, so the wheel's droop bites harder
  // and it leaves slower; range goes as the square of speed. About 4 percent
  // shorter, which is roughly 14 cm at CELL range -- a quarter of a 20 in
  // opening, so it is the difference between the middle and the lip.
  const shortfall = 1 - withNectar.range / withPollen.range;
  assert.ok(
    shortfall > 0.02 && shortfall < 0.08,
    `a NECTAR should land a few percent short, got ${(shortfall * 100).toFixed(1)} percent ` +
      `(${withNectar.range.toFixed(3)} m vs ${withPollen.range.toFixed(3)} m)`,
  );

  // The front of the magazine is what fires, so that is what is drawn -- not
  // whatever happens to be deepest in it.
  intake.held.length = 0;
  intake.held.push(nectar(), pollen());
  assert.equal(launcher.nextShot.kind, 'nectar', 'the front of the queue is the next shot');
});

test('a NECTAR needs a different solution from a POLLEN at the same target', () => {
  const field = new Field(new Config().values);
  const bb = new BiobuzzField({ field });
  const { robot, launcher } = withLauncher();
  const target = bb.hiveTarget('red');
  robot.reset(target.x, target.y - STANDOFF, Math.PI / 2);

  const forPollen = launcher.aimFor(target, POLLEN_MASS);
  const forNectar = launcher.aimFor(target, NECTAR_MASS);
  assert.ok(forPollen && forNectar, 'both elements have a shot from here');

  // Same geometry, so a similar hood; but the heavier element needs the wheel
  // turning faster to leave at the same speed.
  assert.ok(
    forNectar.rpm > forPollen.rpm,
    `a NECTAR should need more RPM: ${forNectar.rpm.toFixed(0)} vs ${forPollen.rpm.toFixed(0)}`,
  );
  assert.ok(
    forNectar.rpm < forPollen.rpm * 1.1,
    'but not dramatically more -- it is the droop, not the drag',
  );
});
