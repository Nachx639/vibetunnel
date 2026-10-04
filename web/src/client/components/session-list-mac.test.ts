// @vitest-environment happy-dom
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MacAgentSession,
  MacSessionItem,
  MacSessionsResponse,
  MacTmuxSession,
} from '../../shared/mac-sessions.js';
import type { Session } from '../../shared/types.js';
import type { AuthClient } from '../services/auth-client.js';
import type { MacSessionRow } from './mac-session-row.js';
import type { PhoneSessionRow } from './phone-session-row.js';
import { SessionList } from './session-list.js';

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const session = (id: string, over: Partial<Session> = {}): Session =>
  ({
    id,
    name: id,
    command: ['zsh'],
    workingDir: '/tmp',
    status: 'running',
    startedAt: at(10),
    lastModified: at(1),
    ...over,
  }) as unknown as Session;

const tmux = (over: Partial<MacTmuxSession> = {}): MacTmuxSession => ({
  kind: 'tmux',
  id: 't-4100-1759490000-0',
  name: 'work',
  server: { label: '', isDefault: true },
  windows: 2,
  activityAt: at(2),
  current: {
    windowIndex: 1,
    windowName: 'zsh',
    command: 'zsh',
    cwd: '/srv/api',
    width: 80,
    height: 24,
  },
  agents: [],
  alsoOpenIn: [],
  canOpen: true,
  ...over,
});

const agent = (over: Partial<MacAgentSession> = {}): MacAgentSession => ({
  kind: 'agent',
  id: 'a-20085-1759500000',
  chatId: 'a-20085-1759500000',
  agent: 'claude',
  app: 'Terminal',
  cwd: '/srv/docs',
  startedAt: at(30),
  status: { status: 'idle', title: 'Docs pass' },
  ...over,
});

const listed = (
  items: MacSessionItem[],
  over: Partial<MacSessionsResponse> = {}
): MacSessionsResponse => ({
  enabled: true,
  platform: 'darwin',
  openMode: 'control',
  items,
  warnings: [],
  ...over,
});

const mount = (
  options: {
    sessions?: Session[];
    mac?: MacSessionsResponse | null;
    compact?: boolean;
    hideExited?: boolean;
  } = {}
) =>
  fixture<SessionList>(
    html`<session-list
      .sessions=${options.sessions ?? []}
      .macSessions=${options.mac ?? null}
      .compactMode=${options.compact ?? false}
      .hideExited=${options.hideExited ?? true}
      .authClient=${{ getAuthHeader: () => ({}) } as unknown as AuthClient}
    ></session-list>`
  );

const section = (list: Element) => list.querySelector('[data-testid="mac-section"]');
const heading = (list: Element) =>
  list
    .querySelector('[data-testid="mac-section-heading"]')
    ?.textContent?.replace(/\s+/g, ' ')
    .trim();
/** The rows of "On this Mac", in order: VibeTunnel sessions by id, Mac items by theirs. */
const macRows = (list: Element) =>
  [...list.querySelectorAll('[data-testid="mac-session-list"] > *')].map((row) =>
    row.localName === 'phone-session-row'
      ? `vt:${(row as PhoneSessionRow).session.id}`
      : `mac:${(row as MacSessionRow).item.id}`
  );
const runningRows = (list: Element) =>
  [
    ...list.querySelectorAll<PhoneSessionRow>(
      '[data-testid="phone-session-list"] phone-session-row'
    ),
  ].map((row) => row.session.id);
const follows = (first: Element | null, second: Element | null) =>
  Boolean(
    first && second && first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING
  );

