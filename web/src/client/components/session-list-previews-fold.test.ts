// @vitest-environment happy-dom
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewItem, Session } from '../../shared/types.js';
import type { AuthClient } from '../services/auth-client.js';
import { writeCompactListPref } from '../utils/phone-list-layout.js';
import { APP_PREFERENCES_STORAGE_KEY } from '../utils/phone-ui.js';
import { SessionList } from './session-list.js';

// On a 375×667 pt iPhone SE the previews section pushed the first session off the screen.
const session = {
  id: 's1',
  name: 'fold',
  command: ['zsh'],
  workingDir: '/home/user/project',
  status: 'running',
  startedAt: new Date().toISOString(),
  lastModified: new Date().toISOString(),
} as unknown as Session;

const preview = (id: string, port: number, title: string): PreviewItem => ({
  id,
  port,
  path: '/',
  createdAt: 1,
  lastOpenedAt: port,
  sessionAlive: false,
  pinned: false,
  source: 'vt-open',
  title,
});

// Newest first in the list: Home (opened later), then Shop.
const TWO_PREVIEWS = [preview('pshop123', 5173, 'Shop'), preview('phome123', 5180, 'Home')];

function setScreen(width: number, height: number) {
  Object.defineProperty(window.screen, 'width', { configurable: true, get: () => width });
  Object.defineProperty(window.screen, 'height', { configurable: true, get: () => height });
}

const mount = async (previews: PreviewItem[] = TWO_PREVIEWS, compactMode = false) => {
  const list = await fixture<SessionList>(
    html`<session-list
      .sessions=${[session]}
      .previews=${previews}
      .previewsEnabled=${true}
      .compactMode=${compactMode}
      .authClient=${{ getAuthHeader: () => ({}) } as unknown as AuthClient}
    ></session-list>`
  );
  await list.updateComplete;
  return list;
};

describe('previews in the compact phone list on a small screen', () => {
  let store: Map<string, string>;
  let phoneRows = true;

  beforeEach(() => {
    store = new Map();
    phoneRows = true;
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({}))
    );
    vi.spyOn(
      SessionList.prototype as unknown as { usePhoneRows: () => boolean },
      'usePhoneRows'
    ).mockImplementation(() => phoneRows);
    setScreen(375, 667);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fixtureCleanup();
  });

  it('folds two previews into one line that opens and closes on a tap', async () => {
    const list = await mount();
    const toggle = list.querySelector<HTMLButtonElement>('[data-testid="preview-rows-toggle"]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(toggle?.textContent).toContain('Previews (2)');
    expect(list.querySelector('[data-testid="preview-rows-summary"]')?.textContent).toBe(
      'Home, Shop'
    );
    expect(list.querySelectorAll('preview-row').length).toBe(0);
    // "+ Add" keeps its full name for VoiceOver.
    const add = list.querySelector('[data-testid="preview-add"]');
    expect(add?.textContent?.trim()).toBe('+ Add');
    expect(add?.getAttribute('aria-label')).toBe('+ Add preview');

    toggle?.click();
    await list.updateComplete;
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(list.querySelectorAll('preview-row').length).toBe(2);
    expect(list.querySelector('[data-testid="preview-rows-summary"]')).toBeNull();

    toggle?.click();
    await list.updateComplete;
    expect(list.querySelectorAll('preview-row').length).toBe(0);
  });

  it('shows a single preview as its row, with no fold', async () => {
    const list = await mount([TWO_PREVIEWS[0]]);
    expect(list.querySelector('[data-testid="preview-rows-toggle"]')).toBeNull();
    expect(list.querySelectorAll('preview-row').length).toBe(1);
    expect(list.querySelector('[data-testid="preview-add"]')?.textContent?.trim()).toBe(
      '+ Add preview'
    );
  });

  it('with "Compact list" off: every row, as before', async () => {
    store.set(APP_PREFERENCES_STORAGE_KEY, JSON.stringify({ compactList: false }));
    const list = await mount();
    expect(list.querySelector('[data-testid="preview-rows-toggle"]')).toBeNull();
    expect(list.querySelectorAll('preview-row').length).toBe(2);
  });

  it('follows the setting at once when it changes', async () => {
    const list = await mount();
    writeCompactListPref('off');
    await list.updateComplete;
    expect(list.querySelectorAll('preview-row').length).toBe(2);
  });

  it('a larger phone keeps every row', async () => {
    setScreen(393, 852);
    const list = await mount();
    expect(list.querySelector('[data-testid="preview-rows-toggle"]')).toBeNull();
    expect(list.querySelectorAll('preview-row').length).toBe(2);
  });

  it('classic layout unchanged: no fold, even on an SE', async () => {
    phoneRows = false;
    const list = await mount();
    expect(list.querySelector('[data-testid="preview-rows-toggle"]')).toBeNull();
  });

  it('the sidebar opened from a session keeps every row, even on an SE', async () => {
    const list = await mount(TWO_PREVIEWS, true);
    expect(list.querySelector('[data-testid="preview-rows-toggle"]')).toBeNull();
    expect(list.querySelectorAll('preview-row').length).toBe(2);
  });
});
