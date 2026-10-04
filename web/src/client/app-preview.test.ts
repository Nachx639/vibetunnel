/**
 * @vitest-environment happy-dom
 * @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PreviewItem, ServerEventType, type Session } from '../shared/types.js';
import { VibeTunnelApp } from './app.js';
import { closePreviewPanel } from './components/preview-panel.js';
import { serverEventService } from './services/server-event-service.js';
import { isPreviewRowHighlighted } from './utils/preview-rows.js';

type AppInternals = HTMLElement & {
  sessions: Session[];
  previews: PreviewItem[];
  currentView: string;
  selectedSessionId: string | null;
  previewTarget: { id: string; path: string; from: string | null } | null;
  handleOpenPreview(e: CustomEvent): void;
  handleOpenPreviewView(e: CustomEvent): void;
  handlePreviewSplit(e: CustomEvent): void;
  handlePreviewBack(e: CustomEvent): void;
  showPreviewRoute(route: unknown): Promise<void>;
  setupNotificationHandlers(): void;
  startAutoRefresh(): void;
  autoRefresh: { stop(): void };
};

const ID = 'pshop123';
const session = (ports: number[] = [5173]) =>
  ({
    id: 's1',
    name: 'shop',
    command: ['zsh'],
    status: 'running',
    workingDir: '/tmp',
    previewPorts: ports.map((port) => ({ id: ID, port, source: 'vt-open', at: 1 })),
  }) as unknown as Session;
const preview: PreviewItem = {
  id: ID,
  port: 5173,
  path: '/',
  createdAt: 1,
  lastOpenedAt: 1,
  sessionId: 's1',
  sessionName: 'shop',
  sessionAlive: true,
  pinned: false,
  source: 'vt-open',
};

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const panel = () => document.querySelector('[data-testid="preview-panel"]');

/**
 * Every way into a preview opens it full screen, at /preview/<id>. Split only when picked
 * inside the session. Back goes where the user came from.
 */