describe('session list: "On this computer"', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    vi.spyOn(
      SessionList.prototype as unknown as { usePhoneRows: () => boolean },
      'usePhoneRows'
    ).mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({}))
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fixtureCleanup();
  });

  it('sits between the running sessions and the finished ones', async () => {
    const list = await mount({
      sessions: [session('a'), session('x', { status: 'exited' })],
      mac: listed([tmux(), agent()]),
      hideExited: false,
    });
    expect(macRows(list)).toEqual(['mac:t-4100-1759490000-0', 'mac:a-20085-1759500000']);
    expect(heading(list)).toBe('On this Mac (2)');
    const running = list.querySelector('[data-testid="phone-session-list"]');
    const finished = list.querySelector('[data-testid="phone-clear-finished"]');
    expect(follows(running, section(list))).toBe(true);
    expect(follows(section(list), finished)).toBe(true);
    // Mac items never become VibeTunnel sessions.
    expect(list.sessions.map((s) => s.id)).toEqual(['a', 'x']);
  });

  it('says "On this computer" off macOS', async () => {
    const list = await mount({
      sessions: [session('a')],
      mac: listed([tmux()], { platform: 'linux' }),
    });
    expect(heading(list)).toBe('On this computer (1)');
  });

  it.each([
    ['no such API on the server', null],
    ['turned off', listed([tmux()], { enabled: false, reason: 'disabled' })],
    ['nothing to list', listed([])],
  ])('is hidden with %s', async (_why, mac) => {
    const list = await mount({ sessions: [session('a')], mac });
    expect(section(list)).toBeNull();
  });

  it('shows on the empty screen too, below its start buttons', async () => {
    const list = await mount({ mac: listed([agent()]) });
    const empty = list.querySelector('[data-testid="phone-empty"]');
    expect(empty).not.toBeNull();
    expect(macRows(list)).toEqual(['mac:a-20085-1759500000']);
    // Its rows come and go with each answer: above the buttons they would move them.
    expect(follows(empty, section(list))).toBe(true);
  });

  it('shows in the sidebar opened from a session', async () => {
    const list = await mount({ sessions: [session('a')], mac: listed([tmux()]), compact: true });
    expect(macRows(list)).toEqual(['mac:t-4100-1759490000-0']);
  });

  it('says once under its heading what could not be listed', async () => {
    const list = await mount({
      sessions: [session('a')],
      mac: listed([], {
        warnings: [
          { code: 'tmux-unreachable' },
          { code: 'tmux-unreachable' },
          { code: 'scan-partial' },
        ],
      }),
    });
    expect(
      [...list.querySelectorAll('[data-testid="mac-section-warning"]')].map((p) =>
        p.textContent?.trim()
      )
    ).toEqual([
      'A tmux server didn’t answer.',
      'Some sessions on this computer couldn’t be listed.',
    ]);
    expect(heading(list)).toBe('On this Mac (0)');
  });

  it('says tmux is missing only beside the agents it lists, never as a section alone', async () => {
    const noTmux = [{ code: 'tmux-unavailable' as const }];
    const list = await mount({ sessions: [session('a')], mac: listed([], { warnings: noTmux }) });
    expect(section(list)).toBeNull();

    fixtureCleanup();
    const empty = await mount({ mac: listed([], { warnings: noTmux }) });
    expect(empty.querySelector('[data-testid="phone-empty"]')).not.toBeNull();
    expect(section(empty)).toBeNull();

    fixtureCleanup();
    const agents = await mount({
      sessions: [session('a')],
      mac: listed([agent()], { warnings: noTmux }),
    });
    expect(
      [...agents.querySelectorAll('[data-testid="mac-section-warning"]')].map((p) =>
        p.textContent?.trim()
      )
    ).toEqual(['tmux isn’t installed, so only agents are listed.']);
    expect(macRows(agents)).toEqual(['mac:a-20085-1759500000']);
  });

  it('collapses, and stays collapsed on this device', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    });
    const sessions = [session('a')];
    const mac = listed([tmux(), agent()], { warnings: [{ code: 'scan-partial' }] });
    const list = await mount({ sessions, mac });
    const toggle = () =>
      list.querySelector<HTMLButtonElement>('[data-testid="mac-section-toggle"]');
    const rows = () => list.querySelector(`#${toggle()?.getAttribute('aria-controls')}`);
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle()?.getAttribute('aria-label')).toBe('Hide these sessions');
    expect(rows()?.hasAttribute('hidden')).toBe(false);

    toggle()?.click();
    await list.updateComplete;
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    expect(toggle()?.getAttribute('aria-label')).toBe('Show these sessions');
    expect(rows()?.hasAttribute('hidden')).toBe(true);
    expect(macRows(list)).toEqual([]);
    expect(list.querySelector('[data-testid="mac-section-warning"]')).toBeNull();
    // The heading still counts what is inside.
    expect(heading(list)).toBe('On this Mac (2)');
    expect(store.get('vt-mac-section-collapsed')).toBe('1');

    fixtureCleanup();
    const again = await mount({ sessions, mac });
    expect(
      again.querySelector('[data-testid="mac-section-toggle"]')?.getAttribute('aria-expanded')
    ).toBe('false');
    again.querySelector<HTMLButtonElement>('[data-testid="mac-section-toggle"]')?.click();
    await again.updateComplete;
    expect(macRows(again)).toEqual(['mac:t-4100-1759490000-0', 'mac:a-20085-1759500000']);
    expect(store.has('vt-mac-section-collapsed')).toBe(false);
  });

  describe('search', () => {
    const items = [
      tmux(),
      tmux({ id: 't-4100-1759490000-1', name: 'build' }),
      agent(),
      agent({
        id: 'a-1-2',
        chatId: 'a-1-2',
        app: 'Visual Studio Code',
        cwd: '/srv/web',
        status: undefined,
      }),
    ];
    const search = async (list: SessionList, text: string) => {
      const input = list.querySelector<HTMLInputElement>('.phone-search input');
      if (!input) throw new Error('no search box');
      input.value = text;
      input.dispatchEvent(new Event('input'));
      await list.updateComplete;
    };

    it('counts what "On this Mac" lists for showing the search box', async () => {
      const sessions = [session('alpha'), session('beta'), session('gamma')];
      expect(
        (await mount({ sessions, mac: listed(items.slice(0, 3)) })).querySelector('.phone-search')
      ).toBeNull();
      fixtureCleanup();
      expect(
        (await mount({ sessions, mac: listed(items) })).querySelector('.phone-search')
      ).not.toBeNull();
    });

    it('finds Mac items by folder, app or name', async () => {
      const sessions = [session('alpha'), session('beta'), session('gamma')];
      const list = await mount({
        sessions,
        mac: listed(items, { warnings: [{ code: 'scan-partial' }] }),
      });

      await search(list, 'docs');
      expect(macRows(list)).toEqual(['mac:a-20085-1759500000']);
      expect(runningRows(list)).toEqual([]);
      expect(list.querySelector('.phone-search-empty')).toBeNull();
      // Warnings are not search results.
      expect(list.querySelector('[data-testid="mac-section-warning"]')).toBeNull();

      await search(list, 'visual studio');
      expect(macRows(list)).toEqual(['mac:a-1-2']);

      await search(list, 'build');
      expect(macRows(list)).toEqual(['mac:t-4100-1759490000-1']);

      await search(list, 'nothing like this');
      expect(section(list)).toBeNull();
      expect(list.querySelector('.phone-search-empty')).not.toBeNull();
    });
  });

  it('its rows reach the app as other rows do; Clear finished and Kill all count only VibeTunnel sessions', async () => {
    const list = await mount({
      sessions: [session('a'), session('x', { status: 'exited' })],
      mac: listed([tmux({ vtSessionId: 'a', vtMode: 'control', vtClient: true }), agent()]),
      hideExited: false,
    });
    const footer = list.querySelector('[data-testid="session-list-footer"]')?.textContent ?? '';
    expect(footer).toContain('1 Running');
    expect(footer).toContain('1 Exited');
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    list.querySelector<HTMLButtonElement>('[data-testid="phone-clear-finished"]')?.click();
    expect(confirm).toHaveBeenCalledWith('Clear 1 finished session?');

    const navigate = vi.fn();
    const killed = vi.fn();
    const refresh = vi.fn();
    list.addEventListener('navigate-to-session', (e) => navigate((e as CustomEvent).detail));
    list.addEventListener('session-killed', (e) => killed((e as CustomEvent).detail));
    list.addEventListener('refresh', refresh);
    const tmuxRow = list.querySelector('mac-session-row');

    // A tap on a tmux session open here goes to that VibeTunnel session.
    tmuxRow?.querySelector<HTMLElement>('[data-testid="mac-session-row"]')?.click();
    expect(navigate).toHaveBeenCalledWith({ sessionId: 'a' });

    // "Disconnect VibeTunnel" on it ends that session like a row's kill.
    tmuxRow?.dispatchEvent(
      new CustomEvent('session-killed', {
        detail: { sessionId: 'a' },
        bubbles: true,
        composed: true,
      })
    );
    expect(killed).toHaveBeenCalledWith('a');
    expect(refresh).toHaveBeenCalled();
  });
});
