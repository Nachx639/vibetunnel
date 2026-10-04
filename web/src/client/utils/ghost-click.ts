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
