/**
 * The compact phone list's floating "+" (session-list.ts): when it hides and where it rests.
 *
 * On a small phone (an iPhone SE) it sat over the rows scrolling under it: their time, status
 * dot and ⋯, the search field, the "Clear all" button. It now hides while the list scrolls
 * down and comes back on a scroll up or near the top, and once the list is at rest it lifts
 * clear of the controls it would cover, or stays hidden if it can't.
 */

/** Within this many px of the top the button always shows. */
export const FAB_TOP_ZONE_PX = 48;
/** Scroll this far in one direction before the button hides or shows (finger jitter). */
export const FAB_SCROLL_THRESHOLD_PX = 12;
/** No scroll event for this long: the list is at rest. */
export const FAB_REST_MS = 160;
/** How far up the button may move to clear a control; past that it hides instead. */
export const FAB_MAX_LIFT_PX = 160;
/** Room kept between the button and a control it clears. */
export const FAB_CLEARANCE_PX = 4;

/**
 * At rest the button covers no control in the list: anything a finger or the keyboard can
 * reach counts. (A fixed list of targets lifted it clear of one control and onto another.)
 */
export const FAB_INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]',
].join(', ');

/**
 * Never covered, whatever their size: content that is read, not only tapped (an inline card
 * in a row, say). Mark such an element with `data-fab-avoid`.
 */
export const FAB_ALWAYS_AVOID_SELECTOR = '[data-fab-avoid]';

const TEXT_FIELD_SELECTOR = 'input, textarea, select, [contenteditable]';

export interface FabScroll {
  hidden: boolean;
  /** Where the current scroll direction started. */
  anchorY: number;
  lastY: number;
}

export const FAB_SCROLL_START: FabScroll = { hidden: false, anchorY: 0, lastY: 0 };

/** The next state for a scroll position `y` (already clamped to the scrollable range). */
export function nextFabScroll(prev: FabScroll, y: number): FabScroll {
  if (y <= FAB_TOP_ZONE_PX) return { hidden: false, anchorY: y, lastY: y };
  const delta = y - prev.lastY;
  if (delta === 0) return prev;
  const wasDown = prev.lastY > prev.anchorY;
  const wasUp = prev.lastY < prev.anchorY;
  // A change of direction starts counting again from where it turned.
  const anchorY = (delta > 0 && wasUp) || (delta < 0 && wasDown) ? prev.lastY : prev.anchorY;
  const travelled = y - anchorY;
  let hidden = prev.hidden;
  if (travelled > FAB_SCROLL_THRESHOLD_PX) hidden = true;
  else if (travelled < -FAB_SCROLL_THRESHOLD_PX) hidden = false;
  return { hidden, anchorY, lastY: y };
}

export interface FabRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

function overlaps(a: FabRect, b: FabRect, clearance: number): boolean {
  return (
    a.left < b.right + clearance &&
    a.right > b.left - clearance &&
    a.top < b.bottom + clearance &&
    a.bottom > b.top - clearance
  );
}

/**
 * How many px to lift the button (at its resting place `fab`) so it covers none of
 * `obstacles`: the smallest lift from 0 (its home slot) up to `maxLift`, or null when every
 * position in that range covers one, and then it hides.
 */
export function fabLift(
  fab: FabRect,
  obstacles: FabRect[],
  maxLift = FAB_MAX_LIFT_PX,
  clearance = FAB_CLEARANCE_PX
): number | null {
  const near = obstacles.filter(
    (rect) =>
      rect.bottom > rect.top &&
      rect.right > rect.left &&
      overlaps({ ...fab, top: fab.top - maxLift }, rect, clearance)
  );
  // The nearest clear position is home or just above one of the obstacles: try those in order.
  const candidates = [0, ...near.map((rect) => Math.ceil(fab.bottom - rect.top + clearance))]
    .filter((lift) => lift >= 0 && lift <= maxLift)
    .sort((a, b) => a - b);
  for (const lift of candidates) {
    const moved = { ...fab, top: fab.top - lift, bottom: fab.bottom - lift };
    if (!near.some((rect) => overlaps(moved, rect, clearance))) return lift;
  }
  return null;
}

/**
 * The boxes the button must not cover at rest, from the controls under `root` (the list).
 *
 * Every visible interactive or focusable element counts, with one exception: a tap surface
 * at least twice as wide as the button and as tall as it (a row's own body) stays tappable
 * around it, so the button may rest over it; otherwise it would hide over any list. Text
 * fields count whatever their size. Hidden ones (swipe actions behind a row, closed sheets,
 * aria-hidden, inert, tabindex -1 and the button itself) don't.
 */
export function fabObstacles(root: ParentNode, fab: HTMLElement): FabRect[] {
  const fabWidth = fab.offsetWidth;
  const fabHeight = fab.offsetHeight;
  const rects: FabRect[] = [];
  for (const el of root.querySelectorAll<HTMLElement>(
    `${FAB_INTERACTIVE_SELECTOR}, ${FAB_ALWAYS_AVOID_SELECTOR}`
  )) {
    if (el === fab || fab.contains(el) || el.contains(fab)) continue;
    const always = el.matches(FAB_ALWAYS_AVOID_SELECTOR);
    if (!always && el.getAttribute('tabindex') === '-1') continue;
    if (el.closest('[inert], [aria-hidden="true"]')) continue;
    const rect = el.getBoundingClientRect();
    if (rect.bottom <= rect.top || rect.right <= rect.left) continue;
    if (!isVisible(el)) continue;
    const surface =
      !always &&
      !el.matches(TEXT_FIELD_SELECTOR) &&
      rect.right - rect.left >= 2 * fabWidth &&
      rect.bottom - rect.top >= fabHeight;
    if (surface) continue;
    rects.push({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right });
  }
  return rects;
}

function isVisible(el: HTMLElement): boolean {
  if (typeof el.checkVisibility === 'function') {
    return el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  }
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

/**
 * The element the list scrolls in: the nearest ancestor that scrolls vertically, or null
 * when the document itself scrolls.
 */
export function listScroller(el: Element): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (node === document.body || node === document.documentElement) break;
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return node;
  }
  return null;
}
