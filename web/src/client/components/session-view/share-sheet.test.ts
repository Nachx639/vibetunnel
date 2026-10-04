// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeShareSheet,
  formatTimeLeft,
  openShareSheet,
  resetShareLinksAvailability,
  shareLinksAvailable,
  shareUrl,
} from './share-sheet.js';

const NOW = 1_000_000;
const item = (token: string, minutesLeft: number) => ({
  token,
  path: `/share/${token}`,
  createdAt: NOW,
  expiresAt: NOW + minutesLeft * 60_000,
});

describe('share sheet', () => {
  let now = NOW;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    now = NOW;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ share: item('newer', 60) }), { status: 201 });
      }
      if (init?.method === 'DELETE') return new Response(JSON.stringify({ revoked: true }));
      return new Response(JSON.stringify({ shares: [item('older', 12)] }));
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    closeShareSheet();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const sheet = () => document.querySelector('[data-testid="share-sheet"]') as HTMLElement;
  const links = () => [...sheet().querySelectorAll('[data-testid="share-link"]')];
  const click = (selector: string) => (sheet().querySelector(selector) as HTMLElement).click();

  it('lists the session’s live links with the time left', async () => {
    openShareSheet('s1', 'shop');
    await vi.waitFor(() => expect(links()).toHaveLength(1));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/sessions/s1/shares');
    expect(links()[0].textContent).toContain(`${window.location.origin}/share/older`);
    expect(links()[0].textContent).toContain('Expires in 12 min');
  });

  it('creates a link for the chosen time and revokes one', async () => {
    openShareSheet('s1', 'shop');
    await vi.waitFor(() => expect(links()).toHaveLength(1));
    now += 1000;
    click('[data-testid="share-create-60"]');
    await vi.waitFor(() => expect(links()).toHaveLength(2));
    const post = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST');
    expect(JSON.parse(post?.[1].body as string)).toEqual({ minutes: 60 });
    click('[data-testid="share-revoke"]');
    await vi.waitFor(() => expect(links()).toHaveLength(1));
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'DELETE')).toBe(true);
  });

  it('a scroll of the sheet that starts on a button does nothing; a still tap acts', async () => {
    openShareSheet('s1', 'shop');
    await vi.waitFor(() => expect(links()).toHaveLength(1));
    now += 1000;
    // iOS ends a scroll that began on a button with a pointerup on it.
    const touch = (selector: string, dy: number) => {
      const el = sheet().querySelector(selector) as HTMLElement;
      const at = (y: number) => ({
        pointerType: 'touch',
        pointerId: 7,
        clientX: 40,
        clientY: y,
        bubbles: true,
      });
      el.dispatchEvent(new PointerEvent('pointerdown', at(400)));
      el.dispatchEvent(new PointerEvent('pointerup', at(400 + dy)));
    };
    touch('[data-testid="share-revoke"]', -100);
    touch('[data-testid="share-create-60"]', -100);
    touch('.psr-sheet-backdrop', -100);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method)).toEqual([]);
    expect(sheet()).not.toBeNull();

    touch('[data-testid="share-create-60"]', 2);
    click('[data-testid="share-create-60"]');
    await vi.waitFor(() => expect(links()).toHaveLength(2));
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
  });

  it('a tap right after opening does nothing (the opening gesture)', async () => {
    openShareSheet('s1', 'shop');
    await vi.waitFor(() => expect(links()).toHaveLength(1));
    click('[data-testid="share-create-15"]');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false);
  });

  it('formats the time left and builds the full link', () => {
    expect(formatTimeLeft(58 * 60_000)).toBe('58 min');
    expect(formatTimeLeft(8 * 60 * 60_000)).toBe('8 h');
    expect(shareUrl({ path: '/share/abc' })).toBe(`${window.location.origin}/share/abc`);
  });

  it('asks the server whether share links are on, and counts any failure as off', async () => {
    const answer = (body: unknown, status = 200) =>
      vi.fn(async (_url: string) => new Response(JSON.stringify(body), { status }));
    for (const [mock, expected] of [
      [answer({ shareLinks: true }), true],
      [answer({ shareLinks: false }), false],
      [answer({}), false],
      [answer({ shareLinks: true }, 401), false],
      [
        vi.fn(async (_url: string): Promise<Response> => {
          throw new Error('offline');
        }),
        false,
      ],
    ] as const) {
      resetShareLinksAvailability();
      vi.stubGlobal('fetch', mock);
      expect(await shareLinksAvailable()).toBe(expected);
      expect(mock.mock.calls[0][0]).toBe('/api/config');
    }
  });

  it('asks at most once a minute', async () => {
    resetShareLinksAvailability();
    const mock = vi.fn(async () => new Response(JSON.stringify({ shareLinks: true })));
    vi.stubGlobal('fetch', mock);
    await shareLinksAvailable();
    now += 30_000;
    await shareLinksAvailable();
    expect(mock).toHaveBeenCalledTimes(1);
    now += 31_000;
    await shareLinksAvailable();
    expect(mock).toHaveBeenCalledTimes(2);
  });
});
