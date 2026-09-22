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

  // 1. Serve the project, with a small FTC repository attached so the
  //    "load my op-modes" path can be exercised the way a team would use it.
  const fixtureRepo = await writeFixtureRepo();
  const server = spawn(
    process.execPath,
    [resolve(ROOT, 'tools/serve.js'), '--port', String(PORT), '--repo', fixtureRepo],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
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
      // There is no 'cell' container to wait for: an element in a CELL is a
      // free element that happens to be inside one, so the question is where
      // it is and whether it has stopped.
      const inCell = () => Boolean(ball) && g.field.hives[g.alliance].upBalls.includes(ball);
      for (let i = 0; i < 1500; i++) {
        g.update(1 / 500);
        if (inCell() && ball.speed < 0.2) break;
      }
      return {
        aimed,
        fired,
        landedIn: inCell() ? 'cell' : ball && ball.container ? ball.container.kind : 'loose',
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

    // --- The on-screen gamepad, including the delay between the two dots.
    const pad = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      const sim = app.sim;
      const view = app.gamepadView;
      const keys = sim.input.keyboardSource.keys;
      sim.input.keyboardSource.active = true;

      const read = () => ({
        dot: view.left.node.querySelector('.pad-dot:not(.ghost)').style.top,
        ghostHidden: view.left.node.querySelector('.pad-dot.ghost').classList.contains('hidden'),
        rb: view.buttons.get('right_bumper').classList.contains('on'),
        source: view.source.textContent,
        rt: view.rightTrigger.node.querySelector('.pad-trigger-fill').style.width,
      });

      // Centred and idle.
      for (let i = 0; i < 40; i++) sim.step(1 / 60);
      view.update(sim.input);
      const idle = read();

      // Stick forward. For one frame the controller is reporting it and the
      // op-mode is not yet, which is the input delay -- so the faint dot shows.
      keys.add('KeyW');
      sim.step(1 / 60);
      view.update(sim.input);
      const lagging = read();

      // Once the delay line has caught up, the two agree again.
      for (let i = 0; i < 20; i++) sim.step(1 / 60);
      view.update(sim.input);
      const settled = read();

      keys.add('KeyH');
      keys.add('Space');
      for (let i = 0; i < 10; i++) sim.step(1 / 60);
      view.update(sim.input);
      const pressed = read();

      keys.clear();
      for (let i = 0; i < 20; i++) sim.step(1 / 60);

      // It must not sit on top of the status pills, which are also bottom left.
      const padBox = view.root.getBoundingClientRect();
      const pills = app.hud.status.getBoundingClientRect();
      const overlapsPills = padBox.bottom > pills.top + 0.5 && padBox.left < pills.right;

      app.config.set('view.showGamepad', false);
      view.setVisible(false);
      const hiddenWhenOff = !view.visible;
      app.config.set('view.showGamepad', true);
      view.setVisible(true);
      sim.resetRobot();
      return { idle, lagging, settled, pressed, hiddenWhenOff, overlapsPills };
    })()`);
    console.log(
      `  Gamepad: idle dot at ${pad.idle.dot}, pushed to ${pad.settled.dot}, ` +
        `source "${pad.settled.source}", trigger ${pad.pressed.rt}`,
    );
    if (pad.idle.dot !== '50%') failures.push(`a centred stick drew at ${pad.idle.dot}`);
    if (!pad.idle.ghostHidden) failures.push('a still stick drew two dots');
    if (pad.lagging.ghostHidden) {
      failures.push('the input delay should show as a second dot on the frame the stick moves');
    }
    if (!pad.settled.ghostHidden) failures.push('the two dots should agree once the delay catches up');
    if (parseFloat(pad.settled.dot) >= 50) {
      failures.push(`forward should move the dot up the screen, drew at ${pad.settled.dot}`);
    }
    if (!pad.pressed.rb) failures.push('the right bumper did not light up');
    if (pad.pressed.rt !== '100%') failures.push(`the trigger bar read ${pad.pressed.rt}`);
    if (pad.settled.source !== 'keyboard') failures.push(`source read "${pad.settled.source}"`);
    if (!pad.hiddenWhenOff) failures.push('turning the gamepad view off left it on screen');
    if (pad.overlapsPills) failures.push('the gamepad view is sitting on top of the status pills');

    // --- The hardware inspector, and breaking something with it.
    const hardware = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      const sim = app.sim;
      const panel = app.hardware;

      // The row of viewport toggles must not overlap: they are positioned by
      // hand in CSS and adding one is exactly how that gets broken.
      const toggles = [...app.viewport.querySelectorAll('.panel-toggle')].map((b) => {
        const r = b.getBoundingClientRect();
        return { text: b.textContent, left: r.left, right: r.right, top: r.top };
      });
      toggles.sort((a, b) => a.left - b.left);
      let overlap = null;
      for (let i = 1; i < toggles.length; i++) {
        if (toggles[i].left < toggles[i - 1].right - 0.5) {
          overlap = toggles[i - 1].text + ' / ' + toggles[i].text;
        }
      }

      panel.toggle(true);
      panel.update();
      const sections = panel.body.querySelectorAll('.hardware-section').length;
      const rows = panel.body.querySelectorAll('.hardware-row').length;
      const selects = panel.body.querySelectorAll('.hardware-fault').length;

      // Drive straight with an intact robot, then again with a dead encoder on
      // one port, and check the readout says so. An encoder-based routine is
      // the thing this breaks, so the number that has to change is the tick
      // count, not the robot's behaviour.
      sim.input.keyboardSource.active = true;
      const run = (seconds) => {
        sim.input.keyboardSource.keys.add('KeyW');
        for (let i = 0; i < Math.round(seconds * 60); i++) sim.step(1 / 60);
        sim.input.keyboardSource.keys.delete('KeyW');
      };
      sim.resetRobot();
      run(0.8);
      const healthyTicks = sim.robot.drivetrain.motors[0].encoder.ticks;

      // By device name, not by position: the sections move around.
      const port = sim.robot.drivetrain.motors[0].name;
      const select = panel.body.querySelector('[data-device="motor:' + port + '"]');
      select.value = 'dead';
      select.dispatchEvent(new Event('change'));
      sim.resetRobot();
      run(0.8);
      const deadTicks = sim.robot.drivetrain.motors[0].encoder.ticks;
      const faulted = panel.faultCount;
      const pill = panel.faultPill.textContent;
      const buttonFaulted = panel.button.classList.contains('faulted');

      // And a stuck IMU, which is the nastier one: field centric quietly
      // rotates its own frame because the heading never changes.
      sim.robot.imu.fault = 'stuck';
      const heldHeading = sim.robot.imu.heading;
      sim.input.keyboardSource.keys.add('KeyQ');
      for (let i = 0; i < 60; i++) sim.step(1 / 60);
      sim.input.keyboardSource.keys.delete('KeyQ');
      const stillHeading = sim.robot.imu.heading;
      const trulyTurned = Math.abs(sim.robot.body.rotation.radians);

      panel.repair();
      panel.update();
      const afterRepair = panel.faultCount;
      // Left open with a fault showing, for the screenshot.
      sim.robot.drivetrain.motors[1].encoder.fault = 'stuck';
      sim.robot.odometry.pods[0].fault = 'dead';
      panel.update();
      return {
        toggles: toggles.length,
        overlap,
        sections,
        rows,
        selects,
        healthyTicks,
        deadTicks,
        faulted,
        pill,
        buttonFaulted,
        headingHeld: Math.abs(stillHeading - heldHeading),
        trulyTurned,
        afterRepair,
      };
    })()`);
    console.log(
      `  Hardware: ${hardware.sections} sections, ${hardware.rows} rows, ` +
        `${hardware.selects} fault selectors; a dead encoder read ` +
        `${hardware.deadTicks} tk where a healthy one read ${hardware.healthyTicks}`,
    );
    console.log(
      `    stuck IMU: heading moved ${hardware.headingHeld.toFixed(4)} rad while the robot ` +
        `turned ${hardware.trulyTurned.toFixed(2)} rad`,
    );
    if (hardware.overlap) failures.push(`viewport toggles overlap: ${hardware.overlap}`);
    if (hardware.toggles < 5) failures.push(`only ${hardware.toggles} viewport toggles found`);
    if (hardware.sections !== 7) failures.push(`${hardware.sections} sections, expected 7`);
    if (hardware.rows < 20) failures.push(`${hardware.rows} rows, expected a row per device`);
    if (hardware.selects < 6) failures.push(`${hardware.selects} fault selectors, expected 6 or more`);
    if (!(Math.abs(hardware.healthyTicks) > 200)) {
      failures.push(`a healthy encoder only counted ${hardware.healthyTicks}`);
    }
    if (hardware.deadTicks !== 0) failures.push(`a dead encoder read ${hardware.deadTicks}`);
    if (hardware.faulted !== 1) failures.push(`${hardware.faulted} devices reported faulted`);
    if (!/1 device faulted/.test(hardware.pill)) failures.push(`the pill read "${hardware.pill}"`);
    if (!hardware.buttonFaulted) failures.push('the toggle did not show that something is broken');
    if (hardware.headingHeld > 1e-9) {
      failures.push(`a stuck IMU moved by ${hardware.headingHeld} rad`);
    }
    if (!(hardware.trulyTurned > 0.3)) {
      failures.push(`the robot needed to actually turn, only managed ${hardware.trulyTurned} rad`);
    }
    if (hardware.afterRepair !== 0) failures.push('Repair everything left something broken');

    await sleep(300);
    const shotHardware = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const hardwarePath = shotPath.replace(/\.png$/, '-hardware.png');
    await writeFile(hardwarePath, Buffer.from(shotHardware.data, 'base64'));
    console.log(`  Screenshot: ${hardwarePath}`);
    await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      app.hardware.repair();
      app.hardware.toggle(false);
      app.sim.resetRobot();
      return true;
    })()`);

    // --- A routine draws on the field, and it comes out on the tiles.
    const drawn = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      const sim = app.sim;
      sim.autoRunner.compile([
        "function init(robot) { robot.frame = 'ftc'; }",
        "function loop(robot) {",
        "  robot.draw.clear();",
        "  robot.draw.circle([0, 0], 24, 'green');",
        "  robot.draw.point(robot.cellTarget, 'amber');",
        "  robot.draw.pose(robot.odometry.pose, 'cyan');",
        "  robot.draw.path([[-60, -24], [-24, -24], [0, 24], [36, 36]], 'magenta');",
        "  robot.draw.text({ x: 0, y: 30 }, 'centre');",
        "}",
      ].join('\\n'));
      sim.game.start();
      for (let i = 0; i < 90; i++) sim.step(1 / 60);

      const shapes = sim.drawing.shapes.length;
      const labels = sim.drawing.labels.length;
      const projected = app.renderer.drawingLabels(sim);
      // Freeze it so the page's own frame loop cannot run the routine past the
      // screenshot and redraw something else.
      sim.paused = true;
      app.renderer.render(sim, 1 / 60);
      app.overlay.begin();
      return { shapes, labels, projected: projected.length, visible: projected.filter((p) => p.visible).length };
    })()`);
    console.log(`  Drawings: ${drawn.shapes} shapes, ${drawn.labels} label(s), ${drawn.visible} on screen`);
    if (drawn.shapes < 40) failures.push(`the routine only drew ${drawn.shapes} shapes`);
    if (drawn.labels !== 1) failures.push(`${drawn.labels} text shapes, expected 1`);
    if (drawn.visible !== 1) failures.push('the text did not project onto the screen');

    await sleep(300);
    const shotDrawn = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const drawnPath = shotPath.replace(/\.png$/, '-drawing.png');
    await writeFile(drawnPath, Buffer.from(shotDrawn.data, 'base64'));
    console.log(`  Screenshot: ${drawnPath}`);

    // Switched off in the panel, nothing is drawn -- and the routine's own
    // shapes are untouched, because the setting is about showing them.
    const hidden = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      app.config.set('view.showDrawings', false);
      const labels = app.renderer.drawingLabels(app.sim).length;
      app.config.set('view.showDrawings', true);
      app.sim.autoRunner.clear();
      app.sim.paused = false;
      app.sim.resetRobot();
      return { labels, shapes: app.sim.drawing.shapes.length };
    })()`);
    if (hidden.labels !== 0) failures.push('turning drawings off still drew text');
    if (hidden.shapes !== 0) failures.push('a reset left drawings on the field');

    // --- Odometry: the pose it reports, how far it drifts, and the two trails.
    const odometry = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      const sim = app.sim;
      const keys = sim.input.keyboardSource.keys;
      sim.input.keyboardSource.active = true;
      sim.placeRobot(-1.2, 0, 0);

      const lap = (key, seconds) => {
        keys.add(key);
        for (let i = 0; i < Math.round(seconds * 60); i++) sim.step(1 / 60);
        keys.delete(key);
      };
      lap('KeyW', 1.2);
      lap('KeyQ', 0.7);
      lap('KeyW', 1.0);
      lap('KeyE', 0.7);
      lap('KeyW', 0.8);
      for (let i = 0; i < 40; i++) sim.step(1 / 60);

      const t = sim.telemetry();
      app.hud.update(sim, t, 1 / 60);
      const rows = [...app.hud.odometryCard.querySelectorAll('.hud-row')].map(
        (r) => r.textContent,
      );

      // A miscalibrated yaw scalar has to make it worse, or the knob is not wired.
      const straight = t.odometry.error.distance;
      app.config.set('odometry.yawScalar', 1.04);
      sim.placeRobot(-1.2, 0, 0);
      lap('KeyQ', 1.4);
      lap('KeyW', 1.2);
      for (let i = 0; i < 20; i++) sim.step(1 / 60);
      const skewed = sim.telemetry().odometry.error.distance;
      app.config.set('odometry.yawScalar', 1);

      const trails = { real: sim.trail.length, odo: sim.odometryTrail.length };
      sim.resetRobot();
      return { straight, skewed, rows, trails, drift: t.odometry.error };
    })()`);
    console.log(
      `  Odometry: after a lap it is ${(odometry.straight * 39.3701).toFixed(2)} in out ` +
        `(${(odometry.drift.heading * 57.2958).toFixed(2)} deg); a 4% yaw scalar makes it ` +
        `${(odometry.skewed * 39.3701).toFixed(2)} in`,
    );
    console.log(`    HUD says: ${odometry.rows.join('  |  ')}`);
    if (!(odometry.straight < 0.08)) {
      failures.push(`odometry drifted ${odometry.straight} m over one lap, which is too much`);
    }
    if (!(odometry.skewed > odometry.straight * 2)) {
      failures.push(
        `a 4% yaw scalar should hurt: ${odometry.straight} m calibrated, ${odometry.skewed} m not`,
      );
    }
    if (odometry.rows.length !== 3) failures.push('the odometry card lost a row');
    if (!/in/.test(odometry.rows.join(' '))) failures.push('the odometry card is not in inches');
    if (odometry.trails.odo !== odometry.trails.real) {
      failures.push(
        `the two trails should have a point each: ${odometry.trails.real} real, ${odometry.trails.odo} odometry`,
      );
    }

    // --- Coordinate frames and putting the robot somewhere, through the UI.
    const frames = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      const sim = app.sim;
      const panel = app.auto;
      panel.toggle(true);

      // Type a pose in FTC inches and press the button.
      panel.frameSelect.value = 'ftc';
      panel.poseInputs.x.value = '12';
      panel.poseInputs.y.value = '-63';
      panel.poseInputs.heading.value = '90';
      panel.placeButton.click();
      const placedFtc = sim.pose('ftc');
      const placedPedro = sim.pose('pedro');

      // Read it back in Pedro's frame, which is what the picker is for.
      panel.frameSelect.value = 'pedro';
      panel.frameSelect.dispatchEvent(new Event('change'));
      const shown = {
        x: panel.poseInputs.x.value,
        y: panel.poseInputs.y.value,
        heading: panel.poseInputs.heading.value,
      };

      // Ctrl-drag: the pointer picks a point on the tiles and the robot goes
      // there. Aiming at the middle of the canvas in the overhead view, which
      // looks straight down, so the answer is near the field centre.
      app.config.set('view.camera', 'overhead');
      sim.step(1 / 60);
      app.renderer.render(sim, 1 / 60);
      const rect = app.canvas.getBoundingClientRect();
      const picked = app.renderer.pickGround(rect.width / 2, rect.height / 2, rect.width, rect.height);
      const before = sim.robot.teleportEpoch;
      app.canvas.dispatchEvent(
        new PointerEvent('pointerdown', {
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          button: 0,
          ctrlKey: true,
          bubbles: true,
        }),
      );
      app.canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      const dragged = sim.pose();
      const epochs = sim.robot.teleportEpoch - before;

      // And the ray misses the floor when it is pointed above the horizon.
      app.config.set('view.camera', 'driverStation');
      sim.step(1 / 60);
      app.renderer.render(sim, 1 / 60);
      const sky = app.renderer.pickGround(rect.width / 2, 2, rect.width, rect.height);

      panel.toggle(false);
      app.config.set('view.camera', 'driverStation');
      sim.resetRobot();
      return { placedFtc, placedPedro, shown, picked, dragged, epochs, skyMissed: sky === null };
    })()`);
    console.log(
      `  Frames: typed FTC 12, -63, 90 -> Pedro ${frames.shown.x}, ${frames.shown.y}, ` +
        `${frames.shown.heading}; ctrl-drag landed at ` +
        `${frames.dragged.x.toFixed(2)}, ${frames.dragged.y.toFixed(2)} m`,
    );
    for (const [axis, want] of [['x', 12], ['y', -63], ['heading', 90]]) {
      if (Math.abs(frames.placedFtc[axis] - want) > 1e-6) {
        failures.push(`the pose row put it at ${axis} = ${frames.placedFtc[axis]}, not ${want}`);
      }
    }
    for (const [axis, want] of [['x', 9], ['y', 60], ['heading', 0]]) {
      if (Math.abs(Number(frames.shown[axis]) - want) > 0.05) {
        failures.push(`read back in Pedro, ${axis} was ${frames.shown[axis]}, not ${want}`);
      }
      if (Math.abs(frames.placedPedro[axis] - want) > 1e-6) {
        failures.push(`sim.pose('pedro') gave ${axis} = ${frames.placedPedro[axis]}, not ${want}`);
      }
    }
    if (!frames.picked) failures.push('looking straight down did not hit the floor');
    else if (Math.hypot(frames.picked.x, frames.picked.y) > 0.6) {
      failures.push(
        `the middle of an overhead view should be the field centre, got ` +
          `${frames.picked.x.toFixed(2)}, ${frames.picked.y.toFixed(2)}`,
      );
    }
    if (frames.epochs !== 1) failures.push(`ctrl-drag teleported ${frames.epochs} times`);
    if (frames.picked && Math.hypot(frames.dragged.x - frames.picked.x, frames.dragged.y - frames.picked.y) > 0.01) {
      failures.push('ctrl-drag did not put the robot where the pointer was');
    }
    if (!frames.skyMissed) failures.push('a ray at the horizon claimed to hit the floor');

    // --- Pause and step, through the real buttons.
    const stepping = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      const sim = app.sim;
      const bar = app.stepBar;
      sim.input.keyboardSource.active = true;
      sim.input.keyboardSource.keys.add('KeyW');
      for (let i = 0; i < 30; i++) sim.step(1 / 60);

      // Pause, and check the world really stops.
      bar.playButton.click();
      const pausedLabel = bar.playButton.textContent;
      const at = sim.time;
      const wasAt = sim.robot.body.position.x;
      for (let i = 0; i < 10; i++) sim.step(1 / 60);
      const frozenTime = sim.time - at;
      const frozenMove = sim.robot.body.position.x - wasAt;

      // The 1 ms button: one millisecond, and frozen again.
      const oneMs = bar.stepButtons[0];
      oneMs.click();
      sim.step(1 / 60);
      const stepped = sim.time - at;
      const refrozen = sim.frozen;

      // The 100 ms button, which is longer than a frame's substep budget.
      bar.stepButtons[3].click();
      sim.step(1 / 60);
      const hundred = sim.time - at - stepped;

      // And one op-mode loop.
      const period = sim.controlPeriod;
      bar.cycleButton.click();
      sim.step(1 / 60);
      const cycle = sim.time - at - stepped - hundred;

      bar.update();
      const clock = bar.readout.textContent;
      bar.togglePause(false);
      sim.input.keyboardSource.keys.delete('KeyW');
      sim.resetRobot();
      return {
        pausedLabel,
        frozenTime,
        frozenMove,
        steppedMs: stepped * 1000,
        refrozen,
        hundredMs: hundred * 1000,
        cycleMs: cycle * 1000,
        periodMs: period * 1000,
        clock,
        running: !sim.paused,
      };
    })()`);
    console.log(
      `  Step: froze at "${stepping.pausedLabel}", then ${stepping.steppedMs.toFixed(3)} ms, ` +
        `${stepping.hundredMs.toFixed(1)} ms, one ${stepping.cycleMs.toFixed(1)} ms loop`,
    );
    if (stepping.frozenTime !== 0) {
      failures.push(`paused, but the clock advanced ${stepping.frozenTime} s`);
    }
    if (stepping.frozenMove !== 0) {
      failures.push(`paused, but the robot moved ${stepping.frozenMove} m`);
    }
    if (Math.abs(stepping.steppedMs - 1) > 1e-6) {
      failures.push(`the 1 ms button advanced ${stepping.steppedMs} ms`);
    }
    if (!stepping.refrozen) failures.push('a step did not freeze again afterwards');
    if (Math.abs(stepping.hundredMs - 100) > 1e-6) {
      failures.push(`the 100 ms button advanced ${stepping.hundredMs} ms`);
    }
    if (Math.abs(stepping.cycleMs - stepping.periodMs) > 0.6) {
      failures.push(
        `a cycle step should be one loop (${stepping.periodMs} ms), was ${stepping.cycleMs} ms`,
      );
    }
    if (!/^\d+\.\d{3} s/.test(stepping.clock ?? '')) {
      failures.push(`the step bar clock read "${stepping.clock}"`);
    }
    if (!stepping.running) failures.push('Run did not let it go again');

    // --- The loop rate is earned from hub transactions, in the real page.
    //
    // The arithmetic is covered in `test/hardware-bus.test.js`; what this is
    // for is that the number reaches the HUD, because a loop time nobody can
    // see teaches nothing.
    const hubLoop = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      const sim = app.sim;
      const keys = sim.input.keyboardSource.keys;
      sim.input.keyboardSource.active = true;

      // Idle: no motor power changes, so nothing is written.
      for (let i = 0; i < 40; i++) sim.step(1 / 60);
      const idleMs = sim.controlPeriod * 1000;
      const idleWrites = sim.robot.bus.lastCounts.write;

      // Driving: the ramp moves all four powers every cycle.
      keys.add('KeyW');
      let peakMs = 0;
      let writes = 0;
      for (let i = 0; i < 20; i++) {
        sim.step(1 / 60);
        peakMs = Math.max(peakMs, sim.controlPeriod * 1000);
        writes = Math.max(writes, sim.robot.bus.lastCounts.write);
      }
      keys.delete('KeyW');
      app.hud.update(sim, sim.telemetry(), 1 / 60);
      const pill = [...app.hud.status.querySelectorAll('.pill')]
        .map((p) => p.textContent)
        .find((t) => t.startsWith('LOOP'));

      // And with the charging switched off it goes back to the panel's rate.
      app.config.set('control.hub.latency', false);
      app.config.set('control.loopRateHz', 40);
      for (let i = 0; i < 20; i++) sim.step(1 / 60);
      const fixedMs = sim.controlPeriod * 1000;
      app.config.set('control.hub.latency', true);
      app.config.set('control.loopRateHz', 50);
      sim.resetRobot();
      return { idleMs, idleWrites, peakMs, writes, pill, fixedMs };
    })()`);
    console.log(
      `  Loop rate: idle ${hubLoop.idleMs.toFixed(1)} ms, driving ${hubLoop.peakMs.toFixed(1)} ms ` +
        `(${hubLoop.writes} writes), fixed ${hubLoop.fixedMs.toFixed(1)} ms`,
    );
    console.log(`    HUD says: ${hubLoop.pill}`);
    if (hubLoop.idleWrites !== 0) {
      failures.push(`an idle robot wrote ${hubLoop.idleWrites} motor powers`);
    }
    if (hubLoop.writes !== 4) failures.push(`driving wrote ${hubLoop.writes} powers, not 4`);
    if (!(hubLoop.peakMs > hubLoop.idleMs + 9)) {
      failures.push(
        `four motor writes should add 10 ms: ${hubLoop.idleMs.toFixed(1)} -> ${hubLoop.peakMs.toFixed(1)}`,
      );
    }
    if (!/^LOOP \d/.test(hubLoop.pill ?? '')) {
      failures.push(`the loop time did not reach the HUD: ${hubLoop.pill}`);
    }
    if (Math.round(hubLoop.fixedMs) !== 25) {
      failures.push(`with charging off, 40 Hz should be 25 ms, got ${hubLoop.fixedMs}`);
    }

    // --- AprilTags: sixteen of them, and a camera that can only see some.
    //
    // Last of the added blocks, because it has to re-stage the FIELD -- which
    // CELL is raised decides which clusters face which way -- and restaging
    // puts the MATCH back into AUTO, where a compiled routine has the ROBOT
    // and the sticks do nothing. The AUTO editor block below restarts the
    // MATCH itself, so nothing after this cares.
    const vision = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      const sim = app.sim;
      // From a staged FIELD, because which CELL is raised decides which
      // clusters face which way, and the MATCH above has been tipping HIVES.
      sim.game.start();
      for (let i = 0; i < 10; i++) sim.step(1 / 60);
      const tags = sim.game.field.aprilTags();
      const redUp = sim.game.field.hives.red.up;

      const look = (x, y, heading) => {
        sim.placeRobot(x, y, heading);
        sim.robot.camera.reset();
        for (let i = 0; i < 30; i++) sim.step(1 / 60);
        return sim.robot.camera.detections;
      };

      const seen = look(-0.3, -1.4, Math.PI / 2);
      const body = sim.robot.body;
      const fix = sim.robot.camera.bestPose(body.rotation.radians);
      const error = fix
        ? Math.hypot(fix.x - body.position.x, fix.y - body.position.y)
        : null;

      // A level camera looks straight under a raised CELL and finds nothing
      // close in, which is the thing to know about this season's tags.
      app.config.set('camera.pitchDegrees', 0);
      const level = look(-0.3, -0.9, Math.PI / 2).length;
      app.config.set('camera.pitchDegrees', 25);
      const pitched = look(-0.3, -0.9, Math.PI / 2).length;
      app.config.set('camera.pitchDegrees', 20);

      // Drawn where they are, and lit when read.
      const drawn = look(-0.3, -1.4, Math.PI / 2).length;
      sim.paused = true;
      app.renderer.render(sim, 1 / 60);
      return {
        total: tags.length,
        ids: [...tags.map((t) => t.id)].sort((a, b) => a - b),
        seen: seen.length,
        seenIds: seen.map((d) => d.id),
        bestPixels: seen[0]?.pixels ?? 0,
        ageMs: (seen[0]?.age ?? 0) * 1000,
        error,
        level,
        pitched,
        drawn,
        redUp,
      };
    })()`);
    console.log(
      `  AprilTags: ${vision.total} on the field; from a metre and a half the camera reads ` +
        `${vision.seen} [${vision.seenIds.join(' ')}] at ${vision.bestPixels.toFixed(0)} px, ` +
        `${vision.ageMs.toFixed(0)} ms old, implying a pose ` +
        `${vision.error === null ? 'n/a' : (vision.error * 1000).toFixed(0) + ' mm'} out`,
    );
    console.log(
      `    red's ${vision.redUp} CELL is up; a level camera finds ${vision.level} up close, ` +
        `pitched up, ${vision.pitched}`,
    );
    if (vision.total !== 16) failures.push(`${vision.total} tags on the field, expected 16`);
    if (vision.ids[0] !== 30 || vision.ids[15] !== 45) {
      failures.push(`tag IDs ran ${vision.ids[0]}..${vision.ids[15]}, expected 30..45`);
    }
    if (vision.seen < 4) failures.push(`the camera only read ${vision.seen} tags`);
    if (!(vision.error !== null && vision.error < 0.06)) {
      failures.push(`a tag fix was ${vision.error} m out`);
    }
    if (!(vision.ageMs > 40)) failures.push(`a detection was only ${vision.ageMs} ms old`);
    if (vision.level !== 0) failures.push(`a level camera should see nothing up close, saw ${vision.level}`);
    if (vision.pitched < 4) failures.push(`pitched up it should see the cluster, saw ${vision.pitched}`);

    await sleep(300);
    const shotTags = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const tagPath = shotPath.replace(/\.png$/, '-apriltags.png');
    await writeFile(tagPath, Buffer.from(shotTags.data, 'base64'));
    console.log(`  Screenshot: ${tagPath}`);
    await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      app.sim.paused = false;
      app.sim.resetRobot();
      return true;
    })()`);

    // --- A team's Java op-modes, loaded from the attached repository.
    const java = await cdp.evaluate(`(async () => {
      const app = globalThis.ftcSim;
      const sim = app.sim;
      const panel = app.auto;
      panel.toggle(true);

      await panel.loadRepo();
      const status = sim.autoRunner.status();
      const options = [...panel.chooser.querySelectorAll('option')].map((o) => o.value);
      const wiring = [...panel.readout.querySelectorAll('.auto-wire')].map((n) => n.textContent.trim());
      const missing = panel.readout.querySelectorAll('.auto-wire.missing').length;

      // Pick the second op-mode from the chooser, as a driver would.
      panel.chooser.value = 'CurveAuto';
      panel.chooser.dispatchEvent(new Event('change'));
      const afterPick = sim.autoRunner.status().selected;

      // Then run the straight one and check it goes straight, which is the
      // whole point of getting the motor mounting right.
      panel.chooser.value = 'StraightAuto';
      panel.chooser.dispatchEvent(new Event('change'));
      // The editor has to follow the chooser, or what is on screen is not what
      // is running.
      const shown = panel.editor.value.includes('class StraightAuto');
      sim.game.start();
      const from = { x: sim.robot.body.position.x, y: sim.robot.body.position.y };
      let peakMs = 0;
      for (let i = 0; i < 60 * 4; i++) {
        sim.step(1 / 60);
        peakMs = Math.max(peakMs, sim.controlPeriod * 1000);
      }
      const ran = sim.autoRunner.status();
      const moved = Math.hypot(
        sim.robot.body.position.x - from.x,
        sim.robot.body.position.y - from.y,
      );
      const drift = Math.abs(sim.robot.body.rotation.radians);
      panel.update();
      return {
        language: status.language,
        files: status.files,
        loadedFrom: panel.loadedFrom,
        options,
        wiring,
        missing,
        afterPick,
        shown,
        messageTone: panel.message.className,
        state: ran.state,
        error: ran.error,
        telemetry: ran.telemetry,
        log: ran.log.join(' | '),
        moved,
        drift,
        peakMs,
      };
    })()`);
    console.log(
      `  Java op-modes: ${java.files.length} file(s) from ${java.loadedFrom}; ` +
        `chooser [${java.options.join(', ')}]`,
    );
    console.log(`    wiring: ${java.wiring.join('  ')}`);
    console.log(
      `    ${java.state} after driving ${java.moved.toFixed(2)} m with ` +
        `${(java.drift * 180 / Math.PI).toFixed(1)} deg of drift, loop peaked at ${java.peakMs.toFixed(1)} ms`,
    );
    if (java.language !== 'java') failures.push(`the repository loaded as ${java.language}`);
    if (java.files.length !== 3) failures.push(`${java.files.length} files loaded, expected 3`);
    if (!java.options.includes('StraightAuto') || !java.options.includes('CurveAuto')) {
      failures.push(`the chooser listed [${java.options.join(', ')}]`);
    }
    if (java.options.includes('NotAnnotated')) failures.push('an unannotated class reached the chooser');
    if (java.afterPick !== 'CurveAuto') failures.push('choosing an op-mode did not select it');
    if (!java.shown) failures.push('the editor did not follow the op-mode chooser');
    if (!/news/.test(java.messageTone)) {
      failures.push(`loading files was reported as an error: ${java.messageTone}`);
    }
    if (java.wiring.length !== 4) failures.push(`${java.wiring.length} devices reported, expected 4`);
    if (java.missing !== 0) failures.push('a drive motor did not resolve');
    if (java.state !== 'done') failures.push(`the op-mode ended ${java.state}: ${java.error}`);
    if (!(java.moved > 0.4)) failures.push(`it only moved ${java.moved} m`);
    if (!(java.drift < 0.08)) failures.push(`it drifted ${java.drift} rad; the mounting signs are wrong`);
    if (!(java.peakMs > 12)) {
      failures.push(`the loop should cost four motor writes, peaked at ${java.peakMs} ms`);
    }
    if (!java.telemetry.Status) failures.push('the init telemetry never arrived');

    await sleep(300);
    const shotJava = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const javaPath = shotPath.replace(/\.png$/, '-java.png');
    await writeFile(javaPath, Buffer.from(shotJava.data, 'base64'));
    console.log(`  Screenshot: ${javaPath}`);
    await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      app.auto.toggle(false);
      app.sim.autoRunner.clear();
      app.sim.resetRobot();
      return true;
    })()`);

    // --- The AUTO editor, through the real UI.
    //
    // The whole point of the feature is that you paste a routine in and it
    // runs, so the check pastes one in and makes sure it does: compiled from
    // the editor's own text, driving the ROBOT during AUTO with the sticks
    // ignored, and scoring.
    const autoRun = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      const panel = app.auto;
      const sim = app.sim;
      panel.toggle(true);
      // A deliberately broken routine first: the error has to reach the panel.
      panel.editor.value = 'function* auto(robot) { yield 1; ';
      const compileError = panel.compile();
      const shownError = panel.message.textContent;
      // Then the example, which is what ships in the box.
      panel.exampleButton.click();
      const armed = sim.autoRunner.armed;

      // Run the AUTO period.
      sim.game.start();
      const drivingDuringAuto = [];
      for (let i = 0; i < 60 * 31; i++) {
        if (i === 60) drivingDuringAuto.push(sim.runningAuto);
        sim.step(1 / 60);
      }
      const status = sim.autoRunner.status();
      const score = sim.game.match.score()[sim.game.alliance];
      panel.update();
      return {
        compileError,
        shownError,
        armed,
        drovAuto: drivingDuringAuto[0] === true,
        state: status.state,
        error: status.error,
        log: status.log.join(' | '),
        total: score.total,
        leave: score.leave,
        parkAuto: score.parkAuto,
        tips: score.tips,
        citations: sim.game.match.referee.citations.map((c) => c.rule + ' ' + c.penalty).join(', '),
        logRows: panel.readout.querySelectorAll('.auto-log div').length,
      };
    })()`);
    console.log(
      `  Auto editor: ${autoRun.state}, ${autoRun.total} points ` +
        `(leave ${autoRun.leave}, park ${autoRun.parkAuto}, tips ${autoRun.tips}), ` +
        `${autoRun.logRows} log rows`,
    );
    console.log(`    routine said: ${autoRun.log}`);
    if (!/SyntaxError|Unexpected/.test(autoRun.compileError ?? '')) {
      failures.push(`a broken routine did not report a syntax error: ${autoRun.compileError}`);
    }
    if (!autoRun.shownError) failures.push('the compile error never reached the panel');
    if (!autoRun.armed) failures.push('the example routine did not compile');
    if (!autoRun.drovAuto) failures.push('the routine was not driving during AUTO');
    if (autoRun.state !== 'done') failures.push(`the routine ended ${autoRun.state}: ${autoRun.error}`);
    if (autoRun.total < 20) failures.push(`the example AUTO only scored ${autoRun.total}`);
    if (autoRun.citations) failures.push(`the example AUTO drew citations: ${autoRun.citations}`);

    await sleep(500);
    const shotAuto = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const autoPath = shotPath.replace(/\.png$/, '-auto.png');
    await writeFile(autoPath, Buffer.from(shotAuto.data, 'base64'));
    console.log(`  Screenshot: ${autoPath}`);
    // Returns a boolean, not the panel: `toggle` returns `this`, and asking
    // CDP to serialise a panel that references the whole app fails with
    // "Object reference chain is too long".
    await cdp.evaluate('(() => { globalThis.ftcSim.auto.toggle(false); return true; })()');

    // --- Multiplayer, over a real WebSocket.
    //
    // The session logic is covered against a loopback link in
    // `test/net-session.test.js`, which is where the game-level bugs are. What
    // that cannot reach is the transport: the hand-written RFC 6455 server, the
    // browser's own WebSocket, the relay's sender stamping, and whether a
    // snapshot survives the round trip as bytes rather than as objects handed
    // between two modules in one process. So this hosts and joins for real,
    // from the page, on the same port the simulator is served from -- and it
    // joins with a *second* full simulation so the mirror is exercised the way
    // a second laptop would exercise it.
    const net = await cdp.evaluate(`(async () => {
      const app = globalThis.ftcSim;
      const [{ NetLink }, { NetHost }, { NetClient }, { Config }, { Simulation }] =
        await Promise.all([
          import('/src/net/NetLink.js'),
          import('/src/net/NetHost.js'),
          import('/src/net/NetClient.js'),
          import('/src/config/Config.js'),
          import('/src/app/Simulation.js'),
        ]);

      const url = 'ws://' + location.host + '/ws';
      const room = 'CHCK';

      app.config.set('ai.enabled', true);
      app.sim.disableGame();
      const hostGame = app.sim.enableGame({ alliance: 'red', startPhase: 'teleop' });
      hostGame.start();
      const hostLink = new NetLink({ url, role: 'host', room, name: 'host' });
      const host = new NetHost({ link: hostLink, sim: app.sim });
      app.sim.net = host;
      hostLink.connect();

      const waitFor = async (predicate, ms, label) => {
        const started = Date.now();
        while (!predicate()) {
          if (Date.now() - started > ms) throw new Error('timed out: ' + label);
          await new Promise((r) => setTimeout(r, 10));
        }
      };
      await waitFor(() => hostLink.open, 5000, 'host connect');

      // A whole second simulation in the same page, standing in for the
      // second laptop. It never steps its own physics.
      const joinConfig = new Config();
      joinConfig.set('ai.enabled', true);
      const joinSim = new Simulation(joinConfig);
      const joinGame = joinSim.enableGame({ alliance: 'red', startPhase: 'teleop' });
      joinGame.start();
      const joinLink = new NetLink({ url, role: 'join', room, name: 'guest' });
      const client = new NetClient({ link: joinLink, sim: joinSim });
      joinSim.net = client;
      joinLink.connect();

      await waitFor(() => joinLink.open, 5000, 'join connect');
      await waitFor(() => host.seats.size === 1, 5000, 'the host seating the joiner');
      await waitFor(() => client.seated, 5000, 'the joiner being told its robot');

      const seat = [...host.seats.values()][0];
      // Put it somewhere with a clear run first. Set the body directly rather
      // than calling reset(), which would also re-zero the subsystems and drop
      // the pre-load -- and what is being measured here is the transport, not
      // whether this particular robot happens to have an A-frame in front of
      // it at its start pose.
      const ownSide = seat.opponent.alliance === 'red' ? -1 : 1;
      seat.opponent.robot.body.position.x = ownSide * 1.25;
      seat.opponent.robot.body.position.y = -0.2;
      seat.opponent.robot.body.rotation.setRadians(Math.PI / 2);
      seat.opponent.robot.body.velocity.x = 0;
      seat.opponent.robot.body.velocity.y = 0;
      const before = {
        x: seat.opponent.robot.body.position.x,
        y: seat.opponent.robot.body.position.y,
      };

      // Drive the remote robot forward for two seconds of frames, sending on
      // the joiner's own control cycle the way the real loop does.
      const pad = new (await import('/src/input/FtcGamepad.js')).FtcGamepad();
      pad.left_stick_y = -1;
      pad.connected = true;
      for (let frame = 0; frame < 120; frame++) {
        client.sendInput(pad);
        app.sim.step(1 / 60);
        // client.update, not joinSim.step. Stepping the joiner would make it
        // send its *own* gamepad too -- an idle keyboard -- so half the
        // packets reaching the host would say the sticks were centred and the
        // robot would barely move. That is not a netcode bug, it is two
        // drivers on one robot, which is what a second laptop is not.
        client.update(1 / 60);
        // Let the sockets actually deliver: this is a real network, and a
        // tight synchronous loop would prove nothing about it.
        if (frame % 10 === 0) await new Promise((r) => setTimeout(r, 4));
      }
      await new Promise((r) => setTimeout(r, 120));
      for (let frame = 0; frame < 6; frame++) client.update(1 / 60);

      const hostBalls = hostGame.field.ballWorld.balls;
      const joinBalls = joinGame.field.ballWorld.balls;
      let worstBall = 0;
      for (let i = 0; i < hostBalls.length; i++) {
        worstBall = Math.max(
          worstBall,
          Math.hypot(
            hostBalls[i].x - joinBalls[i].x,
            hostBalls[i].y - joinBalls[i].y,
            hostBalls[i].z - joinBalls[i].z,
          ),
        );
      }
      let worstRobot = 0;
      const hostEntries = hostGame.match.entries;
      const joinEntries = joinGame.match.entries;
      for (let i = 0; i < hostEntries.length; i++) {
        const a = hostEntries[i].robot.body.position;
        const b = joinEntries[i].robot.body.position;
        worstRobot = Math.max(worstRobot, Math.hypot(a.x - b.x, a.y - b.y));
      }

      const moved = Math.hypot(
        seat.opponent.robot.body.position.x - before.x,
        seat.opponent.robot.body.position.y - before.y,
      );
      const out = {
        seats: host.seats.size,
        label: client.label,
        alliance: client.alliance,
        packets: seat.packets,
        moved,
        snapshots: client.snapshots,
        applied: client.applied,
        mismatch: client.mismatch,
        worstBall,
        worstRobot,
        balls: hostBalls.length,
        scoreMatches:
          client.matchState &&
          client.matchState.score.red.total === hostGame.match.score().red.total,
        bytesOut: hostLink.stats.sent,
      };

      // Leave the page hosting, so the panel screenshot below is of a live
      // session rather than an empty form.
      app.net.update();
      globalThis.__netCheck = { client, joinSim };
      return out;
    })()`);

    console.log(
      `  Multiplayer: seated on ${net.label} (${net.alliance}), ` +
        `${net.packets} input packets moved it ${net.moved.toFixed(2)} m`,
    );
    console.log(
      `    ${net.snapshots} snapshots, ${net.applied} drawn, ${net.balls} elements ` +
        `within ${(net.worstBall * 1000).toFixed(0)} mm, robots within ` +
        `${(net.worstRobot * 1000).toFixed(0)} mm, ${(net.bytesOut / 1024).toFixed(0)} kB sent`,
    );
    if (net.seats !== 1) failures.push(`the joiner was not seated (${net.seats} seats)`);
    if (!net.label) failures.push('the joiner was never told which robot it has');
    if (net.packets < 60) failures.push(`only ${net.packets} input packets arrived`);
    if (net.moved < 0.3) {
      failures.push(`a remote driver moved its robot only ${net.moved.toFixed(2)} m`);
    }
    if (net.snapshots < 20) failures.push(`only ${net.snapshots} snapshots arrived`);
    if (net.applied < 1) failures.push('no snapshot was ever drawn');
    if (net.mismatch) failures.push(`the joiner refused the snapshots: ${net.mismatch}`);
    if (net.worstBall > 0.3) {
      failures.push(`the joiner's elements are ${net.worstBall.toFixed(2)} m out`);
    }
    if (net.worstRobot > 0.4) {
      failures.push(`the joiner's robots are ${net.worstRobot.toFixed(2)} m out`);
    }
    if (!net.scoreMatches) failures.push('the joiner has a different score from the host');

    await cdp.evaluate('(() => { globalThis.ftcSim.net.toggle(true); return true; })()');
    await sleep(400);
    const shotNet = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const netPath = shotPath.replace(/\.png$/, '-multiplayer.png');
    await writeFile(netPath, Buffer.from(shotNet.data, 'base64'));
    console.log(`  Screenshot: ${netPath}`);
    await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      app.net.toggle(false);
      app.net._leave();
      globalThis.__netCheck?.client?.close();
      globalThis.__netCheck = null;
      return true;
    })()`);

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

    // --- A TIPPING HIVE pours; it does not drop its load out of the pivot.
    //
    // The camera is already on the HIVE from the shot above, so this loads the
    // CELL until it goes over and catches it mid-pour. Checked in the browser
    // as well as in `test/biobuzz.test.js` because this is a thing you judge by
    // eye -- the numbers say the load left through the mouth, the picture says
    // whether it looks like pouring.
    const pouring = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      // Its own FIELD, with nobody else on it. This block measures where a
      // TIPPED HIVE puts its load, and with the AI roster still on from the
      // block above, robots drove over and collected the spillage mid-pour --
      // which reads as elements that never left the CELL and a load that
      // scattered a metre and a half sideways.
      app.config.set('ai.enabled', false);
      app.sim.disableGame();
      const game = app.sim.enableGame({ alliance: 'red', startPhase: 'teleop' });
      game.start();
      const hive = game.field.hives[game.alliance];
      // Loose POLLEN lying on the tiles. A bare free test is not enough any
      // more: elements in a CELL are free too, so it would happily pick six
      // that are already in this one and "stage" them to no effect.
      const inAnyCell = (b) =>
        ['red', 'blue'].some(
          (side) =>
            game.field.hives[side].upBalls.includes(b) ||
            game.field.hives[side].downBalls.includes(b),
        );
      const loose = game.field.ballWorld.balls.filter(
        (b) => b.free && b.kind === 'pollen' && b.z < 0.3 && !inAnyCell(b),
      );
      const load = loose.slice(0, 6);
      for (const ball of load) hive.stage(ball);

      const tipsBefore = hive.tips;
      let tippedAt = null;
      let midPour = null;
      const exitX = new Map();
      globalThis.__pourExit = exitX;
      // Stop *at* the mid-pour frame and leave the page there, so the
      // screenshot below is of a HIVE actually pouring rather than of a tidy
      // field several seconds later.
      for (let i = 0; i < 60 * 6; i++) {
        app.sim.step(1 / 60);
        if (tippedAt === null && hive.tips > tipsBefore) tippedAt = i / 60;
        if (midPour === null && tippedAt !== null) {
          // "Out" is no longer "free" -- everything is free now, in a CELL or
          // not -- so it is a question about where each element is. The
          // emptying CELL is the *down* one by this point.
          const up = hive.upBalls;
          const down = hive.downBalls;
          const gone = load.filter((b) => !up.includes(b) && !down.includes(b));
          const out = gone.length;
          // Across the FIELD at the moment it leaves, which is the CELL's own
          // width. Measured at rest it keeps growing, because an element that
          // has left rolls -- so the resting spread says how far things roll,
          // not how wide the mouth is.
          for (const ball of gone) {
            if (!exitX.has(ball.id)) exitX.set(ball.id, ball.x);
          }
          if (out > 0 && out < load.length) {
            midPour = { at: i / 60, out };
            break;
          }
        }
      }
      // Frozen at the mid-pour frame. The page's own render loop keeps
      // stepping between here and the screenshot below, so without this the
      // picture is of a tidy FIELD a second later rather than of a HIVE
      // actually pouring.
      app.sim.paused = true;
      globalThis.__pourCheck = { hive, load, tipsBefore, tippedAt, midPour };
      return {
        tippedAt,
        midPour,
        tipped: hive.tips - tipsBefore,
        staged: load.length,
      };
    })()`);

    // Caught in the act.
    const shotPour = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const pourPath = shotPath.replace(/\.png$/, '-biobuzz-pour.png');
    await writeFile(pourPath, Buffer.from(shotPour.data, 'base64'));

    // Now let it finish and see where the load ended up.
    const settled = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      const { hive, load } = globalThis.__pourCheck;
      const exitX = globalThis.__pourExit;
      app.sim.paused = false;
      for (let i = 0; i < 60 * 6; i++) {
        app.sim.step(1 / 60);
        const up = hive.upBalls;
        const down = hive.downBalls;
        for (const ball of load) {
          if (up.includes(ball) || down.includes(ball)) continue;
          if (!exitX.has(ball.id)) exitX.set(ball.id, ball.x);
        }
      }

      const pivotX = hive.pivotX;
      const dists = load.map((b) => Math.hypot(b.x - pivotX, b.y));
      const spread = (values) => Math.max(...values) - Math.min(...values);
      globalThis.__pourCheck = null;
      globalThis.__pourExit = null;
      const exits = [...exitX.values()];
      return {
        nearest: Math.min(...dists),
        farthest: Math.max(...dists),
        xSpread: exits.length ? spread(exits) : Infinity,
        restSpread: spread(load.map((b) => b.x)),
        leftTheCell: exits.length,
        stillInCell: load.filter(
          (b) => hive.upBalls.includes(b) || hive.downBalls.includes(b),
        ).length,
      };
    })()`);
    const poured = { ...pouring, ...settled };
    console.log(
      `  HIVE pour: ${poured.tipped} tip at ${poured.tippedAt.toFixed(2)} s, ` +
        `${poured.leftTheCell}/${poured.staged} out through a ${(poured.xSpread * 100).toFixed(0)} cm ` +
        `spread, resting ${poured.nearest.toFixed(2)}-${poured.farthest.toFixed(2)} m from the pivot`,
    );
    if (poured.midPour) {
      console.log(
        `    caught mid-pour at ${poured.midPour.at.toFixed(2)} s with ${poured.midPour.out} of 6 out`,
      );
    }
    if (poured.tipped !== 1) failures.push(`the loaded HIVE tipped ${poured.tipped} times`);
    if (poured.stillInCell) failures.push(`${poured.stillInCell} elements never left the CELL`);
    // The mouth is about 0.42 m out along the arm from the pivot, so nothing
    // should end up sitting under the middle of the HIVE.
    if (poured.nearest < 0.3) {
      failures.push(`an element dropped ${poured.nearest.toFixed(2)} m from the pivot`);
    }
    // Leaving through an opening 20 in (0.51 m) wide, so the spread at the
    // mouth is that, not the random sideways shove the old spill used -- which
    // threw elements 2.5 m across the FIELD.
    if (poured.xSpread > 0.7) {
      failures.push(`the load left through a ${poured.xSpread.toFixed(2)} m spread`);
    }
    if (!poured.midPour) failures.push('the load left in a single instant rather than pouring');

    console.log(`  Screenshot: ${pourPath}`);

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

    // --- The buzzer screen, in both of its lifetimes.
    //
    // It has two, and which one it takes depends on a setting, so both are
    // checked here rather than just the one the default config happens to use.
    const ended = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      app.config.set('ai.enabled', false);
      app.config.set('match.autoRestart', false);
      app.config.set('view.showHud', true);
      app.sim.disableGame();
      const g = app.sim.enableGame({ alliance: 'red', startPhase: 'teleop', teleopSeconds: 1 });
      g.start();
      const panel = app.matchOver;
      const before = panel.open;
      for (let i = 0; i < 90; i++) { app.sim.step(1 / 60); }
      app.matchOver.update(app.sim.game);
      const shown = panel.open;
      const headline = panel.headline.textContent;
      const rows = panel.table.querySelectorAll('tr').length;
      const actions = !panel.actions.classList.contains('hidden');
      // Held: many frames later it is still up, because nothing dismissed it.
      for (let i = 0; i < 300; i++) { app.sim.step(1 / 60); app.matchOver.update(app.sim.game); }
      const stillShown = panel.open;
      return {
        before, shown, stillShown, headline, rows, actions,
        phase: app.sim.game.match.phase,
        matchNumber: app.sim.game.matchNumber,
      };
    })()`);
    console.log(
      `  Match over: "${ended.headline}", ${ended.rows} breakdown rows, ` +
        `held ${ended.stillShown ? 'until dismissed' : 'NOT held'}`,
    );
    if (ended.before) failures.push('the buzzer screen was up before the buzzer');
    if (!ended.shown) failures.push('the buzzer screen never appeared');
    if (!ended.stillShown) failures.push('the buzzer screen did not wait to be dismissed');
    if (!ended.actions) failures.push('the buzzer screen offered no way to continue');
    if (ended.rows < 2) failures.push(`the breakdown had ${ended.rows} rows`);

    await sleep(300);
    const shotOver = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const overPath = shotPath.replace(/\.png$/, '-match-over.png');
    await writeFile(overPath, Buffer.from(shotOver.data, 'base64'));
    console.log(`  Screenshot: ${overPath}`);

    // Dismissing it must stick: the same finished match must not pop it back
    // up on the next frame, and it must return for the *next* match.
    const dismissed = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      app.matchOver.dismiss();
      for (let i = 0; i < 60; i++) { app.sim.step(1 / 60); app.matchOver.update(app.sim.game); }
      const stayedDown = !app.matchOver.open;
      app.sim.game.start();
      app.matchOver.update(app.sim.game);
      const downDuringMatch = !app.matchOver.open;
      for (let i = 0; i < 90; i++) { app.sim.step(1 / 60); app.matchOver.update(app.sim.game); }
      return { stayedDown, downDuringMatch, backForNext: app.matchOver.open };
    })()`);
    if (!dismissed.stayedDown) failures.push('the buzzer screen came back after being dismissed');
    if (!dismissed.downDuringMatch) failures.push('the buzzer screen was up during a running match');
    if (!dismissed.backForNext) failures.push('the buzzer screen did not return for the next match');

    // And in a practice loop it lets go on its own, because waiting for a
    // click is the interruption `autoRestart` exists to remove.
    const looped = await cdp.evaluate(`(() => {
      const app = globalThis.ftcSim;
      app.config.set('match.autoRestart', true);
      app.sim.disableGame();
      const g = app.sim.enableGame({ alliance: 'red', startPhase: 'teleop', teleopSeconds: 1 });
      g.start();
      const first = app.sim.game.matchNumber;
      for (let i = 0; i < 70; i++) { app.sim.step(1 / 60); app.matchOver.update(app.sim.game); }
      const shown = app.matchOver.open;
      const countdown = app.matchOver.countdown.textContent;
      const actionsHidden = app.matchOver.actions.classList.contains('hidden');
      // Past the restart delay the loop starts the next match, and the screen
      // has to let go. Watched frame by frame rather than sampled at the end:
      // this is a one-second match on a loop, so by four seconds later the
      // *next* one has finished too and the screen is legitimately up again
      // for it -- which sampling once would read as never having cleared.
      let cleared = false;
      for (let i = 0; i < 60 * 4; i++) {
        app.sim.step(1 / 60);
        app.matchOver.update(app.sim.game);
        if (!app.matchOver.open) cleared = true;
      }
      return {
        shown,
        countdown,
        actionsHidden,
        gone: cleared,
        restarted: app.sim.game.matchNumber > first,
        phase: app.sim.game.match.phase,
      };
    })()`);
    console.log(
      `  Match over, looping: shown "${looped.countdown}", then ` +
        `${looped.gone ? 'cleared itself' : 'STAYED UP'} and the next match ` +
        `${looped.restarted ? 'started' : 'DID NOT start'}`,
    );
    if (!looped.shown) failures.push('the buzzer screen did not appear in a practice loop');
    if (!looped.actionsHidden) {
      failures.push('a looping buzzer screen should not ask for a click it will not wait for');
    }
    if (!/next match in/.test(looped.countdown ?? '')) {
      failures.push(`no restart countdown: ${JSON.stringify(looped.countdown)}`);
    }
    if (!looped.gone) failures.push('the buzzer screen did not clear itself in a practice loop');
    if (!looped.restarted) failures.push('the practice loop did not start the next match');

    await cdp.evaluate(`(() => {
      globalThis.ftcSim.config.set('match.autoRestart', false);
      globalThis.ftcSim.matchOver.dismiss();
      return true;
    })()`);

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

/**
 * A small FTC repository, laid out the way a real one is.
 *
 * Three op-mode files plus the noise a checkout carries -- build output, the
 * SDK's own samples, a class with no annotation -- because what the loader has
 * to get right is choosing among them, and a fixture with only the wanted files
 * would not test that at all.
 */
async function writeFixtureRepo() {
  const root = resolve(ROOT, '.cache/fixture-repo');
  await rm(root, { recursive: true, force: true });
  const team = resolve(root, 'TeamCode/src/main/java/org/firstinspires/ftc/teamcode');
  await mkdir(team, { recursive: true });
  await mkdir(resolve(root, 'TeamCode/build/generated'), { recursive: true });
  await mkdir(resolve(root, 'FtcRobotController/src/main/java/external/samples'), { recursive: true });

  await writeFile(
    resolve(team, 'Drive.java'),
    `package org.firstinspires.ftc.teamcode;

