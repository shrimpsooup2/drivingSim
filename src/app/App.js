import { Config } from '../config/Config.js';
import { Simulation } from './Simulation.js';
import { Renderer } from '../render/Renderer.js';
import { Hud } from '../ui/Hud.js';
import { ParamPanel } from '../ui/ParamPanel.js';
import { InputManager } from '../input/InputManager.js';
import { KEYBOARD_HELP } from '../input/KeyboardSource.js';
import { INCH } from '../math/MathUtil.js';

/**
 * Wires the simulation, renderer and UI together and runs the frame loop.
 *
 * Everything below the app layer is headless and testable: the simulation runs
 * fine in Node with no canvas, which is how the physics is regression-tested.
 */
export class App {
  /** @param {HTMLElement} root */
  constructor(root) {
    this.root = root;
    this.config = new Config();
    this.config.load();

    this.canvas = /** @type {HTMLCanvasElement} */ (root.querySelector('#field-canvas'));
    this.viewport = /** @type {HTMLElement} */ (root.querySelector('#viewport'));
    this.panelRoot = /** @type {HTMLElement} */ (root.querySelector('#panel'));
    this.hudRoot = /** @type {HTMLElement} */ (root.querySelector('#hud'));

    this.input = new InputManager({
      latencySeconds: this.config.values.control.inputLatencyMs / 1000,
      target: globalThis,
    });
    this.input.attach();

    this.sim = new Simulation(this.config, { input: this.input });
    // Start at the driver-station end of the field, facing down the field, the
    // way a match begins.
    this.sim.setStartPose(-this.sim.field.halfSize + 24 * INCH, 0, 0);
    this.sim.resetRobot();

    this.renderer = new Renderer(this.canvas);
    this.hud = new Hud(this.hudRoot);
    this.panel = new ParamPanel(this.panelRoot, this.config);

    this._buildOverlays();
    this._bindKeys();
    this._bindMouse();

    this.lastFrame = 0;
    this.running = true;
    this._frame = this._frame.bind(this);
    requestAnimationFrame(this._frame);
  }

  _buildOverlays() {
    // Panel toggle button lives over the viewport so it is reachable when the
    // panel is hidden.
    const toggle = document.createElement('button');
    toggle.className = 'panel-toggle';
    toggle.textContent = 'Settings';
    toggle.addEventListener('click', () => this.togglePanel());
    this.viewport.append(toggle);
    this.panelToggle = toggle;

    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    const card = document.createElement('div');
    card.className = 'overlay-card';
    card.innerHTML = `
      <h2>FTC Driving Simulator</h2>
      <p>A physics-accurate parallel-plate drivetrain to practise on before kickoff.
         Plug in a controller (Logitech F310 with the rear switch on <strong>X</strong>, or an
         Xbox pad) and press a button on it to wake it up, or drive with the keyboard.</p>
      <h3>Controller</h3>
      <div class="keys">
        <kbd>Left stick</kbd><span>Drive and strafe</span>
        <kbd>Right stick X</kbd><span>Rotate</span>
        <kbd>Left trigger</kbd><span>Precision mode (analogue)</span>
        <kbd>Right trigger</kbd><span>Bypass the acceleration ramp</span>
        <kbd>Y</kbd><span>Toggle field centric</span>
        <kbd>B</kbd><span>Reset IMU heading</span>
        <kbd>Back</kbd><span>Reset robot position</span>
      </div>
      <h3>Keyboard</h3>
      <div class="keys">
        ${KEYBOARD_HELP.map(([k, d]) => `<kbd>${k}</kbd><span>${d}</span>`).join('')}
        <kbd>P</kbd><span>Pause</span>
        <kbd>?</kbd><span>Show this help</span>
      </div>
      <h3>Reading the field</h3>
      <p>Arrows at each wheel show the ground force it is producing: green means grip
         in reserve, red means that wheel is at the limit and about to slide. Red crosses
         mark a wheel that <em>is</em> sliding. Watch them on a hard launch.</p>
      <p style="margin-top:16px"><button class="primary" id="start-driving">Start driving</button></p>
    `;
    overlay.append(card);
    this.viewport.append(overlay);
    this.helpOverlay = overlay;
    card.querySelector('#start-driving')?.addEventListener('click', () => this.toggleHelp(false));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.toggleHelp(false);
    });
  }

  togglePanel(force) {
    const collapsed = force === undefined ? !this.panelRoot.classList.contains('collapsed') : !force;
    this.panelRoot.classList.toggle('collapsed', collapsed);
  }

  toggleHelp(force) {
    const show = force === undefined ? this.helpOverlay.classList.contains('hidden') : force;
    this.helpOverlay.classList.toggle('hidden', !show);
  }

  _bindKeys() {
    const keyboard = this.input.keyboardSource;
    keyboard.on('KeyR', () => {
      this.sim.resetRobot();
      this.hud.clearGraphs();
    });
    keyboard.on('KeyC', () => this._cycleCamera());
    keyboard.on('KeyF', () => {
      const opMode = /** @type {any} */ (this.sim.opMode);
      opMode.driver?.toggleFieldCentric?.();
    });
    keyboard.on('KeyH', () => this.sim.robot.imu.resetYaw(this.sim.robot.body.rotation.radians));
    keyboard.on('KeyP', () => {
      this.sim.paused = !this.sim.paused;
    });
    keyboard.on('Tab', () => this.togglePanel());
    keyboard.on('Slash', () => this.toggleHelp());
    keyboard.on('Escape', () => this.toggleHelp(false));
  }

  _cycleCamera() {
    const modes = ['driverStation', 'chase', 'overhead', 'orbit'];
    const i = modes.indexOf(this.config.values.view.camera);
    this.config.set('view.camera', modes[(i + 1) % modes.length]);
  }

  _bindMouse() {
    let dragging = false;
    let button = 0;
    let lastX = 0;
    let lastY = 0;

    this.canvas.addEventListener('pointerdown', (e) => {
      if (this.config.values.view.camera !== 'orbit') return;
      dragging = true;
      button = e.button;
      lastX = e.clientX;
      lastY = e.clientY;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (button === 0) this.renderer.camera.orbitDrag(dx, dy);
      else this.renderer.camera.orbitPan(dx, dy);
    });
    const stop = (e) => {
      dragging = false;
      if (e.pointerId !== undefined && this.canvas.hasPointerCapture?.(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }
    };
    this.canvas.addEventListener('pointerup', stop);
    this.canvas.addEventListener('pointercancel', stop);
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        if (this.config.values.view.camera !== 'orbit') return;
        e.preventDefault();
        this.renderer.camera.orbitZoom(e.deltaY);
      },
      { passive: false },
    );
  }

  _frame(timestamp) {
    if (!this.running) return;
    requestAnimationFrame(this._frame);

    const dt = this.lastFrame ? Math.min((timestamp - this.lastFrame) / 1000, 0.25) : 1 / 60;
    this.lastFrame = timestamp;

    try {
      this.sim.step(dt);
      this.renderer.render(this.sim, dt);
      const view = this.config.values.view;
      this.hud.setVisible(view.showHud, view.showGraphs);
      if (view.showHud || view.showGraphs) this.hud.update(this.sim, dt);
    } catch (err) {
      this.running = false;
      console.error('[App] frame failed:', err);
      showFatal(this.viewport, err);
    }
  }
}

/** Render a readable message instead of a blank canvas when something fails. */
export function showFatal(container, err) {
  const box = document.createElement('div');
  box.className = 'error-box';
  const message = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err);
  box.textContent = `The simulator hit an error and stopped.\n\n${message}`;
  container.append(box);
}
