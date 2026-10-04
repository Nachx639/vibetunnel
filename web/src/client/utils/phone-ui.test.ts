// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';
import {
  APP_PREFERENCES_STORAGE_KEY,
  getPhoneUi,
  setPhoneUi,
  subscribeToPhoneUi,
} from './phone-ui.js';

describe('phone layout preference', () => {
  beforeEach(() => setupLocalStorageMock());
  afterEach(() => restoreLocalStorage());

  it('is classic when nothing was chosen', () => {
    expect(getPhoneUi()).toBe('classic');
    localStorage.setItem(APP_PREFERENCES_STORAGE_KEY, JSON.stringify({ useDirectKeyboard: true }));
    expect(getPhoneUi()).toBe('classic');
    localStorage.setItem(APP_PREFERENCES_STORAGE_KEY, 'not json');
    expect(getPhoneUi()).toBe('classic');
  });

  it('keeps the other app preferences when it is saved, and tells listeners', () => {
    localStorage.setItem(APP_PREFERENCES_STORAGE_KEY, JSON.stringify({ useDirectKeyboard: false }));
    const listener = vi.fn();
    const unsubscribe = subscribeToPhoneUi(listener);

    setPhoneUi('compact');

    expect(getPhoneUi()).toBe('compact');
    expect(JSON.parse(localStorage.getItem(APP_PREFERENCES_STORAGE_KEY) ?? '{}')).toEqual({
      useDirectKeyboard: false,
      phoneUi: 'compact',
    });
    expect(listener).toHaveBeenCalledWith('compact');
    unsubscribe();
  });
});
