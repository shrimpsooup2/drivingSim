/**
 * Minimal typed event emitter.
 *
 * Used to decouple the simulation from the UI: the sim emits, panels listen.
 * Future subsystems and game elements can emit their own events without the
 * core needing to know about them.
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
  }

  /**
   * @param {string} event
   * @param {Function} handler
   * @returns {() => void} unsubscribe function
   */
  on(event, handler) {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return () => this.off(event, handler);
  }

  /** Subscribe for a single emission. */
  once(event, handler) {
    const off = this.on(event, (...args) => {
      off();
      handler(...args);
    });
    return off;
  }

  off(event, handler) {
    this.listeners.get(event)?.delete(handler);
  }

  emit(event, ...args) {
    const set = this.listeners.get(event);
    if (!set) return;
    // Copy so a handler may unsubscribe during dispatch.
    for (const handler of [...set]) {
      try {
        handler(...args);
      } catch (err) {
        console.error(`[EventBus] handler for "${event}" threw:`, err);
      }
    }
  }

  clear() {
    this.listeners.clear();
  }
}
