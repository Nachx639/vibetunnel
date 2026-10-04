/**
 * How the compact phone list fits a small screen (session-list.ts).
 *
 * On a 375×667 pt iPhone SE the list's first screen could show no session at all: what sits
 * above the rows filled it. Two levels, so larger phones keep the layout they have:
 *
 * - `tight`: less vertical spacing. Pure spacing, automatic on a screen ≤ 375 pt wide or
 *   ≤ 700 pt tall (an SE, a mini), and whenever `compact` is on.
 * - `compact`: sections above the rows may also change shape (fold into one line, become an
 *   icon) to give the rows room. A setting ("Compact list", Settings): on by default only on
 *   screens ≤ 700 pt tall, since folding hides things the user may look for.
 *
 * Both only apply in the compact phone layout (utils/phone-ui.ts); the classic layout and
 * larger screens are unchanged. The screen's size, not the window's: it doesn't change with
 * Safari's bars or the keyboard, so the layout doesn't jump while you type.
 */
import { APP_PREFERENCES_STORAGE_KEY } from './phone-ui.js';

export const SHORT_SCREEN_MAX_PT = 700;
export const NARROW_SCREEN_MAX_PT = 375;

/** Dispatched on window when "Compact list" changes, so the open list lays out again. */
export const COMPACT_LIST_CHANGED_EVENT = 'vibetunnel-compact-list-changed';

/** "on" / "off" once chosen in Settings; nothing stored means the screen decides. */
export type CompactListPref = 'auto' | 'on' | 'off';

export interface ScreenSize {
  width: number;
  height: number;
}

export interface PhoneListLayout {
  tight: boolean;
  compact: boolean;
}

/** The device screen in CSS px (pt on iOS), either orientation. */
export function currentScreen(): ScreenSize {
  const width = window.screen?.width || window.innerWidth;
  const height = window.screen?.height || window.innerHeight;
  return { width, height };
}

export function isShortScreen(screen: ScreenSize): boolean {
  return Math.max(screen.width, screen.height) <= SHORT_SCREEN_MAX_PT;
}

export function isNarrowScreen(screen: ScreenSize): boolean {
  return Math.min(screen.width, screen.height) <= NARROW_SCREEN_MAX_PT;
}

/** Whether the compact list is on for this screen and preference. */
export function compactListOn(screen: ScreenSize, pref: CompactListPref): boolean {
  return pref === 'auto' ? isShortScreen(screen) : pref === 'on';
}

export function phoneListLayout(screen: ScreenSize, pref: CompactListPref): PhoneListLayout {
  const compact = compactListOn(screen, pref);
  return { compact, tight: compact || isShortScreen(screen) || isNarrowScreen(screen) };
}

function readPreferences(): Record<string, unknown> {
  try {
    const stored = localStorage.getItem(APP_PREFERENCES_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** `compactList` in the app preferences: true / false once chosen, missing = auto. */
export function readCompactListPref(): CompactListPref {
  const value = readPreferences().compactList;
  return value === true ? 'on' : value === false ? 'off' : 'auto';
}

export function writeCompactListPref(pref: CompactListPref): void {
  try {
    const { compactList: _previous, ...rest } = readPreferences();
    const next = pref === 'auto' ? rest : { ...rest, compactList: pref === 'on' };
    localStorage.setItem(APP_PREFERENCES_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Blocked storage: the choice is not remembered.
  }
  window.dispatchEvent(new CustomEvent(COMPACT_LIST_CHANGED_EVENT, { detail: pref }));
}

/** The layout for this device now. */
export function currentPhoneListLayout(): PhoneListLayout {
  return phoneListLayout(currentScreen(), readCompactListPref());
}
