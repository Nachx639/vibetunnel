// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import {
  FAB_MAX_LIFT_PX,
  FAB_SCROLL_START,
  FAB_SCROLL_THRESHOLD_PX,
  FAB_TOP_ZONE_PX,
  type FabScroll,
  fabLift,
  fabObstacles,
  listScroller,
  nextFabScroll,
} from './fab-visibility.js';

const scrollThrough = (positions: number[], start: FabScroll = FAB_SCROLL_START) =>
  positions.reduce(nextFabScroll, start);

describe('floating "+" scroll direction', () => {
  it('hides once the list has scrolled down past the threshold, not on jitter', () => {
    const below = FAB_TOP_ZONE_PX + 100;
    const resting: FabScroll = { hidden: false, anchorY: below, lastY: below };
    expect(scrollThrough([below + FAB_SCROLL_THRESHOLD_PX - 1], resting).hidden).toBe(false);
    expect(scrollThrough([below + 4, below + FAB_SCROLL_THRESHOLD_PX + 1], resting).hidden).toBe(
      true
    );
  });

  it('comes back on a scroll up, counted from where the direction turned', () => {
    const down = scrollThrough([100, 300, 600]);
    expect(down.hidden).toBe(true);
    expect(scrollThrough([600 - FAB_SCROLL_THRESHOLD_PX + 2], down).hidden).toBe(true);
    expect(scrollThrough([590, 580], down).hidden).toBe(false);
  });

  it('turning down again after showing hides it again', () => {
    const shown = scrollThrough([100, 600, 500]);
    expect(shown.hidden).toBe(false);
    expect(scrollThrough([520], shown).hidden).toBe(true);
  });

  it('always shows near the top', () => {
    const down = scrollThrough([100, 600]);
    expect(scrollThrough([FAB_TOP_ZONE_PX], down).hidden).toBe(false);
    // Even a fast flick that lands near the top from far below, with no step in between.
    expect(scrollThrough([FAB_TOP_ZONE_PX + 400, 0]).hidden).toBe(false);
  });

  it('the same position twice changes nothing', () => {
    const down = scrollThrough([100, 600]);
    expect(nextFabScroll(down, 600)).toBe(down);
  });
});

describe('floating "+" at rest', () => {
  // A 58 px button 18 px from the right of a 375 px screen, resting above the bottom bar.
  const fab = { top: 440, bottom: 498, left: 299, right: 357 };

  it('stays put when nothing it must not cover is under it', () => {
    expect(fabLift(fab, [])).toBe(0);
    // A row's ⋯ well above it.
    expect(fabLift(fab, [{ top: 300, bottom: 344, left: 331, right: 367 }])).toBe(0);
    // Content to its left (a title, say) is not something it avoids.
    expect(fabLift(fab, [{ top: 440, bottom: 498, left: 16, right: 200 }])).toBe(0);
  });

  it('lifts just clear of a ⋯ under it', () => {
    const menu = { top: 470, bottom: 514, left: 331, right: 367 };
    const lift = fabLift(fab, [menu]);
    expect(lift).not.toBeNull();
    expect(fab.bottom - (lift ?? 0)).toBeLessThanOrEqual(menu.top - 4);
    expect(fab.bottom - (lift ?? 0)).toBeGreaterThan(menu.top - 8);
  });

  it('finds the gap between two rows ⋯ buttons', () => {
    const lower = { top: 470, bottom: 514, left: 331, right: 367 };
    const upper = { top: 340, bottom: 384, left: 331, right: 367 };
    const lift = fabLift(fab, [lower, upper]) ?? -1;
    expect(lift).toBeGreaterThan(0);
    expect(fab.top - lift).toBeGreaterThanOrEqual(upper.bottom + 4);
  });

  it('gives up (hides) over a card taller than it may lift', () => {
    const card = { top: 200, bottom: 560, left: 64, right: 359 };
    expect(fabLift(fab, [card])).toBeNull();
    expect(fabLift(fab, [{ ...card, top: fab.top - FAB_MAX_LIFT_PX + 40 }])).toBeNull();
  });

  it('ignores controls with no box (not rendered)', () => {
    expect(fabLift(fab, [{ top: 0, bottom: 0, left: 0, right: 0 }])).toBe(0);
    expect(fabLift(fab, [{ top: 450, bottom: 450, left: 300, right: 300 }])).toBe(0);
  });
});

