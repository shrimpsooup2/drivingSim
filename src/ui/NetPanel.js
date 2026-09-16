import { NetLink } from '../net/NetLink.js';
import { NetHost, SNAPSHOT_HZ } from '../net/NetHost.js';
import { NetClient } from '../net/NetClient.js';
import { freshCode } from '../net/roomCode.js';

/** Where the last room code and name are kept, so rejoining is one click. */
const STORAGE_KEY = 'ftcsim.net';

/**
 * Host a match for the rest of the room, or join somebody else's.
 *
 * Two buttons and a four-character code, because this gets used by a team
 * standing around a table before a meeting, not by somebody configuring a
 * server. One person runs `npm run lan` and reads out an address and a code;
 * everybody else types them.
 *
 * What it shows while connected is chosen to answer the question people
 * actually ask when multiplayer feels wrong -- "is it me or is it the
 * network?" So: who is seated, whether their input is arriving, how many
 * snapshots have landed, and how much traffic is moving. A stall is then
 * visible rather than something to guess at.
 */
export class NetPanel {
  /**
   * @param {HTMLElement} viewport
   * @param {import('../app/Simulation.js').Simulation} sim
   * @param {{onRoleChange?: (role: string|null) => void}} [opts]
   */
  constructor(viewport, sim, opts = {}) {
    this.sim = sim;
    this.onRoleChange = opts.onRoleChange ?? (() => {});
    const saved = loadSaved();

    this.button = el('button', 'panel-toggle net-toggle');
    this.button.textContent = 'Multiplayer';
    this.button.title = 'Drive against the rest of your team (O)';
    this.button.addEventListener('click', () => this.toggle());
    viewport.append(this.button);

    this.overlay = el('div', 'overlay hidden');
    this.card = el('div', 'overlay-card net-card');
    this.overlay.append(this.card);
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.toggle(false);
    });
    viewport.append(this.overlay);

    const head = el('div', 'net-head');
    head.append(el('h2', '', 'Multiplayer'));
    this.state = el('span', 'net-state');
    head.append(this.state);
    this.card.append(head);

    this.card.append(
      el(
        'p',
        'net-blurb',
        'One machine runs the match and everyone else drives one of the other ' +
          'three robots on it. The host simulates all the physics, so it is the ' +
          'same match for everybody -- a joiner sees its own robot answer the ' +
          'sticks about a frame late, which is roughly what a Control Hub does.',
      ),
    );

    // ----------------------------------------------------------------- hosting
    const hostRow = el('div', 'net-row');
    this.hostButton = button('Host a match', () => this._host());
    hostRow.append(this.hostButton);
    this.card.append(hostRow);
    this.hostInfo = el('div', 'net-share hidden');
    this.card.append(this.hostInfo);

    // ------------------------------------------------------------------ joining
    const joinRow = el('div', 'net-row');
    this.codeInput = el('input', 'net-input net-code');
    this.codeInput.placeholder = 'CODE';
    this.codeInput.maxLength = 12;
    this.codeInput.value = saved.room ?? '';
    this.codeInput.setAttribute('aria-label', 'Room code');
    this.nameInput = el('input', 'net-input net-name');
    this.nameInput.placeholder = 'your name';
    this.nameInput.maxLength = 24;
    this.nameInput.value = saved.name ?? '';
    this.nameInput.setAttribute('aria-label', 'Your name');
    this.joinButton = button('Join', () => this._join());
    joinRow.append(this.codeInput, this.nameInput, this.joinButton);
    this.card.append(joinRow);

    this.codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._join();
    });

    const leaveRow = el('div', 'net-row');
    this.leaveButton = button('Disconnect', () => this._leave());
    this.leaveButton.classList.add('hidden');
    leaveRow.append(this.leaveButton);
    this.card.append(leaveRow);

    this.error = el('div', 'net-error hidden');
    this.card.append(this.error);
    this.readout = el('div', 'net-readout');
    this.card.append(this.readout);
    this.logView = el('pre', 'net-log');
    this.card.append(this.logView);

    /** @type {NetLink|null} */
    this.link = null;
    this.update();
  }

  get open() {
    return !this.overlay.classList.contains('hidden');
  }

  toggle(force) {
    const show = force === undefined ? !this.open : force;
    this.overlay.classList.toggle('hidden', !show);
    this.button.classList.toggle('active', show);
    if (show) this.update();
    return this;
  }

  // ------------------------------------------------------------------ actions

  /**
   * The relay lives on the same origin as the page, so there is one address to
   * share rather than two. A page opened from the filesystem has no relay
   * behind it and says so instead of failing obscurely.
   */
  _socketUrl() {
    const loc = globalThis.location;
    if (!loc || !/^https?:$/.test(loc.protocol)) return null;
    return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
  }

  _host() {
    const url = this._socketUrl();
    if (!url) {
      this._fail('Open the simulator over http first -- run: npm run lan');
      return;
    }
    const room = freshCode();
    this.link = new NetLink({ url, role: 'host', room, name: this.nameInput.value.trim() });
    const host = new NetHost({ link: this.link, sim: this.sim });
    this.sim.net = host;
    this.link.onState = () => this.update();
    this.link.connect();
    save({ room, name: this.nameInput.value.trim() });
    this.onRoleChange('host');
    this.update();
  }

  _join() {
    const url = this._socketUrl();
    if (!url) {
      this._fail('Open the address the host gave you, not a local file.');
      return;
    }
    const room = this.codeInput.value.trim().toUpperCase();
    if (room.length < 3) {
      this._fail('Type the code the host read out.');
      return;
    }
    const name = this.nameInput.value.trim();
    this.link = new NetLink({ url, role: 'join', room, name });
    const client = new NetClient({ link: this.link, sim: this.sim });
    this.sim.net = client;
    this.link.onState = () => this.update();
    this.link.connect();
    save({ room, name });
    this.onRoleChange('client');
    this.update();
  }

  _leave() {
    this.sim.net?.close?.();
    this.sim.net = null;
    this.link = null;
    this.error.classList.add('hidden');
    this.onRoleChange(null);
    this.update();
  }

  _fail(message) {
    this.error.textContent = message;
    this.error.classList.remove('hidden');
  }

  // ------------------------------------------------------------------ painting

  update() {
    const session = this.sim.net;
    const status = session?.status?.() ?? null;

    const connected = Boolean(status && status.state === 'open');
    this.hostButton.classList.toggle('hidden', Boolean(session));
    this.joinButton.classList.toggle('hidden', Boolean(session));
    this.codeInput.classList.toggle('hidden', Boolean(session));
    this.nameInput.classList.toggle('hidden', Boolean(session));
    this.leaveButton.classList.toggle('hidden', !session);

    if (!status) {
      this.state.textContent = 'OFF';
      this.state.dataset.tone = 'idle';
      this.hostInfo.classList.add('hidden');
      this.readout.textContent = '';
      this.logView.textContent = '';
      this.button.classList.remove('live');
      return this;
    }

    this.state.textContent = labelFor(status);
    this.state.dataset.tone = toneFor(status);
    this.button.classList.toggle('live', connected);

    if (status.error) this._fail(status.error);
    else this.error.classList.add('hidden');

    if (status.role === 'host') {
      this.hostInfo.classList.remove('hidden');
      this.hostInfo.textContent = '';
      this.hostInfo.append(el('div', 'net-share-line', 'Everyone else opens this page and joins'));
      this.hostInfo.append(el('div', 'net-code', status.room));
      this.hostInfo.append(el('div', 'net-share-hint', shareHint()));
      this.hostInfo.append(
        el('div', 'net-share-hint', `${SNAPSHOT_HZ} snapshots a second`),
      );
      this.readout.textContent = hostReadout(status);
    } else {
      this.hostInfo.classList.add('hidden');
      this.readout.textContent = clientReadout(status);
    }

    this.logView.textContent = (session.log ?? []).slice(-6).join('\n');
    return this;
  }
}

