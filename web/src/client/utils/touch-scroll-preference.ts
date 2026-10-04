/**
 * Terminal touch scrolling preference ("Smooth touch scrolling" in Settings), stored per
 * browser in localStorage `vibetunnel_app_preferences` as `terminalTouchScroll`, next to
 * `phoneUi`:
 * - `classic` (default, also when missing): a one-finger drag moves the terminal one whole row
 *   each time the finger crosses a row's height, and stops when the finger lifts.
 * - `smooth`: the text follows the finger pixel by pixel, keeps going after the finger lifts
 *   (momentum) and stretches past the ends (rubber band); pinch zooms the terminal font and a
 *   long press opens Select text.
 * Only touch input is affected; mouse wheels and trackpads scroll as before.
 */
import { APP_PREFERENCES_STORAGE_KEY } from './phone-ui.js';

export type TerminalTouchScroll = 'classic' | 'smooth';

export const TERMINAL_TOUCH_SCROLL_CHANGED_EVENT = 'vibetunnel-terminal-touch-scroll-changed';

function readPreferences(): Record<string, unknown> {
  try {
    const stored = localStorage.getItem(APP_PREFERENCES_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function getTerminalTouchScroll(): TerminalTouchScroll {
  return readPreferences().terminalTouchScroll === 'smooth' ? 'smooth' : 'classic';
}

export function setTerminalTouchScroll(value: TerminalTouchScroll): void {
  try {
    localStorage.setItem(
      APP_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ ...readPreferences(), terminalTouchScroll: value })
    );
  } catch {
    // Storage can be unavailable in private browsing; the choice then lasts for this page.
  }
  window.dispatchEvent(
    new CustomEvent<TerminalTouchScroll>(TERMINAL_TOUCH_SCROLL_CHANGED_EVENT, { detail: value })
  );
}

/** Calls `listener` with the new value whenever the preference changes; returns the unsubscribe. */
export function subscribeToTerminalTouchScroll(
  listener: (value: TerminalTouchScroll) => void
): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<TerminalTouchScroll>).detail);
  window.addEventListener(TERMINAL_TOUCH_SCROLL_CHANGED_EVENT, handler);
  return () => window.removeEventListener(TERMINAL_TOUCH_SCROLL_CHANGED_EVENT, handler);
}
