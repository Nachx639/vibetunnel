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
});
