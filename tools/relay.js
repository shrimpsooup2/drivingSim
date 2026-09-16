/**
 * The rendezvous between one hosting browser and up to three joining ones.
 *
 * This is deliberately the stupidest component in the system. It knows about
 * rooms, roles and who is connected; it knows nothing about BIOBUZZ, robots,
 * scoring or the snapshot format. Every byte it handles it forwards unopened.
 *
 * That is not minimalism for its own sake -- it is what makes the browser the
 * authority. If the server understood the game it would be tempting to let it
 * arbitrate, and then there would be two implementations of the rules: one in
 * `Match.js` that is tested against the manual, and one here that is not.
 *
 * ## Routing, without a routing header
 *
 * The hot path needs no addressing, because role decides it:
 *
 *   - a **snapshot** only ever goes host -> everyone else;
 *   - an **input packet** only ever goes joiner -> host.
 *
 * So binary frames are forwarded by role and cost nothing to route. Only the
 * JSON control channel can address one peer, via an optional `to`, and that is
 * rare enough that parsing it is free.
 *
 * ## What it refuses
 *
 * A second host for a room, a joiner for a room with no host, and a room over
 * capacity. Each gets a JSON error and a close, because the alternative is a
 * joiner sitting at a blank field wondering whether the network is broken.
 *
 * @module
 */
import { attachWebSocket } from './websocket.js';
import { INPUT_SENDER_OFFSET } from '../src/net/protocol.js';
import { normaliseCode, freshCode } from '../src/net/roomCode.js';

/** Four robots on a FIELD, so the host plus three. */
export const MAX_PEERS = 3;

/** How long a room with no host is kept before it is forgotten. */
const EMPTY_ROOM_GRACE_MS = 30_000;

export class Relay {
  constructor({ log = () => {} } = {}) {
    /** @type {Map<string, {code: string, host: any, peers: Map<string, any>, emptiedAt: number}>} */
    this.rooms = new Map();
    this.log = log;
    this._nextPeer = 1;
  }

  /** @param {import('node:http').Server} server */
  attach(server, path = '/ws') {
    attachWebSocket(server, {
      path,
      onConnection: (conn) => this._greet(conn),
    });
    return this;
  }

  _greet(conn) {
    // Nothing is routed until a `hello` names a role, so a connection that
    // never sends one costs a socket and no state.
    conn.onMessage = (data) => {
      if (typeof data !== 'string') {
        this._fail(conn, 'say hello before sending frames');
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        this._fail(conn, 'hello must be JSON');
        return;
      }
      if (msg?.t !== 'hello') {
        this._fail(conn, 'expected hello');
        return;
      }
      this._join(conn, msg);
    };
    conn.onClose = () => {};
  }

  _join(conn, msg) {
    const code = normaliseCode(msg.room);
    if (!code) {
      this._fail(conn, 'that is not a room code');
      return;
    }
    const name = typeof msg.name === 'string' ? msg.name.slice(0, 24) : '';

    if (msg.role === 'host') {
      const existing = this.rooms.get(code);
      if (existing?.host?.open) {
        this._fail(conn, `room ${code} already has a host`);
        return;
      }
      const room = existing ?? { code, host: null, peers: new Map(), emptiedAt: 0 };
      room.host = conn;
      room.emptiedAt = 0;
      this.rooms.set(code, room);
      conn.meta = { role: 'host', room: code, name, id: 'host' };
      this.log(`room ${code}: host connected`);
      this._send(conn, { t: 'welcome', role: 'host', room: code, id: 'host', peers: this._roster(room) });
      // A host that arrives after its joiners -- which happens on a reload --
      // has to be told who is already waiting, or their robots never appear.
      for (const peer of room.peers.values()) {
        this._send(conn, { t: 'peer', id: peer.meta.id, name: peer.meta.name, joined: true });
      }
      this._wire(conn, room);
      return;
    }

    if (msg.role !== 'join') {
      this._fail(conn, 'role must be host or join');
      return;
    }
    const room = this.rooms.get(code);
    if (!room || !room.host?.open) {
      this._fail(conn, `nobody is hosting room ${code}`);
      return;
    }
    if (room.peers.size >= MAX_PEERS) {
      this._fail(conn, `room ${code} is full`);
      return;
    }
    const id = `p${this._nextPeer++}`;
    conn.meta = { role: 'join', room: code, name, id };
    room.peers.set(id, conn);
    this.log(`room ${code}: ${id}${name ? ` (${name})` : ''} joined`);
    this._send(conn, { t: 'welcome', role: 'join', room: code, id, peers: this._roster(room) });
    this._send(room.host, { t: 'peer', id, name, joined: true });
    this._wire(conn, room);
  }

