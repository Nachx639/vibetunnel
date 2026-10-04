// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';
import { APP_PREFERENCES_STORAGE_KEY, getPhoneUi } from './phone-ui.js';
import {
  getTerminalTouchScroll,
  setTerminalTouchScroll,
  subscribeToTerminalTouchScroll,
} from './touch-scroll-preference.js';

describe('terminal touch scrolling preference', () => {
  beforeEach(() => setupLocalStorageMock());
  afterEach(() => restoreLocalStorage());

  it('is classic when nothing was chosen', () => {
    expect(getTerminalTouchScroll()).toBe('classic');
    localStorage.setItem(APP_PREFERENCES_STORAGE_KEY, JSON.stringify({ phoneUi: 'compact' }));
    expect(getTerminalTouchScroll()).toBe('classic');
    localStorage.setItem(
      APP_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ terminalTouchScroll: 'bouncy' })
    );
    expect(getTerminalTouchScroll()).toBe('classic');
    localStorage.setItem(APP_PREFERENCES_STORAGE_KEY, 'not json');
    expect(getTerminalTouchScroll()).toBe('classic');
  });

  it('persists next to the other app preferences and tells listeners', () => {
    localStorage.setItem(
      APP_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ useDirectKeyboard: false, phoneUi: 'compact' })
    );
    const listener = vi.fn();
    const unsubscribe = subscribeToTerminalTouchScroll(listener);

    setTerminalTouchScroll('smooth');

    expect(getTerminalTouchScroll()).toBe('smooth');
    expect(getPhoneUi()).toBe('compact');
    expect(JSON.parse(localStorage.getItem(APP_PREFERENCES_STORAGE_KEY) ?? '{}')).toEqual({
      useDirectKeyboard: false,
      phoneUi: 'compact',
      terminalTouchScroll: 'smooth',
    });
    expect(listener).toHaveBeenCalledWith('smooth');

    unsubscribe();
    setTerminalTouchScroll('classic');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getTerminalTouchScroll()).toBe('classic');
  });
});
