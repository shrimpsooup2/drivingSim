#!/usr/bin/env node
/**
 * Dependency-free static file server for the simulator.
 *
 * The project ships as native ES modules, so all it needs is something that
 * serves files over http:// (browsers refuse ES module imports from file://
 * because of CORS). `npm start` runs this; any other static server works too.
 *
 * It is written to be friendly to someone who has never opened a terminal:
 * it picks a free port on its own, opens the browser for you, and prints
 * plain-English messages rather than stack traces.
 *
 * It also carries the multiplayer relay on `/ws`, because the alternative is
 * telling everyone two port numbers. `--lan` binds every interface so the rest
 * of the room can reach it and prints the address they should type; without it
 * the server stays on localhost, which is the right default for a machine that
 * is only ever driving on its own.
 *
 * It can also attach a team's FTC repository, the way a teammate's JVM
 * simulator does with `-Prepo`: `--repo ../FtcRobotController` serves the
 * `.java` files it finds at `/repo/files`, and with no flag it looks for a
 * sibling checkout, because that is where one usually is. The browser then has
 * the team's op-modes without anybody copying a file about, and editing one in
 * an IDE and pressing Reload picks it up.
 *
 * Usage: node tools/serve.js [--port 8080] [--host 127.0.0.1] [--lan] [--no-open] [--repo DIR]
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Relay } from './relay.js';
import { REPO_LIMITS, chooseRepoFiles, isTeamJavaFile, shortName } from '../src/net/repo.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function parseArgs(argv) {
  const out = { port: 8080, host: '127.0.0.1', open: true, lan: false, repo: null, samples: false };
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--port' || argv[i] === '-p') && argv[i + 1]) out.port = Number(argv[++i]);
    else if (argv[i] === '--host' && argv[i + 1]) out.host = argv[++i];
    else if (argv[i] === '--no-open') out.open = false;
    else if (argv[i] === '--lan') out.lan = true;
    else if (argv[i] === '--repo' && argv[i + 1]) out.repo = argv[++i];
    else if (argv[i] === '--samples') out.samples = true;
  }
  // `--lan` is shorthand for "listen on every interface", and it must not
  // silently lose an explicit `--host` given alongside it.
  if (out.lan && out.host === '127.0.0.1') out.host = '0.0.0.0';
  return out;
}

/**
 * The address to read out to the rest of the room.
 *
 * `0.0.0.0` is not something anyone can type into a browser, so when the
 * server is listening on everything this finds the actual LAN address. Private
 * ranges only: a public address here would mean the machine is directly
 * exposed, and printing it as "tell your team this" would be bad advice.
 */
function lanAddress() {
  const candidates = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const ip = entry.address;
      if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) {
        candidates.push(ip);
      }
    }
  }
  // 192.168.x.x first: on a machine with both, that is nearly always the one
  // the phones and laptops in the room are on.
  candidates.sort((a, b) => Number(b.startsWith('192.168.')) - Number(a.startsWith('192.168.')));
  return candidates[0] ?? null;
}

/** Resolve a URL path to a file inside ROOT, or null if it escapes the root. */
function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const abs = join(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + sep)) return null;
  return abs;
}

/**
 * Open the default browser. Best effort only -- the printed URL is the
 * fallback, so a failure here must never take the server down with it.
 *
 * Note that a missing opener (a headless Linux box with no `xdg-open`) surfaces
 * as an asynchronous 'error' event rather than a throw, so a try/catch around
 * spawn is not enough on its own.
 */
function openBrowser(url) {
  const commands = {
    darwin: ['open', [url]],
    win32: ['cmd', ['/c', 'start', '', url]],
  };
  const [command, args] = commands[process.platform] ?? ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      console.log('  (Could not open the browser automatically -- open the address above.)');
    });
    child.unref();
  } catch {
    /* the printed URL is the fallback */
  }
}

const options = parseArgs(process.argv.slice(2));

/**
 * Where the team's repository is, if there is one.
 *
 * An explicit `--repo` wins. Otherwise the parent directory is searched one
 * level for something that looks like an FTC project -- a `TeamCode` folder
 * next to a `FtcRobotController` one -- because a team's checkout is almost
 * always a sibling of whatever else they cloned, and finding it is friendlier
 * than a flag nobody knew to pass.
 */
async function findRepo(explicit) {
  if (explicit) {
    const path = resolve(explicit);
    if (await looksLikeFtcProject(path)) return path;
    // An explicit path is honoured even if it does not look like one: somebody
    // pointing at a directory of loose .java files means that directory.
    try {
      if ((await stat(path)).isDirectory()) return path;
    } catch {
      console.log(`  (No repository at ${path}.)`);
      return null;
    }
  }
  const parent = resolve(ROOT, '..');
  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const candidate = join(parent, entry.name);
    if (candidate === ROOT) continue;
    if (await looksLikeFtcProject(candidate)) return candidate;
  }
  return null;
}

