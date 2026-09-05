import { RingBuffer } from '../util/RingBuffer.js';

/**
 * Strip chart for a single telemetry signal.
 *
 * Autoscales to what it has seen recently rather than to a fixed range, so a
 * trace stays readable whether the robot is creeping or flat out. Drawn with
 * canvas 2D; there is no reason to route a few hundred points through WebGL.
 */
export class Graph {
  /**
   * @param {{label:string, unit?:string, capacity?:number, width?:number,
   *          height?:number, color?:string, min?:number, max?:number,
   *          zeroLine?:boolean, format?:(v:number)=>string}} opts
   */
  constructor(opts) {
    this.label = opts.label;
    this.unit = opts.unit ?? '';
    this.color = opts.color ?? '#2b9bd8';
    this.fixedMin = opts.min;
    this.fixedMax = opts.max;
    this.zeroLine = opts.zeroLine ?? false;
    this.format = opts.format ?? ((v) => v.toFixed(2));
    this.buffer = new RingBuffer(opts.capacity ?? 240);

    this.element = document.createElement('div');
    this.element.className = 'graph-card';

    this.labelEl = document.createElement('div');
    this.labelEl.className = 'graph-label';
    this.nameEl = document.createElement('span');
    this.nameEl.textContent = this.unit ? `${this.label} (${this.unit})` : this.label;
    this.valueEl = document.createElement('span');
    this.labelEl.append(this.nameEl, this.valueEl);

    this.canvas = document.createElement('canvas');
    this.cssWidth = opts.width ?? 230;
    this.cssHeight = opts.height ?? 46;
    this.canvas.style.width = `${this.cssWidth}px`;
    this.canvas.style.height = `${this.cssHeight}px`;

    this.element.append(this.labelEl, this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this._ratio = 0;
  }

  push(value) {
    if (Number.isFinite(value)) this.buffer.push(value);
  }

  draw() {
    const ctx = this.ctx;
    if (!ctx) return;

    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    if (ratio !== this._ratio) {
      this._ratio = ratio;
      this.canvas.width = Math.floor(this.cssWidth * ratio);
      this.canvas.height = Math.floor(this.cssHeight * ratio);
    }
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const n = this.buffer.count;
    if (n < 2) return;

    let { min, max } = this.buffer.extent();
    if (this.fixedMin !== undefined) min = this.fixedMin;
    if (this.fixedMax !== undefined) max = this.fixedMax;
    if (this.zeroLine) {
      min = Math.min(min, 0);
      max = Math.max(max, 0);
    }
    // Keep a flat trace from filling the whole card with noise.
    if (max - min < 1e-6) {
      max += 0.5;
      min -= 0.5;
    }
    const pad = (max - min) * 0.1;
    min -= pad;
    max += pad;

    const toY = (v) => h - ((v - min) / (max - min)) * h;

    if (this.zeroLine && min < 0 && max > 0) {
      ctx.strokeStyle = 'rgba(140,155,175,0.28)';
      ctx.lineWidth = 1 * this._ratio;
      ctx.beginPath();
      ctx.moveTo(0, toY(0));
      ctx.lineTo(w, toY(0));
      ctx.stroke();
    }

    ctx.strokeStyle = this.color;
    ctx.lineWidth = 1.6 * this._ratio;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = toY(this.buffer.get(i));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Soft fill under the trace so several stacked graphs stay distinguishable.
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = this.color.replace(')', ', 0.13)').replace('rgb', 'rgba');
    ctx.fillStyle = hexToRgba(this.color, 0.13);
    ctx.fill();

    this.valueEl.textContent = this.format(this.buffer.last);
  }

  clear() {
    this.buffer.clear();
  }
}

function hexToRgba(hex, alpha) {
  if (!hex.startsWith('#')) return `rgba(43,155,216,${alpha})`;
  const v = hex.slice(1);
  const full = v.length === 3 ? v.split('').map((c) => c + c).join('') : v;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
