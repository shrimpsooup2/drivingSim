import { EXAMPLE_AUTO } from '../teleop/autoExample.js';
import { FIELD_FRAMES, FRAME_LABELS } from '../math/fieldFrames.js';
import {
  loadDirectoryHandle,
  loadDroppedFiles,
  loadGitHubRepo,
  loadLocalRepo,
} from '../net/repo.js';

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
 * ## Java, and where it comes from
 *
 * The editor takes JavaScript or **Java**. Paste a real `LinearOpMode` and it
 * is compiled and run against a shim of the SDK; which language you handed over
 * is detected rather than selected.
 *
 * And a repository has many op-modes, so there is a way to load one and a
 * chooser to pick from it -- the same job a Driver Station's op-mode menu does.
 * Three ways in, because a team has three situations: a checkout on this
 * machine (`npm start -- --repo ../FtcRobotController`), a GitHub repository by
 * name, or a folder picked or dropped. See `net/repo.js`.
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
        'Runs on the same physics you drive: the same battery sag, the same ' +
          'encoder quantisation, the same flywheel recovery. Load your team\u2019s ' +
          'repository, or paste a real LinearOpMode \u2014 Java is compiled and run ' +
          'against a shim of the FTC SDK. JavaScript works too: define ' +
          'function* auto(robot) and yield to wait. It runs in this page, so load ' +
          'code you wrote.',
      ),
    );

    // ------------------------------------------------------------ the sources
    const sources = el('div', 'auto-sources');
    sources.append(el('span', 'auto-pose-label', 'Load'));
    this.repoButton = button('From this machine', () => this.loadRepo());
    this.githubInput = el('input', 'auto-github');
    this.githubInput.placeholder = 'owner/repo';
    this.githubInput.setAttribute('aria-label', 'GitHub repository');
    this.githubInput.value = loadRepoSpec();
    this.githubInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.loadGitHub();
    });
    this.githubButton = button('From GitHub', () => this.loadGitHub());
    this.folderButton = button('Pick a folder', () => this.pickFolder());
    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = '.java';
    this.fileInput.multiple = true;
    this.fileInput.className = 'auto-file-input';
    this.fileInput.addEventListener('change', () => this.loadFiles(this.fileInput.files));
    this.filesButton = button('Pick files', () => this.fileInput.click());
    sources.append(this.repoButton, this.githubInput, this.githubButton, this.folderButton, this.filesButton);
    this.card.append(sources);
    this.card.append(this.fileInput);

    // ---------------------------------------------------------- the op-modes
    this.chooserRow = el('div', 'auto-sources hidden');
    this.chooserRow.append(el('span', 'auto-pose-label', 'Op-mode'));
    this.chooser = document.createElement('select');
    this.chooser.className = 'auto-chooser';
    this.chooser.setAttribute('aria-label', 'Op-mode');
    this.chooser.addEventListener('change', () => {
      this.sim.autoRunner.select(this.chooser.value);
      this._showSelectedSource();
      this._render();
    });
    this.chooserRow.append(this.chooser);
    this.sourceNote = el('span', 'auto-source-note');
    this.chooserRow.append(this.sourceNote);
    this.card.append(this.chooserRow);

    this.editor = document.createElement('textarea');
    this.editor.className = 'auto-source';
    this.editor.spellcheck = false;
    this.editor.value = loadSource();
    this.card.append(this.editor);

    // Dropping a folder or a handful of .java files is the shortest path from
    // "my auto is on this laptop" to "my auto is running".
    for (const event of ['dragover', 'dragenter']) {
      this.card.addEventListener(event, (e) => {
        e.preventDefault();
        this.card.classList.add('dropping');
      });
    }
    for (const event of ['dragleave', 'dragend']) {
      this.card.addEventListener(event, () => this.card.classList.remove('dropping'));
    }
    this.card.addEventListener('drop', (e) => {
      e.preventDefault();
      this.card.classList.remove('dropping');
      const files = e.dataTransfer?.files;
      if (files?.length) this.loadFiles(files);
    });

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
    /** Where the current files came from, for the readout. */
    this.loadedFrom = '';
    /** @type {string[]} */
    this.skipped = [];
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
    // Through `compile`, which detects the language: pasting a `LinearOpMode`
    // into the box is meant to work as well as loading one from a repository.
    const error = this.runner.compile(source);
    this.loadedFrom = this.runner.status().language === 'java' ? 'the editor' : '';
    this.skipped = [];
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

  // --------------------------------------------------------------- loading

  /**
   * Compile a set of files and report what happened.
   * @param {{root?: string, files: Array<{name: string, source: string}>, skipped?: string[]}} bundle
   */
  useFiles(bundle) {
    const files = bundle.files ?? [];
    if (files.length === 0) {
      this._say('nothing to load there', 'error');
      return null;
    }
    const error = this.runner.compileFiles(files);
    this.loadedFrom = bundle.root ?? '';
    this.skipped = bundle.skipped ?? [];
    // The editor shows the op-mode's own file, so what is on screen is what is
    // running rather than whichever file happened to be first.
    const chosen = this.runner.status().selected;
    const descriptor = this.runner.opModes.find((o) => o.className === chosen);
    const shown = files.find((f) => f.name === descriptor?.file) ?? files[0];
    this.editor.value = shown.source;
    saveSource(shown.source);
    this._render();
    if (error) this._say(error, 'error');
    else this._say(`${files.length} file(s) from ${this.loadedFrom || 'your files'}`);
    return error;
  }

  /** The checkout attached to the server serving this page. */
  async loadRepo() {
    this._say('looking for a repository on this machine...');
    try {
      this.useFiles(await loadLocalRepo());
    } catch (err) {
      this._say(err.message, 'error');
    }
  }

  /** A GitHub repository, by name. */
  async loadGitHub() {
    const spec = this.githubInput.value.trim();
    if (!spec) {
      this._say('type owner/repo, or a github.com link', 'error');
      return;
    }
    this._say(`fetching ${spec}...`);
    saveRepoSpec(spec);
    try {
      this.useFiles(await loadGitHubRepo(spec, { onNote: (note) => this._say(note) }));
    } catch (err) {
      this._say(err.message, 'error');
    }
  }

  /** A folder, picked in the browser. Chromium only. */
  async pickFolder() {
    if (typeof globalThis.showDirectoryPicker !== 'function') {
      this._say('This browser cannot pick a folder. Use Pick files, or drag the folder in.', 'error');
      return;
    }
    try {
      const handle = await globalThis.showDirectoryPicker({ mode: 'read' });
      this.useFiles(await loadDirectoryHandle(handle));
    } catch (err) {
      if (err?.name === 'AbortError') return;
      this._say(err.message, 'error');
    }
  }

  /** Files from the picker or a drop. */
  async loadFiles(fileList) {
    try {
      this.useFiles(await loadDroppedFiles(fileList));
    } catch (err) {
      this._say(err.message, 'error');
    }
  }

  /**
   * @param {string} message
   * @param {'news'|'error'} [tone] errors are red; loading three files is not
   *   an error, and colouring it like one was actively misleading
   */
  _say(message, tone = 'news') {
    this.message.textContent = message;
    this.message.classList.toggle('hidden', !message);
    this.message.classList.toggle('news', tone === 'news');
  }

  /**
   * Put the selected op-mode's own file in the editor.
   *
   * So what is on screen is what is running. Without it, choosing `Straight`
   * from the list left `Curve`'s source showing, which is the sort of small lie
   * that costs somebody half an hour.
   */
  _showSelectedSource() {
    const status = this.runner.status();
    const descriptor = (status.opModes ?? []).find((o) => o.className === status.selected);
    const file = this.runner.files.find((f) => f.name === descriptor?.file);
    if (!file) return this;
    this.editor.value = file.source;
    saveSource(file.source);
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
    /** Where the current files came from, for the readout. */
    this.loadedFrom = '';
    /** @type {string[]} */
    this.skipped = [];
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

    if (status.error) this._say(status.error, 'error');

    // The op-mode chooser, grouped the way a Driver Station groups them.
    const opModes = status.opModes ?? [];
    this.chooserRow.classList.toggle('hidden', opModes.length === 0);
    if (opModes.length > 0) {
      const signature = opModes.map((o) => `${o.group}/${o.name}/${o.className}`).join('|');
      if (this._chooserSignature !== signature) {
        this._chooserSignature = signature;
        this.chooser.textContent = '';
        let group = null;
        let parent = this.chooser;
        for (const opMode of opModes) {
          if (opMode.group !== group) {
            group = opMode.group;
            if (group) {
              parent = document.createElement('optgroup');
              parent.label = group;
              this.chooser.append(parent);
            } else {
              parent = this.chooser;
            }
          }
          const option = document.createElement('option');
          option.value = opMode.className;
          option.textContent = `${opMode.name}${opMode.kind === 'teleop' ? '  (teleop)' : ''}`;
          parent.append(option);
        }
      }
      if (status.selected && this.chooser.value !== status.selected) {
        this.chooser.value = status.selected;
      }
      const descriptor = opModes.find((o) => o.className === status.selected);
      const files = status.files ?? [];
      this.sourceNote.textContent = [
        descriptor ? descriptor.file : '',
        files.length > 1 ? `${files.length} files` : '',
        this.loadedFrom ? this.loadedFrom : '',
      ]
        .filter(Boolean)
        .join('  \u00b7  ');
    }

    const lines = [];
    lines.push(status.language === 'java' ? 'Java' : 'JavaScript');
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

    // What `hardwareMap.get` found. The single most useful thing to show about
    // a freshly loaded op-mode: a name that resolved to nothing is a mechanism
    // that will not move, and it would otherwise be silent.
    const resolutions = status.resolutions ?? [];
    if (resolutions.length > 0) {
      const wired = el('div', 'auto-wiring');
      for (const item of resolutions) {
        const row = el('div', item.attachedTo ? 'auto-wire' : 'auto-wire missing');
        row.textContent = `${item.name}  \u2192  ${item.attachedTo ?? 'nothing on this robot'}`;
        wired.append(row);
      }
      this.readout.append(wired);
    }
    for (const warning of status.warnings ?? []) {
      this.readout.append(el('div', 'auto-warning', warning));
    }
    if (this.skipped?.length) {
      this.readout.append(
        el('div', 'auto-warning', `${this.skipped.length} file(s) left out to stay within the size limit`),
      );
    }
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

/** The last repository typed, so loading it again is one click. */
const REPO_KEY = 'ftcsim.auto.repo';

function loadRepoSpec() {
  try {
    return globalThis.localStorage?.getItem(REPO_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveRepoSpec(spec) {
  try {
    globalThis.localStorage?.setItem(REPO_KEY, spec);
  } catch {
    /* private browsing; typing it again is a small price */
  }
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
