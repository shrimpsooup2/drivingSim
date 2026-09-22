/**
 * The hardware inspector: every device on the robot, live, and some of it
 * editable.
 *
 * ## Two jobs
 *
 * **Seeing.** A Driver Station tells you what your op-mode chose to print. This
 * tells you what the hardware is actually doing -- what duty each port ended up
 * at, what its encoder reads, what the pack is delivering, what the hubs cost
 * you this cycle. When a robot behaves oddly the answer is usually in one of
 * those numbers and usually in the one nobody printed.
 *
 * **Breaking.** The sensor rows are editable, and that is the half worth
 * having. An encoder cable comes unplugged, a pod's arm lifts, an I2C bus stops
 * answering -- and none of those look like hardware failures from inside an
 * op-mode. They look like a routine that drives into a wall, or a
 * field-centric drive that slowly rotates its own frame. You cannot practise
 * for that on a working robot, and you cannot easily break a real one on
 * purpose. Here it is a dropdown.
 *
 * Ported from the JVM simulator's Robot/Hardware inspector, which does the same
 * thing against real SDK device objects.
 *
 * @module
 */
import { fmt } from '../util/units.js';
import { INCH, radPerSecToRpm } from '../math/MathUtil.js';

/** The faults every sensor here can be given. */
const FAULTS = [
  { value: 'none', label: 'working' },
  { value: 'dead', label: 'dead (reads zero)' },
  { value: 'stuck', label: 'stuck (holds its last)' },
];

