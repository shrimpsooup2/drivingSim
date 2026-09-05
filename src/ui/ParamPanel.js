import { SCHEMA, PARAM_BY_PATH, defaultConfig } from '../config/schema.js';
import { ROBOT_PRESETS } from '../config/presets/robots.js';
import { fromDisplay, toDisplay } from '../util/units.js';

/**
 * The settings panel, generated entirely from the schema.
 *
 * Nothing here knows what any individual parameter means: it reads types,
 * ranges, units and help text from `schema.js` and builds the controls. Adding
 * a tunable is one schema entry, and it appears here with a slider, a numeric
 * field, unit conversion, a reset affordance and search -- no UI code to write.
 */
export class ParamPanel {
  /**
   * @param {HTMLElement} root
   * @param {import('../config/Config.js').Config} config
   * @param {{onPreset?: (id:string)=>void}} [hooks]
   */
  constructor(root, config, hooks = {}) {
    this.root = root;
    this.config = config;
    this.hooks = hooks;
    this.showAdvanced = false;
    this.filter = '';
    /** @type {Map<string, {update: () => void, element: HTMLElement, def: any}>} */
    this.controls = new Map();
    this._defaults = defaultConfig();

    this._build();
    // A preset load or import changes many values at once; refresh everything.
    config.on('bulk', () => this.refreshAll());
    config.on('change', (path) => this.controls.get(path)?.update());
  }

  _build() {
    this.root.innerHTML = '';

    const head = el('div', 'panel-head');
    const title = el('div', 'panel-title');
    title.append(text('Robot & simulation settings'));
    const count = el('small');
    count.textContent = `${PARAM_BY_PATH.size} parameters`;
    title.append(count);
    head.append(title);

    // Preset selector.
    const presetSelect = /** @type {HTMLSelectElement} */ (el('select'));
    presetSelect.append(option('', 'Load a preset chassis...'));
    for (const p of ROBOT_PRESETS) presetSelect.append(option(p.id, p.name));
    presetSelect.addEventListener('change', () => {
      const id = presetSelect.value;
      if (!id) return;
      const preset = ROBOT_PRESETS.find((p) => p.id === id);
      if (preset) {
        this.config.applyPreset(preset);
        this.hooks.onPreset?.(id);
      }
      presetSelect.value = '';
    });
    head.append(presetSelect);

    const presetHelp = el('div', 'param-help');
    presetHelp.textContent =
      'Presets are starting points. Adjust mass, CG height and gear ratio toward your real robot -- the closer they are, the more practice here transfers.';
    head.append(presetHelp);

    // Search.
    const search = /** @type {HTMLInputElement} */ (el('input', 'search'));
    search.type = 'text';
    search.placeholder = 'Search parameters...';
    search.addEventListener('input', () => {
      this.filter = search.value.trim().toLowerCase();
      this._applyFilter();
    });
    head.append(search);

    // Toolbar.
    const toolbar = el('div', 'toolbar');
    const advanced = labelledCheckbox('Show advanced', this.showAdvanced, (v) => {
      this.showAdvanced = v;
      this._applyFilter();
    });
    toolbar.append(advanced);

    toolbar.append(
      button('Reset all', () => {
        if (globalThis.confirm?.('Reset every parameter to its default?')) this.config.resetAll();
      }),
      button('Export', () => this._export()),
      button('Import', () => this._import()),
      button('Save', () => {
        this.config.save();
        flash(this.root, 'Saved to this browser');
      }),
    );
    head.append(toolbar);
    this.root.append(head);

    // Groups.
    const body = el('div', 'panel-body');
    for (const group of SCHEMA) {
      body.append(this._buildGroup(group));
    }
    this.root.append(body);
    this._applyFilter();
  }

  _buildGroup(group) {
    const container = el('div', 'group');
    container.dataset.group = group.id;

    const head = /** @type {HTMLButtonElement} */ (el('button', 'group-head'));
    const chev = el('span', 'chev');
    chev.textContent = '▾';
    head.append(chev, text(group.label));
    head.addEventListener('click', () => container.classList.toggle('collapsed'));
    container.append(head);

    const desc = el('div', 'group-desc');
    desc.textContent = group.description;
    container.append(desc);

    const bodyEl = el('div', 'group-body');
    for (const def of group.params) bodyEl.append(this._buildParam(def));
    container.append(bodyEl);

    // Everything but the first two groups starts collapsed, so the panel is
    // approachable rather than a wall of 90 controls.
    if (group.id !== 'drivetrain' && group.id !== 'driver') container.classList.add('collapsed');
    return container;
  }

