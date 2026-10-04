// @vitest-environment happy-dom
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../shared/types.js';
import type { AuthClient } from '../services/auth-client.js';
import { writeCompactListPref } from '../utils/phone-list-layout.js';
import { APP_PREFERENCES_STORAGE_KEY } from '../utils/phone-ui.js';
import { SessionList } from './session-list.js';

// Only the classes are checked here (happy-dom has no layout).
const session = {
  id: 's1',
  name: 'compact',
  command: ['zsh'],
  workingDir: '/home/user/project',
  status: 'running',
  startedAt: new Date().toISOString(),
  lastModified: new Date().toISOString(),
} as unknown as Session;

function setScreen(width: number, height: number) {
  Object.defineProperty(window.screen, 'width', { configurable: true, get: () => width });
  Object.defineProperty(window.screen, 'height', { configurable: true, get: () => height });
}

const mount = async (compactMode = false) => {
  const list = await fixture<SessionList>(
    html`<session-list
      .sessions=${[session]}
      .compactMode=${compactMode}
      .authClient=${{ getAuthHeader: () => ({}) } as unknown as AuthClient}
    ></session-list>`
  );
  await list.updateComplete;
  return list;
};

const content = (list: SessionList) =>
  list.querySelector<HTMLElement>('[data-testid="session-list-container"] > div.p-4');

describe('compact phone list on a small screen', () => {
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
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fixtureCleanup();
  });

  describe('iPhone SE (375×667)', () => {
    beforeEach(() => setScreen(375, 667));

    it('tightens the spacing and turns the compact list on', async () => {
      const classes = content(await mount())?.classList;
      expect(classes).toContain('phone-list-fab-room');
      expect(classes).toContain('phone-list-tight');
      expect(classes).toContain('phone-list-compact');
      expect(classes).toContain('pt-3');
      expect(classes).not.toContain('pt-5');
    });

    it('with "Compact list" off: tighter spacing only', async () => {
      store.set(APP_PREFERENCES_STORAGE_KEY, JSON.stringify({ compactList: false }));
      const classes = content(await mount())?.classList;
      expect(classes).toContain('phone-list-tight');
      expect(classes).not.toContain('phone-list-compact');
    });

    it('follows the setting at once when it changes', async () => {
      const list = await mount();
      writeCompactListPref('off');
      await list.updateComplete;
      expect(content(list)?.classList).not.toContain('phone-list-compact');
    });

    it('classic layout unchanged, even on an SE', async () => {
      phoneRows = false;
      const list = await mount();
      expect(content(list)?.className).toBe('p-4 pt-5');
      expect(list.querySelector('.phone-list-tight, .phone-list-compact')).toBeNull();
    });

    it('the sidebar opened from a session keeps its own layout', async () => {
      const list = await mount(true);
      expect(content(list)?.className).toBe('p-4 pt-5');
    });
  });

  describe('larger phones keep the layout they have', () => {
    it.each([
      ['iPhone 15', 393, 852],
      ['iPhone Pro Max', 440, 956],
    ])('%s', async (_name, width, height) => {
      setScreen(width, height);
      const classes = content(await mount())?.classList;
      expect(classes).toContain('pt-5');
      expect(classes).toContain('phone-list-fab-room');
      expect(classes).not.toContain('phone-list-tight');
      expect(classes).not.toContain('phone-list-compact');
    });

    it('unless "Compact list" is turned on', async () => {
      setScreen(393, 852);
      store.set(APP_PREFERENCES_STORAGE_KEY, JSON.stringify({ compactList: true }));
      const classes = content(await mount())?.classList;
      expect(classes).toContain('phone-list-compact');
      expect(classes).toContain('phone-list-tight');
    });
  });
});
