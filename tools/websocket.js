/**
 * A WebSocket server, by hand, in about three hundred lines.
 *
 * The browser has had a `WebSocket` client built in for fifteen years. Node has
 * had a `WebSocket` *client* since 22. Neither ships a server, and this project
 * has no dependencies and no build step -- so here is the server.
 *
 * It is less alarming than it sounds. RFC 6455 is a handshake and a frame
 * header, and the handshake is a SHA-1 of the client's key concatenated with a
 * fixed GUID. What makes hand-rolled implementations go wrong is not the
 * cryptography, it is the framing, and specifically three things that a
 * localhost test will never show you:
 *
 *   1. **TCP is a stream.** A frame can arrive in two chunks and two frames can
 *      arrive in one chunk. Anything that parses `data` as one frame works
 *      perfectly on loopback with small messages and corrupts the moment a
 *      snapshot crosses the MTU. So this buffers and drains in a loop.
 *   2. **Client frames are masked, server frames must not be.** Every byte
 *      from a browser is XOR'd with a rotating four-byte key. Miss it and the
 *      payload is noise. Mask a frame *to* a browser and it closes the
 *      connection on you.
 *   3. **Messages fragment.** A single logical message can arrive as a
 *      sequence of continuation frames, and control frames (ping, close) are
 *      allowed to be interleaved between them.
 *
 * What is deliberately *not* here: `permessage-deflate` (a snapshot is already
 * packed binary, so it would cost CPU to save nothing), and extension
 * negotiation of any kind. The server advertises nothing, so a browser asks for
 * nothing.
 *
 * @module
 */
import { createHash, randomBytes } from 'node:crypto';

/** RFC 6455 section 1.3. Not a secret, not a salt, just a constant. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
};

/**
 * Biggest message we will accept, as a guard rather than a tuning knob.
 *
 * A snapshot of a full FIELD is a few kilobytes; an input packet is tens of
 * bytes. A megabyte means either a bug at the other end or somebody poking at
 * the port, and in both cases the right answer is to hang up rather than
 * allocate whatever the header asked for.
 */
const MAX_MESSAGE = 1 << 20;

/** `Sec-WebSocket-Accept` for a given `Sec-WebSocket-Key`. */
export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/**
 * One end of a WebSocket, wrapping the raw TCP socket.
 *
 * Deliberately not an EventEmitter: three callbacks are all this needs, and
 * assigning them is one fewer thing to get wrong than `.on()` with a typo'd
 * event name that silently never fires.
 */
export class WebSocketConnection {
  /**
   * @param {import('node:net').Socket} socket
   * @param {{id?: string, onMessage?: (data: string|Buffer) => void,
   *          onClose?: (code: number, reason: string) => void}} [opts]
   */
  constructor(socket, opts = {}) {
    this.socket = socket;
    this.id = opts.id ?? randomBytes(6).toString('hex');
    /** @type {((data: string|Buffer) => void)|null} */
    this.onMessage = opts.onMessage ?? null;
    /** @type {((code: number, reason: string) => void)|null} */
    this.onClose = opts.onClose ?? null;
    this.open = true;
    /** Whatever the application wants to hang off this connection. */
    this.meta = {};

    this._buffer = Buffer.alloc(0);
    /** Parts of a fragmented message, and what the first frame said it was. */
    this._fragments = [];
    this._fragmentOp = 0;
    this._closing = false;

    socket.on('data', (chunk) => this._feed(chunk));
    socket.on('close', () => this._finish(1006, 'socket closed'));
    // A reset connection is ordinary -- a browser tab closing does it -- so it
    // must not be an unhandled 'error' event taking the process down.
    socket.on('error', () => this._finish(1006, 'socket error'));
    socket.setNoDelay(true);
  }

  /**
   * Send a message. A string goes as text, a Buffer or view as binary.
   * @param {string|Buffer|ArrayBuffer|ArrayBufferView} data
   */
  send(data) {
    if (!this.open) return false;
    if (typeof data === 'string') {
      return this._writeFrame(OP.text, Buffer.from(data, 'utf8'));
    }
    return this._writeFrame(OP.binary, toBuffer(data));
  }

