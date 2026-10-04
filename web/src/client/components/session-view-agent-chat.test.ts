// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetViewport, setupFetchMock, setViewport } from '@/test/utils/component-helpers';
import { createMockSession } from '@/test/utils/lit-test-utils';
import { resetFactoryCounters } from '@/test/utils/test-factories';
import { resetAgentChatCache } from '../utils/agent-chat.js';
import type { ClaudeChatView } from './claude-chat-view.js';
import type { SessionView } from './session-view';
import type { TerminalChatView } from './terminal-chat-view.js';

vi.mock('../services/terminal-socket-client.js', () => ({
  terminalSocketClient: {
    initialize: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    getConnectionStatus: vi.fn(() => true),
    onConnectionStateChange: vi.fn(() => () => {}),
    sendInputText: vi.fn().mockReturnValue(true),
    sendInputKey: vi.fn().mockReturnValue(true),
    sendResize: vi.fn().mockReturnValue(true),
    sendResetSize: vi.fn().mockReturnValue(true),
  },
}));

interface Internals {
  uiStateManager: {
    setIsMobile(value: boolean): void;
    setChatMode(value: boolean): void;
    getState(): { chatMode: boolean };
  };
  handleToggleChatMode(): void;
}

const internals = (element: SessionView) => element as unknown as Internals;