function labelFor(status) {
  if (status.state === 'connecting') return 'CONNECTING';
  if (status.state === 'error') return 'FAILED';
  if (status.state === 'closed') return 'DISCONNECTED';
  if (status.role === 'host') return `HOSTING ${status.room}`;
  if (status.hostGone) return 'HOST LEFT';
  return status.slot >= 0 ? 'DRIVING' : 'WAITING FOR A ROBOT';
}

function toneFor(status) {
  if (status.state === 'error' || status.hostGone) return 'bad';
  if (status.state === 'open') return 'good';
  return 'idle';
}

function hostReadout(status) {
  const lines = [];
  if (status.seats.length === 0) {
    lines.push('nobody has joined yet');
  } else {
    for (const seat of status.seats) {
      lines.push(
        `${(seat.name || seat.id).padEnd(12)} ${seat.alliance.padEnd(5)} ` +
          `${seat.driving ? 'driving' : 'no input -- AI'}  ${seat.packets} packets`,
      );
    }
  }
  lines.push(`${kb(status.bytesOut)} out / ${kb(status.bytesIn)} in`);
  return lines.join('\n');
}

function clientReadout(status) {
  const lines = [];
  if (status.slot >= 0) lines.push(`${status.label || `slot ${status.slot}`}  (${status.alliance})`);
  if (status.phase) lines.push(`phase ${status.phase}`);
  lines.push(`${status.snapshots} snapshots, ${status.applied} drawn`);
  lines.push(`${kb(status.bytesOut)} out / ${kb(status.bytesIn)} in`);
  return lines.join('\n');
}

/**
 * What to tell everyone else to type.
 *
 * The trap this exists for: `npm run lan` binds every interface, but the host
 * still opens the page on `localhost` -- so `location.host` is `localhost`, and
 * a host reading that off this panel would send their whole team to their own
 * machines. The address to share is the one `npm run lan` printed in the
 * terminal, and this says so rather than confidently showing the wrong thing.
 */
function shareHint() {
  const loc = globalThis.location;
  if (!loc) return 'open the simulator over http first';
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(loc.hostname)) {
    return 'at the http://192.168... address that "npm run lan" printed';
  }
  return `at  ${loc.protocol}//${loc.host}/`;
}

function kb(bytes) {
  if (!bytes) return '0 kB';
  return `${(bytes / 1024).toFixed(0)} kB`;
}

function loadSaved() {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function save(value) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Private browsing. Typing the code again is a small price.
  }
}

function button(label, onClick) {
  const node = el('button', 'auto-button', label);
  node.addEventListener('click', onClick);
  return node;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
