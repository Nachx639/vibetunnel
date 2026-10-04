// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPACT_LIST_CHANGED_EVENT,
  type CompactListPref,
  phoneListLayout,
  readCompactListPref,
  writeCompactListPref,
} from './phone-list-layout.js';
import { APP_PREFERENCES_STORAGE_KEY } from './phone-ui.js';

// Screens in pt (CSS px), portrait. On an iPhone SE the compact list's first screen could
// show no session; larger phones keep the layout they have.
const SE = { width: 375, height: 667 };
const MINI = { width: 375, height: 812 };
const IPHONE_15 = { width: 393, height: 852 };
const PRO_MAX = { width: 440, height: 956 };

describe('phone list layout decision', () => {
  it.each([
    ['iPhone SE', SE, 'auto', { tight: true, compact: true }],
    ['iPhone SE in landscape', { width: 667, height: 375 }, 'auto', { tight: true, compact: true }],
    // Narrow but tall: tighter spacing only, nothing changes shape.
    ['iPhone mini', MINI, 'auto', { tight: true, compact: false }],
    ['iPhone 15', IPHONE_15, 'auto', { tight: false, compact: false }],
    ['iPhone Pro Max', PRO_MAX, 'auto', { tight: false, compact: false }],
    // The setting, once chosen, wins over the screen…
    ['iPhone SE, compact list off', SE, 'off', { tight: true, compact: false }],
    ['iPhone 15, compact list on', IPHONE_15, 'on', { tight: true, compact: true }],
    // …but spacing on a small screen stays tight even with it off.
    ['iPhone mini, compact list off', MINI, 'off', { tight: true, compact: false }],
  ] as const)('%s', (_name, screen, pref, expected) => {
    expect(phoneListLayout(screen, pref as CompactListPref)).toEqual(expected);
  });

  it('the thresholds are 700 pt tall (compact) and 375 pt wide (tight)', () => {
    expect(phoneListLayout({ width: 400, height: 700 }, 'auto')).toEqual({
      tight: true,
      compact: true,
    });
    expect(phoneListLayout({ width: 400, height: 701 }, 'auto')).toEqual({
      tight: false,
      compact: false,
    });
    expect(phoneListLayout({ width: 376, height: 812 }, 'auto').tight).toBe(false);
  });
});

describe('compact list setting', () => {
  let store: Map<string, string>;
  const prefs = () => JSON.parse(store.get(APP_PREFERENCES_STORAGE_KEY) ?? '{}');
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is "auto" until chosen, and remembers on / off next to the other app preferences', () => {
    store.set(APP_PREFERENCES_STORAGE_KEY, JSON.stringify({ phoneUi: 'compact' }));
    expect(readCompactListPref()).toBe('auto');
    writeCompactListPref('off');
    expect(prefs()).toEqual({ phoneUi: 'compact', compactList: false });
    expect(readCompactListPref()).toBe('off');
    writeCompactListPref('on');
    expect(readCompactListPref()).toBe('on');
    writeCompactListPref('auto');
    expect(prefs()).toEqual({ phoneUi: 'compact' });
  });

  it('ignores a stored value it does not know', () => {
    store.set(APP_PREFERENCES_STORAGE_KEY, JSON.stringify({ compactList: 'maybe' }));
    expect(readCompactListPref()).toBe('auto');
    store.set(APP_PREFERENCES_STORAGE_KEY, '{not json');
    expect(readCompactListPref()).toBe('auto');
  });

  it('tells the open list when it changes', () => {
    const changed = vi.fn();
    window.addEventListener(COMPACT_LIST_CHANGED_EVENT, changed);
    writeCompactListPref('on');
    window.removeEventListener(COMPACT_LIST_CHANGED_EVENT, changed);
    expect(changed).toHaveBeenCalledOnce();
  });

  it('falls back to "auto" with blocked storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readCompactListPref()).toBe('auto');
    expect(() => writeCompactListPref('on')).not.toThrow();
  });
});
