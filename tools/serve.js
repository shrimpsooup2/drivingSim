#!/usr/bin/env node
/**
 * Dependency-free static file server for the simulator.
 *
 * The project ships as native ES modules, so all it needs is something that
 * serves files over http:// (the browser refuses ES module imports from
 * file:// due to CORS). `npm start` runs this; any other static server works
 * just as well.
 *
 * Usage: node tools/serve.js [--port 8080] [--host 127.0.0.1]
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
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
  const out = { port: 8080, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--port' || argv[i] === '-p') && argv[i + 1]) out.port = Number(argv[++i]);
    else if (argv[i] === '--host' && argv[i + 1]) out.host = argv[++i];
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

const { port, host } = parseArgs(process.argv.slice(2));

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
      // The simulator is pure client-side state; never let a stale module linger
      // while someone is editing physics parameters.
      'Cache-Control': 'no-cache',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
  }
});

server.listen(port, host, () => {
  console.log(`FTC driving sim  ->  http://${host}:${port}/`);
  console.log('Press Ctrl+C to stop.');
});
