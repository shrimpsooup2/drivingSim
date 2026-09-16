import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { connect } from 'node:net';
import { createHash } from 'node:crypto';
import { attachWebSocket, acceptKey, WebSocketConnection } from '../tools/websocket.js';

/**
 * These test the framing, not the happy path.
 *
 * A hand-written WebSocket server passes "send a short string on loopback" on
 * the first try and then falls over on the three things the spec spends its
 * length on: a stream that does not respect message boundaries, masking, and
 * fragmentation. So there is a test for each, and they drive the socket by hand
 * where the built-in client will not produce the case.
 */

/**
 * Start an http server with the socket attached, on a port the OS picks.
 *
 * `close()` here means `closeAllConnections()` *then* `server.close()`, and the
 * order matters more than it looks: `server.close()` alone stops accepting new
 * connections and then waits for the live ones, and an upgraded WebSocket
 * never finishes on its own. Without this the tests all pass and the process
 * hangs afterwards, which reads as a hung test run rather than a leak.
 */
async function serve(onConnection) {
  const server = createServer((_req, res) => res.end('ok'));
  attachWebSocket(server, { onConnection });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = /** @type {any} */ (server.address());
  return {
    server,
    port,
    url: `ws://127.0.0.1:${port}/ws`,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** A masked client frame, built by hand. */
function clientFrame(opcode, payload, { fin = true } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  let header;
  if (body.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | body.length;
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(body.length, 6);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  const masked = Buffer.allocUnsafe(body.length);
  for (let i = 0; i < body.length; i++) masked[i] = body[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

/** Do the HTTP upgrade by hand and hand back the raw socket. */
async function rawClient(port) {
  const socket = connect(port, '127.0.0.1');
  await once(socket, 'connect');
  const key = Buffer.from('0123456789abcdef').toString('base64');
  socket.write(
    `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
      `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\n` +
      'Sec-WebSocket-Version: 13\r\n\r\n',
  );
  const [head] = await once(socket, 'data');
  const text = head.toString('latin1');
  assert.match(text, /^HTTP\/1\.1 101 /, 'expected the upgrade');
  // A substring rather than a regexp: a base64 digest is full of `+`, `/` and
  // `=`, and `new RegExp` on one of those quietly stops meaning what it says.
  assert.ok(
    text.includes(`Sec-WebSocket-Accept: ${acceptKey(key)}`),
    `accept header missing or wrong in: ${JSON.stringify(text)}`,
  );
  return socket;
}

test('the handshake key is the RFC 6455 example', () => {
  // The worked example from section 1.3, which is the one value in the whole
  // protocol that can be checked against the document rather than against
  // another implementation.
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  const byHand = createHash('sha1')
    .update('dGhlIHNhbXBsZSBub25jZQ==258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), byHand);
});

test('a browser-style client can talk to it both ways', async () => {
  /** @type {WebSocketConnection|null} */
  let conn = null;
  const received = [];
  const { port, url, close } = await serve((c) => {
    conn = c;
    c.onMessage = (data) => {
      received.push(data);
      c.send(typeof data === 'string' ? `echo:${data}` : Buffer.concat([Buffer.from([0xff]), data]));
    };
  });

  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  await once(ws, 'open');

  const replies = [];
  ws.addEventListener('message', (e) => replies.push(e.data));

  ws.send('hello');
  ws.send(new Uint8Array([1, 2, 3]));
  await waitFor(() => replies.length === 2);

  assert.deepEqual(received[0], 'hello', 'text arrives as a string');
  assert.ok(Buffer.isBuffer(received[1]), 'binary arrives as a Buffer');
  assert.deepEqual([...received[1]], [1, 2, 3]);
  assert.equal(replies[0], 'echo:hello');
  assert.deepEqual([...new Uint8Array(replies[1])], [0xff, 1, 2, 3]);

  ws.close();
  await waitFor(() => conn && !conn.open);
  close();
});

test('two frames in one chunk are two messages', async () => {
  const received = [];
  const { port, close } = await serve((c) => {
    c.onMessage = (d) => received.push(d);
  });
  const socket = await rawClient(port);

  // The case a per-chunk parser gets wrong: one write, two frames.
  socket.write(Buffer.concat([clientFrame(0x1, 'first'), clientFrame(0x1, 'second')]));
  await waitFor(() => received.length === 2);
  assert.deepEqual(received, ['first', 'second']);

  socket.destroy();
  close();
});

test('a frame split across chunks is one message', async () => {
  const received = [];
  const { port, close } = await serve((c) => {
    c.onMessage = (d) => received.push(d);
  });
  const socket = await rawClient(port);

  // 400 bytes, so the header carries a 16-bit length, dribbled out a few bytes
  // at a time -- which is what a real network does to a snapshot.
  const body = 'x'.repeat(400);
  const frame = clientFrame(0x1, body);
  for (let i = 0; i < frame.length; i += 7) {
    socket.write(frame.subarray(i, Math.min(i + 7, frame.length)));
    await tick();
  }
  await waitFor(() => received.length === 1);
  assert.equal(received[0], body);
  assert.equal(received[0].length, 400);

  socket.destroy();
  close();
});

test('a fragmented message is reassembled, and a ping may interleave', async () => {
  const received = [];
  const { port, close } = await serve((c) => {
    c.onMessage = (d) => received.push(d);
  });
  const socket = await rawClient(port);
  const back = [];
  socket.on('data', (d) => back.push(d));

  socket.write(clientFrame(0x1, 'one ', { fin: false })); // text, not final
  socket.write(clientFrame(0x9, 'hi')); // ping in the middle, which is legal
  socket.write(clientFrame(0x0, 'two ', { fin: false })); // continuation
  socket.write(clientFrame(0x0, 'three', { fin: true })); // continuation, final

  try {
    await waitFor(() => received.length === 1, 2000, 'the reassembled message');
    assert.equal(received[0], 'one two three');

    // Wait for the pong *before* reading it. The message completing and the
    // pong landing are two different events on two different sockets, and
    // asserting on `back` as soon as the message arrives is a race -- one that
    // fails perhaps a third of the time, and then skips the teardown below and
    // leaves the server holding the event loop open, so the whole file hangs
    // instead of reporting one failed assertion.
    await waitFor(() => Buffer.concat(back).length >= 4, 2000, 'the pong');
    const all = Buffer.concat(back);
    assert.equal(all[0] & 0x0f, 0xa, 'a pong came back');
    assert.equal(all[1] & 0x80, 0, 'server frames are never masked');
    assert.equal(all.subarray(2, 2 + (all[1] & 0x7f)).toString(), 'hi');
  } finally {
    socket.destroy();
    close();
  }
});

test('an unmasked client frame is a protocol error', async () => {
  let closed = null;
  const { port, close } = await serve((c) => {
    c.onClose = (code) => {
      closed = code;
    };
  });
  const socket = await rawClient(port);

  // Same frame as always but with the MASK bit clear, which RFC 6455 5.1 says
  // the server must reject rather than try to read.
  socket.write(Buffer.concat([Buffer.from([0x81, 0x03]), Buffer.from('abc')]));
  const [reply] = await once(socket, 'data');
  assert.equal(reply[0] & 0x0f, 0x8, 'a close frame came back');
  assert.equal(reply.readUInt16BE(2), 1002, 'with the protocol-error code');

  socket.destroy();
  await waitFor(() => closed !== null);
  close();
});

test('a wrong path or version is refused without upgrading', async () => {
  const { port, close } = await serve(() => {
    assert.fail('should not have connected');
  });

  const wrongPath = connect(port, '127.0.0.1');
  await once(wrongPath, 'connect');
  wrongPath.write(
    `GET /nope HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      'Sec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\n\r\n',
  );
  const [a] = await once(wrongPath, 'data');
  assert.match(a.toString('latin1'), /^HTTP\/1\.1 404 /);
  wrongPath.destroy();

  const oldVersion = connect(port, '127.0.0.1');
  await once(oldVersion, 'connect');
  oldVersion.write(
    `GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      'Sec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 8\r\n\r\n',
  );
  const [b] = await once(oldVersion, 'data');
  assert.match(b.toString('latin1'), /^HTTP\/1\.1 400 /);
  oldVersion.destroy();

  close();
});

test('a message over the cap hangs up rather than allocating it', async () => {
  let closed = null;
  const { port, close } = await serve((c) => {
    c.onClose = (code) => {
      closed = code;
    };
    c.onMessage = () => assert.fail('should not have been delivered');
  });
  const socket = await rawClient(port);

  // A 64-bit header claiming 2 MiB, with no payload behind it. A server that
  // trusts the header allocates two megabytes for six bytes of input.
  const header = Buffer.alloc(10);
  header[0] = 0x82;
  header[1] = 0x80 | 127;
  header.writeUInt32BE(0, 2);
  header.writeUInt32BE(2 * 1024 * 1024, 6);
  socket.write(Buffer.concat([header, Buffer.from([0, 0, 0, 0])]));

  const [reply] = await once(socket, 'data');
  assert.equal(reply[0] & 0x0f, 0x8, 'closed instead');
  socket.destroy();
  await waitFor(() => closed !== null);
  close();
});

function tick() {
  return new Promise((r) => setImmediate(r));
}

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 2));
  }
}
