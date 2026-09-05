import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/config/Config.js';
import { ALL_PARAMS, PARAM_BY_PATH, SCHEMA, defaultConfig } from '../src/config/schema.js';
import { ROBOT_PRESETS } from '../src/config/presets/robots.js';
import { MOTOR_PRESETS } from '../src/config/presets/motors.js';
import { toDisplay, fromDisplay, CONVERSIONS } from '../src/util/units.js';

test('every schema parameter is well formed', () => {
  const seen = new Set();
  for (const def of ALL_PARAMS) {
    assert.ok(def.path, 'parameter is missing a path');
    assert.ok(!seen.has(def.path), `duplicate parameter path: ${def.path}`);
    seen.add(def.path);
    assert.ok(def.label, `${def.path} is missing a label`);
    assert.ok(def.default !== undefined, `${def.path} has no default`);

    if (def.type === 'number') {
      assert.equal(typeof def.default, 'number', `${def.path} default is not a number`);
      assert.ok(Number.isFinite(def.default), `${def.path} default is not finite`);
      if (def.min !== undefined) assert.ok(def.default >= def.min, `${def.path} default is below its minimum`);
      if (def.max !== undefined) assert.ok(def.default <= def.max, `${def.path} default is above its maximum`);
      if (def.min !== undefined && def.max !== undefined) {
        assert.ok(def.min < def.max, `${def.path} has an empty range`);
      }
      if (def.unit) assert.ok(CONVERSIONS[def.unit] !== undefined, `${def.path} has an unknown unit ${def.unit}`);
      if (def.display) {
        assert.ok(CONVERSIONS[def.display] !== undefined, `${def.path} has an unknown display unit ${def.display}`);
      }
      assert.ok(!(def.unit && def.suffix), `${def.path} declares both a unit and a suffix`);

      // The invariant that catches the whole class of display bugs: a value
      // stored in unit X can only be shown in a *different* unit if the
      // parameter says so explicitly with `display`. Tagging a value that is
      // already in RPM with `unit: 'rpm'` would otherwise multiply it by the
      // rad/s conversion and show 57296 RPM for a 6000 RPM motor.
      if (def.unit && !def.display) {
        assert.equal(
          CONVERSIONS[def.unit],
          1,
          `${def.path} is stored in ${def.unit} but shown without conversion; ` +
            'use `suffix` if the stored value is already in those units, or add `display`',
        );
      }
    } else if (def.type === 'enum') {
      assert.ok(def.options?.length, `${def.path} is an enum with no options`);
      assert.ok(
        def.options.some((o) => o.value === def.default),
        `${def.path} default is not one of its options`,
      );
    } else if (def.type === 'boolean') {
      assert.equal(typeof def.default, 'boolean', `${def.path} default is not a boolean`);
    } else {
      assert.fail(`${def.path} has an unknown type ${def.type}`);
    }
  }
});

test('the schema covers enough ground to be worth generating a UI from', () => {
  assert.ok(SCHEMA.length >= 8, 'expected at least eight parameter groups');
  assert.ok(ALL_PARAMS.length >= 80, `expected 80+ parameters, found ${ALL_PARAMS.length}`);
  for (const group of SCHEMA) {
    assert.ok(group.description, `group ${group.id} has no description`);
    assert.ok(group.params.length > 0, `group ${group.id} is empty`);
  }
});

test('defaults build a fully populated nested config', () => {
  const config = defaultConfig();
  for (const def of ALL_PARAMS) {
    const value = def.path.split('.').reduce((node, key) => node?.[key], config);
    assert.notEqual(value, undefined, `${def.path} missing from defaults`);
  }
});

test('numbers are clamped to their schema range', () => {
  const config = new Config();
  config.set('chassis.mass', 1e9);
  assert.equal(config.get('chassis.mass'), PARAM_BY_PATH.get('chassis.mass').max);
  config.set('chassis.mass', -50);
  assert.equal(config.get('chassis.mass'), PARAM_BY_PATH.get('chassis.mass').min);
});

test('non-numeric and invalid values are rejected, not stored', () => {
  const config = new Config();
  const before = config.get('chassis.mass');
  assert.equal(config.set('chassis.mass', 'heavy'), false);
  assert.equal(config.get('chassis.mass'), before);
  assert.equal(config.set('chassis.mass', NaN), false);
  assert.equal(config.get('chassis.mass'), before);
  assert.equal(config.set('drivetrain.type', 'hovercraft'), false);
  assert.equal(config.get('drivetrain.type'), 'mecanum');
});

test('change and rebuild events fire appropriately', () => {
  const config = new Config();
  const changes = [];
  const rebuilds = [];
  config.on('change', (path) => changes.push(path));
  config.on('rebuild', (path) => rebuilds.push(path));

  config.set('view.showTrail', false);
  assert.deepEqual(changes, ['view.showTrail']);
  assert.equal(rebuilds.length, 0, 'a view toggle must not rebuild the drivetrain');

  config.set('drivetrain.wheelRadius', 0.05);
  assert.equal(rebuilds.length, 1, 'geometry changes must trigger a rebuild');

  // Setting the same value again is a no-op.
  const count = changes.length;
  config.set('view.showTrail', false);
  assert.equal(changes.length, count);
});

test('export only records what differs from the defaults', () => {
  const config = new Config();
  assert.equal(Object.keys(config.toJSON().values).length, 0, 'a fresh config should export nothing');
  config.set('chassis.mass', 17);
  config.set('driver.turnScale', 0.5);
  const exported = config.toJSON();
  assert.deepEqual(Object.keys(exported.values).sort(), ['chassis.mass', 'driver.turnScale']);
});

