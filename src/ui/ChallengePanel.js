import { fmt, fmtClock } from '../util/units.js';
import { TIER_LABELS } from '../challenges/library.js';
import { PROFILE_BY_ID, SKILL_BY_ID } from '../ai/profiles.js';

/**
 * Drill picker and in-run heads-up display.
 *
 * The picker is a modal list; the HUD is a compact strip at the top of the
 * screen while a drill runs. The HUD deliberately shows the *next* objective
 * and the running clock and little else -- a driver mid-run cannot read a
 * dashboard, and anything more just competes with the field for attention.
 */
export class ChallengePanel {
  /**
   * @param {HTMLElement} viewport
   * @param {import('../challenges/ChallengeRunner.js').ChallengeRunner} runner
   */
  constructor(viewport, runner) {
    this.viewport = viewport;
    this.runner = runner;

    this.button = el('button', 'panel-toggle drills-toggle');
    this.button.textContent = 'Drills';
    this.button.addEventListener('click', () => this.toggle());
    viewport.append(this.button);

    this.overlay = el('div', 'overlay hidden');
    this.card = el('div', 'overlay-card drill-picker');
    this.overlay.append(this.card);
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.toggle(false);
    });
    viewport.append(this.overlay);

    this.hud = el('div', 'drill-hud hidden');
    viewport.append(this.hud);

    this.toast = el('div', 'drill-toast hidden');
    viewport.append(this.toast);
    this._toastTimer = 0;

    runner.on('select', () => {
      this._renderPicker();
      this._updateHudVisibility();
    });
    runner.on('complete', (challenge, info) => this._showResult(challenge, info));

    this._buildHud();
    this._renderPicker();
  }

  toggle(force) {
    const show = force === undefined ? this.overlay.classList.contains('hidden') : force;
    if (show) this._renderPicker();
    this.overlay.classList.toggle('hidden', !show);
  }

  _renderPicker() {
    this.card.innerHTML = '';
    const heading = el('h2');
    heading.textContent = 'Driving drills';
    this.card.append(heading);

    const blurb = el('p');
    blurb.textContent =
      'Timed courses that train the skills every game needs: judging distance from the driver station, stopping where you meant to, and keeping the wheels hooked up. The clock starts when the robot first moves. Hitting a wall adds time.';
    this.card.append(blurb);

    // Grouped by tier, so the progression is visible rather than implied by
    // list order.
    for (const tier of ['basic', 'intermediate', 'advanced']) {
      const inTier = this.runner.available().filter((c) => c.tier === tier);
      if (inTier.length === 0) continue;
      const heading = el('h3');
      heading.textContent = TIER_LABELS[tier];
      this.card.append(heading);
      const list = el('div', 'drill-list');
      for (const challenge of inTier) list.append(this._drillCard(challenge));
      this.card.append(list);
    }

    const footer = el('div', 'drill-footer');
    const free = button('Free driving', () => {
      this.runner.clear();
      this.toggle(false);
    });
    const clearRecords = button('Clear best times', () => {
      if (globalThis.confirm?.('Clear every recorded best time?')) {
        this.runner.clearRecords();
        this._renderPicker();
      }
    });
    footer.append(free, clearRecords);
    this.card.append(footer);

    if (this.runner.challenges.length !== this.runner.available().length) {
      const note = el('p', 'drill-note');
      note.textContent =
        'Some drills need a drivetrain that can strafe, so they are hidden for tank.';
      this.card.append(note);
    }
  }

  _drillCard(challenge) {
    const card = el('div', 'drill-card');
    if (this.runner.active?.id === challenge.id) card.classList.add('active');

    const head = el('div', 'drill-card-head');
    const name = el('strong');
    name.textContent = challenge.name;
    head.append(name);

    const best = this.runner.bestFor(challenge.id);
    const bestEl = el('span', 'drill-best');
    if (best) {
      const grade = best.grade ?? challenge.grade(best.score);
      bestEl.textContent = challenge.higherIsBetter
        ? `best ${Math.round(best.score)}`
        : `best ${fmt(best.score, 2)}s`;
      if (grade) {
        const medal = el('span', `medal ${grade}`);
        medal.textContent = grade;
        head.append(bestEl, medal);
      } else {
        head.append(bestEl);
      }
    } else {
      bestEl.textContent = 'no time yet';
      head.append(bestEl);
    }
    card.append(head);

    const description = el('p');
    description.textContent = challenge.description;
    card.append(description);

    // What this drill throws at you, at a glance.
    const tags = el('div', 'drill-tags');
    if (challenge.scoreMode === 'count') {
      tags.append(tag(`${fmtClock(challenge.duration)} window — most cycles wins`, 'mode'));
    } else if (challenge.par) {
      tags.append(tag(`par ${challenge.par.gold} / ${challenge.par.silver} / ${challenge.par.bronze}s`, 'par'));
    }
    if (challenge.obstacles.length > 0) tags.append(tag(`${challenge.obstacles.length} solid obstacles`, 'hazard'));
    for (const spec of challenge.opponents) {
      const profile = PROFILE_BY_ID[spec.profileId];
      const skill = SKILL_BY_ID[spec.skillId];
      tags.append(tag(`${skill?.name ?? spec.skillId} ${profile?.name ?? spec.profileId}`, 'ai'));
    }
    if (challenge.holonomicOnly) tags.append(tag('needs strafing', 'mode'));
    if (tags.childElementCount > 0) card.append(tags);

    const start = button(this.runner.active?.id === challenge.id ? 'Restart' : 'Start', () => {
      this.runner.select(challenge.id);
      this.toggle(false);
    });
    start.className = 'primary';
    card.append(start);
    return card;
  }

  _buildHud() {
    this.hudName = el('span', 'drill-hud-name');
    this.hudObjective = el('span', 'drill-hud-objective');
    this.hudClock = el('span', 'drill-hud-clock');
    this.hudProgress = el('span', 'drill-hud-progress');
    this.hudMessage = el('span', 'drill-hud-message');

    const left = el('div', 'drill-hud-left');
    left.append(this.hudName, this.hudObjective);
    const right = el('div', 'drill-hud-right');
    right.append(this.hudProgress, this.hudClock);

    const top = el('div', 'drill-hud-row');
    top.append(left, right);
    this.hud.append(top, this.hudMessage);
  }

  _updateHudVisibility() {
    this.hud.classList.toggle('hidden', !this.runner.active);
    this.button.classList.toggle('on', Boolean(this.runner.active));
  }

  /** Called every frame while a drill is loaded. */
  update() {
    const challenge = this.runner.active;
    this._updateHudVisibility();
    if (!challenge) return;

    const h = challenge.hud();
    this.hudName.textContent = h.name;

    if (h.scoreMode === 'count') {
      // Against a match clock, what matters is time left and cycles banked.
      this.hudProgress.textContent = `${h.completions} done`;
      this.hudClock.textContent = fmtClock(h.remaining);
      this.hudClock.className = `drill-hud-clock${h.remaining < 20 ? ' warn' : ''}`;
    } else {
      this.hudProgress.textContent = `${Math.min(h.index + 1, h.total)} / ${h.total}`;
      this.hudClock.textContent = `${fmt(h.score, 2)}s`;
      this.hudClock.className = `drill-hud-clock${h.penalties > 0 ? ' warn' : ''}`;
    }

    if (h.state === 'ready') {
      this.hudObjective.textContent = 'Drive to start the clock';
      this.hudMessage.textContent = h.tip;
      this.hudMessage.className = 'drill-hud-message tip';
    } else if (h.state === 'complete') {
      this.hudObjective.textContent = 'Complete';
      this.hudMessage.textContent = '';
    } else {
      this.hudObjective.textContent = h.objectiveLabel ? `Next: ${h.objectiveLabel}` : '';
      this.hudMessage.textContent = h.message || h.tip;
      this.hudMessage.className = `drill-hud-message${h.message ? ' alert' : ' tip'}`;
    }
  }

  _showResult(challenge, info) {
    const grade = challenge.grade();
    const parts = [challenge.name];

    if (challenge.higherIsBetter) {
      parts.push(`${challenge.completions} objectives`);
    } else {
      parts.push(`${fmt(challenge.score, 2)}s`);
      if (challenge.penaltySeconds > 0) {
        parts.push(`(${fmt(challenge.elapsed, 2)} + ${fmt(challenge.penaltySeconds, 1)} penalties)`);
      }
    }
    if (grade) parts.push(grade.toUpperCase());
    if (info.isRecord) {
      parts.push(
        info.previousBest === null
          ? 'first result'
          : `beat ${challenge.higherIsBetter ? Math.round(info.previousBest) : fmt(info.previousBest, 2) + 's'}`,
      );
    }

    this.toast.textContent = parts.join('   ');
    this.toast.className = `drill-toast${info.isRecord ? ' record' : ''}${grade ? ' ' + grade : ''}`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.toast.classList.add('hidden'), 7000);
  }
}

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function tag(text, kind) {
  const node = el('span', `drill-tag ${kind}`);
  node.textContent = text;
  return node;
}

function button(label, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
