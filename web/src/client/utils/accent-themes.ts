/**
 * Color themes: an accent color plus, in dark mode, a background tinted to match.
 * Applied as `data-accent` on <html>; styles.css maps each id to CSS variables.
 * index.html applies the saved accent before first paint (no flash). The default, emerald,
 * is the app's original palette: it has no override in styles.css.
 */
import { type MessageKey, t } from '../i18n/index.js';

export interface AccentTheme {
  id: string;
  name: string;
  /** Swatch shown in the picker. */
  color: string;
}

export const ACCENT_THEMES: AccentTheme[] = [
  { id: 'emerald', name: 'Emerald', color: '#10B981' },
  { id: 'ocean', name: 'Ocean', color: '#3B82F6' },
  { id: 'violet', name: 'Violet', color: '#8B5CF6' },
  { id: 'sunset', name: 'Sunset', color: '#F97316' },
  { id: 'rose', name: 'Rose', color: '#EC4899' },
  { id: 'cyber', name: 'Cyber', color: '#22D3EE' },
  { id: 'gold', name: 'Gold', color: '#EAB308' },
  { id: 'clay', name: 'Clay', color: '#D97757' },
];

const ACCENT_NAME_KEYS: Record<string, MessageKey> = {
  emerald: 'theme.emerald',
  ocean: 'theme.ocean',
  violet: 'theme.violet',
  sunset: 'theme.sunset',
  rose: 'theme.rose',
  cyber: 'theme.cyber',
  gold: 'theme.gold',
  clay: 'theme.clay',
};

/** The theme's name in the UI language. */
export function accentName(theme: AccentTheme): string {
  const key = ACCENT_NAME_KEYS[theme.id];
  return key ? t(key) : theme.name;
}

export const ACCENT_STORAGE_KEY = 'vibetunnel-accent';
const DEFAULT_ACCENT = 'emerald';

export function getAccent(): string {
  try {
    const saved = localStorage.getItem(ACCENT_STORAGE_KEY);
    if (saved && ACCENT_THEMES.some((theme) => theme.id === saved)) return saved;
  } catch {
    // Storage blocked (private mode): fall back to the default.
  }
  return DEFAULT_ACCENT;
}

export function applyAccent(id: string): void {
  const accent = ACCENT_THEMES.some((theme) => theme.id === id) ? id : DEFAULT_ACCENT;
  document.documentElement.setAttribute('data-accent', accent);
  try {
    localStorage.setItem(ACCENT_STORAGE_KEY, accent);
  } catch {
    // Not persisted; still applied for this page.
  }
  syncThemeColorMeta();
  window.dispatchEvent(new CustomEvent('vibetunnel-accent-changed', { detail: { accent } }));
}

/**
 * Browser chrome (iOS status bar area) follows the background: the default theme keeps the
 * colors it always used, a color theme uses its tinted background.
 */
export function syncThemeColorMeta(): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const root = document.documentElement;
  const accent = root.getAttribute('data-accent');
  if (!accent || accent === DEFAULT_ACCENT) {
    meta.setAttribute(
      'content',
      root.getAttribute('data-theme') === 'dark' ? '#0a0a0a' : '#fafafa'
    );
    return;
  }
  const bg = getComputedStyle(root).getPropertyValue('--color-bg').trim();
  if (bg) meta.setAttribute('content', bg);
}
