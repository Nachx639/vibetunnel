// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../shared/types.js';
import type { AuthClient } from '../services/auth-client.js';
import { SessionList } from './session-list.js';

// On an iPhone Pro Max in landscape (956×440 pt, about 300 pt under Safari's bars) the compact
// list showed no session at all. On its side it has two columns; happy-dom has no layout, so
// the classes and where each part goes are checked here.
const makeSession = (id: string): Session =>
  ({
    id,
    name: `landscape ${id}`,
    command: ['zsh'],
    workingDir: '/home/user/project',
    status: 'running',
    startedAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
  }) as unknown as Session;

// More than six: the list shows its search field.
const SESSIONS = Array.from({ length: 7 }, (_, i) => makeSession(`s${i}`));

function setDevice(screen: [number, number], window_: [number, number]) {
  Object.defineProperty(window.screen, 'width', { configurable: true, get: () => screen[0] });
  Object.defineProperty(window.screen, 'height', { configurable: true, get: () => screen[1] });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: window_[0] });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: window_[1] });
}

const PRO_MAX: [number, number] = [440, 956];
const SE: [number, number] = [375, 667];

const mount = async (sessions: Session[] = SESSIONS, compactMode = false) => {
  const list = await fixture<SessionList>(
    html`<session-list
      .sessions=${sessions}
      .compactMode=${compactMode}
      .authClient=${{ getAuthHeader: () => ({}) } as unknown as AuthClient}
    ></session-list>`
  );
  await list.updateComplete;
  return list;
};

const content = (list: SessionList) =>
  list.querySelector<HTMLElement>('[data-testid="session-list-container"] > div.p-4');

async function rotate(list: SessionList, window_: [number, number]) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: window_[0] });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: window_[1] });
  window.dispatchEvent(new Event('resize'));
  await list.updateComplete;
}

describe('compact phone list on its side', () => {
  let phoneRows = true;
  beforeEach(() => {
    phoneRows = true;
    const store = new Map<string, string>();
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
    setDevice([1024, 768], [1024, 768]);
  });

  it.each([
    ['iPhone Pro Max', PRO_MAX, [956, 330]],
    ['iPhone SE', SE, [667, 323]],
  ] as const)('%s in landscape: two columns, controls left and rows right', async (_name, screen, window_) => {
    setDevice(screen, [...window_]);
    const list = await mount();
    const classes = content(list)?.classList;
    expect(classes).toContain('phone-landscape');
    expect(classes).toContain('phone-list-tight');

    const controls = list.querySelector('[data-testid="phone-list-controls"]');
    const rows = list.querySelector('[data-testid="phone-list-rows"]');
    expect(controls?.querySelector('.phone-search input')).not.toBeNull();
    expect(rows?.querySelector('[data-testid="phone-session-list"]')).not.toBeNull();
    expect(controls?.querySelector('phone-session-row')).toBeNull();
    // The bottom bar is the list's, outside both columns (styles.css puts it under the rows).
    expect(
      list.querySelector('[data-testid="session-list-footer"]')?.closest('.pl-side, .pl-main')
    ).toBeNull();
  });

  it.each([
    ['iPhone Pro Max', PRO_MAX, [440, 830]],
    ['iPhone SE', SE, [375, 548]],
  ] as const)('%s in portrait keeps one column', async (_name, screen, window_) => {
    setDevice(screen, [...window_]);
    const list = await mount();
    expect(content(list)?.classList).not.toContain('phone-landscape');
  });

  it('the Pro Max in portrait keeps its spacing', async () => {
    setDevice(PRO_MAX, [440, 830]);
    const list = await mount();
    expect(content(list)?.classList).not.toContain('phone-list-tight');
    expect(content(list)?.classList).toContain('pt-5');
  });

  it('switches on every rotation, keeping the same search field', async () => {
    setDevice(PRO_MAX, [440, 830]);
    const list = await mount();
    const search = list.querySelector('.phone-search input');

    await rotate(list, [956, 330]);
    expect(content(list)?.classList).toContain('phone-landscape');
    expect(content(list)?.classList).toContain('phone-list-tight');

    await rotate(list, [440, 830]);
    expect(content(list)?.classList).not.toContain('phone-landscape');
    expect(content(list)?.classList).not.toContain('phone-list-tight');

    // Same element throughout: what was typed in it, and its focus, survive the rotation.
    expect(list.querySelector('.phone-search input')).toBe(search);
  });

  it('the floating "+" follows the rows\' column, which scrolls on its own', async () => {
    setDevice(PRO_MAX, [956, 330]);
    const list = await mount();
    const column = list.querySelector('.phone-landscape .pl-main') as HTMLElement;
    let top = 0;
    Object.defineProperties(column, {
      scrollTop: { get: () => top, configurable: true },
      scrollHeight: { get: () => 2000, configurable: true },
      clientHeight: { get: () => 300, configurable: true },
    });
    const fab = list.querySelector<HTMLElement>('[data-testid="new-session-fab"]');
    for (const y of [200, 400]) {
      top = y;
      column.dispatchEvent(new Event('scroll'));
    }
    expect(fab?.dataset.fab).toBe('hidden');
  });

  it('with nothing running it keeps one column', async () => {
    setDevice(PRO_MAX, [956, 330]);
    const list = await mount([]);
    expect(list.querySelector('.phone-landscape')).toBeNull();
  });

  it('the sidebar opened from a session never splits', async () => {
    setDevice(PRO_MAX, [956, 330]);
    const list = await mount(SESSIONS, true);
    expect(list.querySelector('.phone-landscape, .pl-side, .pl-main')).toBeNull();
  });

  it('classic layout unchanged on a phone on its side: cards, no columns', async () => {
    phoneRows = false;
    setDevice(PRO_MAX, [956, 330]);
    const list = await mount();
    expect(content(list)?.className).toBe('p-4 pt-5');
    expect(list.querySelector('.phone-landscape, .pl-side, .pl-main')).toBeNull();
  });
});

describe('the left column on a phone on its side', () => {
  it('stays between 300 and 440 pt and leaves the rows more than half of the width', () => {
    const css = readFileSync(join(__dirname, '../styles.css'), 'utf8');
    const match = css.match(
      /grid-template-columns: minmax\(0, clamp\((\d+)px, (\d+)%, (\d+)px\)\) minmax\(0, 1fr\);/
    );
    expect(match).not.toBeNull();
    const [min, percent, max] = [Number(match?.[1]), Number(match?.[2]), Number(match?.[3])];
    expect([min, max]).toEqual([300, 440]);
    for (const width of [667, 852, 956]) {
      const column = Math.min(Math.max((width * percent) / 100, min), max);
      expect(width - column).toBeGreaterThan(width / 2);
    }
  });
});
