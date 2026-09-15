/**
 * The MATCH panel: clock, phase, live score and the shooter readout.
 *
 * Built to answer the questions a driver actually has mid-MATCH, in the order
 * they matter: how long is left, is the shooter ready, am I ahead, and what is
 * still on the table. The score is split into its components because the
 * endgame turns on which components can still be taken -- a FLOWER can change
 * hands with one NECTAR and a CELL empties the moment it tips.
 */
export class MatchPanel {
  /** @param {HTMLElement} parent */
  constructor(parent) {
    this.element = el('div', 'match-panel hidden');

    this.clock = el('div', 'match-clock');
    this.phase = el('div', 'match-phase');
    this.element.append(this.clock, this.phase);

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

    this.notes = el('div', 'match-notes');
    this.element.append(this.notes);

    parent.append(this.element);
  }

  setVisible(visible) {
    this.element.classList.toggle('hidden', !visible);
  }

  /** @param {import('../app/BiobuzzGame.js').BiobuzzGame|null} game */
  update(game) {
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
    this.shooterText.textContent = s.ready
      ? `SHOOTER READY  ${Math.round(s.rpm)} rpm`
      : `spinning up  ${Math.round(s.rpm)} / ${Math.round(s.target)} rpm`;
    this.shooterText.classList.toggle('ready', s.ready);
    this.shooterBar.style.width = `${(s.recovery * 100).toFixed(1)}%`;
    this.shooterBar.style.background = s.ready ? '#47d18a' : '#f2a33c';

    // Say what to press next. "How do I shoot" should never need the manual.
    const step = nextStep(t);
    this.prompt.textContent = step.text;
    this.prompt.classList.toggle('urgent', step.urgent);

    const notes = [];
    notes.push(`held ${t.held}/${t.capacity}`);
    notes.push(`hood ${s.hoodDegrees.toFixed(0)} deg`);
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
 * The next thing a driver should press, from the state of their own robot.
 *
 * The controls exist in the help overlay, but a driver mid-match is not reading
 * an overlay -- so the panel says which one is useful right now.
 *
 * @param {ReturnType<import('../app/BiobuzzGame.js').BiobuzzGame['telemetry']>} t
 */
function nextStep(t) {
  if (t.phase === 'ended') return { text: 'MATCH OVER', urgent: false };
  if (t.held === 0) return { text: 'RIGHT BUMPER  hold to intake', urgent: false };
  if (!t.shooter.spinning) return { text: 'Y  spin the flywheel up', urgent: false };
  if (!t.solution) {
    return { text: 'no shot from here  -  back away from the HIVE', urgent: true };
  }
  if (!t.shooter.ready) return { text: 'wait for the wheel...', urgent: true };
  if (t.moving) return { text: 'stop moving, then fire', urgent: true };
  return { text: 'RIGHT TRIGGER  fire', urgent: false };
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
