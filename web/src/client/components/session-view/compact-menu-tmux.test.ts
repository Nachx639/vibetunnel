// @vitest-environment happy-dom
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../shared/types.js';
import type { CompactMenu } from './compact-menu.js';
import './compact-menu.js';

const session = (overrides: Partial<Session>): Session =>
  ({
    id: 's1',
    name: 'zsh',
    command: ['zsh'],
    workingDir: '/tmp',
    status: 'running',
    startedAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
    ...overrides,
  }) as Session;

async function terminateLabel(value: Session): Promise<string | undefined> {
  const menu = await fixture<CompactMenu>(
    html`<compact-menu .session=${value} .onTerminateSession=${() => {}}></compact-menu>`
  );
  (menu.querySelector('button[aria-label="More actions menu"]') as HTMLButtonElement).click();
  await menu.updateComplete;
  return menu
    .querySelector('[data-testid="compact-terminate-session"]')
    ?.textContent?.replace(/\s+/g, ' ')
    .trim();
}

describe('compact-menu: ending a session', () => {
  afterEach(() => fixtureCleanup());

  it('says Terminate Session for an ordinary session', async () => {
    expect(await terminateLabel(session({}))).toBe('Terminate Session');
  });

  it('says Disconnect for a session attached to a tmux session, which keeps running', async () => {
    expect(
      await terminateLabel(session({ name: 'tmux: main', command: ['tmux', 'attach-session'] }))
    ).toBe('Disconnect');
  });
});
