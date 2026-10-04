import { html, nothing } from 'lit';
import type { Session } from '../../shared/types.js';
import { t } from '../i18n/index.js';
import { isBackgroundWait } from './claude-activity.js';
import { claudeWaitingLabel } from './claude-waiting-label.js';

/** "Claude working" / "Needs you" badge for sessions running Claude Code. */
export function renderClaudeStatusBadge(session: Pick<Session, 'claudeStatus' | 'status'>) {
  const claude = session.status === 'running' ? session.claudeStatus : undefined;
  if (isBackgroundWait(claude)) {
    // The reply is in; only background agents run: calm, no pulse.
    return html`<span
      class="claude-status-badge flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-sm bg-bg-elevated text-text-muted flex-shrink-0"
      title=${t('activity.backgroundWait')}
      >${t('badge.claudeBackground')}</span
    >`;
  }
  if (claude?.status === 'busy') {
    return html`<span
      class="claude-status-badge flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-sm bg-primary/15 text-primary flex-shrink-0"
      title=${t('badge.claudeWorkingTitle')}
      ><span class="w-1.5 h-1.5 rounded-full bg-primary animate-pulse"></span>${t('badge.claudeWorking')}</span
    >`;
  }
  if (claude?.status === 'waiting') {
    const reason = claudeWaitingLabel(claude.waitingFor);
    return html`<span
      class="claude-status-badge flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-sm bg-status-warning/20 text-status-warning font-semibold flex-shrink-0"
      title=${reason ? t('badge.claudeWaitingTitleReason', { reason }) : t('badge.claudeWaitingTitle')}
      >⏳ ${t('sessions.row.needsYou')}</span
    >`;
  }
  return nothing;
}