describe('opening a preview', () => {
  let app: AppInternals;
  let listed: PreviewItem[] = [preview];
  beforeEach(() => {
    listed = [preview];
    window.history.replaceState(null, '', '/');
    localStorage.setItem('vt-preview-mode', 'split'); // an old remembered split
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/preview/config'
          ? Response.json({ enabled: true, port: 7021, origin: null })
          : url === '/api/preview/ticket'
            ? Response.json({ loginPath: '/__vt_preview_login?ticket=t' })
            : url === '/api/previews'
              ? Response.json({ previews: listed })
              : new Response('[]', { status: 200 })
      )
    );
    app = new VibeTunnelApp() as unknown as AppInternals;
    app.sessions = [session()];
    app.previews = [preview];
    app.currentView = 'list';
  });
  afterEach(() => {
    closePreviewPanel();
    app.autoRefresh?.stop();
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const expectFullScreenView = (path = '/', from: string | null = null) => {
    expect(app.currentView).toBe('preview');
    expect(app.previewTarget).toEqual({ id: ID, path, from });
    expect(window.location.pathname).toBe(`/preview/${ID}`);
    expect(new URLSearchParams(window.location.search).get('from')).toBe(from);
    expect(document.body.classList.contains('preview-split-open')).toBe(false);
  };

  it('from the session row ⋯ sheet or chip on the list: back goes to the list', async () => {
    app.handleOpenPreview(
      new CustomEvent('vt-open-preview', { detail: { sessionId: 's1', port: 5173 } })
    );
    await flush();
    expectFullScreenView();
  });

  it('from the session header chip or ⋮ menu inside the session: back goes to it', async () => {
    app.currentView = 'session';
    app.selectedSessionId = 's1';
    app.handleOpenPreview(new CustomEvent('vt-open-preview', { detail: { sessionId: 's1' } }));
    await flush();
    expectFullScreenView('/', 's1');
  });

  it("a session's chip finds the saved preview by port even before the list arrived", async () => {
    app.sessions = [{ ...session(), previewPorts: [{ port: 5173, source: 'vt-open', at: 1 }] }];
    app.previews = [];
    app.handleOpenPreview(
      new CustomEvent('vt-open-preview', { detail: { sessionId: 's1', port: 5173 } })
    );
    await flush();
    expectFullScreenView();
  });

  it('from its preview row', () => {
    app.setupNotificationHandlers();
    window.dispatchEvent(new CustomEvent('vt-open-preview-view', { detail: { id: ID } }));
    expectFullScreenView();
  });

  it('`vt preview` with the session on screen opens the view; elsewhere it highlights the row', () => {
    const handlers = new Map<string, (event: unknown) => void>();
    vi.spyOn(serverEventService, 'on').mockImplementation((type, handler) => {
      handlers.set(String(type), handler as (event: unknown) => void);
      return () => handlers.delete(String(type));
    });
    app.startAutoRefresh();
    const open = { sessionId: 's1', port: 5173, path: '/', previewId: ID };

    handlers.get(ServerEventType.PreviewOpen)?.(open); // on the list
    expect(app.currentView).toBe('list');
    expect(isPreviewRowHighlighted(ID)).toBe(true);

    app.currentView = 'session';
    app.selectedSessionId = 's1';
    handlers.get(ServerEventType.PreviewOpen)?.(open);
    expectFullScreenView('/', null);
  });

  it('a /preview/<id> link (reload, shared link) opens the view', async () => {
    window.history.replaceState(null, '', `/preview/${ID}?path=%2Fcart`);
    await app.showPreviewRoute({ id: ID, path: '/cart', from: null });
    expect(app.currentView).toBe('preview');
    expect(app.previewTarget).toEqual({ id: ID, path: '/cart', from: null });
  });

  it('back is one real history step when the app opened the view', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    // Its row on the list (straight to this app: other tests' apps also listen on window).
    app.handleOpenPreviewView(new CustomEvent('vt-open-preview-view', { detail: { id: ID } }));
    app.handlePreviewBack(new CustomEvent('preview-back', { detail: { sessionId: null } }));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('back leaves the preview after the previewed site moved to other pages', () => {
    // Its pages are entries of the same history: one step back would go back a page inside
    // the preview, not to the list.
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    app.handleOpenPreviewView(new CustomEvent('vt-open-preview-view', { detail: { id: ID } }));
    window.history.pushState(window.history.state, '', window.location.href);
    window.history.pushState(window.history.state, '', window.location.href);
    app.handlePreviewBack(new CustomEvent('preview-back', { detail: { sessionId: null } }));
    expect(back).not.toHaveBeenCalled();
    expect(app.currentView).toBe('list');
  });

  it('back goes to the entry it came from by key where the browser has the Navigation API', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    const traverseTo = vi.fn(() => ({ finished: Promise.resolve() }));
    Object.defineProperty(window, 'navigation', {
      configurable: true,
      value: {
        currentEntry: { key: 'list-entry' },
        entries: () => [{ key: 'list-entry' }, { key: 'preview-entry' }],
        traverseTo,
      },
    });
    try {
      app.handleOpenPreviewView(new CustomEvent('vt-open-preview-view', { detail: { id: ID } }));
      window.history.pushState(window.history.state, '', window.location.href);
      app.handlePreviewBack(new CustomEvent('preview-back', { detail: { sessionId: null } }));
      expect(traverseTo).toHaveBeenCalledWith('list-entry');
      expect(back).not.toHaveBeenCalled();
    } finally {
      delete (window as unknown as { navigation?: unknown }).navigation;
    }
  });

  it('`vt preview` while in a session: back goes to the list, not one step back', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    const handlers = new Map<string, (event: unknown) => void>();
    vi.spyOn(serverEventService, 'on').mockImplementation((type, handler) => {
      handlers.set(String(type), handler as (event: unknown) => void);
      return () => handlers.delete(String(type));
    });
    app.startAutoRefresh();
    app.currentView = 'session';
    app.selectedSessionId = 's1';
    handlers.get(ServerEventType.PreviewOpen)?.({
      sessionId: 's1',
      port: 5173,
      path: '/',
      previewId: ID,
    });
    app.handlePreviewBack(new CustomEvent('preview-back', { detail: { sessionId: null } }));
    expect(back).not.toHaveBeenCalled();
    expect(app.currentView).toBe('list');
  });

  it('back from a deep link (reload, shared link): to the list, or to the session it was opened from', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    window.history.replaceState(null, '', `/preview/${ID}`);
    app.currentView = 'preview';
    app.previewTarget = { id: ID, path: '/', from: null };
    app.handlePreviewBack(new CustomEvent('preview-back', { detail: { sessionId: null } }));
    expect(app.currentView).toBe('list');

    window.history.replaceState(null, '', `/preview/${ID}?from=s1`);
    app.currentView = 'preview';
    app.previewTarget = { id: ID, path: '/', from: 's1' };
    app.handlePreviewBack(new CustomEvent('preview-back', { detail: { sessionId: 's1' } }));
    await flush();
    expect(app.currentView).toBe('session');
    expect(app.selectedSessionId).toBe('s1');
    expect(back).not.toHaveBeenCalled();
  });

  it('a session with no known dev server asks for a port, full screen too', async () => {
    app.sessions = [session([])];
    app.previews = [];
    listed = [];
    app.currentView = 'session';
    app.selectedSessionId = 's1';
    app.handleOpenPreview(new CustomEvent('vt-open-preview', { detail: { sessionId: 's1' } }));
    await flush();
    expect(panel()?.classList.contains('pv-full')).toBe(true);
  });

  it('split only when picked inside the session ("show beside the session")', async () => {
    app.currentView = 'session';
    app.selectedSessionId = 's1';
    app.handlePreviewSplit(
      new CustomEvent('preview-split', { detail: { sessionId: 's1', port: 5173, path: '/' } })
    );
    await flush();
    expect(panel()?.classList.contains('pv-split')).toBe(true);
  });
});

describe('previews off on the server (the default)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  it('asks only whether they are on; never lists them, and a /preview link goes to the list', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === '/api/preview/config'
        ? Response.json({ enabled: false, port: null, origin: null })
        : new Response('[]', { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const app = new VibeTunnelApp() as unknown as AppInternals & {
      loadPreviews(force?: boolean): Promise<void>;
      previewsEnabled: boolean;
    };
    app.currentView = 'list';
    await app.loadPreviews(true);
    await app.loadPreviews(true);
    expect(app.previewsEnabled).toBe(false);
    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls.filter((url) => url === '/api/preview/config')).toHaveLength(1);
    expect(urls).not.toContain('/api/previews');

    window.history.replaceState(null, '', `/preview/${ID}`);
    await app.showPreviewRoute({ id: ID, path: '/', from: null });
    expect(app.currentView).toBe('list');
    expect(window.location.pathname).toBe('/');
  });
});
