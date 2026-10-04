/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { iosStandaloneShortfall } from './lifecycle-event-manager.js';

function device(options: {
  ua: string;
  standalone: boolean;
  width: number;
  height: number;
  screenHeight: number;
}) {
  vi.stubGlobal('navigator', { userAgent: options.ua, standalone: options.standalone });
  vi.stubGlobal('screen', { height: options.screenHeight });
  Object.defineProperty(window, 'innerWidth', { value: options.width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: options.height, configurable: true });
}

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_2 like Mac OS X)';

describe('iosStandaloneShortfall', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('adds back the status bar an iPhone home-screen app is missing, and only that', () => {
    device({ ua: IPHONE, standalone: true, width: 402, height: 812, screenHeight: 874 });
    expect(iosStandaloneShortfall(812)).toBe(62);

    // Landscape: screen.height stays the portrait value; never stretch to it.
    device({ ua: IPHONE, standalone: true, width: 874, height: 402, screenHeight: 874 });
    expect(iosStandaloneShortfall(402)).toBe(0);

    // In Safari (not installed) the browser bars are real chrome, not a bug.
    device({ ua: IPHONE, standalone: false, width: 402, height: 700, screenHeight: 874 });
    expect(iosStandaloneShortfall(700)).toBe(0);

    // Installed desktop app in a window smaller than the screen.
    device({
      ua: 'Mozilla/5.0 (Macintosh)',
      standalone: true,
      width: 1200,
      height: 900,
      screenHeight: 1440,
    });
    expect(iosStandaloneShortfall(900)).toBe(0);
  });
});
