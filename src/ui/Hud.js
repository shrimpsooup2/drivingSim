import { fmt, fmtClock, toDisplay } from '../util/units.js';
import { Graph } from './Graph.js';
import { clamp } from '../math/MathUtil.js';

/**
 * Telemetry readout over the field view.
 *
 * Shows the numbers a driver or a build lead would actually act on: speed,
 * battery under load, how much grip is left, and whether a wheel is slipping.
 * Everything is refreshed by mutating existing nodes rather than rebuilding
 * DOM, so it costs nothing per frame.
 */
export class Hud {
  /** @param {HTMLElement} root */
  constructor(root) {
    this.root = root;

    this.speedCard = card('Speed');
    this.speedBig = div('hud-big');
    this.speedBig.innerHTML = '0.00<small>ft/s</small>';
    this.speedCard.append(this.speedBig);
    this.speedRows = rows(this.speedCard, ['Forward', 'Strafe', 'Rotation', 'Heading']);

    this.powerCard = card('Power');
    this.powerRows = rows(this.powerCard, ['Bus voltage', 'Current', 'Charge']);
    this.voltageBar = bar(this.powerCard, '#47d18a');
    this.chargeBar = bar(this.powerCard, '#2b9bd8');

    this.gripCard = card('Traction');
    this.gripRows = rows(this.gripCard, ['Grip used', 'Wheel slip', 'Load spread']);
    this.gripBar = bar(this.gripCard, '#47d18a');

    root.append(this.speedCard, this.powerCard, this.gripCard);

    this.status = div('status');
    /** @type {Map<string, HTMLElement>} */
    this.pills = new Map();
    root.parentElement?.append(this.status);

    this.graphContainer = div('graphs');
    this.graphs = {
      speed: new Graph({ label: 'Speed', unit: 'ft/s', color: '#2b9bd8', min: 0 }),
      current: new Graph({ label: 'Current', unit: 'A', color: '#f2a33c', min: 0 }),
      voltage: new Graph({ label: 'Bus', unit: 'V', color: '#47d18a' }),
      slip: new Graph({ label: 'Max wheel slip', unit: 'm/s', color: '#e2564a', min: 0 }),
    };
    for (const g of Object.values(this.graphs)) this.graphContainer.append(g.element);
    root.parentElement?.append(this.graphContainer);

    this._graphAccumulator = 0;
  }

  setVisible(hud, graphs) {
    this.root.classList.toggle('hidden', !hud);
    this.status.classList.toggle('hidden', !hud);
    this.graphContainer.classList.toggle('hidden', !graphs);
  }

