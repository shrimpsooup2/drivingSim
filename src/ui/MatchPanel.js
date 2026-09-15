import { keyFor } from '../input/KeyboardSource.js';

/**
 * The MATCH panel: clock, phase, live score and the shooter readout.
 *
 * Built to answer the questions a driver actually has mid-MATCH, in the order
 * they matter: how long is left, is the shooter ready, am I ahead, and what is
 * still on the table. The score is split into its components because the
 * endgame turns on which components can still be taken -- a FLOWER can change
 * hands with one NECTAR and a CELL empties the moment it tips.
 *
 * It lives down the right-hand side rather than across the top. A driver looks
 * at the middle of the field and at their own ROBOT, and a block across the top
 * centre sat exactly where the far HIVE is drawn -- so the thing you aim at was
 * behind the thing telling you to aim. The breakdown collapses, because the
 * component split matters in the last thirty seconds and not before.
 */
export class MatchPanel {
  /** @param {HTMLElement} parent */
  constructor(parent) {
    this.element = el('div', 'match-panel hidden');

    this.clock = el('div', 'match-clock');
    this.phase = el('div', 'match-phase');
    this.element.append(this.clock, this.phase);

    /** Collapsed hides the breakdown table, which is the tall part. */
    this.collapsed = false;
    this.clock.addEventListener('click', () => this.setCollapsed(!this.collapsed));
    this.clock.title = 'Click to show or hide the score breakdown';

    this.scoreRow = el('div', 'match-score');
    this.redTotal = el('div', 'match-total red');
    this.blueTotal = el('div', 'match-total blue');
    this.scoreRow.append(this.redTotal, this.blueTotal);
    this.element.append(this.scoreRow);

    this.breakdown = el('table', 'match-breakdown');
    /** @type {Record<string, {red: HTMLElement, blue: HTMLElement}>} */
    this.cells = {};
    const head = this.breakdown.insertRow();
    head.append(el('th', '', ''), el('th', 'red', 'RED'), el('th', 'blue', 'BLUE'));
    for (const [key, label] of BREAKDOWN) {
      const row = this.breakdown.insertRow();
      row.append(el('td', 'label', label));
      const red = el('td', 'num');
      const blue = el('td', 'num');
      row.append(red, blue);
      this.cells[key] = { red, blue };
    }
    this.element.append(this.breakdown);

    this.shooter = el('div', 'match-shooter');
    this.shooterText = el('div', 'match-shooter-text');
    this.shooterBarOuter = el('div', 'bar');
    this.shooterBar = document.createElement('div');
    this.shooterBarOuter.append(this.shooterBar);
    this.shooter.append(this.shooterText, this.shooterBarOuter);
    this.element.append(this.shooter);

    this.prompt = el('div', 'match-prompt');
    this.element.append(this.prompt);

    /** The other three ROBOTS: what they are and whose side they are on. */
    this.lineup = el('div', 'match-lineup');
    this.element.append(this.lineup);
    this._lineupKey = '';

    this.notes = el('div', 'match-notes');
    this.element.append(this.notes);

    parent.append(this.element);
  }

  setVisible(visible) {
    this.element.classList.toggle('hidden', !visible);
  }

  setCollapsed(collapsed) {
    this.collapsed = collapsed;
    this.breakdown.classList.toggle('hidden', collapsed);
    return this;
  }

