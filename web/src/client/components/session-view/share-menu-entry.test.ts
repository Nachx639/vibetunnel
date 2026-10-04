// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { describe, expect, it, vi } from 'vitest';
import { createMockSession } from '@/test/utils/lit-test-utils';
import type { CompactMenu } from './compact-menu.js';
import type { SessionStatusDropdown } from './session-status-dropdown.js';
import './compact-menu.js';
import './session-status-dropdown.js';

// The "Share (read-only)" entry exists only when session-view hands the menus an onShare
// callback, which it does only when the server reports `shareLinks: true`.
describe('share menu entry', () => {
  async function openCompact(
    onShareSession?: () => void,
    status: 'running' | 'exited' = 'running'
  ) {
    const el = await fixture<CompactMenu>(html`
      <compact-menu .session=${createMockSession({ status })} .onShareSession=${onShareSession}></compact-menu>
    `);
    el.querySelector<HTMLButtonElement>('button[aria-label="More actions menu"]')?.click();
    await el.updateComplete;
    return el;
  }

  async function openDropdown(onShare?: () => void) {
    const el = await fixture<SessionStatusDropdown>(html`
      <session-status-dropdown .session=${createMockSession({ status: 'running' })} .onShare=${onShare}></session-status-dropdown>
    `);
    el.querySelector<HTMLButtonElement>('button[data-menu-button]')?.click();
    await el.updateComplete;
    return el;
  }

  it('is hidden while share links are off', async () => {
    expect((await openCompact()).querySelector('[data-testid="compact-share-session"]')).toBeNull();
    expect((await openDropdown()).querySelector('[data-action="share"]')).toBeNull();
  });

  it('opens the share sheet from the phone menu and the desktop status menu when on', async () => {
    const onShare = vi.fn();
    const compact = await openCompact(onShare);
    compact.querySelector<HTMLButtonElement>('[data-testid="compact-share-session"]')?.click();
    const dropdown = await openDropdown(onShare);
    dropdown.querySelector<HTMLButtonElement>('[data-action="share"]')?.click();
    // The menus close first and run the action a moment later.
    await vi.waitFor(() => expect(onShare).toHaveBeenCalledTimes(2));
  });

  it('is not offered for a session that has exited', async () => {
    const compact = await openCompact(vi.fn(), 'exited');
    expect(compact.querySelector('[data-testid="compact-share-session"]')).toBeNull();
  });
});