  /**
   * @param {import('../app/Simulation.js').Simulation} sim
   * @param {number} dt
   */
  update(sim, dt) {
    const t = sim.telemetry();
    const config = sim.config;
    const robot = sim.robot;
    const FT = 3.280839895;

    this.speedBig.innerHTML = `${fmt(t.speed * FT, 2)}<small>ft/s</small>`;
    this.speedRows['Forward'].textContent = `${fmt(t.bodyVelocity.x * FT, 2)} ft/s`;
    this.speedRows['Strafe'].textContent = `${fmt(t.bodyVelocity.y * FT, 2)} ft/s`;
    this.speedRows['Rotation'].textContent = `${fmt(toDisplay(t.angularVelocity, 'deg/s'), 0)} deg/s`;
    this.speedRows['Heading'].textContent = `${fmt(toDisplay(t.pose.heading, 'deg'), 1)} deg`;

    const v = t.busVoltage;
    this.powerRows['Bus voltage'].textContent = `${fmt(v, 2)} V`;
    this.powerRows['Bus voltage'].className = v < 10.5 ? 'danger' : v < 11.5 ? 'warn' : '';
    this.powerRows['Current'].textContent = `${fmt(t.current, 1)} A`;
    this.powerRows['Charge'].textContent = `${fmt(t.stateOfCharge * 100, 0)} %`;
    setBar(this.voltageBar, clamp((v - 9) / (13.5 - 9), 0, 1), v < 10.5 ? '#e2564a' : v < 11.5 ? '#f2a33c' : '#47d18a');
    setBar(this.chargeBar, clamp(t.stateOfCharge, 0, 1), '#2b9bd8');

    const grip = clamp(t.peakGripUsage, 0, 1.2);
    let maxSlip = 0;
    for (const w of robot.drivetrain.wheels) maxSlip = Math.max(maxSlip, w.slipSpeed);
    this.gripRows['Grip used'].textContent = `${fmt(grip * 100, 0)} %`;
    this.gripRows['Wheel slip'].textContent = `${fmt(maxSlip, 3)} m/s`;
    this.gripRows['Wheel slip'].className = t.slipping ? 'danger' : '';

    const loads = robot.drivetrain.wheelLoads;
    let minLoad = Infinity;
    let maxLoad = 0;
    for (let i = 0; i < loads.length; i++) {
      minLoad = Math.min(minLoad, loads[i]);
      maxLoad = Math.max(maxLoad, loads[i]);
    }
    this.gripRows['Load spread'].textContent =
      loads.length > 0 ? `${fmt(minLoad, 0)} - ${fmt(maxLoad, 0)} N` : '-';
    this.gripRows['Load spread'].className = minLoad < 1 ? 'warn' : '';
    setBar(this.gripBar, clamp(grip, 0, 1), grip > 0.95 ? '#e2564a' : grip > 0.75 ? '#f2a33c' : '#47d18a');

    // Status pills.
    const opTelemetry = sim.opMode.telemetry ?? {};
    this._pill('time', fmtClock(t.time));
    this._pill('source', sim.input.activeSource === 'gamepad' ? 'CONTROLLER' : sim.input.activeSource === 'keyboard' ? 'KEYBOARD' : 'NO INPUT',
      sim.input.activeSource === 'gamepad');
    this._pill('mode', config.driver.scheme === 'fieldCentric' || opTelemetry['Field centric'] === 'ON' ? 'FIELD CENTRIC' : 'ROBOT CENTRIC');
    this._pill('run', config.control.runMode.replace('RUN_', ''));
    this._pill('camera', config.view.camera.toUpperCase());
    if (t.slipping) this._pill('slip', 'WHEEL SLIP', false, true);
    else this._removePill('slip');
    if (sim.input.controllerNonStandard) this._pill('nonstd', 'CONTROLLER NOT IN XINPUT MODE', false, true);
    else this._removePill('nonstd');
    if (sim.paused) this._pill('paused', 'PAUSED', false, true);
    else this._removePill('paused');
    this._pill('perf', `${t.substeps} substeps  ${fmt(t.stepCostMs, 1)} ms`);

    // Graphs at 20 Hz: fast enough to see a transient, slow enough to be free.
    this._graphAccumulator += dt;
    if (this._graphAccumulator >= 0.05) {
      this._graphAccumulator = 0;
      this.graphs.speed.push(t.speed * FT);
      this.graphs.current.push(t.current);
      this.graphs.voltage.push(t.busVoltage);
      this.graphs.slip.push(maxSlip);
      for (const g of Object.values(this.graphs)) g.draw();
    }
  }

  _pill(id, label, on = false, alert = false) {
    let pill = this.pills.get(id);
    if (!pill) {
      pill = div('pill');
      this.pills.set(id, pill);
      this.status.append(pill);
    }
    pill.textContent = label;
    pill.className = `pill${on ? ' on' : ''}${alert ? ' alert' : ''}`;
  }

  _removePill(id) {
    const pill = this.pills.get(id);
    if (pill) {
      pill.remove();
      this.pills.delete(id);
    }
  }

  clearGraphs() {
    for (const g of Object.values(this.graphs)) g.clear();
  }
}

function div(className) {
  const node = document.createElement('div');
  node.className = className;
  return node;
}
function card(title) {
  const c = div('hud-card');
  const t = div('hud-title');
  t.textContent = title;
  c.append(t);
  return c;
}
function rows(parent, labels) {
  /** @type {Record<string, HTMLElement>} */
  const out = {};
  for (const label of labels) {
    const row = div('hud-row');
    const left = document.createElement('span');
    left.textContent = label;
    const right = document.createElement('span');
    right.textContent = '-';
    row.append(left, right);
    parent.append(row);
    out[label] = right;
  }
  return out;
}
function bar(parent, color) {
  const outer = div('bar');
  const inner = document.createElement('div');
  inner.style.background = color;
  outer.append(inner);
  parent.append(outer);
  return inner;
}
function setBar(node, fraction, color) {
  node.style.width = `${(fraction * 100).toFixed(1)}%`;
  node.style.background = color;
}