import com.qualcomm.robotcore.eventloop.opmode.LinearOpMode;
import com.qualcomm.robotcore.hardware.DcMotor;
import com.qualcomm.robotcore.util.ElapsedTime;

public class Drive {
    private final LinearOpMode op;
    private final DcMotor lf, rf, lb, rb;
    private final ElapsedTime timer = new ElapsedTime();

    public Drive(LinearOpMode op) {
        this.op = op;
        lf = op.hardwareMap.get(DcMotor.class, "leftFront");
        rf = op.hardwareMap.get(DcMotor.class, "rightFront");
        lb = op.hardwareMap.get(DcMotor.class, "leftBack");
        rb = op.hardwareMap.get(DcMotor.class, "rightBack");
        lf.setDirection(DcMotor.Direction.REVERSE);
        lb.setDirection(DcMotor.Direction.REVERSE);
    }

    public void tank(double left, double right, double seconds) {
        timer.reset();
        while (op.opModeIsActive() && timer.seconds() < seconds) {
            lf.setPower(left);
            lb.setPower(left);
            rf.setPower(right);
            rb.setPower(right);
        }
        stop();
    }

    public void stop() {
        lf.setPower(0);
        rf.setPower(0);
        lb.setPower(0);
        rb.setPower(0);
    }
}
`,
  );

  await writeFile(
    resolve(team, 'StraightAuto.java'),
    `package org.firstinspires.ftc.teamcode;

