import { syncThemeColorMeta } from './accent-themes.js';

export type ThemeMode = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'vibetunnel-theme';
const THEME_MODES: ThemeMode[] = ['light', 'dark', 'system'];

/** Saved light/dark/system choice (same key the header toggle and compact menu use). */
export function getThemeMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY) as ThemeMode | null;
    if (saved && THEME_MODES.includes(saved)) return saved;
  } catch {
    // Storage blocked (private mode): fall back to system.
  }
  return 'system';
}

/**
 * Persist and apply a light/dark/system choice: sets `data-theme` on <html> and
 * syncs the browser chrome color. Callers dispatch `theme-changed` themselves.
 */
export function applyThemeMode(mode: ThemeMode): void {
  const theme = THEME_MODES.includes(mode) ? mode : 'system';
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Not persisted; still applied for this page.
  }
  const effective =
    theme === 'system'
      ? window.matchMedia?.('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;
  document.documentElement.setAttribute('data-theme', effective);
  syncThemeColorMeta();
}
