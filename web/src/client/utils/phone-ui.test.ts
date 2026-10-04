// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';
import {
  APP_PREFERENCES_STORAGE_KEY,
  getPhoneUi,
  isPhoneScreen,
  isPhoneSizedScreen,
  setPhoneUi,
  subscribeToPhoneUi,
  usesCompactPhoneUi,
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

  describe('only on phone-sized screens', () => {
    afterEach(() => vi.restoreAllMocks());
    const screenSize = (width: number, height: number) => {
      vi.spyOn(window.screen, 'width', 'get').mockReturnValue(width);
      vi.spyOn(window.screen, 'height', 'get').mockReturnValue(height);
    };

    it('applies Compact on a phone, in portrait and landscape', () => {
      setPhoneUi('compact');
      screenSize(390, 844);
      expect(isPhoneSizedScreen()).toBe(true);
      expect(usesCompactPhoneUi()).toBe(true);
      vi.restoreAllMocks();
      screenSize(932, 430);
      expect(usesCompactPhoneUi()).toBe(true);
    });

    it('keeps an iPad or a desktop on Classic even with Compact chosen', () => {
      setPhoneUi('compact');
      for (const [width, height] of [
        [820, 1180],
        [744, 1133],
        [1024, 1366],
        [1920, 1080],
      ]) {
        vi.restoreAllMocks();
        screenSize(width, height);
        expect(isPhoneSizedScreen()).toBe(false);
        expect(usesCompactPhoneUi()).toBe(false);
      }
    });

    it('counts a touch device with a phone-sized window, but not a narrow desktop window', () => {
      setPhoneUi('compact');
      screenSize(820, 1180);
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(320);
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(1180);
      // A narrow desktop window: no touch, so still classic
      vi.spyOn(navigator, 'maxTouchPoints', 'get').mockReturnValue(0);
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh)');
      expect(isPhoneScreen()).toBe(false);
      expect(usesCompactPhoneUi()).toBe(false);
      // An iPad in a narrow Split View window looks like a phone
      vi.spyOn(navigator, 'maxTouchPoints', 'get').mockReturnValue(5);
      expect(isPhoneScreen()).toBe(true);
      expect(usesCompactPhoneUi()).toBe(true);
      // The same iPad full screen keeps Classic
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(820);
      expect(usesCompactPhoneUi()).toBe(false);
    });

    it('Classic unchanged: a phone with Classic chosen (or nothing saved) stays classic', () => {
      screenSize(390, 844);
      expect(usesCompactPhoneUi()).toBe(false);
      setPhoneUi('classic');
      expect(usesCompactPhoneUi()).toBe(false);
    });
  });
});
