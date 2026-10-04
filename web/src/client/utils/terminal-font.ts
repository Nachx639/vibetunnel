import { TERMINAL_FONT_FAMILY, TERMINAL_NERD_FONT_FAMILY } from './terminal-constants.js';

/**
 * Terminal font preference ("Terminal font" in Settings), stored per browser in localStorage
 * `vibetunnel_app_preferences` as `terminalFont`:
 * - `nerd` (default, also when missing): the canvas terminal draws with the bundled Hack Nerd
 *   Font Mono, so Nerd Font icons in prompts and tools (folder, git branch, file type) show
 *   instead of empty boxes. The terminal waits for the font before its first paint
 *   (utils/terminal-fonts.ts);
 * - `system`: it draws with the system's monospace font, as it did before, and loads no web font.
 * Terminals opened after a change use the new font.
 */
export type TerminalFontChoice = 'system' | 'nerd';

const APP_PREFERENCES_STORAGE_KEY = 'vibetunnel_app_preferences';

function readPreferences(): Record<string, unknown> {
  try {
    const stored = localStorage.getItem(APP_PREFERENCES_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function getTerminalFont(): TerminalFontChoice {
  return readPreferences().terminalFont === 'system' ? 'system' : 'nerd';
}

export function setTerminalFont(value: TerminalFontChoice): void {
  try {
    localStorage.setItem(
      APP_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ ...readPreferences(), terminalFont: value })
    );
  } catch {
    // Storage can be unavailable in private browsing; the choice then lasts for this page.
  }
}

/** The CSS font-family the terminal (and what lines up with its cells) draws with. */
export function terminalFontFamily(choice: TerminalFontChoice = getTerminalFont()): string {
  return choice === 'nerd' ? TERMINAL_NERD_FONT_FAMILY : TERMINAL_FONT_FAMILY;
}