  /** Forward everything from here on, by role. */
  _wire(conn, room) {
    const { role, id } = conn.meta;
    const senderByte = role === 'join' ? Number(id.slice(1)) & 0xff : 0;

    conn.onMessage = (data) => {
      if (typeof data !== 'string') {
        // Binary: role decides where it goes, so there is nothing to parse.
        if (role === 'host') {
          for (const peer of room.peers.values()) peer.send(data);
        } else if (room.host?.open) {
          // The host needs to know whose input this is, and the packet has no
          // room for a name -- so the id rides on the connection and the relay
          // writes it into the byte the format reserves for it.
          room.host.send(stampSender(data, senderByte));
        }
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (role === 'host') {
        if (msg.to) {
          const peer = room.peers.get(msg.to);
          if (peer?.open) this._send(peer, { ...msg, to: undefined });
          return;
        }
        for (const peer of room.peers.values()) this._send(peer, msg);
      } else if (room.host?.open) {
        this._send(room.host, { ...msg, from: id });
      }
    };

    conn.onClose = () => {
      if (role === 'host') {
        if (room.host !== conn) return;
        room.host = null;
        room.emptiedAt = Date.now();
        this.log(`room ${room.code}: host left`);
        for (const peer of room.peers.values()) {
          this._send(peer, { t: 'hostGone' });
        }
        this._sweep();
        return;
      }
      if (room.peers.get(id) !== conn) return;
      room.peers.delete(id);
      this.log(`room ${room.code}: ${id} left`);
      if (room.host?.open) this._send(room.host, { t: 'peer', id, joined: false });
    };
  }

  _roster(room) {
    return [...room.peers.values()].map((p) => ({ id: p.meta.id, name: p.meta.name }));
  }

  _send(conn, msg) {
    if (conn?.open) conn.send(JSON.stringify(msg));
  }

  _fail(conn, message) {
    this._send(conn, { t: 'error', message });
    conn.close(1008, message);
  }

  /** Drop rooms whose host has been gone a while and that nobody is in. */
  _sweep() {
    const now = Date.now();
    for (const [code, room] of [...this.rooms]) {
      if (room.host?.open) continue;
      if (room.peers.size > 0 && now - room.emptiedAt < EMPTY_ROOM_GRACE_MS) continue;
      if (room.peers.size === 0 || now - room.emptiedAt >= EMPTY_ROOM_GRACE_MS) {
        for (const peer of room.peers.values()) peer.close(1001, 'the host left');
        this.rooms.delete(code);
      }
    }
  }

  /** For the console readout. */
  summary() {
    return [...this.rooms.values()].map((r) => ({
      room: r.code,
      hosted: Boolean(r.host?.open),
      peers: r.peers.size,
    }));
  }
}

/**
 * Write the sender into the byte the input format reserves for it.
 *
 * In place, on a copy: the buffer came off the socket and is ours, but copying
 * is 20 bytes and not copying is the sort of aliasing bug that only shows up
 * under load. Ids are `p1`, `p2`, `p3`, so the numeric part is all that goes.
 */
function stampSender(data, senderByte) {
  const body = toUint8(data);
  if (body.length < INPUT_SENDER_OFFSET + 1) return body;
  const out = new Uint8Array(body);
  out[INPUT_SENDER_OFFSET] = senderByte;
  return out;
}

function toUint8(data) {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}

// Room codes are shared with the browser that displays one, so they live in
// `src/net/roomCode.js`; re-exported here because this is where a reader of
// the relay looks for them.
export { normaliseCode, freshCode };
