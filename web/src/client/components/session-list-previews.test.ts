// @vitest-environment happy-dom
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewItem, Session } from '../../shared/types.js';
import type { AuthClient } from '../services/auth-client.js';
import { PREVIEWS_CHANGED_EVENT } from '../utils/preview-rows.js';
import { SessionList } from './session-list.js';

const session = {
  id: 's1',
  name: 'hello-preview',
  command: ['zsh'],
  workingDir: '/tmp',
  status: 'running',
  startedAt: new Date().toISOString(),
  lastModified: new Date().toISOString(),
} as unknown as Session;

const preview = (over: Partial<PreviewItem> = {}): PreviewItem => ({
  id: 'pshop123',
  port: 5175,
  path: '/',
  createdAt: 1,
  lastOpenedAt: Date.now(),
  sessionId: 's1',
  sessionName: 'hello-preview',
  sessionAlive: true,
  pinned: false,
  source: 'vt-open',
  state: 'live',
  title: 'Home',
  ...over,
});

const mount = (sessions: Session[], previews: PreviewItem[], compact = false, enabled = true) =>
  fixture<SessionList>(
    html`<session-list
      .sessions=${sessions}
      .previews=${previews}
      .previewsEnabled=${enabled}
      .compactMode=${compact}
      .authClient=${{ getAuthHeader: () => ({}) } as unknown as AuthClient}
    ></session-list>`
  );

describe('session list: previews section', () => {
  beforeEach(() => {
    vi.spyOn(
      SessionList.prototype as unknown as { usePhoneRows: () => boolean },
      'usePhoneRows'
    ).mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fixtureCleanup();
  });

  it.each([
    false,
    true,
  ])('shows the saved previews on a phone (compact sidebar: %s)', async (compact) => {
    const list = await mount([session], [preview()], compact);
    expect(list.querySelector('[data-testid="preview-rows-heading"]')).not.toBeNull();
    expect(list.querySelectorAll('preview-row').length).toBe(1);
  });

  it('a preview stays after its session ended (it comes from /api/previews, not the sessions)', async () => {
    const list = await mount([], [preview({ sessionAlive: false })]);
    const rows = list.querySelectorAll('preview-row');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('Home');
    expect(rows[0].textContent).toContain('hello-preview');
  });

  it('pinned previews first, then the newest', async () => {
    const list = await mount(
      [session],
      [
        preview({ id: 'pnew1234', port: 3000, lastOpenedAt: 3, title: 'New' }),
        preview({ id: 'ppin1234', port: 4000, lastOpenedAt: 1, title: 'Pinned', pinned: true }),
        preview({ id: 'pold1234', port: 5000, lastOpenedAt: 2, title: 'Old' }),
      ]
    );
    const ids = [...list.querySelectorAll('[data-preview-id]')].map((row) =>
      row.getAttribute('data-preview-id')
    );
    expect(ids).toEqual(['ppin1234', 'pnew1234', 'pold1234']);
  });

  // "+ Add preview" lists the web servers on the server's computer (GET
  // /api/previews/candidates), with typing a port or URL as the last item.
  describe('"+ Add preview"', () => {
    const items = () => [
      ...document.body.querySelectorAll<HTMLButtonElement>('.psr-sheet-group button'),
    ];
    const labels = () => items().map((button) => button.textContent?.trim());
    const sheetTitle = () => document.body.querySelector('.psr-sheet-title')?.textContent?.trim();
    // The sheet ignores the tap that opened it: tap a second later.
    const tap = (button: HTMLButtonElement | undefined) => {
      const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
      button?.click();
      later.mockRestore();
    };
    const serve = (candidates: unknown[]) => {
      const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
        url === '/api/previews/candidates'
          ? Response.json({ candidates })
          : Response.json({ preview: preview() }, { status: 201 })
      );
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    };
    const openSheet = async (list: SessionList) => {
      list.querySelector<HTMLButtonElement>('[data-testid="preview-add"]')?.click();
      await vi.waitFor(() => expect(items().length).toBeGreaterThan(0));
    };
    const added = (body: unknown) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    afterEach(() => document.body.querySelector<HTMLButtonElement>('.psr-sheet-cancel')?.click());

    it('lists the web servers on the computer; tapping one adds its port', async () => {
      const fetchMock = serve([
        { port: 5173, title: 'Vite App', process: 'node', folder: 'shop' },
        { port: 5175, title: 'Home · Hello World', process: 'Python' },
        { port: 8080, process: 'java', folder: 'api' },
      ]);
      const prompt = vi.fn(() => null);
      vi.stubGlobal('prompt', prompt);
      const changed = vi.fn();
      window.addEventListener(PREVIEWS_CHANGED_EVENT, changed);
      const list = await mount([session], []);

      await openSheet(list);
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/previews/candidates',
        expect.objectContaining({ headers: {} })
      );
      expect(prompt).not.toHaveBeenCalled();
      expect(sheetTitle()).toBe('Servers running on this computer');
      expect(labels()).toEqual([
        ':5173 · shop — Vite App',
        ':5175 · Python — Home · Hello World',
        ':8080 · api · java',
        'Other port or URL…',
      ]);
      // Servers are drawn on one line, like folders; the last item is an action.
      expect(items()[0].classList.contains('folder')).toBe(true);
      expect(items()[3].classList.contains('folder')).toBe(false);

      tap(items()[1]);
      expect(items()).toHaveLength(0);
      await vi.waitFor(() => expect(changed).toHaveBeenCalled());
      window.removeEventListener(PREVIEWS_CHANGED_EVENT, changed);
      expect(fetchMock).toHaveBeenCalledWith('/api/previews', added({ port: 5175 }));
      expect(prompt).not.toHaveBeenCalled();
    });

    it('"Other port or URL…" adds one typed; with no server found the sheet says so', async () => {
      const fetchMock = serve([]);
      vi.stubGlobal(
        'prompt',
        vi.fn(() => 'localhost:3000/about')
      );
      const changed = vi.fn();
      window.addEventListener(PREVIEWS_CHANGED_EVENT, changed);
      const list = await mount([session], []);

      await openSheet(list);
      expect(sheetTitle()).toBe('No servers running on this computer');
      expect(labels()).toEqual(['Other port or URL…']);

      tap(items()[0]);
      await vi.waitFor(() => expect(changed).toHaveBeenCalled());
      window.removeEventListener(PREVIEWS_CHANGED_EVENT, changed);
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/previews',
        added({ url: 'localhost:3000/about' })
      );
    });
  });

  it('with previews off on the server, there is no section at all, even with items', async () => {
    const list = await mount([session], [preview()], false, false);
    expect(list.querySelector('[data-testid="preview-rows-heading"]')).toBeNull();
    expect(list.querySelector('[data-testid="preview-add"]')).toBeNull();
    expect(list.querySelectorAll('preview-row').length).toBe(0);
  });

  it('the sidebar opened from a session hides the section while there is nothing in it', async () => {
    const list = await mount([session], [], true);
    expect(list.querySelector('[data-testid="preview-rows-heading"]')).toBeNull();
  });
});
