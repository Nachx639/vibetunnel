/**
 * Shielded sessions: the program runs in a private tmux session on the server and
 * keeps running while VibeTunnel restarts. A running process can't be moved into tmux, so
 * shielding an existing session opens a new shielded one in the same folder (a Claude session
 * continues its conversation there and the old one closes).
 */
import { isForwardedSession } from '../../shared/forwarded-session.js';
import type { Session } from '../../shared/types.js';
import { t } from '../i18n/index.js';

/** Same rule as the server's shieldReopenPlan: Claude with a known conversation. */
export function shieldContinuesClaude(session: Pick<Session, 'command' | 'claudeSessionId'>) {
  return (
    Boolean(session.claudeSessionId) &&
    /(^|[\s/])claude(\s|$)/.test((session.command ?? []).join(' '))
  );
}

/** The question asked before shielding a session. */
export function shieldConfirmText(session: Session, name: string): string {
  return shieldContinuesClaude(session)
    ? t('shield.confirmClaude', { name })
    : t('shield.confirmOther', { name });
}

/**
 * Can this session be shielded from its menu? Not one that runs in a terminal window (vt): its
 * program belongs to that window. Nor one attached to a tmux session (`tmux: …`): shielding
 * reopens the program in a new tmux session, which would run a tmux client inside the shield.
 */
export function canShield(session: Session): boolean {
  return (
    session.status === 'running' &&
    !session.shielded &&
    session.source !== 'remote' &&
    !isForwardedSession(session) &&
    !session.name?.startsWith('tmux:') &&
    !(session.command ?? []).join(' ').includes('tmux attach')
  );
}

/** Open the shielded session for `session`; resolves with the new session's id. */
export async function shieldSession(
  sessionId: string,
  authHeader?: Record<string, string>
): Promise<{ sessionId: string; replaced: boolean }> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/shield`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader },
    body: '{}',
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.sessionId) {
    throw new Error(result.details || result.error || response.statusText);
  }
  return result;
}