  _buildParam(def) {
    const wrap = el('div', 'param');
    wrap.dataset.path = def.path;
    wrap.dataset.advanced = def.advanced ? '1' : '0';
    wrap.dataset.search = `${def.label} ${def.path} ${def.help ?? ''}`.toLowerCase();

    const head = el('div', 'param-head');
    const label = el('span', 'param-label');
    label.textContent = def.label;
    const value = el('span', 'param-value');
    head.append(label, value);

    // Clicking the value resets this one parameter.
    value.style.cursor = 'pointer';
    value.title = 'Click to reset to default';
    value.addEventListener('click', () => this.config.resetParam(def.path));

    wrap.append(head);

    let update = () => {};

    if (def.type === 'boolean') {
      head.removeChild(value);
      const cb = labelledCheckbox('', Boolean(this.config.get(def.path)), (v) =>
        this.config.set(def.path, v),
      );
      const input = /** @type {HTMLInputElement} */ (cb.querySelector('input'));
      wrap.append(cb);
      update = () => {
        input.checked = Boolean(this.config.get(def.path));
        this._markModified(wrap, def);
      };
    } else if (def.type === 'enum') {
      head.removeChild(value);
      const select = /** @type {HTMLSelectElement} */ (el('select'));
      for (const opt of def.options ?? []) select.append(option(String(opt.value), opt.label));
      select.addEventListener('change', () => {
        const raw = select.value;
        const match = def.options?.find((o) => String(o.value) === raw);
        this.config.set(def.path, match ? match.value : raw);
      });
      wrap.append(select);
      update = () => {
        select.value = String(this.config.get(def.path));
        this._markModified(wrap, def);
      };
    } else {
      // A parameter either declares the SI unit it is stored in (and optionally
      // a `display` unit to convert into), or a `suffix` meaning "already in
      // these units, show them as-is". Passing an empty unit to the conversion
      // helpers is a no-op, which keeps the two cases on one code path.
      const conversionUnit = def.suffix ? '' : (def.display ?? def.unit ?? '');
      const unit = conversionUnit;
      const suffix = def.suffix ?? conversionUnit;
      const controls = el('div', 'param-controls');
      const range = /** @type {HTMLInputElement} */ (el('input'));
      range.type = 'range';
      const number = /** @type {HTMLInputElement} */ (el('input'));
      number.type = 'number';

      // Sliders and number boxes work in display units (inches, degrees, RPM);
      // the store always holds SI.
      const dispMin = toDisplay(def.min ?? 0, unit);
      const dispMax = toDisplay(def.max ?? 1, unit);
      const dispStep = Math.abs(toDisplay(def.step ?? 0.01, unit));
      range.min = String(Math.min(dispMin, dispMax));
      range.max = String(Math.max(dispMin, dispMax));
      range.step = String(dispStep || 'any');
      number.min = range.min;
      number.max = range.max;
      number.step = range.step;

      const commit = (displayValue) => {
        const si = fromDisplay(Number(displayValue), unit);
        this.config.set(def.path, si);
      };
      range.addEventListener('input', () => commit(range.value));
      number.addEventListener('change', () => commit(number.value));

      controls.append(range, number);
      wrap.append(controls);

      update = () => {
        const si = Number(this.config.get(def.path));
        const disp = toDisplay(si, unit);
        range.value = String(disp);
        if (document.activeElement !== number) number.value = String(round(disp, dispStep));
        value.textContent = `${format(disp, dispStep)}${suffix ? ' ' + suffix : ''}`;
        this._markModified(wrap, def);
      };
    }

    if (def.help) {
      const help = el('div', 'param-help');
      help.textContent = def.help;
      wrap.append(help);
    }

    update();
    this.controls.set(def.path, { update, element: wrap, def });
    return wrap;
  }

  _markModified(wrap, def) {
    const current = this.config.get(def.path);
    const original = getPath(this._defaults, def.path);
    wrap.classList.toggle('modified', current !== original);
  }

  _applyFilter() {
    for (const { element, def } of this.controls.values()) {
      const advancedHidden = def.advanced && !this.showAdvanced;
      const matches = !this.filter || String(element.dataset.search).includes(this.filter);
      element.classList.toggle('hidden', advancedHidden || !matches);
    }
    // Hide groups whose parameters are all filtered out, and expand the rest
    // while a search is active so results are visible without extra clicks.
    for (const group of this.root.querySelectorAll('.group')) {
      const visible = group.querySelectorAll('.param:not(.hidden)').length;
      group.classList.toggle('hidden', visible === 0);
      if (this.filter && visible > 0) group.classList.remove('collapsed');
    }
  }

  refreshAll() {
    for (const control of this.controls.values()) control.update();
    this._applyFilter();
  }

  _export() {
    const json = JSON.stringify(this.config.toJSON(), null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ftc-sim-config.json';
    a.click();
    URL.revokeObjectURL(url);
    flash(this.root, 'Config exported');
  }

  _import() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const result = this.config.fromJSON(data);
        flash(
          this.root,
          `Imported ${result.applied} settings${result.unknown.length ? `, ${result.unknown.length} unrecognised` : ''}`,
        );
      } catch (err) {
        flash(this.root, `Import failed: ${err instanceof Error ? err.message : err}`);
      }
    });
    input.click();
  }
}

// ---------- small DOM helpers ----------

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}
function text(value) {
  return document.createTextNode(value);
}
function option(value, label) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}
function button(label, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
function labelledCheckbox(label, checked, onChange) {
  const wrap = el('label', 'checkbox');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  wrap.append(input);
  if (label) wrap.append(text(label));
  return wrap;
}
function getPath(obj, path) {
  let node = obj;
  for (const part of path.split('.')) {
    if (node == null) return undefined;
    node = node[part];
  }
  return node;
}
function decimalsFor(step) {
  if (!step || step >= 1) return 0;
  return Math.min(6, Math.max(0, Math.ceil(-Math.log10(step))));
}
function round(v, step) {
  const d = decimalsFor(step);
  return Number(v.toFixed(d));
}
function format(v, step) {
  if (Math.abs(v) >= 1e5 || (v !== 0 && Math.abs(v) < 1e-4)) return v.toExponential(2);
  return v.toFixed(decimalsFor(step));
}

let flashTimer = 0;
function flash(root, message) {
  let node = root.querySelector('.flash-message');
  if (!node) {
    node = el('div', 'flash-message pill on');
    node.style.position = 'absolute';
    node.style.bottom = '14px';
    node.style.left = '50%';
    node.style.transform = 'translateX(-50%)';
    node.style.zIndex = '30';
    root.append(node);
  }
  node.textContent = message;
  node.classList.remove('hidden');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => node?.classList.add('hidden'), 2200);
}
