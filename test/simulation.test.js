import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/config/Config.js';
import { Simulation } from '../src/app/Simulation.js';
import { OpMode } from '../src/teleop/OpMode.js';
import { GRAVITY } from '../src/physics/LoadDistribution.js';

/** Drives a constant normalised command, bypassing the gamepad. */
class Constant extends OpMode {
  constructor(forward = 0, strafe = 0, turn = 0) {
    super({ name: 'constant' });
    this.command = { forward, strafe, turn };
  }
  loop() {
    const c = this.command;
    this.robot?.drivetrain.driveNormalized(c.forward, c.strafe, c.turn);
  }
}

/** Build a simulation with the walls removed, so acceleration tests have room. */
function openField(tweaks = {}) {
  const config = new Config();
  config.set('field.collisionsEnabled', false);
  for (const [path, value] of Object.entries(tweaks)) config.set(path, value);
  return new Simulation(config);
}

function drive(sim, command, seconds) {
  sim.setOpMode(new Constant(command.forward, command.strafe, command.turn));
  const history = [];
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) {
    sim.step(dt);
    history.push({
      t,
      speed: sim.robot.body.speed,
      accel: sim.robot.body.acceleration.length(),
      slip: Math.max(...sim.robot.drivetrain.wheels.map((w) => w.slipSpeed)),
      current: sim.robot.battery.current,
      voltage: sim.robot.battery.busVoltage,
    });
  }
  return history;
}

const FT_PER_M = 3.280839895;

test('a 312 RPM mecanum robot reaches its theoretical top speed', () => {
  const sim = openField();
  const history = drive(sim, { forward: 1 }, 5);
  const top = history.at(-1).speed;
  const theoretical = sim.robot.drivetrain.theoreticalTopSpeed(sim.robot.battery.busVoltage);
  // Losses (rolling resistance, gearbox drag) keep it a few percent short.
  assert.ok(top > theoretical * 0.9, `${top} m/s vs theoretical ${theoretical}`);
  assert.ok(top <= theoretical * 1.02, `exceeded free speed: ${top} vs ${theoretical}`);
  // About 5 ft/s, which is what goBILDA quotes for this exact configuration.
  assert.ok(top * FT_PER_M > 4.6 && top * FT_PER_M < 5.4, `${top * FT_PER_M} ft/s`);
});

test('the robot reaches most of its top speed in about a second', () => {
  const sim = openField();
  const history = drive(sim, { forward: 1 }, 5);
  const top = history.at(-1).speed;
  const t95 = history.find((h) => h.speed >= top * 0.95)?.t ?? Infinity;
  assert.ok(t95 > 0.2 && t95 < 2.0, `time to 95% of top speed was ${t95} s`);
});

test('driving straight stays straight', () => {
  const sim = openField();
  drive(sim, { forward: 1 }, 4);
  const body = sim.robot.body;
  assert.ok(Math.abs(body.position.y) < 0.01, `drifted ${body.position.y} m sideways`);
  assert.ok(Math.abs(body.rotation.radians) < 0.01, `yawed ${body.rotation.radians} rad`);
});

test('an off-centre centre of gravity makes the robot pull to one side', () => {
  const sim = openField({ 'chassis.cgOffsetY': 0.08, 'chassis.cgHeight': 0.2 });
  drive(sim, { forward: 1 }, 4);
  // Uneven wheel loads mean uneven grip, so the robot no longer tracks true.
  assert.ok(Math.abs(sim.robot.body.rotation.radians) > 0.001, 'expected some heading drift');
});

test('mecanum strafes slower than it drives, because of roller drag', () => {
  const forward = drive(openField(), { forward: 1 }, 5).at(-1).speed;
  const strafe = drive(openField(), { strafe: 1 }, 5).at(-1).speed;
  const ratio = strafe / forward;
  assert.ok(ratio > 0.7 && ratio < 0.98, `strafe was ${(ratio * 100).toFixed(1)}% of forward`);
});

test('tank cannot strafe at all', () => {
  const sim = openField({ 'drivetrain.type': 'tank' });
  drive(sim, { strafe: 1 }, 3);
  assert.ok(sim.robot.body.speed < 0.02, `tank drifted sideways at ${sim.robot.body.speed} m/s`);
});

