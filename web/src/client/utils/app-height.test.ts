// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  followRotationsOutsideSession,
  iosStandaloneShortfall,
  resetAppHeight,
  standaloneAppHeight,
} from './app-height.js';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';

/** A 440 x 956 pt iPhone; `window_` is the window's size (innerHeight misses the status bar). */
function iphone(window_: [number, number], standalone = true) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE_UA);
  Object.defineProperty(navigator, 'standalone', { configurable: true, value: standalone });
  vi.spyOn(window.screen, 'width', 'get').mockReturnValue(440);
  vi.spyOn(window.screen, 'height', 'get').mockReturnValue(956);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: window_[0] });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: window_[1] });
}

const appHeight = () => document.documentElement.style.getPropertyValue('--app-height');

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'standalone');
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
  document.documentElement.style.removeProperty('--app-height');
  document.documentElement.style.removeProperty('--keyboard-offset');
});

describe('the iPhone home-screen app height', () => {
  it('adds the status bar back only in the home-screen app, in portrait', () => {
    iphone([440, 894]);
    expect(iosStandaloneShortfall(894)).toBe(62);
    iphone([440, 894], false);
    expect(iosStandaloneShortfall(894)).toBe(0);
    iphone([956, 440]);
    expect(iosStandaloneShortfall(440)).toBe(0);
  });

  it('is the visual viewport plus the status bar while there is no keyboard', () => {
    iphone([440, 894]);
    expect(standaloneAppHeight(894, 894)).toBe(956);
  });

  it('with the keyboard up, is the visual viewport alone, even when innerHeight stays full', () => {
    iphone([440, 894]);
    // innerHeight kept at 894 with a 541 visual viewport: no 62 px added on top of it, which
    // would put the bottom of the page behind the keyboard's accessory bar.
    expect(standaloneAppHeight(894, 541)).toBe(541);
    // innerHeight following the keyboard.
    expect(standaloneAppHeight(541, 541)).toBe(541);
  });

  it('elsewhere is the visual viewport, as before', () => {
    expect(standaloneAppHeight(768, 768)).toBe(768);
    expect(standaloneAppHeight(768, 500)).toBe(500);
  });

  it('leaving a session puts the page height back: no keyboard-time height left behind', () => {
    document.documentElement.style.setProperty('--app-height', '420px');
    document.documentElement.style.setProperty('--keyboard-offset', '300px');
    resetAppHeight();
    // Not a home-screen iPhone app: back to the stylesheet's 100dvh.
    expect(appHeight()).toBe('');
    expect(document.documentElement.style.getPropertyValue('--keyboard-offset')).toBe('0px');

    iphone([440, 894]);
    resetAppHeight();
    expect(appHeight()).toBe('956px');
  });
});

describe('the page height across rotations, outside a session', () => {
  let stop: (() => void) | undefined;

  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  it('drops the portrait height on its side and brings it back upright', () => {
    iphone([440, 894]);
    document.documentElement.style.setProperty('--app-height', '956px');
    stop = followRotationsOutsideSession(() => false);

    iphone([956, 440]);
    window.dispatchEvent(new Event('resize'));
    // The window's own height (100dvh in styles.css).
    expect(appHeight()).toBe('');

    iphone([440, 894]);
    window.dispatchEvent(new Event('resize'));
    expect(appHeight()).toBe('956px');
  });

  it('checks again after orientationchange, when iOS has the new size', () => {
    vi.useFakeTimers();
    try {
      iphone([440, 894]);
      stop = followRotationsOutsideSession(() => false);
      window.dispatchEvent(new Event('orientationchange'));
      expect(appHeight()).toBe('956px');
      iphone([956, 440]);
      vi.advanceTimersByTime(300);
      expect(appHeight()).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the height to an open session, which tracks it itself', () => {
    document.documentElement.style.setProperty('--app-height', '956px');
    stop = followRotationsOutsideSession(() => true);
    iphone([956, 440]);
    window.dispatchEvent(new Event('resize'));
    expect(appHeight()).toBe('956px');
  });

  it('stops when asked', () => {
    document.documentElement.style.setProperty('--app-height', '956px');
    stop = followRotationsOutsideSession(() => false);
    stop();
    iphone([956, 440]);
    window.dispatchEvent(new Event('resize'));
    expect(appHeight()).toBe('956px');
  });
});
