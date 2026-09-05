/**
 * 2D canvas layered over the WebGL view, for text that has to sit at a place in
 * the world: gate numbers, target labels, the distance to the next objective.
 *
 * Drawing text in WebGL means shipping a font atlas and a text shader. Since
 * everything here is short labels anchored to projected world points, a 2D
 * canvas on top is simpler, sharper, and costs nothing.
 */
export class Overlay2d {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ratio = 1;
    this.width = 1;
    this.height = 1;
  }

  /** Match the backing store to the CSS size and clear for a new frame. */
  begin() {
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(this.canvas.clientWidth));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight));
    if (
      this.canvas.width !== Math.floor(width * ratio) ||
      this.canvas.height !== Math.floor(height * ratio)
    ) {
      this.canvas.width = Math.floor(width * ratio);
      this.canvas.height = Math.floor(height * ratio);
    }
    this.ratio = ratio;
    this.width = width;
    this.height = height;
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
  }

  /**
   * Draw a pill-shaped label at a projected point.
   * @param {{x:number,y:number,visible:boolean}} projected normalised 0..1
   * @param {string} text
   * @param {{color?:string, background?:string, size?:number, offsetY?:number, bold?:boolean}} [style]
   */
  label(projected, text, style = {}) {
    const ctx = this.ctx;
    if (!ctx || !projected.visible || !text) return;

    const size = style.size ?? 12;
    const x = projected.x * this.width;
    const y = projected.y * this.height + (style.offsetY ?? 0);

    ctx.font = `${style.bold ? '600 ' : ''}${size}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const padX = 6;
    const padY = 3;
    const textWidth = ctx.measureText(text).width;
    const boxWidth = textWidth + padX * 2;
    const boxHeight = size + padY * 2;

    ctx.fillStyle = style.background ?? 'rgba(10, 13, 17, 0.78)';
    roundedRect(ctx, x - boxWidth / 2, y - boxHeight / 2, boxWidth, boxHeight, 4);
    ctx.fill();

    ctx.fillStyle = style.color ?? '#e6eaf0';
    ctx.fillText(text, x, y + 0.5);
  }

  /** A small filled marker, used for objectives that are off screen. */
  edgeArrow(projected, color) {
    const ctx = this.ctx;
    if (!ctx) return;
    // Clamp the point to the viewport edge and point at it.
    const margin = 26;
    const x = Math.min(Math.max(projected.x * this.width, margin), this.width - margin);
    const y = Math.min(Math.max(projected.y * this.height, margin), this.height - margin);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function roundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