import com.qualcomm.robotcore.eventloop.opmode.Autonomous;
import com.qualcomm.robotcore.eventloop.opmode.LinearOpMode;

@Autonomous(name = "Straight", group = "Comp")
public class StraightAuto extends LinearOpMode {
    @Override
    public void runOpMode() {
        Drive drive = new Drive(this);
        telemetry.addData("Status", "Initialised");
        telemetry.update();
        waitForStart();
        drive.tank(0.6, 0.6, 1.2);
        sleep(200);
        telemetry.addData("Status", "Done");
        telemetry.update();
    }
}
`,
  );

  await writeFile(
    resolve(team, 'CurveAuto.java'),
    `package org.firstinspires.ftc.teamcode;

import com.qualcomm.robotcore.eventloop.opmode.Autonomous;
import com.qualcomm.robotcore.eventloop.opmode.LinearOpMode;

@Autonomous(name = "Curve", group = "Comp")
public class CurveAuto extends LinearOpMode {
    @Override
    public void runOpMode() {
        Drive drive = new Drive(this);
        waitForStart();
        drive.tank(0.6, 0.3, 1.0);
    }
}

class NotAnnotated {
    int twice(int x) { return x * 2; }
}
`,
  );

  await writeFile(resolve(root, 'TeamCode/build/generated/Junk.java'), 'class Junk {}\n');
  await writeFile(
    resolve(root, 'FtcRobotController/src/main/java/external/samples/BasicOpMode.java'),
    '@Autonomous(name = "SDK Sample") public class BasicOpMode extends LinearOpMode { public void runOpMode() {} }\n',
  );
  return root;
}
