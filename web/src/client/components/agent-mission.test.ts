/**
 * @vitest-environment happy-dom
 */
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../shared/types.js';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';
import { setLocale } from '../i18n/index.js';
import type { AuthClient } from '../services/auth-client.js';
import { resetAgentChatCache } from '../utils/agent-chat.js';
import type { BroadcastIo } from '../utils/agent-mission.js';
import { resetGhostClickGuard } from '../utils/ghost-click.js';
import {
  AGENTS_INTRO_DISMISSED_KEY,
  type AgentMission,
  cardTitle,
  renderAgentsTabs,
} from './agent-mission.js';
import { SessionList } from './session-list.js';

const session = (id: string, overrides: Partial<Session> = {}): Session =>
  ({
    id,
    name: id,
    command: ['claude'],
    workingDir: '/Users/x/Projects/app',
    status: 'running',
    startedAt: '2030-10-02T10:00:00.000Z',
    lastModified: '2030-10-02T10:00:00.000Z',
    ...overrides,
  }) as Session;

const sessions = () => [
  session('idle', {
    claudeStatus: { status: 'idle', title: 'Refactor', since: Date.now() - 5000 },
  }),
  session('shell', { command: ['zsh'] }),
  session('busy', {
    claudeStatus: {
      status: 'busy',
      title: 'Tests',
      since: Date.now() - 60_000,
      activity: { kind: 'tool', tool: 'Bash', target: 'pnpm test', since: Date.now() - 20_000 },
    },
  }),
  session('wait', {
    claudeStatus: {
      status: 'waiting',
      title: 'Deploy',
      waitingFor: 'Bash',
      since: Date.now() - 1000,
      choices: { question: 'Do you want to proceed?', options: ['Yes', 'No'] },
    },
  }),
  session('codex', { codexActive: true, codexTitle: 'Port CLI', lastLine: 'Ran cargo build' }),
];

async function mount(list = sessions(), io?: BroadcastIo) {
  return fixture<AgentMission>(html`<agent-mission .sessions=${list} .io=${io}></agent-mission>`);
}

const at = (y: number) => ({
  pointerType: 'touch',
  pointerId: 7,
  clientX: 40,
  clientY: y,
  bubbles: true,
});
/** A finger down on `el` and up `dy` px away: iOS ends a scroll that began on it with a pointerup. */
function touch(el: Element, dy: number) {
  el.dispatchEvent(new PointerEvent('pointerdown', at(300)));
  el.dispatchEvent(new PointerEvent('pointerup', at(300 + dy)));
}

