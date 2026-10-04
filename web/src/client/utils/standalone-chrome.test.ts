// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';
import {
  getHeaderClearance,
  HEADER_CLEARANCE_ATTRIBUTE,
  setHeaderClearance,
  trackHeaderClearance,
} from './standalone-chrome.js';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';

function screen(ua: string, size: [number, number]) {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => ua });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: size[0] });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: size[1] });
}

const marked = () => document.documentElement.hasAttribute(HEADER_CLEARANCE_ATTRIBUTE);

describe('html[data-header-clearance] for the home-screen header clearance', () => {
  let stop: (() => void) | undefined;

  beforeEach(() => setupLocalStorageMock());
  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.restoreAllMocks();
    restoreLocalStorage();
    Reflect.deleteProperty(navigator, 'userAgent');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
  });

  it('is on by default on a phone', () => {
    screen(IPHONE_UA, [390, 844]);
    expect(getHeaderClearance()).toBe(true);
    stop = trackHeaderClearance();
    expect(marked()).toBe(true);
  });

  it('the Settings switch turns it off and back on, and is remembered', () => {
    screen(IPHONE_UA, [390, 844]);
    stop = trackHeaderClearance();
    setHeaderClearance(false);
    expect(marked()).toBe(false);
    expect(JSON.parse(localStorage.getItem('vibetunnel_app_preferences') ?? '{}')).toMatchObject({
      headerClearance: false,
    });
    expect(getHeaderClearance()).toBe(false);
    setHeaderClearance(true);
    expect(marked()).toBe(true);
  });

  it('never applies off a phone', () => {
    screen(DESKTOP_UA, [1024, 768]);
    stop = trackHeaderClearance();
    expect(marked()).toBe(false);
  });

  it('stopping removes the mark', () => {
    screen(IPHONE_UA, [390, 844]);
    stop = trackHeaderClearance();
    expect(marked()).toBe(true);
    stop();
    stop = undefined;
    expect(marked()).toBe(false);
  });
});