test('mecanum gives up traction to a tank drive on a slippery surface', () => {
  // Gear down hard and drop the grip so both drivetrains are traction limited
  // rather than torque limited; only then does the geometry show.
  const tweaks = {
    'motor.gearRatio': 26.9,
    'surface.muLongitudinal': 0.45,
    'surface.muLateral': 0.45,
  };
  const peak = (type) => {
    const history = drive(openField({ ...tweaks, 'drivetrain.type': type }), { forward: 1 }, 4);
    return Math.max(...history.map((h) => h.accel));
  };
  const mecanum = peak('mecanum');
  const tank = peak('tank');
  const ratio = mecanum / tank;
  // A mecanum wheel can only push along its 45 degree roller axis, so its
  // forward grip is cos(45) = 71% of a traction wheel's. This is not coded
  // anywhere -- it falls out of the contact geometry.
  assert.ok(ratio > 0.6 && ratio < 0.82, `mecanum/tank traction ratio was ${ratio.toFixed(3)}`);
});

test('acceleration never exceeds what the tyres can transmit', () => {
  const mu = 1.05;
  const history = drive(openField({ 'motor.gearRatio': 50.9 }), { forward: 1 }, 3);
  const peak = Math.max(...history.map((h) => h.accel));
  // Even wildly over-geared, friction caps acceleration at mu * g.
  assert.ok(peak <= mu * GRAVITY * 1.05, `${peak} m/s^2 exceeds the friction limit`);
});

test('BRAKE stops far shorter than FLOAT', () => {
  const stopDistance = (zeroPowerBehavior) => {
    const sim = openField({ 'control.zeroPowerBehavior': zeroPowerBehavior });
    drive(sim, { forward: 1 }, 4);
    const start = sim.robot.body.position.x;
    sim.setOpMode(new Constant(0, 0, 0));
    let t = 0;
    while (sim.robot.body.speed > 0.05 && t < 10) {
      sim.step(1 / 60);
      t += 1 / 60;
    }
    return sim.robot.body.position.x - start;
  };
  const brake = stopDistance('BRAKE');
  const float = stopDistance('FLOAT');
  assert.ok(brake > 0.05 && brake < 1.0, `brake distance ${brake} m looks wrong`);
  assert.ok(float > brake * 2, `coasting (${float} m) should far exceed braking (${brake} m)`);
});

test('a tired battery makes the robot measurably slower', () => {
  const fresh = drive(openField(), { forward: 1 }, 5).at(-1).speed;
  const tired = drive(
    openField({
      'battery.startingStateOfCharge': 0.45,
      'battery.internalResistance': 0.055,
      'battery.openCircuitVoltage': 12.6,
    }),
    { forward: 1 },
    5,
  ).at(-1).speed;
  assert.ok(tired < fresh * 0.95, `tired pack gave ${tired} m/s vs fresh ${fresh} m/s`);
});

test('the bus sags under load and recovers when the robot coasts', () => {
  const sim = openField();
  const history = drive(sim, { forward: 1 }, 3);
  const minVoltage = Math.min(...history.map((h) => h.voltage));
  const peakCurrent = Math.max(...history.map((h) => h.current));
  assert.ok(peakCurrent > 15, `expected a launch current spike, got ${peakCurrent} A`);
  assert.ok(minVoltage < 12.5, `expected voltage sag, min was ${minVoltage} V`);
  // Coast: current falls back toward the idle load.
  drive(sim, {}, 2);
  assert.ok(sim.robot.battery.current < 3, `idle draw was ${sim.robot.battery.current} A`);
});

test('wheels break loose on a hard launch and grip once rolling', () => {
  const history = drive(openField({ 'motor.gearRatio': 26.9 }), { forward: 1 }, 4);
  const launchSlip = Math.max(...history.slice(0, 30).map((h) => h.slip));
  const cruiseSlip = history.at(-1).slip;
  assert.ok(launchSlip > 0.05, `expected wheel slip on launch, saw ${launchSlip} m/s`);
  assert.ok(cruiseSlip < 0.02, `wheels should grip at steady speed, slip was ${cruiseSlip}`);
});

test('the robot spins in place without wandering', () => {
  const sim = openField();
  drive(sim, { turn: 1 }, 4);
  const drift = Math.hypot(sim.robot.body.position.x, sim.robot.body.position.y);
  assert.ok(drift < 0.02, `drifted ${drift} m while spinning in place`);
  assert.ok(Math.abs(sim.robot.body.angularVelocity) > 2, 'expected a real yaw rate');
});

