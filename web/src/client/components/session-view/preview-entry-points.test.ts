// @vitest-environment happy-dom
/**
 * Where a session offers its dev-server preview: the header chip (only when the server
 * reported a dev server for it) and the session menu item (only when previews are on).
 * With previews off (the default) neither exists.
 */
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockSession } from '@/test/utils/lit-test-utils';
import type { Session } from '../../../shared/types.js';
import { setPreviewsAvailable } from '../../utils/preview-rows.js';
import type { CompactMenu } from './compact-menu.js';
import type { SessionHeader } from './session-header.js';

vi.mock('../../services/terminal-socket-client.js', () => ({
  terminalSocketClient: {
    initialize: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    getConnectionStatus: vi.fn(() => true),
    onConnectionStateChange: vi.fn(() => () => {}),
  },
}));

import './compact-menu.js';
import './session-header.js';

const withPorts = (ports: number[]): Session =>
  ({
    ...createMockSession({ id: 's1', name: 'web' }),
    previewPorts: ports.map((port) => ({ port, source: 'detected', at: 1 })),
  }) as Session;

describe('preview entry points in a session', () => {
  afterEach(() => {
    setPreviewsAvailable(false);
    fixtureCleanup();
  });

  it('the header chip shows only for a session with a known dev server', async () => {
    const without = await fixture<SessionHeader>(
      html`<session-header .session=${withPorts([])} .isMobile=${false}></session-header>`
    );
    expect(without.querySelector('[data-testid="preview-chip"]')).toBeNull();

    const header = await fixture<SessionHeader>(
      html`<session-header .session=${withPorts([5173])} .isMobile=${false}></session-header>`
    );
    const chip = header.querySelector<HTMLButtonElement>('[data-testid="preview-chip"]');
    expect(chip).not.toBeNull();
    const opened = vi.fn();
    window.addEventListener('vt-open-preview', opened);
    chip?.click();
    window.removeEventListener('vt-open-preview', opened);
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({
      sessionId: 's1',
      port: 5173,
    });
  });

  it('the menu offers "Preview" only while the server has previews on', async () => {
    const open = async () => {
      const menu = await fixture<CompactMenu>(
        html`<compact-menu .session=${withPorts([])}></compact-menu>`
      );
      (menu as unknown as { showMenu: boolean }).showMenu = true;
      await menu.updateComplete;
      return menu;
    };
    expect((await open()).querySelector('[data-testid="compact-preview"]')).toBeNull();
    setPreviewsAvailable(true);
    expect((await open()).querySelector('[data-testid="compact-preview"]')).not.toBeNull();
  });
});