  /**
   * @param {import('../app/BiobuzzGame.js').BiobuzzGame|null} game
   * @param {'gamepad'|'keyboard'|'none'} [source] which input the driver is on,
   *   so the prompt names a button they actually have
   */
  update(game, source = 'gamepad') {
    this.setVisible(Boolean(game));
    if (!game) return;

    const t = game.telemetry();
    const score = t.score;

    const shown = t.phase === 'teleop' ? t.teleopRemaining : t.phaseRemaining;
    this.clock.textContent = clockText(shown);
    this.clock.classList.toggle('urgent', t.phase === 'teleop' && t.teleopRemaining <= 30);
    this.phase.textContent = PHASE_LABEL[t.phase] ?? t.phase;

    this.redTotal.textContent = String(score.red.total);
    this.blueTotal.textContent = String(score.blue.total);
    this.redTotal.classList.toggle('leading', score.red.total > score.blue.total);
    this.blueTotal.classList.toggle('leading', score.blue.total > score.red.total);

    for (const [key] of BREAKDOWN) {
      this.cells[key].red.textContent = String(score.red[key] ?? 0);
      this.cells[key].blue.textContent = String(score.blue[key] ?? 0);
    }

    const s = t.shooter;
    const solution = t.solution;
    // A thrower has no RPM to report; what it has is a reset to wait out.
    this.shooterText.textContent = t.needsSpinUp === false
      ? s.ready
        ? `${(t.launchSystem ?? 'thrower').toUpperCase()} LOADED`
        : `winding  ${Math.round(s.recovery * 100)}%`
      : s.ready
        ? `SHOOTER READY  ${Math.round(s.rpm)} rpm`
        : `spinning up  ${Math.round(s.rpm)} / ${Math.round(s.target)} rpm`;
    this.shooterText.classList.toggle('ready', s.ready);
    this.shooterBar.style.width = `${(s.recovery * 100).toFixed(1)}%`;
    this.shooterBar.style.background = s.ready ? '#47d18a' : '#f2a33c';

    // Say what to press next. "How do I shoot" should never need the manual.
    const step = nextStep(t, source);
    this.prompt.textContent = step.text;
    this.prompt.classList.toggle('urgent', step.urgent);

    // Rebuilt only when the line-up actually changes, which is at the start of
    // a MATCH -- not sixty times a second.
    const key = t.lineup.map((r) => `${r.slot}:${r.name}:${r.quality}:${r.skill}`).join('|');
    if (key !== this._lineupKey) {
      this._lineupKey = key;
      this.lineup.innerHTML = '';
      for (const robot of t.lineup) {
        const row = el('div', `match-robot ${robot.ally ? 'ally' : 'foe'}`);
        row.append(el('span', 'match-robot-name', robot.name));
        const detail = [robot.quality, robot.skill].filter(Boolean).join(', ');
        if (detail) row.append(el('span', 'match-robot-detail', detail));
        row.title = [robot.ally ? 'Your partner' : 'Opponent', robot.system]
          .filter(Boolean)
          .join(' - ');
        this.lineup.append(row);
      }
    }

    const notes = [];
    notes.push(`held ${t.held}/${t.capacity}`);
    notes.push(`${t.needsSpinUp === false ? 'release' : 'hood'} ${s.hoodDegrees.toFixed(0)} deg`);
    if (solution) {
      notes.push(`shot: ${solution.rpm.toFixed(0)} rpm at ${((solution.angle * 180) / Math.PI).toFixed(0)} deg`);
    } else {
      // Being too close is the usual reason, and it is not obvious from the
      // field -- the CELL is 50 in up, so inside about 0.9 m no hood angle
      // reaches it on a descending arc.
      notes.push('no shot from here');
    }
    notes.push(t.flowerUnlocked ? 'FLOWERS OPEN' : 'flowers locked');
    if (t.nectarAvailable > 0) notes.push(`${t.nectarAvailable} NECTAR to enter`);
    const early = score[game.alliance].earlyFlowerNectar;
    if (early > 0) notes.push(`G410 x${early}`);
    this.notes.textContent = notes.join('  -  ');
  }
}

/**
 * What a gamepad control is called, for whichever thing the driver is holding.
 *
 * Telling someone on the keyboard to press RIGHT BUMPER names a button they do
 * not have, which is the same failure as not saying how to shoot at all.
 *
 * @param {string} control a gamepad field name, e.g. 'right_bumper'
 * @param {'gamepad'|'keyboard'|'none'} source
 */
function controlLabel(control, source) {
  if (source === 'keyboard') {
    const key = keyFor(control);
    if (key) return key.toUpperCase();
  }
  return PAD_LABEL[control] ?? control.replace(/_/g, ' ').toUpperCase();
}

const PAD_LABEL = {
  y: 'Y',
  right_bumper: 'RIGHT BUMPER',
  left_bumper: 'LEFT BUMPER',
  right_trigger: 'RIGHT TRIGGER',
};

/**
 * The next thing a driver should press, from the state of their own robot.
 *
 * The controls exist in the help overlay, but a driver mid-match is not reading
 * an overlay -- so the panel says which one is useful right now.
 *
 * @param {ReturnType<import('../app/BiobuzzGame.js').BiobuzzGame['telemetry']>} t
 * @param {'gamepad'|'keyboard'|'none'} [source]
 */
export function nextStep(t, source = 'gamepad') {
  const name = (control) => controlLabel(control, source);
  if (t.phase === 'ended') return { text: 'MATCH OVER', urgent: false };
  if (t.held === 0) return { text: `${name('right_bumper')}  hold to intake`, urgent: false };
  // A catapult has nothing to spin up, so telling anyone to spin it would be
  // worse than saying nothing: they would go looking for a control that has no
  // effect on their robot.
  if (t.needsSpinUp !== false && !t.shooter.spinning) {
    return { text: `${name('y')}  spin the flywheel up`, urgent: false };
  }
  if (!t.solution) {
    return { text: 'no shot from here  -  back away from the HIVE', urgent: true };
  }
  if (!t.shooter.ready) return { text: 'wait for the wheel...', urgent: true };
  if (t.moving) return { text: 'stop moving, then fire', urgent: true };
  return { text: `${name('right_trigger')}  fire`, urgent: false };
}

/** Rows of the score breakdown, in the order Table 10-2 lists them. */
const BREAKDOWN = [
  ['leave', 'LEAVE'],
  ['parkAuto', 'PARK (auto)'],
  ['parkTeleop', 'PARK (teleop)'],
  ['tips', 'TIPS'],
  ['tipPoints', 'TIP points'],
  ['cell', 'in CELL'],
  ['flower', 'owned FLOWER'],
  ['bottomNectar', 'bottom NECTAR'],
  ['garden', 'GARDEN'],
];

const PHASE_LABEL = {
  setup: 'PRE-MATCH SETUP',
  auto: 'AUTONOMOUS',
  transition: 'TRANSITION',
  teleop: 'DRIVER CONTROLLED',
  ended: 'MATCH OVER',
};

function clockText(seconds) {
  const s = Math.max(0, seconds);
  const mm = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
