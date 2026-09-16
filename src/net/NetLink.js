/**
 * One connection to the relay, and a fake one for tests.
 *
 * `NetLink` is a thin wrapper over the browser's `WebSocket`: it says hello,
 * splits what comes back into JSON and binary, and reports its state in terms
 * a panel can display. It deliberately does not know what any message means --
 * `NetHost` and `NetClient` do that, and they are testable in Node against
 * `LoopbackLink` without a socket in sight.
 *
 * That pairing is the point. Netcode that can only be exercised by opening two
 * browsers is netcode that gets tested once, by hand, on the day it is written.
 *
 * @module
 */

/** Connection states, in the order they happen. */
export const LINK_STATES = ['idle', 'connecting', 'open', 'closed', 'error'];

export class NetLink {
  /**
   * @param {{url: string, role: 'host'|'join', room: string, name?: string,
   *          WebSocketImpl?: any}} opts
   */
  constructor(opts) {
    this.url = opts.url;
    this.role = opts.role;
    this.room = opts.room;
    this.name = opts.name ?? '';
    this._WebSocket = opts.WebSocketImpl ?? globalThis.WebSocket;

    this.state = 'idle';
    /** Whatever went wrong, for the panel to show. */
    this.error = '';
    /** The id the relay gave us. 'host' for a host. */
    this.id = null;

    /** @type {((msg: any) => void)|null} */
    this.onJson = null;
    /** @type {((data: ArrayBuffer) => void)|null} */
    this.onBinary = null;
    /** @type {((state: string) => void)|null} */
    this.onState = null;

    this._ws = null;
    /** Bytes in and out, for the readout -- a stall is easier to see than to guess at. */
    this.stats = { sent: 0, received: 0, messagesIn: 0, messagesOut: 0 };
  }

  connect() {
    if (this.state === 'connecting' || this.state === 'open') return this;
    if (!this._WebSocket) {
      this._setState('error', 'this browser has no WebSocket');
      return this;
    }
    this._setState('connecting');
    try {
      this._ws = new this._WebSocket(this.url);
    } catch (err) {
      this._setState('error', String(err?.message ?? err));
      return this;
    }
    this._ws.binaryType = 'arraybuffer';

    this._ws.addEventListener('open', () => {
      // The relay routes nothing until it knows the role, so this is the first
      // thing over the wire, always.
      this._sendRaw(
        JSON.stringify({ t: 'hello', role: this.role, room: this.room, name: this.name }),
      );
      this._setState('open');
    });

    this._ws.addEventListener('message', (event) => {
      const data = event.data;
      if (typeof data === 'string') {
        this.stats.received += data.length;
        this.stats.messagesIn++;
        let msg;
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }
        // `welcome` and `error` are the link's own business; everything else is
        // the session's.
        if (msg.t === 'welcome') this.id = msg.id;
        if (msg.t === 'error') this.error = msg.message ?? 'refused';
        this.onJson?.(msg);
        return;
      }
      const bytes = data?.byteLength ?? 0;
      this.stats.received += bytes;
      this.stats.messagesIn++;
      this.onBinary?.(data);
    });

    this._ws.addEventListener('close', () => this._setState('closed'));
    this._ws.addEventListener('error', () => {
      // A failed connection fires 'error' then 'close', and the event carries
      // nothing useful by design (it would leak whether a port is open), so
      // the message has to be written here rather than read off it.
      if (this.state !== 'open') this.error ||= 'could not reach the host';
      this._setState('error');
    });
    return this;
  }

  /** @param {any} msg */
  sendJson(msg) {
    return this._sendRaw(JSON.stringify(msg));
  }

  /** @param {ArrayBuffer|ArrayBufferView} data */
  sendBinary(data) {
    return this._sendRaw(data);
  }

  close() {
    this._ws?.close();
    this._ws = null;
    if (this.state !== 'error') this._setState('closed');
    return this;
  }

  get open() {
    return this.state === 'open';
  }

  _sendRaw(payload) {
    if (!this._ws || this._ws.readyState !== 1) return false;
    try {
      this._ws.send(payload);
    } catch {
      return false;
    }
    this.stats.sent += typeof payload === 'string' ? payload.length : payload.byteLength ?? 0;
    this.stats.messagesOut++;
    return true;
  }

  _setState(state, error) {
    if (error) this.error = error;
    if (this.state === state) return;
    this.state = state;
    this.onState?.(state);
  }
}

/**
 * A pair of links wired to each other with no socket in between.
 *
 * Used by the tests to run a real host against a real client, which is the
 * only way to catch the things that actually break: a slot assigned to the
 * wrong robot, a snapshot applied to the wrong ball, an interpolator that
 * extrapolates off the FIELD when a packet is late.
 *
 * Delivery is synchronous by default -- `deliver()` on the far side is called
 * inside `send` -- because a test that has to await the network is a test that
 * races. `latencySteps` queues instead, for the tests that are *about* delay.
 */
export class LoopbackLink {
  constructor({ role = 'host', latencySteps = 0 } = {}) {
    this.role = role;
    this.state = 'open';
    this.error = '';
    this.id = role === 'host' ? 'host' : 'p1';
    this.peer = /** @type {LoopbackLink|null} */ (null);
    this.latencySteps = latencySteps;
    /** @type {{json?: any, binary?: any, due: number}[]} */
    this._queue = [];
    this._clock = 0;
    this.stats = { sent: 0, received: 0, messagesIn: 0, messagesOut: 0 };

    /** @type {((msg: any) => void)|null} */
    this.onJson = null;
    /** @type {((data: ArrayBuffer) => void)|null} */
    this.onBinary = null;
    /** @type {((state: string) => void)|null} */
    this.onState = null;
  }

  /** Join two links so each one's sends arrive at the other. */
  static pair({ latencySteps = 0 } = {}) {
    const host = new LoopbackLink({ role: 'host', latencySteps });
    const client = new LoopbackLink({ role: 'join', latencySteps });
    host.peer = client;
    client.peer = host;
    return { host, client };
  }

  connect() {
    return this;
  }

  get open() {
    return this.state === 'open';
  }

  sendJson(msg) {
    // Through a JSON round trip even here: a host that hands the client a live
    // object works in a test and cannot work over a wire, and that is exactly
    // the bug a loopback is prone to hiding.
    this._dispatch({ json: JSON.parse(JSON.stringify(msg)) });
    return true;
  }

  sendBinary(data) {
    const copy = data instanceof ArrayBuffer ? data.slice(0) : toArrayBuffer(data);
    this._dispatch({ binary: copy });
    return true;
  }

  /** Advance the delay queue by one step, for a link built with latency. */
  pump() {
    this._clock++;
    while (this._queue.length && this._queue[0].due <= this._clock) {
      const item = this._queue.shift();
      this._receive(item);
    }
    return this;
  }

  close() {
    this.state = 'closed';
    this.onState?.('closed');
    return this;
  }

  _dispatch(item) {
    this.stats.messagesOut++;
    const peer = this.peer;
    if (!peer || !peer.open) return;
    if (peer.latencySteps > 0) {
      peer._queue.push({ ...item, due: peer._clock + peer.latencySteps });
      return;
    }
    peer._receive(item);
  }

  _receive(item) {
    this.stats.messagesIn++;
    if (item.json !== undefined) this.onJson?.(item.json);
    else if (item.binary !== undefined) this.onBinary?.(item.binary);
  }
}

function toArrayBuffer(view) {
  if (!ArrayBuffer.isView(view)) return new ArrayBuffer(0);
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}
