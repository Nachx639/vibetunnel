/**
 * Settings > "Keep the app's files on this device": whether the service worker may serve the
 * client's files from its own cache (sw-shell.ts). On unless turned off, per browser, in the app
 * preferences in localStorage. The worker can't read localStorage, so the page tells it on every
 * start, when the worker changes and when the switch changes. config.json `"pwaShellCache":
 * false` turns it off for every device on the server's side.
 */
import { SHELL_CACHE_PREFERENCE_MESSAGE } from '../sw-shell.js';

const PREFERENCES_KEY = 'vibetunnel_app_preferences';

export function getShellCachePreference(): boolean {
  try {
    const stored = localStorage.getItem(PREFERENCES_KEY);
    return stored ? JSON.parse(stored).pwaShellCache !== false : true;
  } catch {
    return true;
  }
}

/** Tells the worker controlling this page (if any) the device's choice. */
export function postShellCachePreference(): void {
  const controller =
    typeof navigator !== 'undefined' ? navigator.serviceWorker?.controller : undefined;
  controller?.postMessage({ type: SHELL_CACHE_PREFERENCE_MESSAGE, on: getShellCachePreference() });
}

export function setShellCachePreference(on: boolean): void {
  try {
    const stored = localStorage.getItem(PREFERENCES_KEY);
    const preferences = stored ? JSON.parse(stored) : {};
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ ...preferences, pwaShellCache: on }));
  } catch {
    // Storage unavailable (private mode): the worker still hears it for this session.
  }
  const controller =
    typeof navigator !== 'undefined' ? navigator.serviceWorker?.controller : undefined;
  controller?.postMessage({ type: SHELL_CACHE_PREFERENCE_MESSAGE, on });
}

/** Keeps the worker told: now and whenever another worker takes over. Returns the stop. */
export function syncShellCachePreference(): () => void {
  const worker = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
  postShellCachePreference();
  worker?.addEventListener('controllerchange', postShellCachePreference);
  return () => worker?.removeEventListener('controllerchange', postShellCachePreference);
}
