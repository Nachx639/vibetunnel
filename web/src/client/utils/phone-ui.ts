/**
 * Phone layout preference ("Phone layout" in Settings), stored per browser in
 * localStorage `vibetunnel_app_preferences` as `phoneUi`:
 * - `classic` (default, also when missing): the session view as it has always been on
 *   phones (floating action bar, quick keys over the keyboard, the default quick-key layout).
 * - `compact`: the session view is pinned to the visible viewport with the action bar and
 *   quick keys docked under the terminal, two-row quick keys tuned for coding agents,
 *   sticky Ctrl/⌥ and swipe-to-move-cursor on the quick keys.
 * Only phones are affected (see usesCompactPhoneUi); desktop and tablet layouts ignore it.
 */
import { detectMobile } from './mobile-utils.js';

export type PhoneUi = 'classic' | 'compact';

export const APP_PREFERENCES_STORAGE_KEY = 'vibetunnel_app_preferences';
export const PHONE_UI_CHANGED_EVENT = 'vibetunnel-phone-ui-changed';

function readPreferences(): Record<string, unknown> {
  try {
    const stored = localStorage.getItem(APP_PREFERENCES_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function getPhoneUi(): PhoneUi {
  return readPreferences().phoneUi === 'compact' ? 'compact' : 'classic';
}

/**
 * Shortest screen side, in CSS px, up to which a screen counts as a phone. Phones top out
 * around 440 (the largest iPhones); the smallest iPad is 744 and Android tablets start near 600.
 */
export const PHONE_SCREEN_MAX_SHORT_SIDE = 500;

/** True on a phone-sized screen. `screen` doesn't change on rotation, so this is stable. */
export function isPhoneSizedScreen(): boolean {
  if (typeof window === 'undefined' || !window.screen) return false;
  const shortSide = Math.min(window.screen.width, window.screen.height);
  return shortSide > 0 && shortSide <= PHONE_SCREEN_MAX_SHORT_SIDE;
}

/** A phone: a touch device whose shorter side is under 600 px. */
export function isPhoneScreen(): boolean {
  return detectMobile() && Math.min(window.innerWidth, window.innerHeight) < 600;
}

/**
 * The compact phone layout applies: it is chosen, and the screen is phone-sized or a touch
 * device's window is. A full-screen iPad is neither (its window and screen are at least 744
 * wide), so it keeps the classic layout whatever is chosen; a narrow Split View window of
 * one counts as a phone, which is how it should look.
 */
export function usesCompactPhoneUi(phoneUi: PhoneUi = getPhoneUi()): boolean {
  return phoneUi === 'compact' && (isPhoneSizedScreen() || isPhoneScreen());
}

export function setPhoneUi(value: PhoneUi): void {
  try {
    localStorage.setItem(
      APP_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ ...readPreferences(), phoneUi: value })
    );
  } catch {
    // Storage can be unavailable in private browsing; the choice then lasts for this page.
  }
  window.dispatchEvent(new CustomEvent<PhoneUi>(PHONE_UI_CHANGED_EVENT, { detail: value }));
}

/** Calls `listener` with the new value whenever the preference changes; returns the unsubscribe. */
export function subscribeToPhoneUi(listener: (value: PhoneUi) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<PhoneUi>).detail);
  window.addEventListener(PHONE_UI_CHANGED_EVENT, handler);
  return () => window.removeEventListener(PHONE_UI_CHANGED_EVENT, handler);
}
