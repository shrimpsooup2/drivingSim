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