async function looksLikeFtcProject(path) {
  try {
    const entries = await readdir(path);
    return entries.includes('TeamCode') || entries.includes('FtcRobotController');
  } catch {
    return false;
  }
}

/** Every team `.java` file under `root`, with its size. */
async function walkJava(root, prefix = '', out = [], depthLeft = 12) {
  if (depthLeft <= 0) return out;
  let entries;
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      // Pruned rather than walked and filtered: `build` and `.gradle` on a real
      // checkout are thousands of entries.
      if (['build', 'node_modules', '.gradle', '.idea'].includes(entry.name)) continue;
      await walkJava(root, path, out, depthLeft - 1);
      continue;
    }
    if (!isTeamJavaFile(path, { includeSamples: options.samples })) continue;
    try {
      const info = await stat(join(root, path));
      out.push({ path, size: info.size });
    } catch {
      /* it went away between reading the directory and asking about it */
    }
  }
  return out;
}

/** `GET /repo/files` -- the attached repository's op-mode sources. */
async function serveRepoFiles(res) {
  if (!repoRoot) {
    res
      .writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
      .end(JSON.stringify({ error: 'no repository attached' }));
    return;
  }
  const found = await walkJava(repoRoot);
  const chosen = chooseRepoFiles(found, { includeSamples: options.samples });
  const files = [];
  for (const file of chosen.files) {
    try {
      files.push({
        name: shortName(file.path),
        path: file.path,
        source: await readFile(join(repoRoot, file.path), 'utf8'),
      });
    } catch {
      /* unreadable, so it is simply not offered */
    }
  }
  res
    .writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      // Always re-read: the point of attaching a checkout is that editing a
      // file and pressing Reload picks it up.
      'Cache-Control': 'no-store',
    })
    .end(JSON.stringify({ root: repoRoot, files, skipped: chosen.skipped, limits: REPO_LIMITS }));
}

const server = createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/repo/files') {
    await serveRepoFiles(res);
    return;
  }
  let filePath = safePath(req.url || '/');
  if (!filePath) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    let info = await stat(filePath);
    if (info.isDirectory()) {
      filePath = join(filePath, 'index.html');
      info = await stat(filePath);
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
      // The simulator is pure client-side state; never let a stale module
      // linger while someone is editing physics parameters.
      'Cache-Control': 'no-cache',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
  }
});

/** Resolved before the first request, and printed so it is never a mystery. */
let repoRoot = null;

const relay = new Relay({
  log: (line) => console.log(`  [multiplayer] ${line}`),
});
relay.attach(server);

/**
 * Try the requested port, then walk upward.
 *
 * "Address already in use" is a confusing error for a first-time user, and the
 * usual cause is simply that they already have the simulator open in another
 * window. Finding the next free port is friendlier than explaining the problem.
 */
let attempts = 0;
const MAX_ATTEMPTS = 20;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && attempts < MAX_ATTEMPTS) {
    attempts++;
    server.listen(options.port + attempts, options.host);
    return;
  }
  if (err.code === 'EADDRINUSE') {
    console.error(`\nCould not find a free port between ${options.port} and ${options.port + MAX_ATTEMPTS}.`);
    console.error('Close some other programs and try again.\n');
  } else {
    console.error(`\nCould not start the server: ${err.message}\n`);
  }
  process.exit(1);
});

server.listen(options.port, options.host, async () => {
  repoRoot = await findRepo(options.repo);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  // `0.0.0.0` is a bind address, not somewhere a browser can go, so the line
  // this window prints for the person sitting at it is always localhost.
  const localHost = options.host === '0.0.0.0' || options.host === '::' ? 'localhost' : options.host;
  const url = `http://${localHost}:${port}/`;

  console.log('');
  console.log('  FTC Driving Simulator is running.');
  console.log('');
  console.log(`      ${url}`);
  console.log('');
  if (options.open) {
    console.log('  Opening your browser...');
    openBrowser(url);
  } else {
    console.log('  Open that address in your browser.');
  }
  if (options.lan) {
    const ip = lanAddress();
    console.log('  Multiplayer is on. Everyone else on this network opens:');
    console.log('');
    console.log(`      http://${ip ?? '<this machine\u2019s address>'}:${port}/`);
    console.log('');
    if (!ip) {
      console.log('  (No private network address found -- are you connected to Wi-Fi?)');
      console.log('');
    }
  } else {
    console.log('  For multiplayer, stop this and run:  npm run lan');
    console.log('');
  }
  if (repoRoot) {
    const found = chooseRepoFiles(await walkJava(repoRoot), { includeSamples: options.samples });
    console.log(`  Your FTC repository is attached: ${repoRoot}`);
    console.log(`  ${found.files.length} op-mode source file(s). Press F, then Load repository.`);
    console.log('');
  } else {
    console.log('  To run your own op-modes, attach your repository:');
    console.log('');
    console.log('      npm start -- --repo ../your-FtcRobotController');
    console.log('');
  }
  console.log('  Leave this window open while you drive.');
  console.log('  Press Ctrl+C (or just close this window) to stop.');
  console.log('');
});
