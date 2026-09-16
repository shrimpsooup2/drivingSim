import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Relay, normaliseCode, freshCode, MAX_PEERS } from '../tools/relay.js';
import { encodeInput, decodeInput, encodeSnapshot, decodeSnapshot } from '../src/net/protocol.js';
import { FtcGamepad } from '../src/input/FtcGamepad.js';

/**
 * A relay on a port the OS picks.
 *
 * `close()` drops the live sockets first: an upgraded WebSocket never completes
 * on its own, so `server.close()` by itself waits for it for ever and the test
 * process hangs after every assertion has already passed.
 */
async function relay() {
  const server = createServer((_req, res) => res.end('ok'));
  const r = new Relay();
  r.attach(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = /** @type {any} */ (server.address());
  return {
    relay: r,
    server,
    url: `ws://127.0.0.1:${port}/ws`,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** Connect, say hello, and collect everything that comes back. */
async function peer(url, hello) {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  await once(ws, 'open');
  const json = [];
  const binary = [];
  ws.addEventListener('message', (e) => {
    if (typeof e.data === 'string') json.push(JSON.parse(e.data));
    else binary.push(e.data);
  });
  ws.send(JSON.stringify({ t: 'hello', ...hello }));
  return {
    ws,
    json,
    binary,
    /** Wait for a JSON message of a given type and return it. */
    async expect(t, timeoutMs = 2000) {
      const started = Date.now();
      for (;;) {
        const found = json.find((m) => m.t === t);
        if (found) return found;
        if (Date.now() - started > timeoutMs) {
          throw new Error(`no ${t} arrived; got ${JSON.stringify(json)}`);
        }
        await new Promise((r) => setTimeout(r, 2));
      }
    },
    close() {
      ws.close();
    },
  };
}

async function waitFor(predicate, timeoutMs = 2000, what = 'condition') {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

test('room codes are unambiguous when read off one screen and typed on another', () => {
  assert.equal(normaliseCode(' bcdf '), 'BCDF');
  assert.equal(normaliseCode('bc-df'), 'BCDF');
  assert.equal(normaliseCode('ab'), null, 'too short');
  assert.equal(normaliseCode('abcdefghijklmnop'), null, 'too long');
  assert.equal(normaliseCode(42), null);

  // No vowels, so a code cannot spell a word; and none of the four characters
  // that get misread between two screens.
  let sequence = 0;
  const random = () => ((sequence = (sequence + 0.137) % 1), sequence);
  for (let i = 0; i < 200; i++) {
    const code = freshCode(random);
    assert.equal(code.length, 4);
    assert.match(code, /^[BCDFGHJKLMNPQRSTVWXYZ2-9]{4}$/, code);
    assert.ok(!/[AEIOU10]/.test(code), `${code} should not be confusable`);
  }
});

test('a snapshot reaches every joiner and an input reaches only the host', async () => {
  const { url, close } = await relay();
  const host = await peer(url, { role: 'host', room: 'TEST' });
  await host.expect('welcome');

  const one = await peer(url, { role: 'join', room: 'test', name: 'Ada' });
  const two = await peer(url, { role: 'join', room: 'TEST', name: 'Grace' });
  const welcomeOne = await one.expect('welcome');
  const welcomeTwo = await two.expect('welcome');
  assert.equal(welcomeOne.role, 'join');
  assert.notEqual(welcomeOne.id, welcomeTwo.id, 'each joiner gets its own id');

  // The host is told who arrived, which is how a slot gets assigned.
  await waitFor(() => host.json.filter((m) => m.t === 'peer' && m.joined).length === 2);
  const names = host.json.filter((m) => m.t === 'peer').map((m) => m.name);
  assert.deepEqual(names.sort(), ['Ada', 'Grace']);

  // Host -> everyone.
  const snap = encodeSnapshot({
    tick: 7,
    clock: 1.5,
    phase: 3,
    robots: [],
    balls: [],
    hives: [],
    flowers: [],
  });
  host.ws.send(snap);
  await waitFor(() => one.binary.length === 1 && two.binary.length === 1, 2000, 'the snapshot');
  assert.equal(decodeSnapshot(one.binary[0]).tick, 7);
  assert.equal(decodeSnapshot(two.binary[0]).tick, 7);

  // Joiner -> host only, stamped with who sent it.
  const pad = new FtcGamepad();
  pad.left_stick_y = -1;
  pad.right_bumper = true;
  one.ws.send(encodeInput(pad, 99));
  await waitFor(() => host.binary.length === 1, 2000, 'the input packet');
  const got = decodeInput(host.binary[0]);
  assert.equal(got.seq, 99);
  assert.equal(got.pad.right_bumper, true);
  assert.ok(Math.abs(got.pad.left_stick_y - -1) < 1e-4);
  assert.equal(got.sender, Number(welcomeOne.id.slice(1)), 'the relay says who sent it');

  // And a joiner never sees another joiner's input.
  assert.equal(two.binary.length, 1, 'still just the snapshot');

  host.close();
  one.close();
  two.close();
  close();
});

test('a joiner leaving and the host leaving are both announced', async () => {
  const { url, close } = await relay();
  const host = await peer(url, { role: 'host', room: 'GONE' });
  await host.expect('welcome');
  const guest = await peer(url, { role: 'join', room: 'GONE' });
  const welcome = await guest.expect('welcome');

  guest.close();
  await waitFor(
    () => host.json.some((m) => m.t === 'peer' && m.joined === false && m.id === welcome.id),
    2000,
    'the departure',
  );

  const second = await peer(url, { role: 'join', room: 'GONE' });
  await second.expect('welcome');
  host.close();
  // A joiner has to be told, or it sits there interpolating a snapshot that is
  // never going to be replaced.
  await second.expect('hostGone');

  second.close();
  close();
});

test('a second host, an unhosted room and a full room are all refused', async () => {
  const { url, close } = await relay();
  const host = await peer(url, { role: 'host', room: 'FULL' });
  await host.expect('welcome');

  const impostor = await peer(url, { role: 'host', room: 'FULL' });
  const clash = await impostor.expect('error');
  assert.match(clash.message, /already has a host/);

  const orphan = await peer(url, { role: 'join', room: 'NONE' });
  const missing = await orphan.expect('error');
  assert.match(missing.message, /nobody is hosting/);

  const bad = await peer(url, { role: 'spectate', room: 'FULL' });
  assert.match((await bad.expect('error')).message, /host or join/);

  const joined = [];
  for (let i = 0; i < MAX_PEERS; i++) {
    const p = await peer(url, { role: 'join', room: 'FULL' });
    await p.expect('welcome');
    joined.push(p);
  }
  const extra = await peer(url, { role: 'join', room: 'FULL' });
  assert.match((await extra.expect('error')).message, /is full/);

  host.close();
  for (const p of joined) p.close();
  close();
});

test('the relay never opens a frame it forwards', async () => {
  const { url, close } = await relay();
  const host = await peer(url, { role: 'host', room: 'OPAQUE' });
  await host.expect('welcome');
  const guest = await peer(url, { role: 'join', room: 'OPAQUE' });
  await guest.expect('welcome');

  // Not a snapshot, not an input packet, not valid anything -- and it should
  // still arrive byte for byte, because knowing the game is not the relay's
  // job and a future message type must not need a server deploy.
  const nonsense = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x7f]);
  host.ws.send(nonsense);
  await waitFor(() => guest.binary.length === 1);
  assert.deepEqual([...new Uint8Array(guest.binary[0])], [...nonsense]);

  host.close();
  guest.close();
  close();
});

test('a targeted control message goes to one joiner only', async () => {
  const { url, close } = await relay();
  const host = await peer(url, { role: 'host', room: 'AIM' });
  await host.expect('welcome');
  const one = await peer(url, { role: 'join', room: 'AIM' });
  const two = await peer(url, { role: 'join', room: 'AIM' });
  const first = await one.expect('welcome');
  await two.expect('welcome');

  host.ws.send(JSON.stringify({ t: 'assign', to: first.id, slot: 2, alliance: 'blue' }));
  const assigned = await one.expect('assign');
  assert.equal(assigned.slot, 2);
  assert.equal(assigned.alliance, 'blue');
  assert.equal(assigned.to, undefined, 'the routing field does not travel on');

  await new Promise((r) => setTimeout(r, 60));
  assert.ok(!two.json.some((m) => m.t === 'assign'), 'the other joiner was not told');

  // And a joiner's control message reaches the host tagged with its sender.
  one.ws.send(JSON.stringify({ t: 'ready' }));
  const ready = await host.expect('ready');
  assert.equal(ready.from, first.id);

  host.close();
  one.close();
  two.close();
  close();
});

test('a connection that sends frames before saying hello is dropped', async () => {
  const { url, close } = await relay();
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  await once(ws, 'open');
  const messages = [];
  ws.addEventListener('message', (e) => messages.push(e.data));

  ws.send(encodeInput(new FtcGamepad(), 0));
  await waitFor(() => messages.length > 0, 2000, 'the refusal');
  assert.match(JSON.parse(messages[0]).message, /say hello/);

  close();
});