describe('agent-mission', () => {
  afterEach(async () => {
    await setLocale('en');
    vi.restoreAllMocks();
    for (const el of document.body.querySelectorAll('[data-testid="broadcast-sheet"]')) el.remove();
    // A touch in one test must not swallow the next test's first click.
    resetGhostClickGuard();
    fixtureCleanup();
  });

  it('shows agent cards, the one that needs you first, with what each is doing', async () => {
    await setLocale('en');
    const view = await mount();
    const cards = [...view.querySelectorAll<HTMLElement>('[data-testid="agent-card"]')];
    expect(cards.map((card) => card.dataset.sessionId)).toEqual(['wait', 'busy', 'codex', 'idle']);
    expect(cards[0].dataset.state).toBe('waiting');
    expect(cards[0].querySelector('[data-testid="agent-doing"]')?.textContent).toContain(
      'Needs you'
    );
    expect(cards[1].querySelector('[data-testid="agent-doing"]')?.textContent).toContain(
      'pnpm test'
    );
    expect(cards[1].querySelector('claude-activity-elapsed')).not.toBeNull();
    expect(cards[2].dataset.kind).toBe('codex');
    expect(cards[2].querySelector('[data-testid="agent-preview"]')?.textContent).toContain(
      'Ran cargo build'
    );
    // Singular where it's one, and no line ever starts with the separator.
    const counts = view.querySelector('[data-testid="mission-counts"]');
    const text = (counts?.textContent ?? '').replace(/\s+/g, ' ').trim();
    expect(text).toBe('1 needs you · 1 working · 2 idle');
    expect(
      [...(counts?.querySelectorAll('.vtm-count') ?? [])].map((part) =>
        part.textContent?.trim().startsWith('·')
      )
    ).not.toContain(true);
  });

  it('says what the tab is for until dismissed, then never again on this device', async () => {
    setupLocalStorageMock();
    await setLocale('en');
    const view = await mount();
    expect(view.querySelector('[data-testid="agents-intro"]')?.textContent).toContain(
      'Only your AI agents (Claude, Codex, Gemini) with their status'
    );
    touch(view.querySelector('[data-testid="agents-intro-dismiss"]') as HTMLElement, 2);
    await view.updateComplete;
    expect(view.querySelector('[data-testid="agents-intro"]')).toBeNull();

    fixtureCleanup();
    const again = await mount();
    expect(again.querySelector('[data-testid="agents-intro"]')).toBeNull();
    expect(localStorage.getItem(AGENTS_INTRO_DISMISSED_KEY)).toBe('1');
    restoreLocalStorage();
  });

  it('says "1 needs you" in the singular', async () => {
    await setLocale('en');
    const view = await mount([sessions()[0]]);
    const text = view.querySelector('[data-testid="mission-counts"]')?.textContent ?? '';
    expect(text.replace(/\s+/g, ' ').trim()).toBe('0 need you · 0 working · 1 idle');
  });

  it('opens a session on tap and selects cards after a long press', async () => {
    const view = await mount();
    const opened = vi.fn();
    view.addEventListener('session-select', (e) => opened((e as CustomEvent<Session>).detail.id));
    const card = () => view.querySelector<HTMLElement>('[data-session-id="busy"]') as HTMLElement;
    card().click();
    expect(opened).toHaveBeenCalledWith('busy');

    vi.useFakeTimers();
    card().dispatchEvent(
      new PointerEvent('pointerdown', { pointerType: 'touch', clientX: 5, clientY: 5 })
    );
    vi.advanceTimersByTime(600);
    card().dispatchEvent(
      new PointerEvent('pointerup', { pointerType: 'touch', clientX: 5, clientY: 5 })
    );
    vi.useRealTimers();
    await view.updateComplete;
    expect(opened).toHaveBeenCalledTimes(1);
    expect(card().getAttribute('aria-checked')).toBe('true');
    expect(view.querySelector('[data-testid="broadcast-bar"]')).not.toBeNull();
  });

  it('opens the answer sheet from "Needs you" on a waiting card, not the session', async () => {
    const view = await mount();
    const opened = vi.fn();
    const sheet = vi.fn();
    view.addEventListener('session-select', () => opened());
    const onSheet = (e: Event) => sheet((e as CustomEvent<{ sessionId: string }>).detail.sessionId);
    window.addEventListener('vt-open-answer-sheet', onSheet);
    try {
      const needs = view.querySelector<HTMLElement>(
        '[data-session-id="wait"] [data-testid="agent-doing"]'
      );
      touch(needs as HTMLElement, -100); // scrolling the list
      expect(sheet).not.toHaveBeenCalled();
      needs?.dispatchEvent(
        new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true })
      );
      needs?.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true }));
      expect(sheet).toHaveBeenCalledWith('wait');
      // A mouse click on it does the same; the card around it stays closed.
      await new Promise((resolve) => setTimeout(resolve, 750));
      needs?.click();
      expect(sheet).toHaveBeenCalledTimes(2);
      expect(opened).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('vt-open-answer-sheet', onSheet);
    }
  });

  it('a scroll that starts on a button does nothing, even if the list renders meanwhile', async () => {
    const view = await mount();
    const select = () => view.querySelector('[data-testid="mission-select"]') as HTMLElement;
    select().dispatchEvent(new PointerEvent('pointerdown', at(300)));
    // News from the server mid-scroll: the render makes new handlers.
    view.sessions = sessions();
    await view.updateComplete;
    select().dispatchEvent(new PointerEvent('pointerup', at(200)));
    await view.updateComplete;
    expect(view.querySelector('[data-testid="broadcast-bar"]')).toBeNull();
    touch(select(), 2);
    select().click();
    await view.updateComplete;
    expect(view.querySelector('[data-testid="broadcast-bar"]')).not.toBeNull();
  });

  it('confirms the targets, skips the one in a dialog and reports each result', async () => {
    const screens: Record<string, string> = {
      wait: 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n',
      busy: '✻ Running…\n  ⏵⏵ accept edits on\n',
      idle: '> \n  ? for shortcuts\n',
      codex: '› \n',
    };
    const send = vi.fn(async () => {});
    const view = await mount(sessions(), { readScreen: async (id) => screens[id], send });
    (view.querySelector('[data-testid="mission-select"]') as HTMLElement).click();
    await view.updateComplete;
    (view.querySelector('[data-testid="mission-select-all"]') as HTMLElement).click();
    await view.updateComplete;
    const input = view.querySelector('[data-testid="broadcast-input"]') as HTMLInputElement;
    input.value = 'Ejecuta los tests';
    input.dispatchEvent(new Event('input'));
    await view.updateComplete;
    (view.querySelector('[data-testid="broadcast-send"]') as HTMLElement).click();

    const sheet = document.body.querySelector('[data-testid="broadcast-sheet"]') as HTMLElement;
    expect(sheet.querySelector('[data-testid="broadcast-title"]')?.textContent).toContain(
      'Ejecuta los tests'
    );
    expect(sheet.querySelectorAll('[data-testid="broadcast-target"]')).toHaveLength(4);

    // The tap that opened the sheet can't also confirm it.
    const confirm = () =>
      sheet.querySelector('[data-testid="broadcast-confirm"]') as HTMLElement | null;
    confirm()?.click();
    expect(send).not.toHaveBeenCalled();

    const opened = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(opened + 600);
    confirm()?.click();
    await vi.waitFor(() =>
      expect(sheet.querySelectorAll('[data-testid="broadcast-result"]')).toHaveLength(4)
    );
    const outcomes = Object.fromEntries(
      [...sheet.querySelectorAll<HTMLElement>('[data-testid="broadcast-target"]')].map((row) => [
        row.dataset.sessionId,
        (row.querySelector('[data-testid="broadcast-result"]') as HTMLElement).dataset.outcome,
      ])
    );
    expect(outcomes).toEqual({ wait: 'blocked', busy: 'sent', codex: 'sent', idle: 'sent' });
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).not.toHaveBeenCalledWith('wait', expect.anything());
    expect(sheet.querySelector('[data-testid="broadcast-title"]')?.textContent).toContain(
      'Sent to 3 of 4'
    );
  });
  it('reports a tmux session opened only to watch as skipped, not sent', async () => {
    const send = vi.fn(async () => {});
    const watching = session('watch', {
      claudeStatus: { status: 'idle', title: 'Watched' },
      multiplexer: {
        type: 'tmux',
        socketPath: '/tmp/tmux-501/default',
        serverPid: 15674,
        serverStartedAt: 1727426400,
        sessionId: '$0',
        sessionName: '0',
        mode: 'watch',
        sizing: 'others',
        source: 'mac-sessions',
      },
    });
    const view = await mount([watching], {
      readScreen: async () => '> \n  ? for shortcuts\n',
      send,
    });
    (view.querySelector('[data-testid="mission-select"]') as HTMLElement).click();
    await view.updateComplete;
    (view.querySelector('[data-testid="mission-select-all"]') as HTMLElement).click();
    await view.updateComplete;
    const input = view.querySelector('[data-testid="broadcast-input"]') as HTMLInputElement;
    input.value = 'Sigue';
    input.dispatchEvent(new Event('input'));
    await view.updateComplete;
    (view.querySelector('[data-testid="broadcast-send"]') as HTMLElement).click();
    const sheet = document.body.querySelector('[data-testid="broadcast-sheet"]') as HTMLElement;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600);
    (sheet.querySelector('[data-testid="broadcast-confirm"]') as HTMLElement).click();
    await vi.waitFor(() =>
      expect(sheet.querySelector('[data-testid="broadcast-result"]')?.textContent?.trim()).toBe(
        'Skipped: watch only'
      )
    );
    expect(send).not.toHaveBeenCalled();
  });
});

