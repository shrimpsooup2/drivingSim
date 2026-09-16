/**
 * The buzzer screen: who won, by what, and what the ALLIANCE earned.
 *
 * A match ending used to be nothing but the clock reaching zero and the robots
 * going limp. The score was on the side panel the whole time, so there was no
 * moment where the result *landed* -- and a practice session is a sequence of
 * results, which is the thing you are trying to improve.
 *
 * ## Two lifetimes, because there are two ways to practise
 *
 * Driving one match at a time, the screen waits: you read it, you think about
 * it, you dismiss it. Driving a loop -- `match.autoRestart`, which puts the
 * field back and starts again a few seconds after the buzzer -- it cannot
 * wait, because waiting for a click is exactly the interruption that setting
 * exists to remove. So there it shows for the length of the restart delay and
 * gets out of the way on its own.
 *
 * Both lifetimes are driven off `game.endedFor`, the same simulated clock the
 * auto-restart is timed from, rather than a `setTimeout`. A wall-clock timer
 * would drift out of step whenever the simulation was paused or slowed, and
 * the screen would still be up when the next match had already started.
 *
 * @module
 */

/** What the screen reports, in the order it reports it. */
const BREAKDOWN = [
  ['leave', 'LEAVE'],
  ['parkAuto', 'PARK (auto)'],
  ['parkTeleop', 'PARK'],
  ['tipPoints', 'HIVE TIPS'],
  ['cell', 'IN CELL'],
  ['flower', 'FLOWERS'],
  ['bottomNectar', 'BOTTOM NECTAR'],
  ['garden', 'GARDEN'],
  ['penalty', 'PENALTY'],
];

export class MatchOverPanel {
  /**
   * @param {HTMLElement} viewport
   * @param {{onRestart?: () => void}} [opts]
   */
  constructor(viewport, opts = {}) {
    this.onRestart = opts.onRestart ?? (() => {});

    this.overlay = el('div', 'overlay match-over hidden');
    this.card = el('div', 'overlay-card match-over-card');
    this.overlay.append(this.card);
    viewport.append(this.overlay);

    this.headline = el('div', 'match-over-headline');
    this.card.append(this.headline);

    this.scoreLine = el('div', 'match-over-score');
    this.redScore = el('span', 'match-over-red');
    this.dash = el('span', 'match-over-dash', '–');
    this.blueScore = el('span', 'match-over-blue');
    this.scoreLine.append(this.redScore, this.dash, this.blueScore);
    this.card.append(this.scoreLine);

    this.table = el('table', 'match-over-table');
    this.card.append(this.table);

    this.rp = el('div', 'match-over-rp');
    this.card.append(this.rp);

    this.actions = el('div', 'match-over-actions');
    this.continueButton = button('Continue', () => this.dismiss());
    this.restartButton = button('Restart match', () => {
      this.dismiss();
      this.onRestart();
    });
    this.actions.append(this.continueButton, this.restartButton);
    this.card.append(this.actions);

    this.countdown = el('div', 'match-over-countdown');
    this.card.append(this.countdown);

    // Dismissable by clicking anywhere off the card, or with Escape, because a
    // screen that can only be dismissed by finding one small button is a
    // screen that gets in the way.
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.dismiss();
    });

    /** The match this screen has already been dismissed for. */
    this._dismissed = -1;
    this._shownFor = -1;
  }

  get open() {
    return !this.overlay.classList.contains('hidden');
  }

  dismiss() {
    this.overlay.classList.add('hidden');
    this._dismissed = this._shownFor;
    return this;
  }

  /**
   * @param {import('../app/BiobuzzGame.js').BiobuzzGame|null} game
   */
  update(game) {
    const over = Boolean(game) && game.match.phase === 'ended';
    if (!over) {
      // A new match clears the dismissal, so the next buzzer shows again.
      if (this.open) this.overlay.classList.add('hidden');
      this._dismissed = -1;
      return this;
    }

    const matchNumber = game.matchNumber ?? 0;
    this._shownFor = matchNumber;
    if (this._dismissed === matchNumber) return this;

    // In a loop, the screen's life is the restart delay -- and the restart
    // hides it anyway by taking the match out of 'ended', so this only has to
    // stop it lingering on the last frame before that happens.
    const looping = Boolean(game.settings?.autoRestart);
    if (looping && game.endedFor >= game.restartDelay) {
      this.overlay.classList.add('hidden');
      return this;
    }

    this._paint(game, looping);
    this.overlay.classList.remove('hidden');
    return this;
  }

  _paint(game, looping) {
    const score = game.match.score();
    const mine = game.alliance;
    const theirs = mine === 'red' ? 'blue' : 'red';
    const winner = score.winner;

    this.headline.textContent =
      winner === null || winner === 'tie'
        ? 'TIE'
        : winner === mine
          ? 'YOU WIN'
          : 'YOU LOSE';
    this.headline.dataset.result =
      winner === 'tie' || winner === null ? 'tie' : winner === mine ? 'win' : 'loss';

    this.redScore.textContent = String(score.red.total);
    this.blueScore.textContent = String(score.blue.total);

    // Rebuilt rather than patched: it is drawn once per match, not per frame,
    // so there is nothing to gain from keeping cell references around.
    this.table.textContent = '';
    const head = el('tr');
    head.append(el('th', '', ''), el('th', 'match-over-red', 'RED'), el('th', 'match-over-blue', 'BLUE'));
    this.table.append(head);
    for (const [key, label] of BREAKDOWN) {
      const red = score.red[key] ?? 0;
      const blue = score.blue[key] ?? 0;
      // Skip what neither side scored, so the table is the match that happened
      // rather than a form with zeroes in it.
      if (!red && !blue) continue;
      const row = el('tr');
      row.append(el('td', 'label', label), el('td', '', String(red)), el('td', '', String(blue)));
      this.table.append(row);
    }

    const rp = score[mine]?.rp;
    if (rp) {
      const parts = [`${rp.total} RP`];
      if (rp.result) parts.push(rp.result === 3 ? 'win' : 'tie');
      if (rp.swarm) parts.push('SWARM');
      if (rp.pollinator2) parts.push('POLLINATOR 2');
      else if (rp.pollinator1) parts.push('POLLINATOR 1');
      this.rp.textContent = parts.join('  ·  ');
    } else {
      this.rp.textContent = '';
    }

    this.actions.classList.toggle('hidden', looping);
    if (looping) {
      const left = Math.max(0, game.restartDelay - game.endedFor);
      this.countdown.textContent = `next match in ${left.toFixed(1)} s`;
    } else {
      this.countdown.textContent = '';
    }
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
