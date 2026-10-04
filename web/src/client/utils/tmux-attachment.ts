/**
 * A session attached to a tmux session from the Terminal Sessions dialog ("tmux: …") runs
 * only a tmux client. Ending it detaches that client, and the tmux session keeps running
 * (DELETE /api/sessions/:id tells it apart the same way and answers "Detached from tmux
 * session"), so the UI says "Disconnect", not "Kill".
 */
import type { Session } from '../../shared/types.js';

export function isTmuxAttachment(
  session: Pick<Session, 'name' | 'command'> | null | undefined
): boolean {
  if (!session) return false;
  return (
    (session.name ?? '').startsWith('tmux:') || (session.command ?? []).includes('tmux attach')
  );
}
