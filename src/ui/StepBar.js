/**
 * Pause, and step the world forward a millisecond at a time.
 *
 * ## Why a millisecond
 *
 * Because the interesting events are shorter than a frame. A NECTAR is in
 * contact with the flywheel for about 8 ms; a wheel goes from gripping to
 * sliding in less; the HIVE's first contact with the floor, the thing that
 * decides where the load scatters, is over in a handful of milliseconds.
 * Watching any of those at 60 frames a second shows you the before and the
 * after and nothing in between, and "nothing in between" is where the bugs
 * live.
 *
 * The four sizes are the ones the JVM simulator offers, and they are well
 * chosen: 1 ms is inside a contact, 5 ms is a flywheel's grip on a ball, 20 ms
 * is about a control cycle, 100 ms is a movement. `Cycle` is the fifth, and it
 * is the one for debugging code rather than physics -- it advances exactly one
 * op-mode loop, so an AUTO can be walked a line at a time, and with hub latency
 * on the step length is itself the loop time.
 *
 * ## Why it is a transport bar and not a panel
 *
 * It is always visible, because the moment you want it is the moment something
 * went wrong and you do not want to go looking for a menu. Bottom centre, where
 * a transport control lives in anything else that plays back time.
 *
 * @module
 */

/** The step sizes, in milliseconds. */
export const STEP_SIZES = [1, 5, 20, 100];

export class StepBar {
  /**
   * @param {HTMLElement} viewport
   * @param {import('../app/Simulation.js').Simulation} sim
   */
  constructor(viewport, sim) {
    this.sim = sim;

    this.root = el('div', 'step-bar');
    viewport.append(this.root);

    this.playButton = el('button', 'step-play');
    this.playButton.addEventListener('click', () => this.togglePause());
    this.root.append(this.playButton);

    /** @type {HTMLButtonElement[]} */
    this.stepButtons = [];
    for (const ms of STEP_SIZES) {
      const button = el('button', 'step-jump', `${ms} ms`);
      button.title = `Advance ${ms} ms and freeze`;
      button.addEventListener('click', () => this.step(ms / 1000));
      this.root.append(button);
      this.stepButtons.push(button);
    }

    this.cycleButton = el('button', 'step-jump step-cycle', 'cycle');
    this.cycleButton.title = 'Advance one op-mode loop and freeze (.)';
    this.cycleButton.addEventListener('click', () => {
      this.sim.stepOneCycle();
      this.update();
    });
    this.root.append(this.cycleButton);

    this.readout = el('span', 'step-clock');
    this.root.append(this.readout);

    this.update();
  }

  /** @param {number} seconds */
  step(seconds) {
    this.sim.stepFor(seconds);
    this.update();
    return this;
  }

  togglePause(force) {
    this.sim.pause(force);
    this.update();
    return this;
  }

  update() {
    const sim = this.sim;
    const frozen = sim.frozen;
    this.playButton.textContent = sim.paused ? '▶ Run' : '⏸ Pause';
    this.playButton.title = sim.paused ? 'Let it run (P)' : 'Freeze the world (P)';
    this.playButton.classList.toggle('paused', sim.paused);
    this.root.classList.toggle('frozen', frozen);

    // While a step is being worked through there is a budget left to show,
    // which is the only way to tell a 100 ms step from a stuck one.
    const left = sim.stepRemaining;
    this.readout.textContent =
      left > 0
        ? `${sim.time.toFixed(3)} s  +${(left * 1000).toFixed(1)} ms`
        : `${sim.time.toFixed(3)} s`;
    return this;
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
