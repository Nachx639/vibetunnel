// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';
import {
  getShellCachePreference,
  setShellCachePreference,
  syncShellCachePreference,
} from './shell-cache-preference.js';

describe("Keep the app's files on this device", () => {
  let posted: unknown[];
  let worker: EventTarget & { controller?: { postMessage: (m: unknown) => void } };

  beforeEach(() => {
    setupLocalStorageMock();
    posted = [];
    worker = Object.assign(new EventTarget(), {
      controller: { postMessage: (message: unknown) => posted.push(message) },
    });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: worker });
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'serviceWorker');
    restoreLocalStorage();
    vi.restoreAllMocks();
  });

  it('is on by default, and the worker is told so at start and when another one takes over', () => {
    expect(getShellCachePreference()).toBe(true);
    const stop = syncShellCachePreference();
    expect(posted).toEqual([{ type: 'vt-shell-cache-preference', on: true }]);
    worker.dispatchEvent(new Event('controllerchange'));
    expect(posted).toHaveLength(2);
    stop();
    worker.dispatchEvent(new Event('controllerchange'));
    expect(posted).toHaveLength(2);
  });

  it('turned off: stored with the other app preferences and told to the worker', () => {
    localStorage.setItem('vibetunnel_app_preferences', JSON.stringify({ phoneUi: 'compact' }));
    setShellCachePreference(false);
    expect(getShellCachePreference()).toBe(false);
    expect(JSON.parse(localStorage.getItem('vibetunnel_app_preferences') ?? '{}')).toEqual({
      phoneUi: 'compact',
      pwaShellCache: false,
    });
    expect(posted).toEqual([{ type: 'vt-shell-cache-preference', on: false }]);
  });
});
