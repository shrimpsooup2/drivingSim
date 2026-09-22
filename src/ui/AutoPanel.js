import { EXAMPLE_AUTO } from '../teleop/autoExample.js';
import { FIELD_FRAMES, FRAME_LABELS } from '../math/fieldFrames.js';

/** Where the routine is kept between sessions. */
const STORAGE_KEY = 'ftcsim.auto.source';

/**
 * The AUTO editor: paste a routine in, compile it, watch it run.
 *
 * Deliberately a plain textarea rather than a syntax-highlighting editor.
 * Nobody writes an auto here from scratch -- they write it in their own IDE
 * against the real SDK and paste it in to see it move -- so what matters is
 * that pasting is one gesture, that a mistake says where it is, and that the
 * routine is still there tomorrow. A code editor would be a lot of machinery
 * to make the one thing people do slightly prettier.
 *
 * What it reports while running is the part worth having: the state, the
 * runtime, whatever the routine logged, and its telemetry -- the same three
 * things a Driver Station shows, for the same reason.
 *
 * ## The pose row
 *
 * Underneath is where the robot starts, in whichever coordinate frame your
 * routine uses. An AUTO is a list of coordinates and the first of them is the
 * start pose, so being able to type it -- in the inches and degrees the routine
 * is written in, rather than in metres from the field centre -- is the
 * difference between testing a routine and porting it first. The frame picker
 * is the same three frames `robot.frame` offers.
 */
