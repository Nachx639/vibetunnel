/**
 * The row just above what ghostty-web's canvas shows. A touch scroll moves the canvas down by a
 * fraction of a row between whole rows (terminal-touch-scroll.ts), which uncovers a strip at its
 * top the canvas has no pixels for: this draws that row there, so the text runs on without a
 * gap. It mirrors ghostty-web 0.4's CanvasRenderer.renderLine for one row, without selection
 * or link hover (a selection or a hover makes ghostty repaint the whole canvas instead).
 */
import type { GhosttyCell } from 'ghostty-web';

// ghostty-web's CellFlags (not imported: unit tests mock the module without it).
const BOLD = 1;
const ITALIC = 2;
const UNDERLINE = 4;
const STRIKETHROUGH = 8;
const INVERSE = 16;
const INVISIBLE = 32;
const FAINT = 128;

export interface CellMetrics {
  width: number;
  height: number;
  baseline: number;
}

export interface RowFont {
  size: number;
  family: string;
}

const rgb = (r: number, g: number, b: number) => `rgb(${r}, ${g}, ${b})`;

/**
 * Paints one row of cells at the top of `ctx`, as ghostty-web paints a row of its canvas.
 * `grapheme(col)` gives the whole cluster of a cell made of several code points (emoji with
 * ZWJ, combining marks); without it such a cell shows its first code point.
 */
export function paintCellRow(
  ctx: CanvasRenderingContext2D,
  cells: readonly GhosttyCell[],
  cols: number,
  metrics: CellMetrics,
  font: RowFont,
  background: string,
  grapheme?: (col: number) => string
): void {
  const { width, height, baseline } = metrics;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, cols * width, height);
  // Backgrounds first: a glyph may reach into the cell to its left.
  cells.forEach((cell, col) => {
    if (cell.width === 0) return;
    const inverse = (cell.flags & INVERSE) !== 0;
    const [r, g, b] = inverse
      ? [cell.fg_r, cell.fg_g, cell.fg_b]
      : [cell.bg_r, cell.bg_g, cell.bg_b];
    // Black is ghostty's "default background": the row's fill already painted it.
    if (r === 0 && g === 0 && b === 0) return;
    ctx.fillStyle = rgb(r, g, b);
    ctx.fillRect(col * width, 0, width * cell.width, height);
  });
  cells.forEach((cell, col) => {
    if (cell.width === 0 || (cell.flags & INVISIBLE) !== 0) return;
    const style = `${cell.flags & ITALIC ? 'italic ' : ''}${cell.flags & BOLD ? 'bold ' : ''}`;
    ctx.font = `${style}${font.size}px ${font.family}`;
    ctx.fillStyle =
      cell.flags & INVERSE
        ? rgb(cell.bg_r, cell.bg_g, cell.bg_b)
        : rgb(cell.fg_r, cell.fg_g, cell.fg_b);
    const faint = (cell.flags & FAINT) !== 0;
    if (faint) ctx.globalAlpha = 0.5;
    const text =
      cell.grapheme_len > 0 && grapheme
        ? grapheme(col)
        : String.fromCodePoint(cell.codepoint || 32);
    ctx.fillText(text, col * width, baseline);
    if (faint) ctx.globalAlpha = 1;
    const line = (y: number) => {
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(col * width, y);
      ctx.lineTo((col + cell.width) * width, y);
      ctx.stroke();
    };
    if (cell.flags & UNDERLINE) line(baseline + 2);
    if (cell.flags & STRIKETHROUGH) line(height / 2);
  });
}

export class PeekRow {
  readonly canvas: HTMLCanvasElement;
  /** What the canvas shows now; null when it must be drawn again. */
  private drawn: string | null = null;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'terminal-peek-row';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.style.cssText = 'position:absolute;left:0;top:0;display:none;pointer-events:none;';
  }

  /** Draws `cells()` for `cols` columns unless `key` says the canvas already shows them. */
  draw(
    key: string,
    cells: () => readonly GhosttyCell[] | null,
    cols: number,
    metrics: CellMetrics,
    font: RowFont,
    background: string,
    grapheme?: (col: number) => string
  ): void {
    const ratio = window.devicePixelRatio || 1;
    const fullKey = `${key}|${cols}|${metrics.width}x${metrics.height}|${font.size}|${background}|${ratio}`;
    if (this.drawn === fullKey) return;
    const width = cols * metrics.width;
    if (this.canvas.width !== Math.round(width * ratio))
      this.canvas.width = Math.round(width * ratio);
    if (this.canvas.height !== Math.round(metrics.height * ratio)) {
      this.canvas.height = Math.round(metrics.height * ratio);
    }
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${metrics.height}px`;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    paintCellRow(ctx, cells() ?? [], cols, metrics, font, background, grapheme);
    this.drawn = fullKey;
  }

  /**
   * Puts the row right above a canvas moved down by `shift` px and scaled by `scale` from its
   * top left corner (the pinch preview), so it moves and scales with it.
   */
  place(shift: number, rowHeight: number, scale: number): void {
    this.canvas.style.display = 'block';
    this.canvas.style.visibility = 'visible';
    this.canvas.style.transformOrigin = `0 ${rowHeight}px`;
    this.canvas.style.transform = `translate3d(0, ${shift - rowHeight}px, 0)${
      scale !== 1 ? ` scale(${scale})` : ''
    }`;
  }

  /** Hidden, but left in place: its compositing layer stays for the next row. */
  hide(): void {
    this.canvas.style.visibility = 'hidden';
  }
}
