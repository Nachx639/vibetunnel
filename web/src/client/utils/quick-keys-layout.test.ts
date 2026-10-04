// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';
import { setPhoneUi } from './phone-ui.js';
import {
  COMPACT_QUICK_KEYS_LAYOUT,
  controlCharacterFor,
  DEFAULT_QUICK_KEYS_LAYOUT,
  getHiddenQuickKeys,
  getQuickKeyDescription,
  isValidQuickKeysLayout,
  loadQuickKeysLayout,
  PHONE_QUICK_KEYS_LAYOUT,
  QUICK_KEYS_LAYOUT_CHANGED_EVENT,
  QUICK_KEYS_STORAGE_KEY,
  resetQuickKeysLayout,
  saveQuickKeysLayout,
} from './quick-keys-layout.js';

describe('quick keys layout preferences', () => {
  beforeEach(() => {
    setupLocalStorageMock();
  });

  afterEach(() => {
    restoreLocalStorage();
  });

  it('uses the current fixed layout as the default', () => {
    expect(loadQuickKeysLayout()).toEqual(DEFAULT_QUICK_KEYS_LAYOUT);
  });

  it('round-trips a versioned browser-local layout', () => {
    expect(saveQuickKeysLayout(COMPACT_QUICK_KEYS_LAYOUT)).toBe(true);
    expect(loadQuickKeysLayout()).toEqual(COMPACT_QUICK_KEYS_LAYOUT);
    expect(JSON.parse(localStorage.getItem(QUICK_KEYS_STORAGE_KEY) ?? '')).toEqual({
      version: 1,
      rows: COMPACT_QUICK_KEYS_LAYOUT,
    });
  });

  it('rejects unknown, duplicate, empty, oversized, and unsupported row layouts', () => {
    expect(isValidQuickKeysLayout([['Escape'], ['not-a-key']])).toBe(false);
    expect(isValidQuickKeysLayout([['Escape'], ['Escape']])).toBe(false);
    expect(isValidQuickKeysLayout([['Escape'], []])).toBe(false);
    expect(
      isValidQuickKeysLayout([
        [
          'Escape',
          'Control',
          'CtrlExpand',
          'F',
          'Tab',
          'shift_tab',
          'ArrowUp',
          'ArrowDown',
          'ArrowLeft',
          'ArrowRight',
          'PageUp',
          'PageDown',
          'Home',
        ],
        ['Paste'],
      ])
    ).toBe(false);
    expect(isValidQuickKeysLayout([['Escape']])).toBe(false);
    expect(isValidQuickKeysLayout([['Escape'], ['Tab'], ['Home'], ['End']])).toBe(false);
  });

  it('falls back to defaults for malformed or future storage values', () => {
    localStorage.setItem(QUICK_KEYS_STORAGE_KEY, '{');
    expect(loadQuickKeysLayout()).toEqual(DEFAULT_QUICK_KEYS_LAYOUT);

    localStorage.setItem(
      QUICK_KEYS_STORAGE_KEY,
      JSON.stringify({ version: 2, rows: COMPACT_QUICK_KEYS_LAYOUT })
    );
    expect(loadQuickKeysLayout()).toEqual(DEFAULT_QUICK_KEYS_LAYOUT);
  });

  it('removes customization when reset and notifies live components', () => {
    const listener = vi.fn();
    window.addEventListener(QUICK_KEYS_LAYOUT_CHANGED_EVENT, listener);
    saveQuickKeysLayout(COMPACT_QUICK_KEYS_LAYOUT);

    expect(resetQuickKeysLayout()).toBe(true);
    expect(localStorage.getItem(QUICK_KEYS_STORAGE_KEY)).toBeNull();
    expect(loadQuickKeysLayout()).toEqual(DEFAULT_QUICK_KEYS_LAYOUT);
    expect(listener).toHaveBeenCalledTimes(2);

    window.removeEventListener(QUICK_KEYS_LAYOUT_CHANGED_EVENT, listener);
  });
});

describe('new quick keys (↵ Enter, #+ symbols)', () => {
  beforeEach(() => {
    setupLocalStorageMock();
  });

  afterEach(() => {
    restoreLocalStorage();
  });

  it('leaves the default layout as it was and offers them among the hidden keys', () => {
    expect(DEFAULT_QUICK_KEYS_LAYOUT.flat()).not.toContain('Enter');
    expect(DEFAULT_QUICK_KEYS_LAYOUT.flat()).not.toContain('Symbols');
    const hidden = getHiddenQuickKeys(loadQuickKeysLayout()).map(({ key }) => key);
    expect(hidden).toContain('Enter');
    expect(hidden).toContain('Symbols');
  });

  it('names the glyph-only keys in the editor, including what ⇤ does in Claude Code', () => {
    expect(getQuickKeyDescription('Enter')).toBe('Enter');
    expect(getQuickKeyDescription('shift_tab')).toBe('Shift Tab · Cycles modes in Claude Code');
    expect(getQuickKeyDescription('/')).toBeUndefined();
  });
});

describe('controlCharacterFor', () => {
  it.each([
    ['c', '\x03'],
    ['C', '\x03'],
    ['[', '\x1b'],
    ['_', '\x1f'],
    [' ', '\x00'],
    ['?', '\x7f'],
  ])('maps Ctrl+%j', (char, expected) => {
    expect(controlCharacterFor(char)).toBe(expected);
  });

  it('returns null for characters without a control code', () => {
    expect(controlCharacterFor('1')).toBeNull();
  });
});

describe('phone default layout', () => {
  beforeEach(() => {
    setupLocalStorageMock();
  });

  afterEach(() => {
    restoreLocalStorage();
    vi.restoreAllMocks();
  });

  const onPhone = () => {
    vi.spyOn(window.screen, 'width', 'get').mockReturnValue(430);
    vi.spyOn(window.screen, 'height', 'get').mockReturnValue(932);
  };

  it('keeps the default layout on phones in the classic phone layout', () => {
    onPhone();
    expect(loadQuickKeysLayout()).toEqual(DEFAULT_QUICK_KEYS_LAYOUT);
  });

  it('uses the two-row agent layout on phones in the compact phone layout, still honoring a saved layout', () => {
    onPhone();
    setPhoneUi('compact');
    expect(isValidQuickKeysLayout(PHONE_QUICK_KEYS_LAYOUT)).toBe(true);
    expect(loadQuickKeysLayout()).toEqual(PHONE_QUICK_KEYS_LAYOUT);

    saveQuickKeysLayout(COMPACT_QUICK_KEYS_LAYOUT);
    expect(loadQuickKeysLayout()).toEqual(COMPACT_QUICK_KEYS_LAYOUT);
  });

  it('keeps the default layout on larger screens in the compact phone layout', () => {
    setPhoneUi('compact');
    vi.spyOn(window.screen, 'width', 'get').mockReturnValue(1024);
    vi.spyOn(window.screen, 'height', 'get').mockReturnValue(1366);
    expect(loadQuickKeysLayout()).toEqual(DEFAULT_QUICK_KEYS_LAYOUT);
  });
});
