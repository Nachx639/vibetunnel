/**
 * Phone layout preference: "classic" (the default: the same cards and header as on a wider
 * screen) or "compact" (a chat-style session list, a three-button header and a session
 * switcher in the session header). Per browser, in the app preferences in localStorage; it
 * only applies on phones (touch devices whose shorter side is under 600 px).
 */
import { detectMobile } from './mobile-utils.js';

export type PhoneUi = 'classic' | 'compact';

export const APP_PREFERENCES_STORAGE_KEY = 'vibetunnel_app_preferences';

/** Dispatched on window when the preference changes, so open views can re-render. */
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
    // Blocked storage: the choice lasts until the page reloads.
  }
  window.dispatchEvent(new CustomEvent(PHONE_UI_CHANGED_EVENT, { detail: value }));
}

/** A phone: a touch device whose shorter side is under 600 px. */
export function isPhoneScreen(): boolean {
  return detectMobile() && Math.min(window.innerWidth, window.innerHeight) < 600;
}

/** The compact phone layout is on: chosen in Settings, and this is a phone. */
export function usesCompactPhoneUi(): boolean {
  return getPhoneUi() === 'compact' && isPhoneScreen();
}
