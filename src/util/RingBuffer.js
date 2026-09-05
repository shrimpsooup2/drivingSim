/**
 * Fixed-capacity circular buffer of numbers, used by the telemetry graphs.
 * Overwrites the oldest sample when full; never allocates after construction.
 */
export class RingBuffer {
  /** @param {number} capacity */
  constructor(capacity) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.data = new Float64Array(this.capacity);
    this.start = 0;
    this.count = 0;
  }

  clear() {
    this.start = 0;
    this.count = 0;
    this.data.fill(0);
  }

  push(value) {
    const end = (this.start + this.count) % this.capacity;
    this.data[end] = value;
    if (this.count < this.capacity) this.count++;
    else this.start = (this.start + 1) % this.capacity;
  }

  /** @param {number} i 0 = oldest sample */
  get(i) {
    return this.data[(this.start + i) % this.capacity];
  }

  get last() {
    return this.count ? this.get(this.count - 1) : 0;
  }

  /** Min and max over the whole buffer, for autoscaling a plot. */
  extent() {
    if (!this.count) return { min: 0, max: 0 };
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const v = this.get(i);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { min, max };
  }

  *[Symbol.iterator]() {
    for (let i = 0; i < this.count; i++) yield this.get(i);
  }
}
