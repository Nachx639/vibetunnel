/**
 * Continue a Claude Code conversation (`claude --resume <id>`) in a new VibeTunnel session.
 * Shared by the exited-session row, the session view and the conversation history. A
 * conversation running right now outside VibeTunnel (a Terminal tab, a tmux pane) is never
 * resumed: the server refuses it, which would make a second writer of it.
 */
import type { MacLiveConversation } from '../../shared/mac-sessions.js';
import type { Session } from '../../shared/types.js';
import { t } from '../i18n/index.js';
import { macAppName } from './mac-sessions.js';

export const SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions';
const APP_PREFERENCES_KEY = 'vibetunnel_app_preferences';

/**
 * `claude --resume <id>`, with the permission-prompt bypass only when the user asked for it in
 * the UI for this resume. It is never inferred (not from other sessions, nor the old command).
 */
export function claudeResumeCommand(claudeSessionId: string, skipPermissions: boolean): string[] {
  return [
    'claude',
    '--resume',
    claudeSessionId,
    ...(skipPermissions ? [SKIP_PERMISSIONS_FLAG] : []),
  ];
}

/** A running session already showing this conversation: open it rather than a second claude. */
export function findLiveClaudeSession(
  sessions: Session[],
  claudeSessionId: string
): Session | undefined {
  return sessions.find(
    (session) => session.status !== 'exited' && session.claudeSessionId === claudeSessionId
  );
}

/** Open the next session in chat mode on phones (the session view restores this preference). */
export function preferChatMode() {
  try {
    const preferences = JSON.parse(localStorage.getItem(APP_PREFERENCES_KEY) || '{}');
    localStorage.setItem(APP_PREFERENCES_KEY, JSON.stringify({ ...preferences, chatMode: true }));
  } catch {
    // Blocked storage: the session opens in whatever view it would have anyway.
  }
}

/**
 * Where a conversation runs right now outside VibeTunnel (`live` in the history list, and in the
 * server's refusal to resume it), as the server sends it.
 */
export type ClaudeLiveOutside = MacLiveConversation;

/** Why it can't be continued here: where it runs, and what to do instead. */
export function liveOutsideText(live: ClaudeLiveOutside): string {
  if (live.where === 'tmux') return t('history.liveInTmux');
  return live.app
    ? t('history.liveElsewhere', { app: macAppName(live.app) })
    : t('history.liveOutside');
}

/** The server refused to resume: the conversation runs outside VibeTunnel right now. */
export class ClaudeLiveOutsideError extends Error {
  constructor(readonly live: ClaudeLiveOutside) {
    super(liveOutsideText(live));
    this.name = 'ClaudeLiveOutsideError';
  }
}

function liveOutsideOf(value: unknown): ClaudeLiveOutside | null {
  const live = value as Partial<ClaudeLiveOutside> | null | undefined;
  if (live?.where !== 'tmux' && live?.where !== 'terminal') return null;
  return live as ClaudeLiveOutside;
}

/**
 * Start `claude --resume` in the conversation's folder; resolves with the new session's id.
 * Throws a ClaudeLiveOutsideError when the conversation runs outside VibeTunnel right now.
 */
export async function resumeClaudeConversation(options: {
  claudeSessionId: string;
  workingDir: string;
  name?: string;
  /** Ticked by the user for this resume; false everywhere else. */
  skipPermissions: boolean;
  authHeader?: Record<string, string>;
  /** Run it in a shielded session (survives VibeTunnel restarts). */
  shielded?: boolean;
}): Promise<{ sessionId: string }> {
  const response = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...options.authHeader },
    body: JSON.stringify({
      command: claudeResumeCommand(options.claudeSessionId, options.skipPermissions),
      workingDir: options.workingDir,
      name: options.name,
      spawn_terminal: false,
      ...(options.shielded ? { shielded: true } : {}),
    }),
  });
  const result = await response.json().catch(() => ({}));
  const live = response.status === 409 ? liveOutsideOf(result.live) : null;
  if (live) throw new ClaudeLiveOutsideError(live);
  if (!response.ok || !result.sessionId) {
    throw new Error(result.error || response.statusText || `HTTP ${response.status}`);
  }
  return result;
}