test('export and import round-trip exactly', () => {
  const source = new Config();
  source.set('drivetrain.type', 'tank6');
  source.set('chassis.mass', 16.5);
  source.set('control.runMode', 'RUN_USING_ENCODER');
  source.set('surface.muLongitudinal', 0.7);
  source.set('view.showLoads', true);

  const target = new Config();
  const result = target.fromJSON(source.toJSON());
  assert.equal(result.unknown.length, 0);
  for (const def of ALL_PARAMS) {
    assert.equal(target.get(def.path), source.get(def.path), `${def.path} did not survive the round trip`);
  }
});

test('importing resets untouched values back to defaults', () => {
  const config = new Config();
  config.set('chassis.mass', 25);
  config.fromJSON({ version: 1, values: { 'driver.turnScale': 0.4 } });
  assert.equal(config.get('chassis.mass'), PARAM_BY_PATH.get('chassis.mass').default);
  assert.equal(config.get('driver.turnScale'), 0.4);
});

test('unknown paths in an imported file are reported, not silently dropped', () => {
  const config = new Config();
  const result = config.fromJSON({
    version: 1,
    values: { 'chassis.mass': 14, 'future.feature': 42 },
  });
  assert.equal(result.applied, 1);
  assert.deepEqual(result.unknown, ['future.feature']);
});

test('a config file that only names a motor preset still loads its figures', () => {
  const config = new Config();
  config.fromJSON({ version: 1, values: { 'motor.preset': 'neverest' } });
  assert.equal(config.get('motor.freeSpeedRpm'), MOTOR_PRESETS.neverest.freeSpeedRpm);
  assert.equal(config.get('motor.stallTorque'), MOTOR_PRESETS.neverest.stallTorque);
});

test('every robot preset only references real parameters and valid values', () => {
  for (const preset of ROBOT_PRESETS) {
    assert.ok(preset.name && preset.description, `${preset.id} is missing a name or description`);
    const config = new Config();
    for (const [path, value] of Object.entries(preset.values)) {
      assert.ok(PARAM_BY_PATH.has(path), `${preset.id} references unknown parameter ${path}`);
      const def = PARAM_BY_PATH.get(path);
      if (def.type === 'number') {
        assert.ok(
          value >= (def.min ?? -Infinity) && value <= (def.max ?? Infinity),
          `${preset.id} sets ${path} to ${value}, outside [${def.min}, ${def.max}]`,
        );
      } else if (def.type === 'enum') {
        assert.ok(
          def.options.some((o) => o.value === value),
          `${preset.id} sets ${path} to an invalid option ${value}`,
        );
      }
    }
    // Applying it must not silently clamp anything away.
    config.applyPreset(preset);
    for (const [path, value] of Object.entries(preset.values)) {
      if (path === 'motor.preset') continue;
      assert.equal(config.get(path), value, `${preset.id}: ${path} was not applied as given`);
    }
  }
});

test('applying a motor preset loads its whole spec', () => {
  const config = new Config();
  config.applyMotorPreset('revHdHex');
  const spec = MOTOR_PRESETS.revHdHex;
  assert.equal(config.get('motor.freeSpeedRpm'), spec.freeSpeedRpm);
  assert.equal(config.get('motor.stallCurrent'), spec.stallCurrent);
  assert.equal(config.get('motor.ticksPerRev'), spec.ticksPerRev);
  assert.equal(config.values.motor.name, spec.name);
});

test('resetAll restores every default', () => {
  const config = new Config();
  config.set('chassis.mass', 20);
  config.set('drivetrain.type', 'xdrive');
  config.resetAll();
  assert.deepEqual(config.values, defaultConfig());
});

test('resetParam restores one value', () => {
  const config = new Config();
  config.set('driver.deadband', 0.3);
  config.resetParam('driver.deadband');
  assert.equal(config.get('driver.deadband'), PARAM_BY_PATH.get('driver.deadband').default);
});

test('display unit conversions round-trip', () => {
  for (const def of ALL_PARAMS) {
    if (def.type !== 'number') continue;
    const unit = def.display ?? def.unit;
    if (!unit) continue;
    const back = fromDisplay(toDisplay(def.default, unit), unit);
    assert.ok(Math.abs(back - def.default) < 1e-9, `${def.path} failed unit round trip`);
  }
});

test('parameters stored in non-SI units are shown unconverted', () => {
  // These four are deliberately kept in the units their consumers expect
  // rather than in SI, so they must be shown as-is.
  const rawUnits = {
    'motor.freeSpeedRpm': 'rpm',
    'control.inputLatencyMs': 'ms',
    'imu.driftRateDegPerSec': 'deg/s',
    'imu.noiseDeg': 'deg',
  };
  for (const [path, suffix] of Object.entries(rawUnits)) {
    const def = PARAM_BY_PATH.get(path);
    assert.ok(def, `${path} is missing from the schema`);
    assert.equal(def.suffix, suffix, `${path} should carry suffix "${suffix}"`);
    assert.equal(def.unit, undefined, `${path} must not declare a converting unit`);
  }
});

test('known conversions are numerically right', () => {
  assert.ok(Math.abs(toDisplay(1, 'in') - 39.3700787) < 1e-6);
  assert.ok(Math.abs(fromDisplay(144, 'in') - 3.6576) < 1e-9);
  assert.ok(Math.abs(toDisplay(Math.PI, 'deg') - 180) < 1e-9);
  assert.ok(Math.abs(toDisplay(1, 'ft/s') - 3.280839895) < 1e-6);
});
