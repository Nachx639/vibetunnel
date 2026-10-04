/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerEventType } from '../shared/types.js';
import { sessionRefreshDelay, VibeTunnelApp } from './app.js';
import { serverEventService } from './services/server-event-service.js';

type AppInternals = {
  sessions: unknown[];
  currentView: string;
  initialLoadComplete: boolean;
  startAutoRefresh(): void;
  loadSessions(): Promise<void>;
  autoRefresh: { stop(): void };
};

let visibility: DocumentVisibilityState = 'visible';

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('session list polling', () => {
  let app: AppInternals;
  let fetchMock: ReturnType<typeof vi.fn>;

  const sessionRequests = () =>
    fetchMock.mock.calls.filter(([url]) => String(url) === '/api/sessions').length;

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    fetchMock = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    app = new VibeTunnelApp() as unknown as AppInternals;
    app.currentView = 'list';
    app.initialLoadComplete = true;
  });

  afterEach(() => {
    app.autoRefresh.stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sees a session being muted on another device', async () => {
    const row = (muted?: boolean) => ({
      id: 's1',
      name: 's1',
      status: 'running',
      workingDir: '/home/user/project',
      ...(muted ? { muted } : {}),
    });
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([row()])));
    await app.loadSessions();
    const shown = app.sessions;
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([row(true)])));
    await app.loadSessions();
    expect(app.sessions).not.toBe(shown);
    expect((app.sessions[0] as { muted?: boolean }).muted).toBe(true);
  });

  it('stops polling while the page is hidden and refreshes at once on return', async () => {
    app.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(5_000);
    const visibleCount = sessionRequests();
    expect(visibleCount).toBeGreaterThanOrEqual(4);

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sessionRequests()).toBe(visibleCount);

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionRequests()).toBe(visibleCount + 1);
  });
  it('a re-login does not start a second poll', async () => {
    app.startAutoRefresh();
    app.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sessionRequests()).toBeLessThanOrEqual(10);
  });
  it('coalesces overlapping loads into one follow-up request', async () => {
    let release!: () => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(new Response('[]', { status: 200 }));
        })
    );
    const loads = [app.loadSessions(), app.loadSessions(), app.loadSessions()];
    expect(sessionRequests()).toBe(1);
    release();
    await Promise.all(loads);
    expect(sessionRequests()).toBe(2);
  });
  it('keeps the same sessions array (no re-render) when the list is identical', async () => {
    const session = { id: 'a', name: 'one', status: 'running', workingDir: '/tmp' };
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([session])));
    await app.loadSessions();
    const shown = app.sessions;
    await app.loadSessions();
    expect(app.sessions).toBe(shown);

    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify([{ ...session, name: 'renamed' }]))
    );
    await app.loadSessions();
    expect(app.sessions).not.toBe(shown);
  });
  it('a killed session in a git repo gets a new object, so rows holding it re-render', async () => {
    const running = { id: 'a', name: 'claude', status: 'running', workingDir: '/repo' };
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([running])));
    await app.loadSessions();
    const before = app.sessions[0] as Record<string, unknown>;
    // The git badge fills these in on the client; the server list doesn't send them.
    before.gitRepoPath = '/repo';
    before.gitModifiedCount = 3;

    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify([{ ...running, status: 'exited' }]))
    );
    await app.loadSessions();

    const after = app.sessions[0] as Record<string, unknown>;
    expect(after).not.toBe(before);
    expect(after.status).toBe('exited');
    expect(after.gitRepoPath).toBe('/repo');
    expect(after.gitModifiedCount).toBe(3);
  });
  it('backs off to one poll every 3 s on an idle list: 60 -> about 20 per minute', async () => {
    app.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(60_000);
    const firstMinute = sessionRequests();
    await vi.advanceTimersByTimeAsync(60_000);
    const secondMinute = sessionRequests() - firstMinute;
    expect(firstMinute).toBe(10 + 20 + 3); // 10 at 1 s (to 10 s), 20 at 2 s (to 50 s), 3 at 3 s
    expect(secondMinute).toBe(20);
    expect(sessionRefreshDelay(0)).toBe(1000);
    expect(sessionRefreshDelay(30)).toBe(3000);
  });
  it('returns to 1 s and refreshes at once when a session starts or exits', async () => {
    const handlers = new Map<string, () => void>();
    vi.spyOn(serverEventService, 'on').mockImplementation((type, handler) => {
      handlers.set(String(type), handler as () => void);
      return () => handlers.delete(String(type));
    });
    app.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(120_000);
    const before = sessionRequests();
    handlers.get(ServerEventType.SessionStart)?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionRequests()).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sessionRequests()).toBe(before + 2);
    expect(handlers.has(ServerEventType.SessionExit)).toBe(true);
  });
  it('shows a killed session as finished at once, even if the server still says running', async () => {
    const running = { id: 'k', name: 'zsh', status: 'running', workingDir: '/tmp' };
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([running])));
    await app.loadSessions();
    const internals = app as unknown as {
      handleSessionKilled(e: CustomEvent): void;
      showError(message: string): void;
    };
    const showError = vi.fn();
    internals.showError = showError;

    (app as unknown as { isAuthenticated: boolean }).isAuthenticated = true;
    internals.handleSessionKilled(new CustomEvent('session-killed', { detail: 'k' }));
    expect((app.sessions[0] as { status: string }).status).toBe('exited');
    await vi.advanceTimersByTimeAsync(1000); // a poll that still says running
    expect((app.sessions[0] as { status: string }).status).toBe('exited');
    expect(showError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(8000); // it really didn't die: say so
    await app.loadSessions();
    expect((app.sessions[0] as { status: string }).status).toBe('running');
    expect(showError).toHaveBeenCalledTimes(1);
  });
  it('the follow-up refreshes after a kill stop at logout (no 401, no second logout)', async () => {
    const running = { id: 'k', name: 'zsh', status: 'running', workingDir: '/tmp' };
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([running])));
    await app.loadSessions();
    const internals = app as unknown as {
      isAuthenticated: boolean;
      handleSessionKilled(e: CustomEvent): void;
      handleLogout(): Promise<void>;
    };
    internals.isAuthenticated = true;
    const { authClient } = await import('./services/auth-client.js');
    vi.spyOn(authClient, 'logout').mockResolvedValue(undefined);

    internals.handleSessionKilled(new CustomEvent('session-killed', { detail: 'k' }));
    await vi.advanceTimersByTimeAsync(0);
    await internals.handleLogout();
    const atLogout = sessionRequests();
    await vi.advanceTimersByTimeAsync(3000);
    expect(sessionRequests()).toBe(atLogout);
  });
  it('the follow-up refreshes after a kill skip a view that does not show sessions', async () => {
    const internals = app as unknown as {
      isAuthenticated: boolean;
      handleSessionKilled(e: CustomEvent): void;
    };
    internals.isAuthenticated = true;
    internals.handleSessionKilled(new CustomEvent('session-killed', { detail: 'k' }));
    await vi.advanceTimersByTimeAsync(0);
    app.currentView = 'settings';
    const before = sessionRequests();
    await vi.advanceTimersByTimeAsync(3000);
    expect(sessionRequests()).toBe(before);
  });
  it('a cleared finished session leaves at once, even if a poll in flight still lists it', async () => {
    const done = { id: 'x', name: 'zsh', status: 'exited', workingDir: '/tmp' };
    const other = { id: 'o', name: 'other', status: 'running', workingDir: '/tmp' };
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([done, other])));
    await app.loadSessions();
    const internals = app as unknown as { handleSessionKilled(e: CustomEvent): void };

    // Started before the DELETE landed: it still has the session.
    const stale = app.loadSessions();
    internals.handleSessionKilled(new CustomEvent('session-killed', { detail: 'x' }));
    expect(app.sessions.map((s) => (s as { id: string }).id)).toEqual(['o']);
    await stale;
    expect(app.sessions.map((s) => (s as { id: string }).id)).toEqual(['o']);

    // Not actually removed (the server still lists it later): it shows up again.
    await vi.advanceTimersByTimeAsync(6000);
    await app.loadSessions();
    expect(app.sessions.map((s) => (s as { id: string }).id)).toEqual(['x', 'o']);
  });
  it('forgets a killed session once it is gone from the server list', async () => {
    const running = { id: 'k', name: 'zsh', status: 'running', workingDir: '/tmp' };
    const other = { id: 'o', name: 'other', status: 'running', workingDir: '/tmp' };
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([running, other])));
    await app.loadSessions();
    const internals = app as unknown as {
      recentlyKilled: Map<string, number>;
      handleSessionKilled(e: CustomEvent): void;
    };
    internals.handleSessionKilled(new CustomEvent('session-killed', { detail: 'k' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(internals.recentlyKilled.has('k')).toBe(true);

    // Cleaned up before it ever showed as exited: the list no longer has it.
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([other])));
    await app.loadSessions();
    expect(internals.recentlyKilled.has('k')).toBe(false);
  });

  it('a session ended from its own view and then removed goes back to the list quietly', async () => {
    const running = { id: 'gone', name: 'zsh', status: 'running', workingDir: '/tmp' };
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([running])));
    await app.loadSessions();
    const internals = app as unknown as {
      selectedSessionId: string | null;
      sessionLoadingState: string;
      isAuthenticated: boolean;
      handleSessionKilled(e: CustomEvent): void;
      handleNavigateToList(): void;
      showError(message: string): void;
    };
    internals.isAuthenticated = true;
    app.currentView = 'session';
    internals.selectedSessionId = 'gone';
    internals.sessionLoadingState = 'loaded';
    const showError = vi.fn();
    const toList = vi.fn();
    internals.showError = showError;
    internals.handleNavigateToList = toList;

    internals.handleSessionKilled(
      new CustomEvent('session-killed', { detail: { sessionId: 'gone' } })
    );
    fetchMock.mockImplementation(async () => new Response('[]'));
    await app.loadSessions();
    expect(toList).toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });
});