export class AutoPanel {
  /**
   * @param {HTMLElement} viewport
   * @param {import('../app/Simulation.js').Simulation} sim
   */
  constructor(viewport, sim) {
    this.sim = sim;
    this.runner = sim.autoRunner;

    this.button = el('button', 'panel-toggle auto-toggle');
    this.button.textContent = 'Auto';
    this.button.title = 'Paste in an autonomous routine (F)';
    this.button.addEventListener('click', () => this.toggle());
    viewport.append(this.button);

    this.overlay = el('div', 'overlay hidden');
    this.card = el('div', 'overlay-card auto-editor');
    this.overlay.append(this.card);
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.toggle(false);
    });
    viewport.append(this.overlay);

    const head = el('div', 'auto-head');
    head.append(el('h2', '', 'Autonomous'));
    this.state = el('span', 'auto-state');
    head.append(this.state);
    this.card.append(head);

    this.card.append(
      el(
        'p',
        'auto-blurb',
        'Runs during the 30-second AUTO period, on the same physics you drive: ' +
          'the same battery sag, the same encoder quantisation, the same flywheel ' +
          'recovery. Define function* auto(robot) and use yield to wait, or ' +
          'function loop(robot, dt) for a state machine. It is compiled and run in ' +
          'this page, so paste code you wrote.',
      ),
    );

    this.editor = document.createElement('textarea');
    this.editor.className = 'auto-source';
    this.editor.spellcheck = false;
    this.editor.value = loadSource();
    this.card.append(this.editor);

    this.message = el('div', 'auto-message');
    this.card.append(this.message);

    const actions = el('div', 'auto-actions');
    this.compileButton = button('Compile', () => this.compile());
    this.restartButton = button('Restart match', () => this.restart());
    this.exampleButton = button('Load example', () => {
      this.editor.value = EXAMPLE_AUTO;
      this.compile();
    });
    this.clearButton = button('Clear', () => {
      this.editor.value = '';
      this.runner.clear();
      saveSource('');
      this._render();
    });
    actions.append(this.compileButton, this.restartButton, this.exampleButton, this.clearButton);
    this.card.append(actions);

    // ------------------------------------------------------------- the pose row
    const pose = el('div', 'auto-pose');
    pose.append(el('span', 'auto-pose-label', 'Pose'));

    this.frameSelect = document.createElement('select');
    this.frameSelect.className = 'auto-pose-frame';
    for (const name of FIELD_FRAMES) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = FRAME_LABELS[name].label;
      this.frameSelect.append(option);
    }
    this.frameSelect.value = 'ftc';
    this.frameSelect.setAttribute('aria-label', 'Coordinate frame');
    this.frameSelect.addEventListener('change', () => this._showPose());
    pose.append(this.frameSelect);

    this.poseInputs = {};
    for (const axis of ['x', 'y', 'heading']) {
      const field = document.createElement('input');
      field.className = 'auto-pose-input';
      field.inputMode = 'decimal';
      field.setAttribute('aria-label', axis);
      field.placeholder = axis;
      field.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.placeRobot();
      });
      this.poseInputs[axis] = field;
      pose.append(field);
    }

    this.placeButton = button('Put it here', () => this.placeRobot());
    this.startHereButton = button('Start here', () => this.useAsStart());
    this.readPoseButton = button('Read back', () => this._showPose(true));
    pose.append(this.placeButton, this.startHereButton, this.readPoseButton);
    this.card.append(pose);
    this.card.append(
      el(
        'p',
        'auto-pose-hint',
        'Ctrl-drag on the field moves the robot too. "Start here" is where a ' +
          'match reset puts it, which is what you want between runs of a routine.',
      ),
    );
    this._showPose(true);

    this.readout = el('div', 'auto-readout');
    this.card.append(this.readout);

    // Compile whatever was there from last time, so a reload picks up where it
    // left off rather than silently having no auto.
    if (this.editor.value.trim()) this.compile();
    this._render();
  }

  get open() {
    return !this.overlay.classList.contains('hidden');
  }

  toggle(force) {
    const open = force ?? !this.open;
    this.overlay.classList.toggle('hidden', !open);
    this.button.classList.toggle('active', open);
    if (open) {
      this._render();
      this.editor.focus();
    }
    return this;
  }

  /** Compile what is in the editor and remember it. */
  compile() {
    const source = this.editor.value;
    saveSource(source);
    const error = this.runner.compile(source);
    this._render();
    return error;
  }

  /**
   * Put the match back to the start so the routine runs again.
   *
   * `Simulation.reset` and `BiobuzzGame.start` both re-arm the routine
   * themselves, so this is only the one gesture.
   */
  restart() {
    if (this.sim.game) this.sim.game.start();
    else this.sim.reset();
    this._render();
    return this;
  }

  /** The frame the pose row is working in. */
  get frame() {
    return this.frameSelect.value;
  }

  /** What is typed in the three boxes, or null if any of them is not a number. */
  readPose() {
    const out = {};
    for (const axis of ['x', 'y', 'heading']) {
      const value = Number(this.poseInputs[axis].value);
      if (!Number.isFinite(value)) return null;
      out[axis] = value;
    }
    return out;
  }

  /** Move the robot to the typed pose, leaving the match alone. */
  placeRobot() {
    const pose = this.readPose();
    if (!pose) {
      this.message.textContent = 'Type three numbers: x, y and a heading.';
      this.message.classList.remove('hidden');
      return null;
    }
    this.sim.placeRobot(pose.x, pose.y, pose.heading, this.frame);
    this._showPose(true);
    return pose;
  }

  /** And make it the pose a reset goes back to. */
  useAsStart() {
    const pose = this.placeRobot();
    if (pose) this.sim.setStartPose(pose.x, pose.y, pose.heading, this.frame);
    return pose;
  }

  /**
   * Fill the boxes from where the robot actually is.
   *
   * `force` overwrites whatever is typed; without it a number the user is part
   * way through typing is left alone, because a field that rewrites itself
   * under the cursor cannot be typed into.
   */
  _showPose(force = false) {
    const pose = this.sim.pose(this.frame);
    const decimals = this.frame === 'sim' ? 3 : 1;
    for (const [axis, value] of Object.entries(pose)) {
      const field = this.poseInputs[axis];
      if (!field) continue;
      if (!force && field === document.activeElement) continue;
      field.value = value.toFixed(decimals);
    }
    return this;
  }

  /** Called every frame while the panel is open. */
  update() {
    if (!this.open) return this;
    this._render();
    return this;
  }

  _render() {
    const status = this.runner.status();
    this.state.textContent = STATE_LABEL[status.state] ?? status.state;
    this.state.className = `auto-state ${status.state}`;

    this.message.textContent = status.error ?? '';
    this.message.classList.toggle('hidden', !status.error);

    const lines = [];
    lines.push(`runtime ${status.runtime.toFixed(2)} s`);
    if (this.sim.runningAuto) lines.push('driving now');
    else if (status.state === 'done') lines.push('restart the match to run it again');
    else if (this.runner.armed) lines.push('waiting for AUTO');
    const telemetry = Object.entries(status.telemetry);
    if (telemetry.length) {
      lines.push(telemetry.map(([k, v]) => `${k}: ${v}`).join('   '));
    }
    this._showPose();
    this.readout.innerHTML = '';
    this.readout.append(el('div', 'auto-stats', lines.join('   -   ')));
    if (status.log.length) {
      const log = el('div', 'auto-log');
      // Newest last, as a log reads, and scrolled to the end.
      for (const line of status.log.slice(-12)) log.append(el('div', '', line));
      this.readout.append(log);
      log.scrollTop = log.scrollHeight;
    }
  }
}

const STATE_LABEL = {
  empty: 'nothing loaded',
  compiled: 'ready',
  running: 'running',
  done: 'finished',
  error: 'error',
};

/**
 * The saved routine, or the example the first time.
 *
 * Starting empty would be the safe choice and the wrong one: the first thing
 * anybody needs is a routine that already works, to change one number in.
 */
function loadSource() {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (saved !== null && saved !== undefined) return saved;
  } catch {
    // Private browsing, or storage turned off. The example is a fine default.
  }
  return EXAMPLE_AUTO;
}

function saveSource(source) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, source);
  } catch {
    // Nothing to do about it, and losing the draft is better than a crash.
  }
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
