/**
 * Phone layout preference ("Phone layout" in Settings), stored per browser in
 * localStorage `vibetunnel_app_preferences` as `phoneUi`:
 * - `classic` (default, also when missing): the session view as it has always been on
 *   phones (floating action bar, quick keys over the keyboard, the default quick-key layout).
 * - `compact`: the session view is pinned to the visible viewport with the action bar and
 *   quick keys docked under the terminal, two-row quick keys tuned for coding agents,
 *   sticky Ctrl/⌥ and swipe-to-move-cursor on the quick keys.
 * Only phones are affected; desktop and tablet layouts ignore it.
 */
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
