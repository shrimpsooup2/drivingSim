#!/usr/bin/env node
/**
 * Headless smoke test: load the simulator in Chromium, drive it, and fail if
 * anything throws.
 *
 * Uses the Chrome DevTools Protocol directly over Node's built-in WebSocket, so
 * like the rest of this project it needs no npm dependencies.
 *
 * Checks that:
 *   - the page loads with no console errors or unhandled exceptions,
 *   - WebGL2 initialises and the renderer produces frames,
 *   - simulated driving advances the robot and keeps the physics finite,
 *   - a screenshot can be captured (written to screenshots/).
 *
 * Usage: node tools/check.js [--headed] [--keep] [--shot path.png]
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.CHECK_PORT ?? 8099);
const DEBUG_PORT = Number(process.env.CHECK_CDP_PORT ?? 9223);

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter(Boolean);

function findChrome() {
  for (const path of CHROME_CANDIDATES) {
    if (path && existsSync(path)) return path;
  }
  return null;
}

const args = process.argv.slice(2);
const headed = args.includes('--headed');
const shotIndex = args.indexOf('--shot');
const shotPath = shotIndex >= 0 ? args[shotIndex + 1] : resolve(ROOT, 'screenshots/field.png');

/** Minimal CDP client over one WebSocket. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.handlers = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined) {
        const entry = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) entry?.reject(new Error(`${msg.error.message} (${entry.method})`));
        else entry?.resolve(msg.result);
      } else {
        this.events.push(msg);
        this.handlers.get(msg.method)?.forEach((h) => h(msg.params));
      }
    });
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej, method });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  /** Evaluate an expression in the page and return its value. */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result.value;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`);
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.error('No Chromium binary found. Set CHROME_PATH to run this check.');
    process.exit(2);
  }

  const failures = [];
  const consoleErrors = [];

  // 1. Serve the project.
  const server = spawn(process.execPath, [resolve(ROOT, 'tools/serve.js'), '--port', String(PORT)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/index.html`).catch(() => null);
    return res?.ok;
  }, 10000, 'static server');

  // 2. Launch Chromium.
  const userDataDir = resolve(ROOT, '.cache/chrome-check');
  await rm(userDataDir, { recursive: true, force: true });
  const chromeArgs = [
    headed ? '--headless=false' : '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--disable-extensions',
    // WebGL2 without a GPU: ANGLE's software backend.
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--window-size=1440,900',
    'about:blank',
  ].filter((a) => a !== '--headless=false');

  const browser = spawn(chrome, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  let browserStderr = '';
  browser.stderr.on('data', (d) => {
    browserStderr += d.toString();
  });

  const cleanup = () => {
    browser.kill('SIGKILL');
    server.kill('SIGKILL');
  };
  process.on('exit', cleanup);

  try {
    const targets = await waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).catch(() => null);
      if (!res?.ok) return null;
      const list = await res.json();
      return list.find((t) => t.type === 'page') ?? null;
    }, 20000, 'Chromium DevTools endpoint');

    const ws = new WebSocket(targets.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP websocket failed')), { once: true });
    });
    const cdp = new Cdp(ws);

    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error' || p.type === 'warning') {
        const textValue = p.args.map((a) => a.value ?? a.description ?? '').join(' ');
        if (p.type === 'error') consoleErrors.push(textValue);
        console.log(`  [page ${p.type}] ${textValue}`);
      }
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails;
      consoleErrors.push(d.exception?.description ?? d.text);
      console.log(`  [page exception] ${d.exception?.description ?? d.text}`);
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
    await waitFor(() => cdp.evaluate('document.readyState === "complete"'), 20000, 'page load');

    // 3. App booted and WebGL2 is live.
    await waitFor(() => cdp.evaluate('Boolean(globalThis.ftcSim)'), 15000, 'app construction');
    const glInfo = await cdp.evaluate(`(() => {
      const gl = globalThis.ftcSim.renderer.gl;
      return { version: gl.getParameter(gl.VERSION), renderer: gl.getParameter(gl.RENDERER) };
    })()`);
    console.log(`  WebGL: ${glInfo.version}`);
    console.log(`  Driver: ${glInfo.renderer}`);

    // 4. Frames are being produced.
    await sleep(700);
    const framesRan = await cdp.evaluate('globalThis.ftcSim.running && globalThis.ftcSim.lastFrame > 0');

    // BIOBUZZ should be up the moment the app opens.
    const defaultGame = await cdp.evaluate(`(() => {
      const g = globalThis.ftcSim.sim.game;
      return g ? { on: true, phase: g.match.phase, balls: g.field.allBalls.length } : { on: false };
    })()`);
    console.log(`  Default mode: ${defaultGame.on ? `BIOBUZZ, ${defaultGame.phase}, ${defaultGame.balls} elements` : 'bare field'}`);
    if (!defaultGame.on) failures.push('BIOBUZZ should be on when the app opens');
    // The drivetrain and camera checks below want an empty field to drive on.
    await cdp.evaluate('globalThis.ftcSim.sim.disableGame(), true');
    if (!framesRan) failures.push('render loop is not running');

    // 5. Drive it through the full input -> op-mode -> drivetrain -> physics
    //    path. Stepping a fixed number of simulated frames rather than waiting
    //    on wall time keeps this deterministic: under software rendering the
    //    frame rate is far below 60 Hz, which would otherwise make the check
    //    measure the GPU rather than the physics.
    const driveResult = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      const sim = app.sim;
      sim.setStartPose(-1.4, 0, 0);
      sim.resetRobot();
      const startX = sim.robot.body.position.x;
      const startTime = sim.time;
      // A held key, exactly as the browser would deliver it.
      app.input.keyboardSource.keys.add('KeyW');
      app.input.keyboardSource.active = true;
      for (let i = 0; i < 120; i++) sim.step(1 / 60);
      app.input.keyboardSource.keys.clear();
      const b = sim.robot.body;
      return {
        startX,
        simSeconds: sim.time - startTime,
        x: b.position.x,
        y: b.position.y,
        speed: b.speed,
        heading: b.rotation.radians,
        finite: b.isFinite(),
        voltage: sim.robot.battery.busVoltage,
        current: sim.robot.battery.current,
        substeps: sim.substepsLastFrame,
        stepMs: sim.stepCostMs,
        wheelAngles: sim.robot.drivetrain.wheels.map((w) => Number(w.angle.toFixed(2))),
      };
    })()`);

    console.log(
      `  Drove ${(driveResult.x - driveResult.startX).toFixed(3)} m in ${driveResult.simSeconds.toFixed(2)} s sim time, ` +
        `reaching ${(driveResult.speed * 3.2808).toFixed(2)} ft/s`,
    );
    console.log(`  Bus ${driveResult.voltage.toFixed(2)} V, draw ${driveResult.current.toFixed(1)} A, ${driveResult.substeps} substeps/frame, ${driveResult.stepMs.toFixed(2)} ms/step`);

    if (!driveResult.finite) failures.push('physics state went non-finite');
    if (driveResult.simSeconds < 1.5) failures.push(`only advanced ${driveResult.simSeconds.toFixed(2)} s of sim time`);
    if (driveResult.x - driveResult.startX < 1.0) {
      failures.push(`robot barely moved: ${(driveResult.x - driveResult.startX).toFixed(3)} m in 2 s`);
    }
    if (Math.abs(driveResult.y) > 0.05) {
      failures.push(`robot drifted sideways while driving straight: ${driveResult.y.toFixed(3)} m`);
    }
    if (Math.abs(driveResult.heading) > 0.05) {
      failures.push(`robot yawed while driving straight: ${driveResult.heading.toFixed(3)} rad`);
    }
    if (driveResult.wheelAngles.every((a) => a === 0)) failures.push('wheels never turned');

    // 6. Exercise the parameter panel: every control must build and update.
    const panelResult = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      const controls = app.panel.controls.size;
      // Flip a rebuild-triggering parameter and make sure nothing throws.
      app.config.set('drivetrain.type', 'tank');
      app.config.set('drivetrain.type', 'mecanum');
      app.config.set('chassis.mass', 18);
      app.config.set('view.camera', 'overhead');
      app.config.set('view.camera', 'driverStation');
      return { controls, wheels: app.sim.robot.drivetrain.wheels.length, mass: app.sim.robot.body.mass };
    })()`);
    console.log(`  Panel built ${panelResult.controls} controls; rebuild OK (${panelResult.wheels} wheels, ${panelResult.mass} kg)`);
    if (panelResult.controls < 80) failures.push(`expected 80+ panel controls, got ${panelResult.controls}`);

    // 6b. Camera controls must work in every mode, and every adjustment must
    //     land in the config so the settings panel stays in step.
    const cameraResult = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      const rig = app.renderer.camera;
      const set = (path, value) => app.config.set(path, value);
      const out = {};
      for (const mode of ['driverStation', 'chase', 'overhead', 'orbit']) {
        app.config.set('view.camera', mode);
        const before = JSON.stringify(app.config.values.view);
        rig.drag(app.config.values.view, set, 40, 25);
        rig.zoom(app.config.values.view, set, -240);
        rig.pan(app.config.values.view, set, 15, 15);
        out[mode] = {
          changed: JSON.stringify(app.config.values.view) !== before,
          describe: rig.describe(app.config.values.view),
        };
      }
      app.config.set('view.camera', 'driverStation');
      app._resetCamera();
      out.resetFov = app.config.values.view.fov;
      // Projection must place the field centre somewhere sensible on screen.
      app.renderer.render(app.sim, 1 / 60);
      const p = rig.project(0, 0, 0);
      out.centreProjects = { x: +p.x.toFixed(3), y: +p.y.toFixed(3), visible: p.visible };
      return out;
    })()`);
    for (const mode of ['driverStation', 'chase', 'overhead', 'orbit']) {
      if (!cameraResult[mode].changed) failures.push(`camera controls did nothing in ${mode} mode`);
    }
    console.log(`  Camera: ${cameraResult.driverStation.describe}`);
    console.log(`  Camera reset restored fov to ${cameraResult.resetFov}`);
    if (cameraResult.resetFov !== 55) failures.push(`camera reset did not restore the default fov (got ${cameraResult.resetFov})`);
    if (!cameraResult.centreProjects.visible) failures.push('field centre did not project on screen');

    // 6c. Drills: every course must load, place the robot and render geometry.
    const drillResult = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      const runner = app.sim.challenges;
      const summary = [];
      for (const challenge of runner.available()) {
        runner.select(challenge.id);
        app.renderer.render(app.sim, 1 / 60);
        const labels = app.renderer.challengeLabels(app.sim);
        summary.push({
          id: challenge.id,
          objectives: challenge.total,
          shapes: challenge.describe().length,
          labels: labels.length,
          placed: Math.abs(app.sim.robot.body.position.x - challenge.startPose.x) < 1e-6,
        });
      }
      runner.select('slalom');
      // Drive it for a moment so the clock starts and an objective is cleared.
      app.input.keyboardSource.keys.add('KeyW');
      app.input.keyboardSource.active = true;
      for (let i = 0; i < 150; i++) app.sim.step(1 / 60);
      app.input.keyboardSource.keys.clear();
      const active = runner.active;
      return { summary, running: active.state, elapsed: +active.elapsed.toFixed(2), index: active.index };
    })()`);
    console.log(`  Drills: ${drillResult.summary.length} available`);
    for (const d of drillResult.summary) {
      if (!d.placed) failures.push(`drill ${d.id} did not place the robot on its start line`);
      if (d.shapes < d.objectives) failures.push(`drill ${d.id} rendered ${d.shapes} shapes for ${d.objectives} objectives`);
    }
    console.log(`  Slalom after driving: ${drillResult.running}, ${drillResult.elapsed}s, objective ${drillResult.index}`);
    if (drillResult.running !== 'running') failures.push(`drill clock did not start (state ${drillResult.running})`);
    if (drillResult.elapsed <= 0) failures.push('drill clock did not advance');

    // 7. Screenshots, with the help overlay dismissed so the field is visible.
    await cdp.evaluate('globalThis.ftcSim.toggleHelp(false)');
    await sleep(500);
    await mkdir(dirname(shotPath), { recursive: true });

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(shotPath, Buffer.from(shot.data, 'base64'));
    console.log(`  Screenshot: ${shotPath}`);

    // A second view from above, which is the clearest way to confirm the wheel
    // force overlays and the chassis geometry are drawing correctly.
    await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      app.config.set('view.camera', 'orbit');
      app.renderer.camera.orbitDistance = 2.2;
      app.renderer.camera.orbitPitch = 0.75;
      app.renderer.camera.orbitYaw = -2.3;
      const p = app.sim.robot.body.position;
      app.renderer.camera.orbitTarget = [p.x, p.y, 0.1];
      app.config.set('view.showLoads', true);
      app.input.keyboardSource.keys.add('KeyW');
      app.input.keyboardSource.keys.add('KeyD');
      app.input.keyboardSource.active = true;
      for (let i = 0; i < 30; i++) app.sim.step(1 / 60);
    })()`);
    await sleep(500);
    const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const closePath = shotPath.replace(/\.png$/, '-robot.png');
    await writeFile(closePath, Buffer.from(shot2.data, 'base64'));
    console.log(`  Screenshot: ${closePath}`);
    await cdp.evaluate('globalThis.ftcSim.input.keyboardSource.keys.clear()');

    // A clean, close, overlay-free view of the chassis. This is the shot to
    // look at when changing anything about how the robot is drawn.
    await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      app.togglePanel(false);
      for (const k of ['showHud', 'showGraphs', 'showLoads', 'showForceVectors', 'showTrail', 'showSlip']) {
        app.config.set('view.' + k, false);
      }
      app.sim.setStartPose(0, 0, 0);
      app.sim.resetRobot();
      app.config.set('view.camera', 'orbit');
      app.renderer.camera.orbitDistance = 1.1;
      app.renderer.camera.orbitPitch = 1.0;
      app.renderer.camera.orbitYaw = -2.0;
      app.renderer.camera.orbitTarget = [0, 0, 0.05];
      for (let i = 0; i < 20; i++) app.sim.step(1 / 60);
    })()`);
    await sleep(600);
    const shot3 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const chassisPath = shotPath.replace(/\.png$/, '-chassis.png');
    await writeFile(chassisPath, Buffer.from(shot3.data, 'base64'));
    console.log(`  Screenshot: ${chassisPath}`);

    // A drill in progress, from the driver station: gates, labels and the HUD.
    await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      for (const k of ['showHud', 'showGraphs', 'showTrail', 'showForceVectors', 'showSlip']) {
        app.config.set('view.' + k, true);
      }
      app.config.set('view.camera', 'driverStation');
      app._resetCamera();
      app.sim.challenges.select('slalom');
      app.input.keyboardSource.keys.add('KeyW');
      app.input.keyboardSource.keys.add('KeyA');
      app.input.keyboardSource.active = true;
      for (let i = 0; i < 90; i++) app.sim.step(1 / 60);
      app.input.keyboardSource.keys.clear();
    })()`);
    await sleep(700);
    const shot4 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const drillPath = shotPath.replace(/\.png$/, '-drill.png');
    await writeFile(drillPath, Buffer.from(shot4.data, 'base64'));
    console.log(`  Screenshot: ${drillPath}`);

    // A contested drill: solid obstacles plus AI opponents on the field.
    const contested = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      app.sim.challenges.select('matchSim');
      app.config.set('view.camera', 'orbit');
      app.renderer.camera.orbitDistance = 6.0;
      app.renderer.camera.orbitPitch = 40;
      app.renderer.camera.orbitYaw = -150;
      app.config.set('view.orbitFollow', false);
      app.renderer.camera.orbitTarget = [0, 0, 0.1];
      app.input.keyboardSource.keys.add('KeyW');
      app.input.keyboardSource.active = true;
      // Watch how far each opponent travels rather than reading its speed at
      // one instant: a camper legitimately sits still between moves, so a
      // single sample makes this check flaky.
      const travelled = new Map(app.sim.opponents.map((o) => [o.id, 0]));
      const last = new Map(
        app.sim.opponents.map((o) => [o.id, { x: o.robot.body.position.x, y: o.robot.body.position.y }]),
      );
      for (let i = 0; i < 240; i++) {
        app.sim.step(1 / 60);
        for (const o of app.sim.opponents) {
          const p = last.get(o.id);
          travelled.set(
            o.id,
            travelled.get(o.id) + Math.hypot(o.robot.body.position.x - p.x, o.robot.body.position.y - p.y),
          );
          p.x = o.robot.body.position.x;
          p.y = o.robot.body.position.y;
        }
      }
      app.input.keyboardSource.keys.clear();
      return {
        opponents: app.sim.opponents.map((o) => ({
          id: o.id,
          mass: o.robot.body.mass,
          x: +o.robot.body.position.x.toFixed(2),
          y: +o.robot.body.position.y.toFixed(2),
          travelled: +travelled.get(o.id).toFixed(2),
          moving: travelled.get(o.id) > 0.1,
        })),
        obstacles: app.sim.field.elements.length,
        completions: app.sim.challenges.active.completions,
      };
    })()`);
    console.log(`  Contested drill: ${contested.opponents.length} opponents, ${contested.obstacles} obstacles`);
    for (const o of contested.opponents) {
      console.log(`    ${o.id} ${o.mass} kg at (${o.x}, ${o.y}), travelled ${o.travelled} m${o.moving ? '' : ' (held position)'}`);
    }
    if (contested.opponents.length !== 2) failures.push('match simulation should spawn two opponents');
    if (!contested.opponents.some((o) => o.moving)) failures.push('opponents never moved');
    await sleep(600);
    const shot5 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const contestedPath = shotPath.replace(/\.png$/, '-contested.png');
    await writeFile(contestedPath, Buffer.from(shot5.data, 'base64'));
    console.log(`  Screenshot: ${contestedPath}`);

    // --- BIOBUZZ: turn the game on and make sure a MATCH runs and renders.
    const game = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      app.sim.challenges.clear();
      app.sim.clearOpponents();
      const g = app.sim.game ?? app._toggleGame();
      g.start();
      const staged = g.participants.map((p) => ({
        id: p.id,
        alliance: p.alliance,
        held: p.intake.count,
        legal: g.match.checkStartingPosition(p.robot, p.alliance).legal,
      }));
      return {
        staged,
        balls: g.field.allBalls.length,
        flowers: g.field.flowers.length,
        inFlowers: g.field.flowers.reduce((n, f) => n + f.stack.length, 0),
        inCells: ['red', 'blue'].reduce(
          (n, a) => n + g.field.hives[a].foreBalls.length + g.field.hives[a].aftBalls.length, 0),
        obstacles: app.sim.field.elements.length,
        phase: g.match.phase,
      };
    })()`);
    console.log(`  BIOBUZZ: ${game.balls} elements, ${game.flowers} flowers (${game.inFlowers} POLLEN), ${game.inCells} NECTAR in cells, ${game.obstacles} solids`);
    for (const p of game.staged) {
      console.log(`    ${p.id} (${p.alliance}) preload ${p.held}, G304 legal: ${p.legal}`);
    }
    if (game.balls !== 56) failures.push(`expected 56 scoring elements, got ${game.balls}`);
    if (game.flowers !== 4) failures.push(`expected 4 flowers, got ${game.flowers}`);
    if (game.inFlowers !== 16) failures.push(`expected 16 staged flower POLLEN, got ${game.inFlowers}`);
    if (game.inCells !== 6) failures.push(`expected 6 staged cell NECTAR, got ${game.inCells}`);
    if (!game.staged.every((p) => p.legal)) failures.push('a robot was staged illegally');
    // Loading a drill puts the game away and clearing it brings the game back,
    // so a driver can dip into a drill and return to the match.
    const roundTrip = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      const before = Boolean(app.sim.game);
      app.sim.challenges.select(app.sim.challenges.available()[0].id);
      const duringDrill = Boolean(app.sim.game);
      const solidsDuring = app.sim.field.elements.length;
      app.sim.challenges.clear();
      return {
        before,
        duringDrill,
        solidsDuring,
        after: Boolean(app.sim.game),
        solidsAfter: app.sim.field.elements.length,
      };
    })()`);
    console.log(`  Drill round trip: game ${roundTrip.before ? 'on' : 'off'} -> drill (${roundTrip.solidsDuring} solids) -> ${roundTrip.after ? 'on' : 'off'} (${roundTrip.solidsAfter} solids)`);
    if (roundTrip.duringDrill) failures.push('a drill should be run on a bare field');
    if (!roundTrip.after) failures.push('clearing a drill should put the game back');
    if (roundTrip.solidsAfter !== 10) failures.push(`game solids not restored: ${roundTrip.solidsAfter}`);
    // Two frame foot bars, four strut shadows, four flower tubes.
    if (game.obstacles !== 10) failures.push(`expected 10 game solids, got ${game.obstacles}`);

    // Shoot into the CELL through the real renderer/physics loop.
    const launched = await cdp.evaluate(`(() => {
      const g = globalThis.ftcSim.sim.game;
      const target = g.field.hiveTarget(g.alliance);
      const robot = g.sim.robot;
      robot.reset(target.x, target.y - 1.5, Math.PI / 2);
      robot.body.velocity.set(0, 0);
      const aimed = g.aimAtHive();
      g.launcher.spinning = true;
      g.launcher.omega = (g.launcher.targetRpm * 2 * Math.PI) / 60;
      const before = g.field.hives[g.alliance].elementsInUpCell();
      // robot.reset() resets its subsystems, which releases whatever the intake
      // was holding -- so pick a ball up after moving, not before.
      const ball = g.field.pollen.find(
        (b) => b.free || (b.container && b.container.kind === 'preload'),
      );
      if (ball) ball.release();
      const fired = ball ? Boolean(g.launcher.launch(ball)) : false;
      for (let i = 0; i < 1500; i++) {
        g.update(1 / 500);
        if (ball && ball.container && ball.container.kind === 'cell') break;
      }
      return {
        aimed,
        fired,
        landedIn: ball && ball.container ? ball.container.kind : null,
        cellBefore: before,
        cellAfter: g.field.hives[g.alliance].elementsInUpCell(),
        rpm: Math.round(g.launcher.targetRpm),
        hood: Math.round((g.launcher.hoodAngle * 180) / Math.PI),
      };
    })()`);
    console.log(`  Shot: aim ${launched.rpm} rpm at ${launched.hood} deg -> ${launched.landedIn}; cell ${launched.cellBefore} -> ${launched.cellAfter}`);
    if (!launched.aimed) failures.push('launcher could not solve a 1.5 m shot at the cell');
    if (launched.landedIn !== 'cell') failures.push(`shot did not land in the cell (got ${launched.landedIn})`);

    // Run the clock forward and confirm the panel and score keep up.
    const played = await cdp.evaluate(`(() => {
      const g = globalThis.ftcSim.sim.game;
      for (let i = 0; i < 60 * 40; i++) g.update(1 / 60);
      const panel = document.querySelector('.match-panel');
      globalThis.ftcSim.matchPanel.update(g);
      return {
        phase: g.match.phase,
        clock: +g.match.matchClock.toFixed(1),
        panelVisible: panel && !panel.classList.contains('hidden'),
        clockText: document.querySelector('.match-clock').textContent,
        phaseText: document.querySelector('.match-phase').textContent,
        redTotal: document.querySelector('.match-total.red').textContent,
        blueTotal: document.querySelector('.match-total.blue').textContent,
        rows: document.querySelectorAll('.match-breakdown tr').length,
        prompt: document.querySelector('.match-prompt').textContent,
        // The drills panel shares the .overlay-card class, so go through the
        // app's own reference rather than picking the first match in the DOM.
        helpText: globalThis.ftcSim.helpOverlay.textContent ?? '',
      };
    })()`);
    console.log(`  Match panel: ${played.clockText} ${played.phaseText}, red ${played.redTotal} - blue ${played.blueTotal}, ${played.rows} rows`);
    console.log(`  Next-step prompt: "${played.prompt}"`);
    if (!played.panelVisible) failures.push('match panel is not visible with the game running');
    if (played.phase !== 'teleop') failures.push(`expected teleop after 40 s, got ${played.phase}`);
    if (!/^\d:\d\d$/.test(played.clockText)) failures.push(`clock did not render: ${played.clockText}`);
    if (Number(played.redTotal) <= 0) failures.push('red total did not score');
    // "How do I shoot" should be answerable without leaving the app.
    if (!played.prompt) failures.push('the match panel gives no next-step prompt');
    for (const phrase of ['right trigger', 'right bumper', 'spin the flywheel']) {
      if (!new RegExp(phrase, 'i').test(played.helpText)) {
        failures.push(`the help overlay never mentions "${phrase}"`);
      }
    }

    // --- The REFEREE, through the real loop.
    //
    // A foul is 20 points and the panel is where a driver finds out about it,
    // so both halves are worth checking in the browser rather than only in the
    // unit tests: the citation has to be raised by the game stepping, and it
    // has to reach the DOM.
    const officiated = await cdp.evaluate(`(() => {
      const g = globalThis.ftcSim.sim.game;
      const before = g.match.score();
      const ball = g.field.ballWorld.balls.find((b) => b.free && b.kind === 'pollen');
      ball.setPosition(0, 0, 1);
      ball.touch('eject', g.match.robotMeta('player'), g.field.ballWorld.clock);
      ball.outOfBounds = true;
      for (let i = 0; i < 4; i++) g.update(1 / 60);
      const queued = g.field.pendingReturns;
      globalThis.ftcSim.matchPanel.update(g);
      const row = document.querySelector('.match-call');
      // And now wait out Section 10.8.2's return.
      for (let i = 0; i < 60 * 10; i++) g.update(1 / 60);
      const other = g.alliance === 'red' ? 'blue' : 'red';
      return {
        rule: row?.querySelector('.match-call-rule')?.textContent ?? '',
        tag: row?.querySelector('.match-call-tag')?.textContent ?? '',
        major: g.match.referee.fouls[g.alliance].major,
        creditedBefore: before[other].penalty,
        credited: g.match.score()[other].penalty,
        queued,
        returned: !ball.outOfBounds && ball.free,
        pending: g.field.pendingReturns,
      };
    })()`);
    console.log(
      `  Referee: ${officiated.rule} ${officiated.tag}, ` +
        `${officiated.credited - officiated.creditedBefore} points to the opponent; ` +
        `element off the FIELD ${officiated.queued} -> back ${officiated.returned}`,
    );
    if (officiated.rule !== 'G405') failures.push(`no G405 call in the panel (got "${officiated.rule}")`);
    if (!/MAJOR FOUL/.test(officiated.tag)) failures.push(`G405 was not a MAJOR FOUL: "${officiated.tag}"`);
    if (officiated.major < 1) failures.push('the foul was not recorded against the alliance');
    if (officiated.credited - officiated.creditedBefore !== 20) {
      failures.push(`expected 20 points credited to the opponent, got ${officiated.credited - officiated.creditedBefore}`);
    }
    if (officiated.queued !== 1) failures.push('the departed element was not queued for return');
    if (!officiated.returned) failures.push('the departed element never came back');
    if (officiated.pending !== 0) failures.push('the return queue never drained');

    // A picture of the calls strip, because "is the panel readable" is not
    // something an assertion answers.
    const fouled = await cdp.evaluate(`(() => {
      const g = globalThis.ftcSim.sim.game;
      const ref = g.match.referee;
      ref.cite('G421', g.alliance, 'PINNED blue1 for 3 seconds', { robotId: 'player' });
      ref.cite('G409', g.alliance, 'caught an element released by a TIPPED HIVE');
      globalThis.ftcSim.matchPanel.update(g);
      return document.querySelectorAll('.match-call').length;
    })()`);
    if (fouled < 3) failures.push(`the calls strip showed ${fouled} of 3 rows`);
    await sleep(300);
    const shotFouls = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const foulsPath = shotPath.replace(/\.png$/, '-biobuzz-fouls.png');
    await writeFile(foulsPath, Buffer.from(shotFouls.data, 'base64'));
    console.log(`  Screenshot: ${foulsPath}`);

    await sleep(700);
    const shot6 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const gamePath = shotPath.replace(/\.png$/, '-biobuzz.png');
    await writeFile(gamePath, Buffer.from(shot6.data, 'base64'));
    console.log(`  Screenshot: ${gamePath}`);

    // Tie the drawn CELL to Figure 9-9: transform the cell mesh's own corners
    // through the render matrix and check they land on the figure's heights.
    // This is what stops the visual drifting away from the model.
    const cellDraw = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      const g = app.sim.game;
      const IN = 0.0254;
      const out = [];
      for (const alliance of ['red', 'blue']) {
        const hive = g.field.hives[alliance];
        for (const side of ['fore', 'aft']) {
          const opening = hive.cellOpening(side);
          const normal = hive.openingNormal(side);
          const up = hive.openingUp(side);
          const m = new Float32Array(16);
          app.renderer._cellMatrix(m, opening.x, opening.y, opening.z, normal, up);
          // Mesh z runs 0 at the opening's lower edge to 1 at the apex; mesh y
          // runs 0 at the opening plane to 1 at the back of the cell.
          const at = (x, y, z) => [0, 1, 2].map(
            (i) => m[i] * x + m[4 + i] * y + m[8 + i] * z + m[12 + i],
          );
          const lower = at(0, 0, 0);
          const apex = at(0, 0, 1);
          const back = at(0, 1, 0);
          out.push({
            alliance,
            side,
            raised: hive.up === side,
            lowerZ: lower[2] / IN,
            apexZ: apex[2] / IN,
            widthIn: (at(1, 0, 0)[0] - at(-1, 0, 0)[0]) / IN,
            depthIn: Math.hypot(back[1] - lower[1], back[2] - lower[2]) / IN,
          });
        }
      }
      return out;
    })()`);
    for (const c of cellDraw) {
      const tag = `${c.alliance} ${c.side}${c.raised ? ' (raised)' : ''}`;
      console.log(
        `  CELL as drawn, ${tag}: base ${c.lowerZ.toFixed(1)} in, apex ${c.apexZ.toFixed(1)} in, ` +
          `${c.widthIn.toFixed(1)} in wide, ${c.depthIn.toFixed(1)} in deep`,
      );
      // The apex is the top of the pentagon. Drawing it below the base turns
      // the basket into a funnel, and it is invisible in a span check because
      // the flipped cell covers the same interval from the other end.
      if (c.apexZ <= c.lowerZ) {
        failures.push(`drawn ${tag} CELL is upside down: apex ${c.apexZ.toFixed(2)} in is below its base ${c.lowerZ.toFixed(2)} in`);
      }
      if (Math.abs(c.widthIn - 20) > 0.1) {
        failures.push(`drawn ${tag} CELL is ${c.widthIn.toFixed(2)} in wide, should be 20`);
      }
      if (Math.abs(c.depthIn - 12) > 0.1) {
        failures.push(`drawn ${tag} CELL is ${c.depthIn.toFixed(2)} in deep, should be 12`);
      }
      // Figure 9-9 dimensions the raised CELL. The lowered one is the same
      // part rotated to the other stop, so its heights differ by design.
      if (c.raised) {
        if (Math.abs(c.lowerZ - 53.5) > 0.1) {
          failures.push(`drawn ${tag} CELL opening bottom is ${c.lowerZ.toFixed(2)} in, Figure 9-9 says 53.5`);
        }
        if (Math.abs(c.apexZ - 65.6) > 0.1) {
          failures.push(`drawn ${tag} CELL apex is ${c.apexZ.toFixed(2)} in, Figure 9-9 says 65.6`);
        }
      }
    }

    // An overhead plan view with the panels hidden, to put next to the
    // manual's own field figure.
    await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      app.config.set('view.showHud', false);
      app.config.set('view.showGraphs', false);
      app.config.set('view.camera', 'overhead');
      // Frame the whole field, the way the manual's figure does.
      app.config.set('view.overheadFollow', false);
      app.config.set('view.overheadZoom', 1);
      app.sim.robot.reset(-1.55, 0.6, 0);
      return true;
    })()`);
    await sleep(700);
    const shotTop = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const planPath = shotPath.replace(/\.png$/, '-biobuzz-plan.png');
    await writeFile(planPath, Buffer.from(shotTop.data, 'base64'));
    console.log(`  Screenshot: ${planPath}`);

    // The aiming guide, with the ROBOT lined up on its own raised CELL and the
    // wheel at speed. Captured from a low orbit so the arc, its ground shadow
    // and the CELL are all in frame -- a guide is a visual feature and a number
    // check cannot tell you it looks wrong.
    const guide = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      const g = app.sim.game;
      const hive = g.field.hives[g.alliance];
      const target = g.field.hiveTarget(g.alliance);
      const n = hive.openingNormal(hive.up);
      // A CELL faces along the arm, so a shot can only arrive from the outside
      // of its opening plane -- but straight out along that normal at shooting
      // range is past the perimeter wall. So: back off diagonally, far enough
      // out that the exit point is still on the outside of the plane, and near
      // enough in that the ROBOT is on the tiles. Dropped on the floor outside
      // the wall it gets shoved back in by the physics, and the arc drawn a
      // frame later is from wherever it ended up.
      // Inside the wall by the ROBOT's own half-length, or the physics shoves
      // it back in and the shot is then solved for a range it is no longer at.
      const limit = app.sim.field.halfSize - app.sim.robot.halfLength - 0.03;
      const clamp = (v) => Math.max(-limit, Math.min(limit, v));
      const x = clamp(target.x - Math.sign(target.x || 1) * 1.1);
      const y = clamp(target.y + Math.sign(n.y) * 1.4);
      app.sim.robot.reset(x, y, Math.atan2(target.y - y, target.x - x));
      app.sim.robot.body.velocity.set(0, 0);
      app.sim.robot.body.angularVelocity = 0;
      g.loadPreloads();
      app.config.set('view.showTrajectory', true);
      app.config.set('view.trajectoryMode', 'both');
      app.config.set('view.camera', 'orbit');
      app.config.set('view.orbitPitch', 18);
      app.config.set('view.orbitYaw', -150);
      app.config.set('view.orbitDistance', 4.2);
      app.config.set('view.showHud', false);
      app.config.set('view.showGraphs', false);
      return { x, y, range: Math.hypot(target.x - x, target.y - y) };
    })()`);
    // Aim *after* the ROBOT has settled, and read the arcs at the same moment
    // the screenshot is taken. Aimed before settling, the solution is for a
    // range the ROBOT is no longer at -- which is correct behaviour and a
    // useless thing to assert on.
    await sleep(500);
    const guideArcs = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      const g = app.sim.game;
      const b = app.sim.robot.body;
      const aimed = g.aimAtHive();
      g.launcher.spinning = true;
      g.launcher.omega = (g.launcher.targetRpm * 2 * Math.PI) / 60;
      return {
        aimed,
        hood: (g.launcher.hoodAngle * 180) / Math.PI,
        rpm: g.launcher.rpm,
        x: b.position.x,
        y: b.position.y,
        speed: b.speed,
        arcs: g.shotPreview('both').map((a) => ({ kind: a.kind, hit: a.hit, points: a.points.length })),
      };
    })()`);
    console.log(
      `  Trajectory guide: ${guideArcs.x.toFixed(2)}, ${guideArcs.y.toFixed(2)} at ` +
        `${guide.range.toFixed(2)} m, hood ${guideArcs.hood.toFixed(0)} deg, ${guideArcs.rpm.toFixed(0)} rpm -> ` +
        guideArcs.arcs.map((a) => `${a.kind} ${a.hit ? 'HIT' : 'miss'} (${a.points} pts)`).join(', '),
    );
    if (!guideArcs.aimed) failures.push('the guide scenario could not be aimed');
    if (guideArcs.speed > 0.05) {
      failures.push(`the guide scenario ROBOT is still moving at ${guideArcs.speed.toFixed(2)} m/s`);
    }
    if (guideArcs.arcs.length !== 2) {
      failures.push(`trajectoryMode "both" drew ${guideArcs.arcs.length} arcs`);
    }
    for (const a of guideArcs.arcs) {
      if (!a.hit) failures.push(`the ${a.kind} arc misses a CELL the launcher says it can hit`);
      if (a.points < 8) failures.push(`the ${a.kind} arc has only ${a.points} points`);
    }
    const shotGuide = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const guidePath = shotPath.replace(/\.png$/, '-biobuzz-guide.png');
    await writeFile(guidePath, Buffer.from(shotGuide.data, 'base64'));
    console.log(`  Screenshot: ${guidePath}`);

    // A close-up of one HIVE from the side, where an upside-down CELL is
    // obvious and a pentagon apex is unmistakable.
    await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      app.config.set('view.showTrajectory', false);
      app.config.set('view.orbitPitch', 10);
      app.config.set('view.orbitYaw', -90);
      app.config.set('view.orbitDistance', 3.0);
      app.config.set('view.orbitFollow', false);
      // The orbit target lives on the camera, not in the config -- panning is a
      // gesture, not a setting -- so point it at the HIVE directly.
      const hive = app.sim.game.field.hives[app.sim.game.alliance];
      app.renderer.camera.orbitTarget[0] = hive.pivotX;
      app.renderer.camera.orbitTarget[1] = 0;
      app.renderer.camera.orbitTarget[2] = 1.1;
      return true;
    })()`);
    await sleep(700);
    const shotHive = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const hivePath = shotPath.replace(/\.png$/, '-biobuzz-hive.png');
    await writeFile(hivePath, Buffer.from(shotHive.data, 'base64'));
    console.log(`  Screenshot: ${hivePath}`);

    // --- A SCORING ELEMENT close up, big enough to see the perforations.
    //
    // The holes are cut per pixel from an alpha mask and the dark inside is a
    // second shell, so "do the elements look like the elements" is a thing that
    // can break silently. A POLLEN and a NECTAR side by side, turned onto an
    // angle so the moulding seam and both hole bands are in shot.
    const elements = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      const g = app.sim.game;
      const pollen = g.field.ballWorld.balls.find((b) => b.kind === 'pollen');
      const nectar = g.field.nectar[g.alliance][0];
      for (const b of [pollen, nectar]) {
        b.release();
        b.outOfBounds = false;
        b.stop();
      }
      pollen.setPosition(-0.06, 0, pollen.radius);
      nectar.setPosition(0.08, 0, nectar.radius);
      // Tipped off axis, so neither a pole nor the seam faces the camera square
      // on, and rolling, so the orientation integrator is what put it there.
      pollen.setSpin(2.5, 1.5, 0.8);
      nectar.setSpin(-1.8, 2.2, -1);
      const spun = pollen.spinRate;
      for (let i = 0; i < 60; i++) g.update(1 / 60);
      app.renderer.camera.orbitTarget[0] = 0;
      app.renderer.camera.orbitTarget[1] = 0;
      app.renderer.camera.orbitTarget[2] = 0.05;
      app.config.set('view.orbitFollow', false);
      app.config.set('view.orbitPitch', 18);
      app.config.set('view.orbitYaw', -90);
      app.config.set('view.orbitDistance', 0.42);
      return {
        turned: Math.abs(pollen.ow) < 0.9999,
        // The spin it was *given*; rolling resistance has taken most of it
        // back by the time the frame is captured, which is the point -- the
        // orientation is where that spin went.
        pollenSpin: +spun.toFixed(2),
        holes: app.renderer.meshes.ball ? 'ball mesh' : 'missing',
      };
    })()`);
    console.log(
      `  Elements: close-up at 0.42 m, ${elements.holes}, POLLEN turned ${elements.turned} ` +
        `while spinning ${elements.pollenSpin} rad/s`,
    );
    if (!elements.turned) {
      failures.push('a spinning element never changed orientation');
    }
    if (elements.holes !== 'ball mesh') failures.push('the element mesh is missing');
    await sleep(700);
    const shotElement = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const elementPath = shotPath.replace(/\.png$/, '-biobuzz-element.png');
    await writeFile(elementPath, Buffer.from(shotElement.data, 'base64'));
    console.log(`  Screenshot: ${elementPath}`);

    await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      app.config.set('view.orbitFollow', true);
      app.config.set('view.orbitDistance', 3.0);
      return true;
    })()`);

    // A second angle with the panels hidden, so the field geometry itself can
    // be eyeballed rather than guessed at through a HUD.
    await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      app.config.set('view.showHud', false);
      app.config.set('view.showGraphs', false);
      app.config.set('view.camera', 'driverStation');
      app.sim.robot.reset(-1.2, -0.6, 0.4);
      return true;
    })()`);
    await sleep(700);
    const shot7 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const anglePath = shotPath.replace(/\.png$/, '-biobuzz-field.png');
    await writeFile(anglePath, Buffer.from(shot7.data, 'base64'));
    console.log(`  Screenshot: ${anglePath}`);
    await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      app.config.set('view.showHud', true);
      app.config.set('view.showGraphs', true);
      return true;
    })()`);

    // Fill the other three seats and let a real MATCH run. This is the one
    // part of the game that cannot be checked from the model alone: the AIs
    // drive the same physics, so whether they actually get anywhere depends on
    // the FIELD's furniture being where the renderer says it is.
    const roster = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      app.config.set('view.showTrajectory', false);
      app.config.set('ai.enabled', true);
      app.config.set('ai.partner.archetype', 'twinWheel');
      app.config.set('ai.partner.quality', 'elite');
      app.config.set('ai.partner.skill', 'veteran');
      app.config.set('ai.opponent1.archetype', 'gardener');
      app.config.set('ai.opponent1.quality', 'solid');
      app.config.set('ai.opponent1.skill', 'competent');
      app.config.set('ai.opponent2.archetype', 'catapult');
      app.config.set('ai.opponent2.quality', 'rough');
      app.config.set('ai.opponent2.skill', 'rookie');
      // The roster is built when the game is created, so cycle it.
      app.sim.disableGame();
      const g = app.sim.enableGame();
      app.config.set('match.startPhase', 'teleop');
      g.start();
      return {
        participants: g.participants.length,
        opponents: app.sim.opponents.length,
        lineup: g.lineup().map((r) => ({
          slot: r.slot, name: r.name, ally: r.ally, quality: r.quality, skill: r.skill,
        })),
        mechanisms: app.sim.opponents.map((o) => ({
          id: o.id,
          role: o.role,
          intake: Boolean(o.intake),
          launcher: o.launcher ? (o.launcher.kind ?? 'yes') : null,
        })),
      };
    })()`);
    console.log(`  Roster: ${roster.participants} ROBOTS in the MATCH`);
    for (const m of roster.mechanisms) {
      console.log(`    ${m.id} (${m.role}): intake ${m.intake ? 'yes' : 'no'}, launcher ${m.launcher ?? 'none'}`);
    }
    if (roster.participants !== 4) failures.push(`expected 4 ROBOTS, got ${roster.participants}`);
    if (roster.lineup.length !== 3) failures.push(`the panel lists ${roster.lineup.length} other robots`);
    if (roster.lineup.filter((r) => r.ally).length !== 1) {
      failures.push('exactly one of the other three should be on your own alliance');
    }
    const gardener = roster.mechanisms.find((m) => m.role === 'flowerFiller');
    if (!gardener) failures.push('the FLOWER robot is missing');
    else if (gardener.launcher) failures.push('a FLOWER robot should have no launcher');
    const thrower = roster.mechanisms.find((m) => m.launcher === 'catapult');
    if (!thrower) failures.push('the catapult built a flywheel instead of a thrower');

    // Long enough for a cycle: collect, cross the FIELD, line up, score.
    await sleep(45000);
    const played2 = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      const g = app.sim.game;
      const score = g.match.score();
      return {
        phase: g.match.phase,
        red: score.red.total,
        blue: score.blue.total,
        tips: { red: g.field.hives.red.tips, blue: g.field.hives.blue.tips },
        flowers: g.field.flowers.reduce((n, f) => n + f.stack.length, 0),
        robots: app.sim.opponents.map((o) => ({
          id: o.id,
          shots: o.launcher ? o.launcher.shots : null,
          jams: o.jams,
          moved: Math.hypot(o.robot.body.position.x, o.robot.body.position.y),
        })),
        lineupRows: document.querySelectorAll('.match-robot').length,
      };
    })()`);
    console.log(
      `  After 45 s: red ${played2.red} - blue ${played2.blue}, tips ${played2.tips.red}/${played2.tips.blue}, ` +
        `${played2.flowers} elements in FLOWERS`,
    );
    for (const r of played2.robots) {
      console.log(`    ${r.id}: ${r.shots === null ? 'no launcher' : `${r.shots} shots`}, ${r.jams} jams`);
    }
    if (played2.lineupRows !== 3) {
      failures.push(`the match panel drew ${played2.lineupRows} line-up rows, expected 3`);
    }
    const shooters = played2.robots.filter((r) => r.shots !== null);
    if (shooters.length && shooters.every((r) => r.shots === 0)) {
      failures.push('no AI shooter took a single shot in 45 s of MATCH');
    }
    await sleep(400);
    const shotRoster = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const rosterPath = shotPath.replace(/\.png$/, '-biobuzz-match.png');
    await writeFile(rosterPath, Buffer.from(shotRoster.data, 'base64'));
    console.log(`  Screenshot: ${rosterPath}`);

    // Back to a solo FIELD, so the teardown check below sees what it expects.
    await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      app.config.set('ai.enabled', false);
      app.sim.disableGame();
      app.sim.enableGame().start();
      app.config.set('view.showHud', true);
      app.config.set('view.showGraphs', true);
      return app.sim.opponents.length;
    })()`);

    // And that it comes back off cleanly.
    const off = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      app._toggleGame();
      return {
        game: app.sim.game,
        elements: app.sim.field.elements.length,
        subsystems: app.sim.robot.subsystems.length,
      };
    })()`);
    if (off.game !== null) failures.push('the game did not switch off');
    if (off.elements !== 0) failures.push(`${off.elements} field elements left behind`);
    if (off.subsystems !== 0) failures.push(`${off.subsystems} subsystems left behind`);
    console.log('  Game off: field and robot back to bare');

    if (consoleErrors.length) {
      failures.push(`${consoleErrors.length} console error(s): ${consoleErrors[0]}`);
    }
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
    if (browserStderr.trim()) console.error(browserStderr.trim().split('\n').slice(-8).join('\n'));
  } finally {
    cleanup();
    process.off('exit', cleanup);
  }

  if (failures.length) {
    console.error('\nFAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
