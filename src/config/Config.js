import { EventBus } from '../util/events.js';
import { ALL_PARAMS, PARAM_BY_PATH, defaultConfig } from './schema.js';
import { MOTOR_PRESETS } from './presets/motors.js';
import { clamp } from '../math/MathUtil.js';

const STORAGE_KEY = 'ftc-sim-config-v1';

/**
 * Live configuration store.
 *
 * Holds the nested config object, validates writes against the schema, and
 * announces changes so the simulation and UI can react. Changes to parameters
 * marked `rebuild` in the schema emit a separate event, because they need the
 * drivetrain rebuilt rather than just re-read.
 *
 * Emits:
 *   'change'  (path, value, def)
 *   'rebuild' (path)
 *   'bulk'    ()  after a preset load, import or reset
 */
export class Config {
  constructor() {
    this.events = new EventBus();
    this.values = defaultConfig();
  }

  /** @param {string} path dotted path, e.g. 'chassis.mass' */
  get(path) {
    const parts = path.split('.');
    /** @type {any} */
    let node = this.values;
    for (const part of parts) {
      if (node == null) return undefined;
      node = node[part];
    }
    return node;
  }

  /**
   * Set a value, coercing and clamping it to the schema.
   * @param {string} path
   * @param {any} raw
   * @param {{silent?:boolean}} [opts]
   */
  set(path, raw, opts = {}) {
    const def = PARAM_BY_PATH.get(path);
    let value = raw;

    if (def) {
      if (def.type === 'number') {
        value = Number(raw);
        if (!Number.isFinite(value)) return false;
        if (def.min !== undefined || def.max !== undefined) {
          value = clamp(value, def.min ?? -Infinity, def.max ?? Infinity);
        }
      } else if (def.type === 'boolean') {
        value = Boolean(raw);
      } else if (def.type === 'enum' && def.options) {
        const allowed = def.options.some((o) => o.value === value);
        if (!allowed) return false;
      }
    }

    const parts = path.split('.');
    /** @type {any} */
    let node = this.values;
    for (let i = 0; i < parts.length - 1; i++) {
      node[parts[i]] ??= {};
      node = node[parts[i]];
    }
    const key = parts[parts.length - 1];
    if (node[key] === value) return false;
    node[key] = value;

    if (!opts.silent) {
      this.events.emit('change', path, value, def);
      if (def?.rebuild) this.events.emit('rebuild', path);
    }
    return true;
  }

  /** Reset one parameter to its schema default. */
  resetParam(path) {
    const def = PARAM_BY_PATH.get(path);
    if (!def) return false;
    return this.set(path, def.default);
  }

  /** Reset everything. */
  resetAll() {
    this.values = defaultConfig();
    this.events.emit('bulk');
    this.events.emit('rebuild', '*');
    return this;
  }

  /**
   * Copy a motor preset's catalogue figures into the live config.
   * @param {string} id
   */
  applyMotorPreset(id) {
    const spec = MOTOR_PRESETS[id];
    if (!spec) return false;
    this.set('motor.preset', id, { silent: true });
    this.set('motor.freeSpeedRpm', spec.freeSpeedRpm, { silent: true });
    this.set('motor.stallTorque', spec.stallTorque, { silent: true });
    this.set('motor.stallCurrent', spec.stallCurrent, { silent: true });
    this.set('motor.freeCurrent', spec.freeCurrent, { silent: true });
    this.set('motor.ticksPerRev', spec.ticksPerRev, { silent: true });
    this.set('motor.rotorInertia', spec.rotorInertia, { silent: true });
    this.values.motor.name = spec.name;
    this.events.emit('bulk');
    this.events.emit('rebuild', 'motor.preset');
    return true;
  }

  /**
   * Apply a named robot preset: a partial config of dotted paths.
   * @param {{name:string, values:Record<string, any>}} preset
   */
  applyPreset(preset) {
    for (const [path, value] of Object.entries(preset.values)) {
      if (path === 'motor.preset') {
        this.applyMotorPresetSilently(String(value));
      } else {
        this.set(path, value, { silent: true });
      }
    }
    this.events.emit('bulk');
    this.events.emit('rebuild', 'preset');
    return this;
  }

  /** @private */
  applyMotorPresetSilently(id) {
    const spec = MOTOR_PRESETS[id];
    if (!spec) return;
    this.set('motor.preset', id, { silent: true });
    this.set('motor.freeSpeedRpm', spec.freeSpeedRpm, { silent: true });
    this.set('motor.stallTorque', spec.stallTorque, { silent: true });
    this.set('motor.stallCurrent', spec.stallCurrent, { silent: true });
    this.set('motor.freeCurrent', spec.freeCurrent, { silent: true });
    this.set('motor.ticksPerRev', spec.ticksPerRev, { silent: true });
    this.set('motor.rotorInertia', spec.rotorInertia, { silent: true });
    this.values.motor.name = spec.name;
  }

  /**
   * Export only the values that differ from the defaults, so a shared config
   * file stays short and readable and keeps picking up future default changes.
   */
  toJSON() {
    const defaults = defaultConfig();
    /** @type {Record<string, any>} */
    const diff = {};
    for (const def of ALL_PARAMS) {
      const current = this.get(def.path);
      const original = getPath(defaults, def.path);
      if (current !== original) diff[def.path] = current;
    }
    return { version: 1, savedAt: new Date().toISOString(), values: diff };
  }

  /**
   * Load a config produced by `toJSON`. Unknown paths are reported rather than
   * silently dropped, so a config from a newer version is obvious.
   * @param {any} data
   * @returns {{applied:number, unknown:string[]}}
   */
  fromJSON(data) {
    const unknown = [];
    let applied = 0;
    const values = data?.values ?? {};
    // Start from defaults so an imported file fully determines the state.
    this.values = defaultConfig();
    for (const [path, value] of Object.entries(values)) {
      if (!PARAM_BY_PATH.has(path)) {
        unknown.push(path);
        continue;
      }
      if (this.set(path, value, { silent: true })) applied++;
    }
    if (values['motor.preset'] && !values['motor.freeSpeedRpm']) {
      this.applyMotorPresetSilently(String(values['motor.preset']));
    }
    this.events.emit('bulk');
    this.events.emit('rebuild', 'import');
    return { applied, unknown };
  }

  /** Persist to localStorage. No-op outside a browser. */
  save() {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(this.toJSON()));
      return true;
    } catch {
      return false;
    }
  }

  /** Restore from localStorage, if present and parseable. */
  load() {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
      if (!raw) return false;
      this.fromJSON(JSON.parse(raw));
      return true;
    } catch (err) {
      console.warn('[Config] could not restore saved settings:', err);
      return false;
    }
  }

  clearSaved() {
    try {
      globalThis.localStorage?.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  on(event, handler) {
    return this.events.on(event, handler);
  }
}

function getPath(obj, path) {
  let node = obj;
  for (const part of path.split('.')) {
    if (node == null) return undefined;
    node = node[part];
  }
  return node;
}