describe('SessionView phone chat with agent chat', () => {
  let fetchMock: ReturnType<typeof setupFetchMock>;
  let element: SessionView;

  beforeAll(async () => {
    await import('./session-view');
    await import('./terminal');
    await import('./session-view/terminal-renderer');
  });

  const touchPoints = navigator.maxTouchPoints;

  /** The chatMode last written to the app preferences (localStorage is a mock in tests). */
  const savedChatMode = (): boolean | undefined => {
    const writes = vi
      .mocked(localStorage.setItem)
      .mock.calls.filter(([key]) => key === 'vibetunnel_app_preferences')
      .map(([, value]) => JSON.parse(String(value)) as { chatMode?: boolean })
      .filter((preferences) => 'chatMode' in preferences);
    return writes.at(-1)?.chatMode;
  };

  async function open(options: { agentChat: boolean; mobile?: boolean }) {
    // A touch device, as a phone is when the view connects.
    Object.defineProperty(navigator, 'maxTouchPoints', {
      value: options.mobile === false ? 0 : 2,
      configurable: true,
    });
    fetchMock.mockResponse('/api/config', {
      repositoryBasePath: '~/',
      agentChat: options.agentChat,
    });
    element = await fixture<SessionView>(html`<session-view></session-view>`);
    element.session = createMockSession({ status: 'running', command: ['claude'] });
    internals(element).uiStateManager.setIsMobile(options.mobile ?? true);
    await element.updateComplete;
  }

  /** Chat mode is on once the server said which chat mode to use (agentChat). */
  async function enterChatMode() {
    internals(element).handleToggleChatMode();
    await vi.waitFor(() =>
      expect(internals(element).uiStateManager.getState().chatMode).toBe(true)
    );
    element.requestUpdate();
    await element.updateComplete;
  }

  beforeEach(() => {
    resetFactoryCounters();
    resetAgentChatCache();
    vi.mocked(localStorage.setItem).mockClear();
    vi.mocked(localStorage.getItem).mockReset();
    setViewport(375, 667);
    fetchMock = setupFetchMock();
    fetchMock.mockResponse('/api/server/status', {
      macAppConnected: false,
      cloudflareEnabled: false,
      isDevelopmentServer: false,
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'maxTouchPoints', { value: touchPoints, configurable: true });
    element?.remove();
    fetchMock.clear();
    resetViewport();
    vi.clearAllMocks();
  });

  it('asks the server nothing on opening unless the phone chose agent chat mode before', async () => {
    await open({ agentChat: true });
    const asked = fetchMock.getCalls().some(([url]) => String(url).includes('/api/config'));
    expect(asked).toBe(false);
  });

  it('keeps the classic chat mode while agent chat is off, and remembers nothing', async () => {
    await open({ agentChat: false });
    await enterChatMode();

    expect(element.querySelector('claude-chat-view')).toBeNull();
    expect(element.querySelector('terminal-chat-view[composeronly]')).toBeNull();
    const classic = element.querySelector('terminal-chat-view');
    expect(classic).toBeTruthy();
    expect(classic?.getAttribute('style')).not.toContain('display: none');
    expect(element.querySelector<HTMLElement>('terminal-renderer')?.style.display).toBe('none');
    expect(savedChatMode()).toBeUndefined();
  });

  it('shows the conversation over the live terminal and a composer under it when on', async () => {
    await open({ agentChat: true });
    await enterChatMode();

    expect(element.querySelector('claude-chat-view')).toBeTruthy();
    expect(element.querySelector('terminal-chat-view[composeronly]')).toBeTruthy();
    const terminal = element.querySelector<HTMLElement>('terminal-renderer');
    expect(terminal?.style.display).not.toBe('none');
    const actionBar = element.querySelector('mobile-action-bar') as
      | (HTMLElement & { visible: boolean })
      | null;
    expect(actionBar?.visible).toBe(false);
  });

  it('neither paints the terminal under the conversation nor lets it take the focus', async () => {
    await open({ agentChat: true });
    await enterChatMode();
    const terminal = () => element.querySelector<HTMLElement>('terminal-renderer');
    const covered = async (on: boolean) => {
      element
        .querySelector('claude-chat-view')
        ?.dispatchEvent(new CustomEvent('claude-chat-availability', { detail: on, bubbles: true }));
      await element.updateComplete;
    };

    await covered(true);
    expect(terminal()?.style.visibility).toBe('hidden');
    expect(terminal()?.hasAttribute('inert')).toBe(true);

    // A session without a conversation to show: the chat view steps aside, the terminal shows.
    await covered(false);
    expect(terminal()?.style.visibility).not.toBe('hidden');
    expect(terminal()?.hasAttribute('inert')).toBe(false);
  });

  it('wires the composer to the conversation: focus, sent bubbles, failures and Retry', async () => {
    const sessionId = 'agent-chat-session';
    fetchMock.mockResponse(`/api/sessions/${sessionId}/claude-chat`, {
      available: true,
      status: 'idle',
      messages: [],
    });
    await open({ agentChat: true });
    element.session = createMockSession({ id: sessionId, status: 'running' });
    await enterChatMode();

    const chat = element.querySelector('claude-chat-view') as ClaudeChatView | null;
    const composer = element.querySelector(
      'terminal-chat-view[composeronly]'
    ) as TerminalChatView | null;
    if (!chat || !composer) throw new Error('phone chat not rendered');

    const followLatest = vi.spyOn(chat, 'followLatest');
    composer.dispatchEvent(new CustomEvent('composer-focus', { bubbles: true, composed: true }));
    expect(followLatest).toHaveBeenCalledTimes(1);

    const sent = vi.spyOn(chat, 'addSentMessage');
    const message = { sessionId, id: 'p1', text: 'hello', at: Date.now(), startedAt: 0 };
    composer.dispatchEvent(
      new CustomEvent('chat-message-sent', { detail: message, bubbles: true, composed: true })
    );
    expect(sent).toHaveBeenCalledWith(message);

    const failed = vi.spyOn(chat, 'markSendFailed');
    const ref = { sessionId, id: 'p1' };
    composer.dispatchEvent(
      new CustomEvent('chat-message-failed', { detail: ref, bubbles: true, composed: true })
    );
    expect(failed).toHaveBeenCalledWith(ref);

    const resend = vi.spyOn(composer, 'resendMessage');
    chat.dispatchEvent(
      new CustomEvent('chat-message-retry', { detail: ref, bubbles: true, composed: true })
    );
    expect(resend).toHaveBeenCalledWith(ref);
  });

  it('remembers chat mode on the phone only once the user turns it on', async () => {
    await open({ agentChat: true });
    expect(internals(element).uiStateManager.getState().chatMode).toBe(false);
    expect(savedChatMode()).toBeUndefined();
    await enterChatMode();
    expect(savedChatMode()).toBe(true);
    element.remove();

    // The next session view opens in chat mode.
    vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
      key === 'vibetunnel_app_preferences' ? JSON.stringify({ chatMode: true }) : null
    );
    resetAgentChatCache();
    await open({ agentChat: true });
    await vi.waitFor(() =>
      expect(internals(element).uiStateManager.getState().chatMode).toBe(true)
    );
  });

  it('lays the chat out for a phone on its side only in the compact phone layout', async () => {
    const landscapeOf = () => ({
      chat: (element.querySelector('claude-chat-view') as ClaudeChatView | null)?.landscape,
      composer: (
        element.querySelector('terminal-chat-view[composeronly]') as TerminalChatView | null
      )?.landscape,
    });
    // A small phone on its side, under Safari's bars.
    setViewport(667, 330);

    // Classic layout (the default): unchanged, no landscape chat.
    await open({ agentChat: true });
    await enterChatMode();
    expect(landscapeOf()).toEqual({ chat: false, composer: false });
    element.remove();

    // Compact layout: the centred column and the composer's ⚡ button.
    vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
      key === 'vibetunnel_app_preferences' ? JSON.stringify({ phoneUi: 'compact' }) : null
    );
    await open({ agentChat: true });
    await enterChatMode();
    expect(landscapeOf()).toEqual({ chat: true, composer: true });
  });

  it('keeps the classic desktop chat mode even with agent chat on', async () => {
    await open({ agentChat: true, mobile: false });
    await enterChatMode();
    expect(element.querySelector('claude-chat-view')).toBeNull();
    expect(element.querySelector('terminal-chat-view[composeronly]')).toBeNull();
  });
});