test('the robot stops at the field wall instead of driving through it', () => {
  const config = new Config();
  const sim = new Simulation(config);
  sim.setStartPose(0, 0, 0);
  sim.resetRobot();
  drive(sim, { forward: 1 }, 6);
  const limit = sim.field.halfSize;
  assert.ok(
    sim.robot.body.position.x < limit,
    `robot escaped the field at x=${sim.robot.body.position.x}`,
  );
  assert.ok(sim.robot.body.speed < 0.2, 'robot should be stopped against the wall');
});

test('every drivetrain type runs without diverging', () => {
  for (const type of ['mecanum', 'tank', 'tank6', 'omni', 'xdrive']) {
    const sim = openField({ 'drivetrain.type': type });
    drive(sim, { forward: 0.8, strafe: 0.4, turn: -0.6 }, 4);
    assert.ok(sim.robot.body.isFinite(), `${type} produced a non-finite state`);
    assert.ok(sim.robot.body.speed < 10, `${type} reached an implausible ${sim.robot.body.speed} m/s`);
  }
});

test('the simulation is stable across substep rates', () => {
  const speeds = [];
  for (const hz of [500, 1000, 2000, 4000]) {
    const sim = openField({ 'sim.substepHz': hz });
    drive(sim, { forward: 1 }, 4);
    assert.ok(sim.robot.body.isFinite(), `diverged at ${hz} Hz`);
    speeds.push(sim.robot.body.speed);
  }
  const spread = Math.max(...speeds) - Math.min(...speeds);
  assert.ok(spread < 0.05, `top speed varied by ${spread} m/s across substep rates`);
});

test('a stationary robot with no command stays put', () => {
  const sim = openField();
  drive(sim, {}, 3);
  const body = sim.robot.body;
  assert.ok(body.speed < 1e-3, `crept at ${body.speed} m/s`);
  assert.ok(Math.hypot(body.position.x, body.position.y) < 1e-3, 'drifted while idle');
});

test('odometry from the drive encoders tracks the real velocity', () => {
  const sim = openField();
  drive(sim, { forward: 1 }, 4);
  const measured = sim.robot.drivetrain.telemetry.measuredTwist;
  const actual = sim.robot.body.bodyVelocity;
  // Encoders see wheel speed, so at steady state with little slip they should
  // agree closely with the truth.
  assert.ok(Math.abs(measured.vx - actual.x) < 0.1, `odometry said ${measured.vx}, truth ${actual.x}`);
});

test('op-modes can be swapped at runtime', () => {
  const sim = openField();
  sim.setOpMode(new Constant(1, 0, 0));
  for (let i = 0; i < 60; i++) sim.step(1 / 60);
  assert.ok(sim.robot.body.speed > 0.1);
  sim.setOpMode(new Constant(0, 0, 0));
  for (let i = 0; i < 300; i++) sim.step(1 / 60);
  assert.ok(sim.robot.body.speed < 0.1, 'robot should have stopped after the op-mode changed');
});

test('resetting restores the starting pose and clears electrical state', () => {
  const sim = openField();
  sim.setStartPose(-1, 0.5, 0.3);
  drive(sim, { forward: 1, turn: 0.5 }, 2);
  sim.resetRobot();
  const body = sim.robot.body;
  assert.equal(body.position.x, -1);
  assert.equal(body.position.y, 0.5);
  assert.equal(body.speed, 0);
  assert.equal(sim.time, 0);
  assert.ok(sim.robot.battery.stateOfCharge > 0.99, 'battery should be restored on reset');
});

test('changing a rebuild parameter reconfigures the live drivetrain', () => {
  const config = new Config();
  config.set('field.collisionsEnabled', false);
  const sim = new Simulation(config);
  assert.equal(sim.robot.drivetrain.wheels.length, 4);
  config.set('drivetrain.type', 'tank6');
  assert.equal(sim.robot.drivetrain.wheels.length, 6);
  drive(sim, { forward: 1 }, 2);
  assert.ok(sim.robot.body.isFinite());
  assert.ok(sim.robot.body.speed > 0.5, 'rebuilt drivetrain should still drive');
});

test('simulation keeps up with real time comfortably', () => {
  const sim = openField();
  sim.setOpMode(new Constant(1, 0.5, -0.5));
  const start = performance.now();
  for (let i = 0; i < 600; i++) sim.step(1 / 60);
  const elapsed = performance.now() - start;
  // 10 seconds of simulated time; anything approaching 10 s of wall time would
  // mean the browser could not also render.
  assert.ok(elapsed < 3000, `10 s of simulation took ${elapsed.toFixed(0)} ms`);
});
