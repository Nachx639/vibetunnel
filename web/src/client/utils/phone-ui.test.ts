/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPhoneUi, PHONE_UI_CHANGED_EVENT, setPhoneUi, usesCompactPhoneUi } from './phone-ui.js';

describe('phone layout preference', () => {
  // The global localStorage mock stores nothing; give these tests a real one.
  const store = new Map<string, string>();
  const realWidth = window.innerWidth;
  const realHeight = window.innerHeight;
  const setSize = (width: number, height: number) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  };
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockImplementation((key) => store.get(key) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
      store.set(key, value);
    });
  });
  afterEach(() => {
    store.clear();
    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.setItem).mockReset();
    setSize(realWidth, realHeight);
    vi.restoreAllMocks();
  });

  it('is classic unless compact was chosen, so existing users see no change', () => {
    expect(getPhoneUi()).toBe('classic');
    store.set('vibetunnel_app_preferences', JSON.stringify({ useDirectKeyboard: false }));
    expect(getPhoneUi()).toBe('classic');
    store.set('vibetunnel_app_preferences', '{broken');
    expect(getPhoneUi()).toBe('classic');
  });

  it('saves the choice next to the other app preferences and announces it', () => {
    store.set('vibetunnel_app_preferences', JSON.stringify({ useDirectKeyboard: false }));
    const heard = vi.fn();
    window.addEventListener(PHONE_UI_CHANGED_EVENT, heard);
    setPhoneUi('compact');
    window.removeEventListener(PHONE_UI_CHANGED_EVENT, heard);
    expect(JSON.parse(store.get('vibetunnel_app_preferences') ?? '{}')).toEqual({
      useDirectKeyboard: false,
      phoneUi: 'compact',
    });
    expect(getPhoneUi()).toBe('compact');
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('applies the compact layout only on a phone', () => {
    const userAgent = (value: string) =>
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(value);
    setPhoneUi('compact');
    userAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    setSize(390, 844);
    expect(usesCompactPhoneUi()).toBe(true);
    setSize(1024, 1366); // a tablet
    expect(usesCompactPhoneUi()).toBe(false);
    userAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    setSize(390, 844); // a narrow desktop window
    expect(usesCompactPhoneUi()).toBe(false);
    userAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    setPhoneUi('classic');
    expect(usesCompactPhoneUi()).toBe(false);
  });
});
