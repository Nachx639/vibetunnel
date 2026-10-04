/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VibeTunnelApp } from './app.js';

const realWidth = window.innerWidth;
const setWidth = (value: number) =>
  Object.defineProperty(window, 'innerWidth', { configurable: true, value });
const sidebarCollapsed = () =>
  (new VibeTunnelApp() as unknown as { sidebarCollapsed: boolean }).sidebarCollapsed;

describe('the sidebar when the app loads', () => {
  beforeEach(() => {
    // The shared test setup stubs localStorage with no-op mocks; this needs one that stores.
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
    });
  });
  afterEach(() => {
    setWidth(realWidth);
    vi.unstubAllGlobals();
  });

  it('starts closed on a phone even if it was left open, so a session link shows the session', () => {
    setWidth(390);
    localStorage.setItem('sidebarCollapsed', 'false');
    expect(sidebarCollapsed()).toBe(true);
  });

  it('keeps the saved state on a wider screen', () => {
    setWidth(1280);
    localStorage.setItem('sidebarCollapsed', 'false');
    expect(sidebarCollapsed()).toBe(false);
    localStorage.setItem('sidebarCollapsed', 'true');
    expect(sidebarCollapsed()).toBe(true);
  });
});
