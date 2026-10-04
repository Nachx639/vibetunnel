/**
 * iOS sends a click shortly after a tap's pointerup. Sheets act on pointerup (a first tap on a
 * fresh button can be eaten as a hover) and close at once, so that click lands on whatever is
 * now under the finger, such as a session row underneath. Call this when a pointerup action
 * closes or replaces the UI under the finger: the next click anywhere within `ms` is swallowed.
 */
let pending: ((e: Event) => void) | null = null;

/**
 * A new touch is a new gesture: the guard of the last one ends with it. Some actions that set
 * it never get a click (a swipe, a long press), and a real tap right after must still work.
 */
const releaseOnTouch = () => resetGhostClickGuard();

export function resetGhostClickGuard(): void {
  if (pending && typeof document !== 'undefined') {
    document.removeEventListener('click', pending, true);
    document.removeEventListener('pointerdown', releaseOnTouch, true);
  }
  pending = null;
}

/**
 * A tap that closed or replaced the UI under the finger is still finishing: a field focused
 * now was focused by that tap, not a new one.
 */
export function isSwallowingGhostClick(): boolean {
  return pending !== null;
}

export function swallowNextClick(ms = 700): void {
  if (typeof document === 'undefined') return;
  resetGhostClickGuard();
  const until = Date.now() + ms;
  const swallow = (e: Event) => {
    resetGhostClickGuard();
    if (Date.now() > until) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };
  pending = swallow;
  document.addEventListener('click', swallow, true);
  document.addEventListener('pointerdown', releaseOnTouch, true);
  setTimeout(() => {
    if (pending === swallow) resetGhostClickGuard();
  }, ms);
}

const TAP_SLOP_PX = 10;
const OPEN_GUARD_MS = 500;

/**
 * Touch acts on pointerup (iOS can take the first tap on a fresh button as a hover and send
 * no click); the click that follows is swallowed. Mouse and keyboard use the click. With
 * `openedAt`, nothing acts in the first moments after a sheet opened. Bind the result to
 * pointerdown, pointerup and click.
 */
export function tapHandler(fn: () => void, openedAt = 0) {
  let touchActedAt = 0;
  let down: { x: number; y: number } | null = null;
  return {
    handleEvent: (e: Event) => {
      if (e.type === 'pointerdown') {
        const p = e as PointerEvent;
        down = { x: p.clientX, y: p.clientY };
        return;
      }
      if (Date.now() - openedAt < OPEN_GUARD_MS) return;
      if (e.type === 'pointerup') {
        const p = e as PointerEvent;
        if (p.pointerType === 'mouse') return;
        const moved = down && Math.hypot(p.clientX - down.x, p.clientY - down.y) > TAP_SLOP_PX;
        down = null;
        if (moved) return;
        touchActedAt = Date.now();
        swallowNextClick();
      } else if (Date.now() - touchActedAt < 700) {
        return;
      }
      fn();
    },
  };
}
