// @vitest-environment happy-dom
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MultiplexerStatus } from '../../shared/multiplexer-types.js';
import { setLocale } from '../i18n/index.js';
import { apiClient } from '../services/api-client.js';
import type { MultiplexerModal } from './multiplexer-modal.js';
import './multiplexer-modal.js';

const twoMinutesAgo = () => String(Math.floor(Date.now() / 1000) - 120);

const status = (): MultiplexerStatus => ({
  tmux: {
    available: true,
    type: 'tmux',
    sessions: [
      { name: 'main', type: 'tmux', windows: 1, attached: true, activity: twoMinutesAgo() },
      { name: 'build', type: 'tmux', windows: 3 },
    ],
  },
  zellij: { available: false, type: 'zellij', sessions: [] },
  screen: { available: false, type: 'screen', sessions: [] },
});

describe('multiplexer-modal', () => {
  afterEach(async () => {
    await setLocale('en');
    vi.restoreAllMocks();
    fixtureCleanup();
  });

  it("names each tmux session by its pane's title, program and folder", async () => {
    // "0" and "1" tell little; the pane's title is Claude Code's conversation.
    vi.spyOn(apiClient, 'get').mockImplementation((async (path: string) =>
      path === '/multiplexer/status'
        ? {
            ...status(),
            tmux: {
              available: true,
              type: 'tmux',
              sessions: [
                {
                  name: '0',
                  type: 'tmux',
                  windows: 1,
                  title: 'Fix the login form',
                  command: 'claude',
                  path: '/Users/someone/project',
                },
              ],
            },
          }
        : { windows: [] }) as typeof apiClient.get);
    const modal = await fixture<MultiplexerModal>(
      html`<multiplexer-modal open></multiplexer-modal>`
    );
    const text = (id: string) =>
      modal.querySelector(`[data-testid="${id}"]`)?.textContent?.replace(/\s+/g, ' ').trim();
    // The tmux session's name stays first, as before; the title gets a line of its own.
    await vi.waitFor(() => expect(text('multiplexer-session-name')).toBe('0'));
    expect(text('multiplexer-session-title')).toBe('Fix the login form');
    expect(text('multiplexer-session-where')).toBe('claude · ~/project');
    // Those lines do not wrap: the dialog must still shrink to the phone (a flex item does not
    // go below its content's width without min-width: 0; it spilled past both edges).
    expect(modal.querySelector('modal-wrapper')?.classList.contains('min-w-0')).toBe(true);
    // Stacked on phones (the buttons under the title), side by side from sm up.
    const row = modal.querySelector('[data-testid="multiplexer-session-row"]');
    expect(row?.classList.contains('flex-col')).toBe(true);
    expect(row?.classList.contains('sm:flex-row')).toBe(true);
  });

  it('lists tmux sessions in the chosen language and follows a language change', async () => {
    vi.spyOn(apiClient, 'get').mockImplementation((async (path: string) =>
      path === '/multiplexer/status' ? status() : { windows: [] }) as typeof apiClient.get);
    await setLocale('es');
    const modal = await fixture<MultiplexerModal>(
      html`<multiplexer-modal open></multiplexer-modal>`
    );
    const spans = () => [...modal.querySelectorAll('span')].map((span) => span.textContent?.trim());

    await vi.waitFor(() => expect(spans()).toContain('1 ventana'));
    expect(modal.querySelector('h2')?.textContent).toBe('Sesiones de terminal');
    // Without a title, program or folder the row shows only the name, as before.
    expect(modal.querySelector('[data-testid="multiplexer-session-title"]')).toBeNull();
    expect(modal.querySelector('[data-testid="multiplexer-session-where"]')).toBeNull();
    expect(spans()).toContain('3 ventanas');
    expect(spans()).toContain('Última actividad: hace 2 min');

    await setLocale('en');
    await modal.updateComplete;
    expect(modal.querySelector('h2')?.textContent).toBe('Terminal Sessions');
    expect(spans()).toEqual(
      expect.arrayContaining(['1 window', '3 windows', 'Last activity: 2m ago'])
    );
  });
});

describe('modal-wrapper', () => {
  it('lets its dialog shrink to the screen whatever lines it holds', async () => {
    const wrapper = await fixture(html`<modal-wrapper visible><p>hi</p></modal-wrapper>`);
    expect(
      wrapper.querySelector('[data-testid="modal-content"]')?.classList.contains('min-w-0')
    ).toBe(true);
    fixtureCleanup();
  });
});
