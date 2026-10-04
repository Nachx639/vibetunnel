// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';
import { setLocale } from '../i18n/index.js';
import { quickKeyRowFits } from '../utils/quick-key-sizing.js';
import { PHONE_QUICK_KEYS_LAYOUT, saveQuickKeysLayout } from '../utils/quick-keys-layout.js';
import { TerminalQuickKeys } from './terminal-quick-keys.js';

// On a phone on its side (about 300 pt tall under Safari's bars) the two rows of keys took
// about 90 pt before the keyboard even opened. In the compact phone layout both rows go in one
// when they fit.
const setWindow = (width: number, height: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  window.dispatchEvent(new Event('resize'));
};

const rows = (component: TerminalQuickKeys) =>
  Array.from(component.querySelectorAll<HTMLElement>('.quick-keys-bar > div'));

describe('quick keys on a phone on its side', () => {
  let component: TerminalQuickKeys;

  beforeEach(() => {
    setupLocalStorageMock();
    saveQuickKeysLayout(PHONE_QUICK_KEYS_LAYOUT);
    component = new TerminalQuickKeys();
    component.visible = true;
    component.docked = true;
    component.compact = true;
  });
  afterEach(async () => {
    component.remove();
    restoreLocalStorage();
    setWindow(1024, 768);
    await setLocale('en');
  });

  it.each([
    ['iPhone Pro Max', 956, 330],
    ['iPhone SE', 667, 323],
  ])('%s in landscape: one row, Done at its end', async (_name, width, height) => {
    await setLocale('es');
    setWindow(width, height);
    document.body.append(component);
    await component.updateComplete;
    const [row, ...rest] = rows(component);
    expect(rest).toEqual([]);
    const keys = Array.from(row.querySelectorAll('button')).map((b) => b.textContent?.trim());
    expect(keys).toContain('Esc');
    expect(keys).toContain('Pegar');
    expect(keys.at(-1)).toBe('Listo');
  });

  it('upright, the phone keeps its two rows', async () => {
    setWindow(440, 830);
    document.body.append(component);
    await component.updateComplete;
    expect(rows(component).length).toBe(2);
  });

  it('follows rotations both ways and tells the session view its height changed', async () => {
    setWindow(440, 830);
    document.body.append(component);
    await component.updateComplete;
    const layoutChange = vi.fn();
    component.addEventListener('quick-keys-layout-change', layoutChange);

    setWindow(956, 330);
    await component.updateComplete;
    expect(rows(component).length).toBe(1);
    expect(layoutChange).toHaveBeenCalled();

    layoutChange.mockClear();
    setWindow(440, 830);
    await component.updateComplete;
    expect(rows(component).length).toBe(2);
    expect(layoutChange).toHaveBeenCalled();
  });

  it('an expanded row (Ctrl shortcuts) still opens as a second one', async () => {
    setWindow(956, 330);
    document.body.append(component);
    await component.updateComplete;
    (component as unknown as { showCtrlKeys: boolean }).showCtrlKeys = true;
    await component.updateComplete;
    expect(rows(component).length).toBe(2);
  });

  it('Classic unchanged: without the compact layout the rows stay as they are', async () => {
    component.compact = false;
    component.docked = false;
    setWindow(956, 330);
    document.body.append(component);
    await component.updateComplete;
    expect(rows(component).length).toBe(2);
    expect(component.querySelector('.quick-keys-bar')?.classList.contains('compact')).toBe(false);
  });

  it('two rows when one would not fit', () => {
    const labels = Array.from({ length: 40 }, () => 'Return');
    expect(quickKeyRowFits(labels, 956)).toBe(false);
    expect(quickKeyRowFits(['Esc', '↑', '↓'], 200)).toBe(true);
  });
});
