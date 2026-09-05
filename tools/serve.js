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
 * Usage: node tools/serve.js [--port 8080] [--host 127.0.0.1] [--no-open]
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const out = { port: 8080, host: '127.0.0.1', open: true };
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--port' || argv[i] === '-p') && argv[i + 1]) out.port = Number(argv[++i]);
    else if (argv[i] === '--host' && argv[i + 1]) out.host = argv[++i];
    else if (argv[i] === '--no-open') out.open = false;
  }
  return out;
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

const server = createServer(async (req, res) => {
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

server.listen(options.port, options.host, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  const url = `http://${options.host}:${port}/`;

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
  console.log('');
  console.log('  Leave this window open while you drive.');
  console.log('  Press Ctrl+C (or just close this window) to stop.');
  console.log('');
});