  /** @param {number} [code] @param {string} [reason] */
  close(code = 1000, reason = '') {
    if (!this.open || this._closing) return;
    this._closing = true;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2, 'utf8');
    this._writeFrame(OP.close, body);
    // Give the close frame a moment to leave, then drop the socket -- a peer
    // that never answers must not hold the connection open for ever.
    this.socket.end();
  }

  // ------------------------------------------------------------------ writing

  _writeFrame(opcode, payload) {
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[1] = length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      // 64-bit length, but the high word is always zero here: MAX_MESSAGE is
      // a megabyte and `writeUInt32BE` at offset 6 covers 4 GiB.
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(length, 6);
    }
    header[0] = 0x80 | opcode; // FIN, no RSV bits
    try {
      this.socket.write(header);
      return this.socket.write(payload);
    } catch {
      this._finish(1006, 'write failed');
      return false;
    }
  }

  // ------------------------------------------------------------------ reading

  _feed(chunk) {
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;
    // Drain every *complete* frame the buffer now holds. One TCP chunk can
    // carry several, and a frame can span chunks, so this is a loop that stops
    // when it cannot make progress rather than a single parse.
    for (;;) {
      const frame = this._readFrame();
      if (!frame) return;
      if (frame === INVALID) {
        this.close(1002, 'protocol error');
        return;
      }
      this._dispatch(frame);
      if (!this.open) return;
    }
  }

  /** @returns {{opcode: number, fin: boolean, payload: Buffer}|null|symbol} */
  _readFrame() {
    const buf = this._buffer;
    if (buf.length < 2) return null;

    const first = buf[0];
    const second = buf[1];
    const fin = (first & 0x80) !== 0;
    if (first & 0x70) return INVALID; // RSV bits set, but we negotiated nothing
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    // "The server MUST close the connection upon receiving a frame that is
    // not masked" -- RFC 6455 section 5.1.
    if (!masked) return INVALID;

    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.length < offset + 2) return null;
      length = buf.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buf.length < offset + 8) return null;
      const high = buf.readUInt32BE(offset);
      const low = buf.readUInt32BE(offset + 4);
      if (high !== 0) return INVALID;
      length = low;
      offset += 8;
    }
    if (length > MAX_MESSAGE) return INVALID;

    // A control frame may not be fragmented and may not exceed 125 bytes.
    if (opcode >= 0x8 && (!fin || length > 125)) return INVALID;

    if (buf.length < offset + 4 + length) return null;
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i++) payload[i] = buf[offset + i] ^ mask[i & 3];
    offset += length;

    this._buffer = buf.subarray(offset);
    return { opcode, fin, payload };
  }

  _dispatch(frame) {
    const { opcode, fin, payload } = frame;

    if (opcode === OP.ping) {
      this._writeFrame(OP.pong, payload);
      return;
    }
    if (opcode === OP.pong) return;
    if (opcode === OP.close) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.toString('utf8', 2) : '';
      if (!this._closing) {
        this._closing = true;
        this._writeFrame(OP.close, payload);
        this.socket.end();
      }
      this._finish(code, reason);
      return;
    }

    if (opcode === OP.continuation) {
      if (!this._fragmentOp) {
        this.close(1002, 'continuation without a start');
        return;
      }
      this._fragments.push(payload);
    } else {
      if (this._fragmentOp) {
        this.close(1002, 'new message before the last one finished');
        return;
      }
      if (!fin) {
        this._fragmentOp = opcode;
        this._fragments = [payload];
        return;
      }
      this._deliver(opcode, payload);
      return;
    }

    if (!fin) return;
    const op = this._fragmentOp;
    const whole = Buffer.concat(this._fragments);
    this._fragmentOp = 0;
    this._fragments = [];
    this._deliver(op, whole);
  }

  _deliver(opcode, payload) {
    if (!this.onMessage) return;
    this.onMessage(opcode === OP.text ? payload.toString('utf8') : payload);
  }

  _finish(code, reason) {
    if (!this.open) return;
    this.open = false;
    this.onClose?.(code, reason);
  }
}

/** Returned by `_readFrame` for "this stream is not a WebSocket any more". */
const INVALID = Symbol('invalid frame');

/**
 * Attach WebSocket upgrade handling to an existing `http.Server`.
 *
 * Sharing the HTTP server is the point: the simulator is served over http and
 * the socket has to come from the same origin and port, or every joiner has to
 * be told two numbers instead of one.
 *
 * @param {import('node:http').Server} server
 * @param {{path?: string, onConnection: (conn: WebSocketConnection,
 *          req: import('node:http').IncomingMessage) => void}} opts
 */
export function attachWebSocket(server, opts) {
  const path = opts.path ?? '/ws';
  server.on('upgrade', (req, socket) => {
    const url = (req.url ?? '').split('?')[0];
    if (url !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    if (typeof key !== 'string' || String(version) !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
        '\r\n',
    );
    opts.onConnection(new WebSocketConnection(socket), req);
  });
  return server;
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new TypeError('send() takes a string, Buffer, ArrayBuffer or view');
}
