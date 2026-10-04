// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  restoreLocalStorage,
  setupFetchMock,
  setupLocalStorageMock,
  waitForAsync,
} from '@/test/utils/component-helpers';
import type { AuthClient } from '../services/auth-client';

vi.mock('../services/auth-client');

import type { SessionCreateForm } from './session-create-form';

// "Quick start" buttons of the new-session form whose program the server reports missing.
describe('new-session form: quick starts that are not installed', () => {
  let element: SessionCreateForm;
  let fetchMock: ReturnType<typeof setupFetchMock>;
  const authClient = {
    getAuthHeader: () => ({ Authorization: 'Bearer t' }),
  } as unknown as AuthClient;

  beforeAll(async () => {
    await import('./session-create-form');
  });

  beforeEach(() => {
    setupLocalStorageMock();
    fetchMock = setupFetchMock();
    fetchMock.mockResponse('/api/server/status', { macAppConnected: false, isHQMode: false });
    fetchMock.mockResponse('/api/config', {
      repositoryBasePath: '~/',
      quickStartCommands: [{ name: '✨ claude', command: 'claude' }, { command: 'gemini' }],
    });
    fetchMock.mockResponse('/api/quick-start/availability', { claude: true, gemini: false });
    fetchMock.mockResponse('/api/sessions', { sessionId: 'new-1' });
  });

  afterEach(() => {
    element?.remove();
    restoreLocalStorage();
    vi.clearAllMocks();
  });

  async function open() {
    element = await fixture<SessionCreateForm>(html`
      <session-create-form .authClient=${authClient} .visible=${true}></session-create-form>
    `);
    await waitForAsync();
    await element.updateComplete;
  }

  const quickStart = (label: string) =>
    [...element.querySelectorAll<HTMLButtonElement>('quick-start-section .grid button')].find(
      (button) => button.textContent?.includes(label)
    ) as HTMLButtonElement;
  const notice = () => element.querySelector('#quick-start-unavailable-notice');
  const sessionPosts = () => fetchMock.getCalls().filter(([url]) => url === '/api/sessions');

  it('dims the missing one with a note; the others look as before', async () => {
    await open();
    await vi.waitFor(() =>
      expect(quickStart('gemini').classList.contains('opacity-50')).toBe(true)
    );

    expect(quickStart('gemini').getAttribute('aria-disabled')).toBe('true');
    expect(quickStart('gemini').textContent).toContain('Not installed');
    expect(quickStart('claude').classList.contains('opacity-50')).toBe(false);
    expect(quickStart('claude').hasAttribute('aria-disabled')).toBe(false);
    expect(quickStart('claude').textContent).not.toContain('Not installed');
  });

  it('tapping it says why and picks nothing; an available one is picked and created', async () => {
    await open();
    await vi.waitFor(() =>
      expect(quickStart('gemini').classList.contains('opacity-50')).toBe(true)
    );
    const commandBefore = element.command;

    quickStart('gemini').click();
    await element.updateComplete;
    expect(notice()?.textContent?.trim()).toBe(
      'gemini is not installed on the computer running VibeTunnel'
    );
    expect(element.command).toBe(commandBefore);

    quickStart('claude').click();
    await element.updateComplete;
    expect(element.command).toBe('claude');
    expect(notice()).toBeNull();

    element.querySelector<HTMLButtonElement>('#session-create-button')?.click();
    await vi.waitFor(() => expect(sessionPosts()).toHaveLength(1));
    expect(JSON.parse(sessionPosts()[0][1]?.body as string).command).toEqual(['claude']);
  });

  it('on an HQ, whose sessions run on other machines, never asks and dims nothing', async () => {
    fetchMock.mockResponse('/api/server/status', { macAppConnected: false, isHQMode: true });
    fetchMock.mockResponse('/api/remotes', [{ id: 'm1', name: 'build box', url: 'http://m1' }]);
    await open();

    expect(quickStart('gemini').classList.contains('opacity-50')).toBe(false);
    expect(fetchMock.getCalls().some(([url]) => url === '/api/quick-start/availability')).toBe(
      false
    );
  });
});