describe('floating "+" at rest, several controls stacked', () => {
  const fab = { top: 440, bottom: 498, left: 299, right: 357 };

  it('takes the nearest clear place, not the first one clear of the lowest control', () => {
    const menu = { top: 476, bottom: 520, left: 331, right: 367 };
    const add = { top: 420, bottom: 446, left: 270, right: 367 };
    const search = { top: 372, bottom: 412, left: 16, right: 359 };
    const lift = fabLift(fab, [menu, add, search]);
    expect(lift).toBe(fab.bottom - search.top + 4);
  });

  it('hides when the controls leave no room up to the max lift', () => {
    const rows = [0, 1, 2, 3].map((i) => ({
      top: 300 + i * 50,
      bottom: 340 + i * 50,
      left: 16,
      right: 359,
    }));
    expect(fabLift(fab, rows)).toBeNull();
  });
});

describe('what the floating "+" must not cover', () => {
  function box(
    el: HTMLElement,
    rect: { top: number; height: number; left: number; width: number }
  ) {
    el.getBoundingClientRect = () =>
      ({
        top: rect.top,
        bottom: rect.top + rect.height,
        left: rect.left,
        right: rect.left + rect.width,
      }) as DOMRect;
    return el;
  }

  function setup(markup: string) {
    const root = document.createElement('div');
    root.innerHTML = `${markup}<button id="fab"></button>`;
    document.body.appendChild(root);
    const fab = root.querySelector<HTMLElement>('#fab') as HTMLElement;
    Object.defineProperties(fab, {
      offsetWidth: { get: () => 58 },
      offsetHeight: { get: () => 58 },
    });
    box(fab, { top: 440, height: 58, left: 299, width: 58 });
    return {
      root,
      fab,
      get: (id: string) => root.querySelector<HTMLElement>(`#${id}`) as HTMLElement,
    };
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('counts any control: buttons, links, inputs, role=button, tabindex, summary', () => {
    const { root, fab, get } = setup(`
      <button id="x" aria-label="Close">✕</button>
      <a id="link" href="#">Needs you</a>
      <input id="search" type="search" />
      <div id="role" role="button">More</div>
      <span id="focus" tabindex="0">chip</span>
      <details><summary id="summary">More</summary></details>
      <p id="text">Turn on notifications</p>
    `);
    for (const [i, id] of ['x', 'link', 'search', 'role', 'focus', 'summary', 'text'].entries()) {
      box(get(id), { top: 100 + i * 40, height: 32, left: 300, width: 40 });
    }
    expect(fabObstacles(root, fab).map((rect) => rect.top)).toEqual([100, 140, 180, 220, 260, 300]);
  });

  it('a search field counts however wide it is; a row body as large as the button does not', () => {
    const { root, fab, get } = setup(`
      <input id="search" type="search" />
      <div id="row" role="button" tabindex="0">Numbers from 1 to 150</div>
    `);
    box(get('search'), { top: 380, height: 40, left: 16, width: 343 });
    box(get('row'), { top: 430, height: 80, left: 64, width: 256 });
    expect(fabObstacles(root, fab)).toEqual([{ top: 380, bottom: 420, left: 16, right: 359 }]);
  });

  it('a card marked data-fab-avoid counts as a whole, though it is not a control itself', () => {
    const { root, fab, get } = setup('<div id="card" data-fab-avoid></div>');
    box(get('card'), { top: 300, height: 200, left: 64, width: 295 });
    expect(fabObstacles(root, fab)).toHaveLength(1);
  });

  it('skips what nobody can see or reach: hidden, aria-hidden, inert, tabindex -1, no box', () => {
    const { root, fab, get } = setup(`
      <div aria-hidden="true"><button id="swipe">Delete</button></div>
      <div inert><button id="inert">x</button></div>
      <button id="hidden" style="visibility: hidden">x</button>
      <button id="minus" tabindex="-1">x</button>
      <button id="nobox">x</button>
    `);
    for (const id of ['swipe', 'inert', 'hidden', 'minus']) {
      box(get(id), { top: 450, height: 40, left: 300, width: 40 });
    }
    expect(fabObstacles(root, fab)).toEqual([]);
  });
});

describe("the list's scroller", () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('is the nearest ancestor that scrolls vertically', () => {
    document.body.innerHTML = `
      <div id="outer" style="overflow-y: auto">
        <div id="inner" style="overflow-y: scroll"><div><span id="list"></span></div></div>
      </div>`;
    const list = document.getElementById('list') as HTMLElement;
    expect(listScroller(list)?.id).toBe('inner');
  });

  it('is null when only the document scrolls', () => {
    document.body.innerHTML = '<div style="overflow: visible"><span id="list"></span></div>';
    expect(listScroller(document.getElementById('list') as HTMLElement)).toBeNull();
  });
});