export class HardwarePanel {
  /**
   * @param {HTMLElement} viewport
   * @param {import('../app/Simulation.js').Simulation} sim
   */
  constructor(viewport, sim) {
    this.sim = sim;

    this.button = el('button', 'panel-toggle hardware-toggle');
    this.button.textContent = 'Hardware';
    this.button.title = 'Inspect every device, and break one (`)';
    this.button.addEventListener('click', () => this.toggle());
    viewport.append(this.button);

    this.overlay = el('div', 'overlay hidden');
    this.card = el('div', 'overlay-card hardware-card');
    this.overlay.append(this.card);
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.toggle(false);
    });
    viewport.append(this.overlay);

    const head = el('div', 'hardware-head');
    head.append(el('h2', '', 'Hardware'));
    this.faultPill = el('span', 'hardware-faults');
    head.append(this.faultPill);
    this.card.append(head);

    this.card.append(
      el(
        'p',
        'hardware-blurb',
        'What every device is actually doing, and what happens when one stops. ' +
          'An unplugged encoder or a stuck IMU does not look like a hardware ' +
          'failure from inside an op-mode -- it looks like a routine that drives ' +
          'into a wall. This is where you find out what yours does.',
      ),
    );

    this.body = el('div', 'hardware-body');
    this.card.append(this.body);

    const actions = el('div', 'hardware-actions');
    this.repairButton = button('Repair everything', () => this.repair());
    actions.append(this.repairButton);
    this.card.append(actions);

    /** Sections are built once and repainted, so inputs keep focus. */
    this._sections = new Map();
    this._builtFor = '';
    this._build();
    this.update();
  }

  get open() {
    return !this.overlay.classList.contains('hidden');
  }

  toggle(force) {
    const show = force === undefined ? !this.open : force;
    this.overlay.classList.toggle('hidden', !show);
    this.button.classList.toggle('active', show);
    if (show) this.update();
    return this;
  }

  /** Clear every injected fault. One button, because faults are easy to forget. */
  repair() {
    const robot = this.sim.robot;
    for (const motor of robot.drivetrain.motors) {
      motor.encoder.fault = 'none';
      motor.encoder.offsetTicks = 0;
    }
    robot.imu.fault = 'none';
    robot.imu.bias = 0;
    for (const pod of robot.odometry.pods) pod.fault = 'none';
    this.update();
    return this;
  }

  /** How many devices are faulted, so the button can say so from outside. */
  get faultCount() {
    const robot = this.sim.robot;
    let count = 0;
    for (const motor of robot.drivetrain.motors) if (motor.encoder.fault !== 'none') count++;
    if (robot.imu.fault !== 'none') count++;
    for (const pod of robot.odometry.pods) if (pod.fault !== 'none') count++;
    return count;
  }

  // ------------------------------------------------------------------ building

  _build() {
    this.body.textContent = '';
    this._sections.clear();
    this._builtFor = this._signature();
    this._section('hub', 'Control Hub', ['Loop', 'Hub time', 'Transactions', 'Caching']);
    this._section('battery', 'Battery', ['Bus voltage', 'Current', 'Charge']);
    this._imuSection();
    this._section('subsystems', 'Mechanisms', ['Flywheel', 'Held']);

    // One row per drive port, plus a fault selector for its encoder.
    const motors = this.sim.robot.drivetrain.motors;
    // Full width: four numbers and a dropdown do not fit in half a card, and
    // wrapping them into a vertical stack makes four ports unreadable.
    const ports = this._section(
      'motors',
      'Drive ports',
      motors.map((m) => m.name),
      { wide: true },
    );
    ports.faults = new Map();
    motors.forEach((motor, index) => {
      const row = ports.rows[motor.name];
      // By index, not by holding the motor: the drivetrain is rebuilt whenever
      // a setting that changes its geometry does, and a closure over the old
      // `DriveMotor` would then quietly set a fault on an object nothing reads.
      const select = faultSelect(`motor:${motor.name}`, () => {
        const port = this.sim.robot.drivetrain.motors[index];
        if (port) port.encoder.fault = select.value;
        this.update();
      });
      row.after.append(select);
      ports.faults.set(motor.name, select);
    });

    // A row per pod rather than all of them on one: a fault selector squeezed
    // into a third of a row is a selector nobody can read the options of.
    const pods = this.sim.robot.odometry.pods;
    const odometry = this._section(
      'odometry',
      'Odometry',
      ['Pose', 'Drift', ...pods.map((pod) => pod.name)],
      { wide: true },
    );
    odometry.podFaults = [];
    pods.forEach((pod, index) => {
      // Also by index: changing a pod offset rebuilds them.
      const select = faultSelect(`pod:${pod.name}`, () => {
        const target = this.sim.robot.odometry.pods[index];
        if (target) target.fault = select.value;
        this.update();
      });
      odometry.rows[pod.name].after.append(select);
      odometry.podFaults.push({ index, name: pod.name, select });
    });

  }

  /** The IMU, with a fault selector and a drift you can dial in. */
  _imuSection() {
    const imu = this._section('imu', 'IMU', ['Heading', 'True heading', 'Error']);
    const imuFault = faultSelect('imu', () => {
      this.sim.robot.imu.fault = imuFault.value;
      this.update();
    });
    imu.rows['Heading'].after.append(imuFault);
    imu.imuFault = imuFault;
    // Drift, injected directly, because a slow bias is the failure people
    // actually meet and it is not a fault so much as a fact of the sensor.
    const bias = numberInput('deg', (value) => {
      this.sim.robot.imu.bias = (value * Math.PI) / 180;
    });
    imu.rows['Error'].after.append(bias);
    imu.bias = bias;
    return imu;
  }

  /**
   * A titled block of label/value rows, each with room for a control.
   * @param {string} id
   * @param {string} title
   * @param {string[]} labels
   * @param {{wide?: boolean}} [opts]
   */
  _section(id, title, labels, opts = {}) {
    const node = el('div', `hardware-section${opts.wide ? ' wide' : ''}`);
    node.append(el('div', 'hardware-title', title));
    /** @type {Record<string, {value: HTMLElement, after: HTMLElement}>} */
    const rows = {};
    for (const label of labels) {
      const row = el('div', 'hardware-row');
      row.append(el('span', 'hardware-label', label));
      const value = el('span', 'hardware-value', '-');
      const after = el('span', 'hardware-after');
      row.append(value, after);
      node.append(row);
      rows[label] = { value, after };
    }
    this.body.append(node);
    const section = { node, rows };
    this._sections.set(id, section);
    return section;
  }

  // ------------------------------------------------------------------ painting

  /**
   * What the panel was built for: the ports and pods that existed then.
   *
   * Both are rebuilt when a setting changes their geometry -- a different
   * drivetrain layout, a moved pod -- and a panel showing rows for devices that
   * no longer exist is worse than one that rebuilt itself.
   */
  _signature() {
    const robot = this.sim.robot;
    return [
      robot.drivetrain.motors.map((m) => m.name).join(','),
      robot.odometry.pods.map((p) => p.name).join(','),
    ].join(' | ');
  }

  /** Called every frame while open, and once on every fault change. */
  update() {
    if (this._builtFor !== this._signature()) this._build();
    if (!this.open) {
      const faults = this.faultCount;
      this.button.classList.toggle('faulted', faults > 0);
      return this;
    }
    const sim = this.sim;
    const robot = sim.robot;
    const bus = robot.bus;

    const faults = this.faultCount;
    this.button.classList.toggle('faulted', faults > 0);
    this.faultPill.textContent = faults
      ? `${faults} device${faults === 1 ? '' : 's'} faulted`
      : 'all working';
    this.faultPill.dataset.tone = faults ? 'bad' : 'good';
    this.repairButton.disabled = faults === 0 && robot.imu.bias === 0;

    // --- hub
    const hub = this._sections.get('hub').rows;
    hub['Loop'].value.textContent = `${fmt(sim.controlPeriod * 1000, 2)} ms`;
    hub['Hub time'].value.textContent =
      `${fmt(bus.lastSeconds * 1000, 2)} ms · ${fmt(bus.totalSeconds, 1)} s total`;
    const counts = bus.lastCounts;
    hub['Transactions'].value.textContent =
      `${counts.write}w · ${counts.bulkRead}b · ${counts.read}r · ${counts.i2c}i`;
    hub['Caching'].value.textContent = bus.enabled
      ? `${bus.cachingMode}${bus.cacheWarm ? ', warm' : ''}`
      : `${bus.cachingMode}, free`;

    // --- battery
    const battery = this._sections.get('battery').rows;
    battery['Bus voltage'].value.textContent = `${fmt(robot.battery.busVoltage, 2)} V`;
    battery['Current'].value.textContent = `${fmt(robot.battery.current, 1)} A`;
    battery['Charge'].value.textContent = `${fmt(robot.battery.stateOfCharge * 100, 0)} %`;

    // --- drive ports
    const ports = this._sections.get('motors');
    for (const motor of robot.drivetrain.motors) {
      const row = ports.rows[motor.name];
      if (!row) continue;
      const rpm = radPerSecToRpm(motor.encoder.velocityRadPerSec);
      row.value.textContent =
        `${fmt(motor.duty, 2)} duty · ${motor.encoder.ticks} tk · ` +
        `${fmt(rpm, 0)} rpm · ${fmt(motor.current, 1)} A`;
      const select = ports.faults.get(motor.name);
      if (select && select.value !== motor.encoder.fault) select.value = motor.encoder.fault;
    }

    // --- imu
    const imu = this._sections.get('imu');
    const reported = (robot.imu.heading * 180) / Math.PI;
    const actual = (robot.body.rotation.radians * 180) / Math.PI;
    imu.rows['Heading'].value.textContent = `${fmt(reported, 2)} deg`;
    imu.rows['True heading'].value.textContent = `${fmt(actual, 2)} deg`;
    imu.rows['Error'].value.textContent = `${fmt(wrapDeg(reported - actual), 2)} deg`;
    if (imu.imuFault.value !== robot.imu.fault) imu.imuFault.value = robot.imu.fault;
    if (document.activeElement !== imu.bias) {
      imu.bias.value = ((robot.imu.bias * 180) / Math.PI).toFixed(2);
    }

    // --- odometry
    const odometry = this._sections.get('odometry');
    if (robot.odometry.enabled) {
      const pose = robot.odometry.pose;
      const error = robot.odometry.error({
        x: robot.body.position.x,
        y: robot.body.position.y,
        heading: robot.body.rotation.radians,
      });
      odometry.rows['Pose'].value.textContent =
        `${fmt(pose.x / INCH, 1)}, ${fmt(pose.y / INCH, 1)} in  ` +
        `${fmt((pose.heading * 180) / Math.PI, 1)} deg`;
      odometry.rows['Drift'].value.textContent =
        `${fmt(error.distance / INCH, 2)} in, ${fmt((error.heading * 180) / Math.PI, 2)} deg`;
      for (const { index, name } of odometry.podFaults) {
        const pod = robot.odometry.pods[index];
        const row = odometry.rows[name];
        if (!pod || !row) continue;
        row.value.textContent = `${pod.ticks} tk · ${fmt(pod.metres / INCH, 2)} in`;
      }
    } else {
      odometry.rows['Pose'].value.textContent = 'not fitted';
      odometry.rows['Drift'].value.textContent = '-';
      for (const { name } of odometry.podFaults) {
        const row = odometry.rows[name];
        if (row) row.value.textContent = '-';
      }
    }
    for (const { index, select } of odometry.podFaults) {
      const pod = robot.odometry.pods[index];
      if (pod && select.value !== pod.fault) select.value = pod.fault;
    }

    // --- mechanisms
    const mech = this._sections.get('subsystems').rows;
    const shooter = robot.subsystems.find((s) => typeof s.fire === 'function');
    const intake = robot.subsystems.find((s) => 'held' in s && 'capacity' in s);
    mech['Flywheel'].value.textContent = shooter
      ? `${fmt(shooter.rpm ?? 0, 0)} / ${fmt(shooter.targetRpm ?? 0, 0)} rpm${shooter.ready ? '  ready' : ''}`
      : 'none';
    mech['Held'].value.textContent = intake
      ? `${intake.count} of ${intake.capacity}`
      : 'no intake';

    return this;
  }
}

/**
 * @param {string} device a stable name for what this breaks, e.g.
 *   `motor:frontLeft`. On the element as `data-device`, so a test can find the
 *   selector for one device rather than counting from the top of the panel --
 *   which is a thing that breaks every time a section moves.
 * @param {() => void} onChange
 */
function faultSelect(device, onChange) {
  const node = document.createElement('select');
  node.className = 'hardware-fault';
  node.dataset.device = device;
  node.setAttribute('aria-label', `${device} fault`);
  for (const fault of FAULTS) {
    const option = document.createElement('option');
    option.value = fault.value;
    option.textContent = fault.label;
    node.append(option);
  }
  node.addEventListener('change', onChange);
  return node;
}

function numberInput(suffix, onChange) {
  const node = document.createElement('input');
  node.className = 'hardware-input';
  node.inputMode = 'decimal';
  node.title = suffix;
  node.addEventListener('change', () => {
    const value = Number(node.value);
    if (Number.isFinite(value)) onChange(value);
  });
  return node;
}

function wrapDeg(degrees) {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

function button(label, onClick) {
  const node = el('button', 'auto-button', label);
  node.addEventListener('click', onClick);
  return node;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
