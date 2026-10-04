/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VibeTunnelApp } from './app.js';

const realWidth = window.innerWidth;
const realHeight = window.innerHeight;
const setWidth = (value: number) =>
  Object.defineProperty(window, 'innerWidth', { configurable: true, value });
const setHeight = (value: number) =>
  Object.defineProperty(window, 'innerHeight', { configurable: true, value });
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
    setHeight(realHeight);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  // A Pro Max on its side is 956 pt wide, past the 768 pt breakpoint. As a desktop the sidebar
  // "opened" under the full-screen session view and the header's "›" went away.
  const app = () =>
    new VibeTunnelApp() as unknown as {
      sidebarCollapsed: boolean;
      mediaState: { isMobile: boolean };
    };
  const phoneOnItsSide = (phoneUi: string) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15'
    );
    setWidth(956);
    setHeight(330);
    localStorage.setItem('vibetunnel_app_preferences', JSON.stringify({ phoneUi }));
    localStorage.setItem('sidebarCollapsed', 'false');
  };

  it('compact layout: a phone on its side is still a phone, the sidebar starts closed', () => {
    phoneOnItsSide('compact');
    const state = app();
    expect(state.sidebarCollapsed).toBe(true);
    expect(state.mediaState.isMobile).toBe(true);
  });

  it('classic layout unchanged: a phone on its side keeps the width breakpoints', () => {
    phoneOnItsSide('classic');
    const state = app();
    expect(state.sidebarCollapsed).toBe(false);
    expect(state.mediaState.isMobile).toBe(false);
  });

  it('a desktop window as wide keeps the desktop sidebar', () => {
    setWidth(956);
    setHeight(330);
    localStorage.setItem('sidebarCollapsed', 'false');
    const state = app();
    expect(state.sidebarCollapsed).toBe(false);
    expect(state.mediaState.isMobile).toBe(false);
  });
});
