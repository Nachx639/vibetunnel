/**
 * Sizing for the rows of terminal quick keys.
 *
 * Keys share their row equally (flex: 1 1 0), but a key is never narrower than its label
 * (min-width: min-content in the component CSS): word keys such as "Home" or "Done" take
 * what they need and the glyph keys split the rest. A row therefore fits when the sum of
 * those label minimums fits, and this picks the roomiest padding and font that do.
 *
 * On a 375 pt phone a translated 12-key second row got 29 px per key, 14 px of it padding
 * and border, so 5- and 6-letter labels spilled out of their keys: one was painted over by
 * the next key and the last was cut at the screen edge.
 */

/** Monospace fonts advance about 0.6 em per character; a little extra covers fallback glyphs. */
const MONO_ADVANCE_EM = 0.62;
/** `border` on every key: 1 px each side. */
const KEY_BORDER_PX = 2;
/** `gap-0.5` between keys. */
export const QUICK_KEY_GAP_PX = 2;
/** Row padding (0.125rem each side) set in the component CSS. */
export const QUICK_KEY_ROW_INSET_PX = 4;
/** Rows this long always use compact padding, whatever the screen width. */
export const COMPACT_ROW_KEY_COUNT = 11;

const FONT_SIZES_PX = [13, 10, 8, 7] as const;
const FONT_CLASSES = [
  'quick-key-btn-medium',
  'quick-key-btn-small',
  'quick-key-btn-xs',
  'quick-key-btn-xxs',
] as const;

/** Horizontal padding per side, roomiest first, with the Tailwind class that sets it. */
const PADDINGS = [
  { px: 6, className: 'px-1.5' },
  { px: 4, className: 'px-1' },
  { px: 2, className: 'px-0.5' },
  { px: 1, className: 'px-px' },
  { px: 0, className: 'px-0' },
] as const;
const COMPACT_PADDING_PX = 2;

export interface QuickKeyRowSizing {
  /** Tailwind classes for the keys' padding. */
  paddingClass: string;
  /** Horizontal padding per side, in px. */
  paddingPx: number;
  /** 1 when word labels (3+ characters) drop one font size so the row fits. */
  fontStep: 0 | 1;
}

function labelLength(label: string): number {
  return [...label].length;
}

function fontIndex(label: string, fontStep: 0 | 1): number {
  const length = labelLength(label);
  const base = length >= 4 ? 2 : length === 3 ? 1 : 0;
  // Glyph keys keep their size: shrinking a single character saves next to nothing.
  return Math.min(base + (length >= 3 ? fontStep : 0), FONT_SIZES_PX.length - 1);
}

/** Font class for a key label: 13 px for glyphs, 10 px for three letters, 8 px for words. */
export function quickKeyFontClass(label: string, fontStep: 0 | 1 = 0): string {
  return FONT_CLASSES[fontIndex(label, fontStep)];
}

/** Narrowest a key can be without its label spilling out: text + padding + border. */
export function quickKeyMinWidth(label: string, paddingPx: number, fontStep: 0 | 1 = 0): number {
  const fontPx = FONT_SIZES_PX[fontIndex(label, fontStep)];
  return Math.ceil(labelLength(label) * fontPx * MONO_ADVANCE_EM) + 2 * paddingPx + KEY_BORDER_PX;
}

/**
 * Padding and font for one row of keys (labels as shown, Done included) in a row
 * `rowWidth` px wide. Rows of COMPACT_ROW_KEY_COUNT or more keys never get more than
 * compact padding; otherwise the roomiest padding that fits wins, and word labels shrink
 * one size only when even no padding is not enough.
 */
export function quickKeyRowSizing(
  labels: readonly string[],
  rowWidth: number,
  landscape = false
): QuickKeyRowSizing {
  const verticalClass = landscape ? 'py-2' : 'py-2.5';
  const roomiestPx = landscape ? 4 : 6;
  const maxPx = labels.length >= COMPACT_ROW_KEY_COUNT ? COMPACT_PADDING_PX : roomiestPx;
  const paddings = PADDINGS.filter(({ px }) => px <= maxPx);
  const available =
    rowWidth - QUICK_KEY_ROW_INSET_PX - QUICK_KEY_GAP_PX * Math.max(labels.length - 1, 0);

  for (const fontStep of [0, 1] as const) {
    for (const padding of paddings) {
      const needed = labels.reduce(
        (sum, label) => sum + quickKeyMinWidth(label, padding.px, fontStep),
        0
      );
      if (needed <= available) {
        return {
          paddingClass: `${padding.className} ${verticalClass}`,
          paddingPx: padding.px,
          fontStep,
        };
      }
    }
  }
  return { paddingClass: `px-0 ${verticalClass}`, paddingPx: 0, fontStep: 1 };
}
