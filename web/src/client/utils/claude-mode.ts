/**
 * Claude Code's permission mode, read from its screen. Its own module so the session list's
 * agent cards can use it without pulling the whole chat view into the list's code.
 */
import { parseScreenChoices } from '../../shared/claude-screen.js';

/**
 * Whether pressing Shift+Tab now could answer something instead of changing the mode: no
 * mode line on the live screen, or a numbered permission dialog showing (Claude can keep the
 * mode line visible under it; Shift+Tab there means "allow all edits this session").
 */
export function modeSwitchBlocked(screen: string): boolean {
  return !parseClaudeMode(screen) || parseScreenChoices(screen) !== null;
}

/** Claude Code's permission mode, read from its status line at the bottom of the screen. */
export function parseClaudeMode(screenText: string): string | null {
  // e.g. "⏵⏵ bypass permissions on", "⏸ plan mode on", "⏸ manual mode on"
  const match = screenText.match(/(?:⏵⏵|⏵|⏸)\s*([a-z][a-z -]*?) on\b/i);
  if (match) {
    const name = match[1].trim();
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  return screenText.includes('? for shortcuts') ? 'Default mode' : null;
}
