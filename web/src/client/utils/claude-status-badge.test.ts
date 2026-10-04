// @vitest-environment happy-dom
import { render } from 'lit';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '../../shared/types.js';
import { setLocale } from '../i18n/index.js';
import { es } from '../i18n/locales/es.js';
import { renderClaudeStatusBadge } from './claude-status-badge.js';

function renderBadge(claudeStatus: Session['claudeStatus']) {
  const host = document.createElement('div');
  render(renderClaudeStatusBadge({ status: 'running', claudeStatus }), host);
  return host.querySelector('.claude-status-badge');
}

describe('renderClaudeStatusBadge', () => {
  afterEach(async () => {
    await setLocale('en');
  });

  it('says Claude is working or needs you in the chosen language, with the reason translated', async () => {
    await setLocale('es');

    const working = renderBadge({ status: 'busy' });
    expect(working?.textContent?.trim()).toBe(es['badge.claudeWorking']);
    expect(working?.getAttribute('title')).toBe(es['badge.claudeWorkingTitle']);

    const waiting = renderBadge({ status: 'waiting', waitingFor: 'permission prompt' });
    expect(waiting?.textContent?.trim()).toBe(`⏳ ${es['sessions.row.needsYou']}`);
    expect(waiting?.getAttribute('title')).toBe(
      es['badge.claudeWaitingTitleReason'].replace('{reason}', es['claudeWaiting.permission'])
    );
  });

  it('shows a calm badge, not "working", while only background agents run', async () => {
    await setLocale('es');
    const badge = renderBadge({ status: 'busy', waitingForBackground: true });
    expect(badge?.textContent?.trim()).toBe('Agentes en segundo plano');
    expect(badge?.getAttribute('title')).toBe('Esperando a agentes en segundo plano');
    expect(badge?.querySelector('.animate-pulse')).toBeNull();
  });
});
