// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../shared/types.js';
import type { AuthClient } from '../services/auth-client.js';
import { FAB_REST_MS, FAB_SCROLL_THRESHOLD_PX, FAB_TOP_ZONE_PX } from '../utils/fab-visibility.js';
import './session-list.js';
import { SessionList } from './session-list.js';

const css = () =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'), 'utf8');

describe('floating new-session button position', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  function setup(footerTop: number | null) {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(900);
    const list = document.createElement('session-list') as SessionList;
    const fab = document.createElement('button');
    fab.dataset.testid = 'new-session-fab';
    list.appendChild(fab);
    if (footerTop !== null) {
      const footer = document.createElement('div');
      footer.dataset.testid = 'session-list-footer';
      footer.getBoundingClientRect = () => ({ top: footerTop }) as DOMRect;
      list.appendChild(footer);
    }
    (list as unknown as { placeFab(): void }).placeFab();
    return fab;
  }

  it('sits 14 px above the bottom bar, however tall the bar is', () => {
    expect(setup(786).style.bottom).toBe('128px');
    expect(setup(820).style.bottom).toBe('94px');
  });

  it('keeps its CSS position when there is no bottom bar', () => {
    expect(setup(null).style.bottom).toBe('');
  });
});

describe('floating "+" while the phone list scrolls', () => {
  const session = {
    id: 's1',
    name: 'fab',
    command: ['zsh'],
    workingDir: '/home/user/project',
    status: 'running',
    startedAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
  } as unknown as Session;

  let scrollTop = 0;
  let reducedMotion = false;
  let phoneRows = true;

  beforeEach(() => {
    scrollTop = 0;
    reducedMotion = false;
    phoneRows = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(
      SessionList.prototype as unknown as { usePhoneRows: () => boolean },
      'usePhoneRows'
    ).mockImplementation(() => phoneRows);
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query.includes('prefers-reduced-motion') && reducedMotion,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }))
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({}))
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fixtureCleanup();
  });

  async function mount() {
    const scroller = await fixture<HTMLDivElement>(
      html`<div style="overflow-y: auto">
        <session-list
          .sessions=${[session]}
          .authClient=${{ getAuthHeader: () => ({}) } as unknown as AuthClient}
        ></session-list>
      </div>`
    );
    Object.defineProperties(scroller, {
      scrollTop: { get: () => scrollTop, configurable: true },
      scrollHeight: { get: () => 3000, configurable: true },
      clientHeight: { get: () => 600, configurable: true },
    });
    const list = scroller.querySelector('session-list') as SessionList;
    await list.updateComplete;
    const fab = list.querySelector<HTMLElement>('[data-testid="new-session-fab"]');
    const scrollTo = (y: number) => {
      scrollTop = y;
      scroller.dispatchEvent(new Event('scroll'));
    };
    return { list, fab, scrollTo };
  }

  async function mountWithFab() {
    const mounted = await mount();
    if (!mounted.fab) throw new Error('no floating +');
    return { ...mounted, fab: mounted.fab };
  }

  const lift = (fab: HTMLElement) => fab.style.getPropertyValue('--fab-lift');

  it('classic layout unchanged: no button, nothing follows the scroll', async () => {
    phoneRows = false;
    const { list, fab, scrollTo } = await mount();
    expect(fab).toBeNull();
    expect(list.querySelector('.phone-list-fab-room')).toBeNull();
    const place = vi.spyOn(list as unknown as { placeFab(): void }, 'placeFab');
    scrollTo(400);
    vi.advanceTimersByTime(FAB_REST_MS + 10);
    expect(place).not.toHaveBeenCalled();
  });

  it('leaves room under the last row for the button and its gap', async () => {
    const { list } = await mountWithFab();
    expect(list.querySelector('.phone-list-fab-room')).not.toBeNull();
    const room = css().match(/\.phone-list-fab-room \{\s*padding-bottom: calc\(([^)]*)\)/)?.[1];
    const total = (room ?? '').split('+').reduce((sum, part) => sum + Number.parseFloat(part), 0);
    // The button (58 px) and its gap above the bottom bar (14 px), plus some air.
    expect(total).toBeGreaterThanOrEqual(58 + 14);
  });

  it('hides while scrolling down and comes back on a scroll up', async () => {
    const { fab, scrollTo } = await mountWithFab();
    expect(fab.dataset.fab).toBe('shown');

    scrollTo(200);
    scrollTo(400);
    expect(fab.dataset.fab).toBe('hidden');
    expect(fab.classList.contains('fab-hidden')).toBe(true);
    // Out of the way for touch, focus and VoiceOver as well.
    expect(fab.hasAttribute('inert')).toBe(true);

    scrollTo(400 - FAB_SCROLL_THRESHOLD_PX - 4);
    expect(fab.dataset.fab).toBe('shown');
    expect(fab.classList.contains('fab-hidden')).toBe(false);
    expect(fab.hasAttribute('inert')).toBe(false);
  });

  it('stays hidden once the list stops after a scroll down', async () => {
    const { fab, scrollTo } = await mountWithFab();
    scrollTo(300);
    vi.advanceTimersByTime(FAB_REST_MS + 10);
    expect(fab.dataset.fab).toBe('hidden');
  });

  it('comes back near the top', async () => {
    const { fab, scrollTo } = await mountWithFab();
    scrollTo(900);
    expect(fab.dataset.fab).toBe('hidden');
    scrollTo(FAB_TOP_ZONE_PX - 10);
    expect(fab.dataset.fab).toBe('shown');
  });

  it('ignores the rubber-band bounce past the bottom', async () => {
    const { fab, scrollTo } = await mountWithFab();
    scrollTo(2400); // the bottom: 3000 - 600
    scrollTo(2460); // iOS overscroll
    scrollTo(2400); // bouncing back is not a scroll up
    expect(fab.dataset.fab).toBe('hidden');
  });

  it('animates by default and only appears and disappears in place under Reduce Motion', async () => {
    const { fab, scrollTo } = await mountWithFab();
    expect(fab.dataset.motion).toBe('full');
    reducedMotion = true;
    scrollTo(500);
    expect(fab.dataset.motion).toBe('reduced');
    expect(css()).toMatch(/\.new-chat-fab\[data-motion="reduced"\] \{\s*transition: none;/);
    expect(css()).toMatch(
      /\.new-chat-fab\[data-motion="reduced"\]\.fab-hidden \{\s*transform: translateY\(calc\(-1 \* var\(--fab-lift, 0px\)\)\);\s*transition: none;/
    );
  });

  describe('at rest', () => {
    // A 58 px button resting at 440–498 px, 18 px from the right of a 375 px screen.
    function placeFabBox(fab: HTMLElement) {
      Object.defineProperties(fab, {
        offsetTop: { get: () => 440, configurable: true },
        offsetLeft: { get: () => 299, configurable: true },
        offsetWidth: { get: () => 58, configurable: true },
        offsetHeight: { get: () => 58, configurable: true },
      });
    }
    function control(
      list: SessionList,
      className: string,
      rect: Partial<DOMRect>,
      tag: 'button' | 'div' | 'input' = 'button'
    ) {
      const el = document.createElement(tag);
      el.className = className;
      el.getBoundingClientRect = () =>
        ({ left: 0, right: 0, top: 0, bottom: 0, ...rect }) as DOMRect;
      list.querySelector('[data-testid="session-list-container"]')?.appendChild(el);
      return el;
    }

    it('lifts clear of a row ⋯ under it once the list stops', async () => {
      const { list, fab, scrollTo } = await mountWithFab();
      placeFabBox(fab);
      control(list, 'psr-menu', { top: 470, bottom: 514, left: 331, right: 367 });

      scrollTo(30);
      // Still moving: no jump.
      expect(lift(fab)).toBe('0px');
      vi.advanceTimersByTime(FAB_REST_MS + 10);
      expect(fab.dataset.fab).toBe('shown');
      expect(Number.parseFloat(lift(fab))).toBeGreaterThanOrEqual(32);
    });

    it('hides instead when a card it must not cover fills the room above it', async () => {
      const { list, fab, scrollTo } = await mountWithFab();
      placeFabBox(fab);
      const card = control(list, 'card', { top: 180, bottom: 560, left: 64, right: 359 }, 'div');
      card.dataset.fabAvoid = '';

      scrollTo(20);
      vi.advanceTimersByTime(FAB_REST_MS + 10);
      expect(fab.dataset.fab).toBe('hidden');
      expect(fab.hasAttribute('inert')).toBe(true);
    });

    it('stays where it is when nothing it must avoid is under it', async () => {
      const { list, fab, scrollTo } = await mountWithFab();
      placeFabBox(fab);
      control(list, 'psr-menu', { top: 200, bottom: 244, left: 331, right: 367 });

      scrollTo(10);
      vi.advanceTimersByTime(FAB_REST_MS + 10);
      expect(fab.dataset.fab).toBe('shown');
      expect(lift(fab)).toBe('0px');
    });

    it('rests in the nearest gap between stacked controls, never on one', async () => {
      const { list, fab, scrollTo } = await mountWithFab();
      placeFabBox(fab);
      // Home 440–498. Stacked above it: a row ⋯, "Clear all", the search field; clearing
      // each lands on the next, and the first free place is above the search field.
      const stack = [
        control(list, 'psr-menu', { top: 476, bottom: 520, left: 331, right: 367 }),
        control(list, 'clear', { top: 420, bottom: 446, left: 270, right: 367 }),
        control(list, 'search', { top: 372, bottom: 412, left: 16, right: 359 }, 'input'),
        control(list, 'other', { top: 240, bottom: 280, left: 315, right: 355 }),
      ];

      scrollTo(10);
      vi.advanceTimersByTime(FAB_REST_MS + 10);
      expect(fab.dataset.fab).toBe('shown');
      const moved = 440 - Number.parseFloat(lift(fab));
      for (const el of stack) {
        const rect = el.getBoundingClientRect();
        expect(moved + 58 <= rect.top || moved >= rect.bottom).toBe(true);
      }
      expect(moved).toBeGreaterThanOrEqual(280);
      expect(moved + 58).toBeLessThanOrEqual(372);
    });

    it('hides when nothing between the controls is free', async () => {
      const { list, fab, scrollTo } = await mountWithFab();
      placeFabBox(fab);
      control(list, 'psr-menu', { top: 476, bottom: 520, left: 331, right: 367 });
      control(list, 'clear', { top: 420, bottom: 446, left: 270, right: 367 });
      control(list, 'search', { top: 372, bottom: 412, left: 16, right: 359 }, 'input');
      control(list, 'other', { top: 322, bottom: 362, left: 315, right: 355 });
      control(list, 'more', { top: 266, bottom: 306, left: 300, right: 340 });

      scrollTo(10);
      vi.advanceTimersByTime(FAB_REST_MS + 10);
      expect(fab.dataset.fab).toBe('hidden');
      expect(fab.hasAttribute('inert')).toBe(true);
    });

    it('may rest over a row body, which stays tappable around it', async () => {
      const { list, fab, scrollTo } = await mountWithFab();
      placeFabBox(fab);
      const row = control(list, 'psr-main', { top: 400, bottom: 480, left: 64, right: 320 }, 'div');
      row.setAttribute('role', 'button');
      row.tabIndex = 0;

      scrollTo(10);
      vi.advanceTimersByTime(FAB_REST_MS + 10);
      expect(fab.dataset.fab).toBe('shown');
      expect(lift(fab)).toBe('0px');
    });
  });
});
