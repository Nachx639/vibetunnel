/**
 * Claude Code's status line, as the terminal shows it: the lines under the prompt box. Whatever
 * produces them (Claude Code's own mode line, a `statusLine` command such as a usage meter) is
 * read off the screen, so the chat shows exactly what the terminal does.
 *
 *   ─────────────────────────────
 *   ❯ <what is being typed>
 *   ─────────────────────────────
 *     Opus · 5h 5% · week 16% …      ← status line
 *     ⏵⏵ bypass permissions on · …   ← mode line
 */

/** A horizontal rule of the prompt box (top rules may carry a title in the middle). */
const RULE = /^\s*[─━]{8,}/;
/** The prompt line inside the box. */
const PROMPT = /^\s*[❯>]/;
/** At most this many lines under the box are taken (more is not a status line). */
const MAX_LINES = 4;

export const CHAT_STATUS_LINE_KEY = 'vt-chat-status-line';
export const CHAT_STATUS_LINE_CHANGED_EVENT = 'vt-chat-status-line-changed';

export function parseClaudeStatusLine(screen: string): string[] {
  const lines = screen.split('\n').map((line) => line.replace(/\s+$/, ''));
  // The box's bottom rule: the last rule with a prompt line a few lines above it.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!RULE.test(lines[i])) continue;
    let prompt = false;
    for (let j = i - 1; j >= Math.max(0, i - 12); j--) {
      if (RULE.test(lines[j])) break;
      if (PROMPT.test(lines[j])) {
        prompt = true;
        break;
      }
    }
    if (!prompt) return [];
    const below = lines
      .slice(i + 1)
      .map((line) => line.trim())
      .filter((line) => line && !RULE.test(line));
    return below.slice(0, MAX_LINES);
  }
  return [];
}

/** "Show Claude's status line in chat" (Settings); off unless turned on on this device. */
export function readChatStatusLinePref(): boolean {
  try {
    return localStorage.getItem(CHAT_STATUS_LINE_KEY) === 'on';
  } catch {
    return false;
  }
}

export function writeChatStatusLinePref(on: boolean): void {
  try {
    if (on) localStorage.setItem(CHAT_STATUS_LINE_KEY, 'on');
    else localStorage.removeItem(CHAT_STATUS_LINE_KEY);
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
  window.dispatchEvent(new CustomEvent(CHAT_STATUS_LINE_CHANGED_EVENT, { detail: on }));
}

/** One piece of the status line, ready for a compact chip. */
export interface StatusSegment {
  /** Plain text ("Opus 5.5", "1 shell"), or the label before a percentage ("5h"). */
  text: string;
  /** A usage percentage ("5h 7%"), drawn as a small bar. */
  percent?: number;
  /** When that usage resets ("22:30" from "(reinicia 22:30)" or "(resets 22:30)"). */
  reset?: string;
}

/** Mode-line pieces that the chat already shows (its mode chip) or that only make sense typing. */
const MODE_PIECE = /(?:⏵⏵|⏵|⏸|►►|▶▶)|\b(?:mode|permissions) on\b/i;
const HINT_PIECE = /(?:shift\+tab|for shortcuts|to cycle|← for agents|esc to|ctrl\+)/i;
const RESET = /\((?:reinicia|reinicio|resets?|renews?|se reinicia)\s+([^)]*)\)/i;

/**
 * The status lines as compact pieces: split on "·", the permission mode and key hints dropped
 * (the chat has its mode chip), a piece the terminal cut off ("cont…") dropped, and a cut-off
 * "(resets …" left out.
 */
export function compactStatusSegments(lines: string[]): StatusSegment[] {
  const out: StatusSegment[] = [];
  for (const line of lines) {
    for (const raw of line.split(/\s+·\s+|\s+•\s+|\s+\|\s+/)) {
      let piece = raw.trim();
      if (!piece || MODE_PIECE.test(piece) || HINT_PIECE.test(piece)) continue;
      const cut = /…$/.test(piece);
      let reset: string | undefined;
      const resetMatch = RESET.exec(piece);
      if (resetMatch) {
        reset = resetMatch[1].trim() || undefined;
        piece = piece.replace(RESET, '').trim();
      } else if (piece.includes('(') && !piece.includes(')')) {
        piece = piece.slice(0, piece.indexOf('(')).trim();
      } else if (cut) {
        // A piece the terminal cut short says nothing useful ("cont…").
        if (!/\d+%/.test(piece)) continue;
        piece = piece.replace(/…$/, '').trim();
      }
      const pct = /^(.*?)\s*(\d{1,3})%$/.exec(piece);
      if (pct) {
        out.push({ text: pct[1].trim(), percent: Math.min(100, Number(pct[2])), reset });
      } else if (piece) {
        out.push({ text: piece, reset });
      }
    }
  }
  return out;
}