describe('agent card title', () => {
  it("is Claude's title when there is one, else the name", () => {
    const base = {
      id: 'a',
      name: 'claude (~/Projects)',
      command: ['claude'],
      claudeStatus: { status: 'idle', title: 'Fix login' },
    } as Session;
    expect(cardTitle(base)).toBe('Fix login');
    expect(cardTitle({ ...base, claudeStatus: undefined })).toBe('claude (~/Projects)');
  });
});

describe('session-list entry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetAgentChatCache();
    window.history.replaceState(null, '', '/');
    fixtureCleanup();
  });

  it('a scroll that starts on a tab does not switch lists; a still tap does', async () => {
    const host = await fixture<HTMLElement>(
      html`<div>${renderAgentsTabs(false, sessions())}</div>`
    );
    const tab = host.querySelector('[data-testid="tab-agents"]') as HTMLElement;
    touch(tab, -100);
    expect(window.location.pathname).toBe('/');
    touch(tab, 2);
    tab.click();
    expect(window.location.pathname).toBe('/agents');
  });

  it('switches the phone list to mission control on /agents, with agent chat on', async () => {
    resetAgentChatCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ agentChat: true }), { status: 200 }))
    );
    vi.spyOn(
      SessionList.prototype as unknown as { usePhoneRows: () => boolean },
      'usePhoneRows'
    ).mockReturnValue(true);
    const list = await fixture<SessionList>(
      html`<session-list
        .sessions=${sessions()}
        .authClient=${{ getAuthHeader: () => ({}) } as unknown as AuthClient}
      ></session-list>`
    );
    await vi.waitFor(() =>
      expect(list.querySelector('[data-testid="agents-tabs"]')).not.toBeNull()
    );
    expect(list.querySelector('agent-mission')).toBeNull();
    expect(list.querySelector('[data-testid="phone-session-list"]')).not.toBeNull();
    // The Agents tab shows how many need you.
    expect(list.querySelector('[data-testid="tab-agents"]')?.textContent).toContain('1');

    (list.querySelector('[data-testid="tab-agents"]') as HTMLElement).click();
    await list.updateComplete;
    expect(window.location.pathname).toBe('/agents');
    expect(list.querySelector('agent-mission')).not.toBeNull();
    expect(list.querySelector('[data-testid="phone-session-list"]')).toBeNull();

    const opened = vi.fn();
    list.addEventListener('navigate-to-session', (e) =>
      opened((e as CustomEvent<{ sessionId: string }>).detail.sessionId)
    );
    await (list.querySelector('agent-mission') as AgentMission).updateComplete;
    (list.querySelector('[data-session-id="wait"]') as HTMLElement).click();
    expect(opened).toHaveBeenCalledWith('wait');

    window.history.pushState(null, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await list.updateComplete;
    expect(list.querySelector('agent-mission')).toBeNull();
  });

  it('offers no Agents tab while agent chat is off', async () => {
    resetAgentChatCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ agentChat: false }), { status: 200 }))
    );
    vi.spyOn(
      SessionList.prototype as unknown as { usePhoneRows: () => boolean },
      'usePhoneRows'
    ).mockReturnValue(true);
    window.history.replaceState(null, '', '/agents');
    const list = await fixture<SessionList>(
      html`<session-list
        .sessions=${sessions()}
        .authClient=${{ getAuthHeader: () => ({}) } as unknown as AuthClient}
      ></session-list>`
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await list.updateComplete;
    expect(list.querySelector('[data-testid="agents-tabs"]')).toBeNull();
    expect(list.querySelector('agent-mission')).toBeNull();
    expect(list.querySelector('ask-claude-box')).toBeNull();
    expect(list.querySelector('[data-testid="phone-session-list"]')).not.toBeNull();
  });

  it('"Ask Claude…" starts Claude and hands the question to the server, with agent chat on', async () => {
    resetAgentChatCache();
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/sessions' && init?.method === 'POST') {
          posted.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ sessionId: 'new-1' }), { status: 200 });
        }
        return new Response(JSON.stringify({ agentChat: true, repositoryBasePath: '~' }), {
          status: 200,
        });
      })
    );
    vi.spyOn(
      SessionList.prototype as unknown as { usePhoneRows: () => boolean },
      'usePhoneRows'
    ).mockReturnValue(true);
    const list = await fixture<SessionList>(
      html`<session-list
        .sessions=${sessions()}
        .authClient=${{ getAuthHeader: () => ({}) } as unknown as AuthClient}
      ></session-list>`
    );
    await vi.waitFor(() => expect(list.querySelector('ask-claude-box')).not.toBeNull());
    const box = list.querySelector('ask-claude-box') as HTMLElement & { send(): void };
    const textarea = box.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'fix the tests';
    textarea.dispatchEvent(new Event('input'));
    box.send();
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      command: ['claude'],
      initialInput: 'fix the tests',
      initialInputAgent: 'claude',
    });
  });
});

describe('agent-mission while background agents run', () => {
  afterEach(async () => {
    await setLocale('en');
    fixtureCleanup();
  });

  it('shows a Claude busy only for background agents as waiting for them, not working', async () => {
    await setLocale('en');
    const view = await mount([
      session('bg', {
        claudeStatus: {
          status: 'busy',
          waitingForBackground: true,
          title: 'Agents',
          since: Date.now() - 60_000,
        },
      }),
    ]);
    const card = view.querySelector<HTMLElement>('[data-testid="agent-card"]');
    expect(card?.dataset.state).toBe('idle');
    expect(card?.querySelector('[data-testid="agent-doing"]')?.textContent).toBe(
      'Waiting for background agents'
    );
  });
});
