// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';

const push = vi.hoisted(() => ({
  started: Promise.resolve(),
  enabled: false,
  permission: false,
  subscription: null as { endpoint: string } | null,
  forceRefresh: vi.fn(async () => {}),
}));

vi.mock('../services/push-notification-service.js', () => ({
  pushNotificationService: {
    waitForInitialization: vi.fn(async () => {}),
    whenInitialized: vi.fn(() => push.started),
    getPermission: vi.fn(() => (push.permission ? 'granted' : 'default')),
    getSubscription: vi.fn(() => push.subscription),
    loadPreferences: vi.fn(async () => ({ enabled: push.enabled })),
    getSubscriptionStatus: vi.fn(() => ({ hasPermission: push.permission })),
    forceRefreshSubscription: push.forceRefresh,
    onPermissionChange: vi.fn(() => () => {}),
    onSubscriptionChange: vi.fn(() => () => {}),
    isSupported: vi.fn(() => true),
    isSubscribed: vi.fn(() => false),
    getServerStatus: vi.fn(async () => ({ enabled: true, configured: true })),
  },
}));

vi.mock('../services/server-config-service.js', () => ({
  ServerConfigService: class {
    loadConfig = vi.fn(async () => ({ repositoryBasePath: '~/' }));
    updateConfig = vi.fn(async () => {});
    setAuthClient = vi.fn();
  },
}));

import { applyAccent } from '../utils/accent-themes.js';
import { applyThemeMode } from '../utils/theme-mode.js';
import { Settings } from './settings.js';

describe('Settings', () => {
  let component: Settings;

  beforeEach(async () => {
    setupLocalStorageMock();
    push.started = Promise.resolve();
    push.enabled = false;
    push.permission = false;
    push.subscription = null;
    push.forceRefresh.mockClear();
    component = new Settings();
    component.visible = true;
    document.body.append(component);
    await component.updateComplete;
  });

  afterEach(() => {
    component.remove();
    restoreLocalStorage();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-accent');
  });

  const button = (testId: string) =>
    component.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;

  describe('notifications before the push service has started', () => {
    it('waits for it instead of forcing a resubscribe of a subscription not read yet', async () => {
      let start = () => {};
      push.started = new Promise<void>((resolve) => {
        start = resolve;
      });
      push.enabled = true;
      push.permission = true;
      const early = new Settings();
      early.visible = true;
      document.body.append(early);
      await early.updateComplete;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(push.forceRefresh).not.toHaveBeenCalled();

      // Started: the subscription was there all along.
      push.subscription = { endpoint: 'https://push.example/abc' };
      start();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(push.forceRefresh).not.toHaveBeenCalled();
      early.remove();
    });
  });

  describe('appearance', () => {
    it('starts on the default color theme', () => {
      expect(button('settings-accent-emerald')?.getAttribute('aria-pressed')).toBe('true');
    });

    it('applies light/dark/system and color themes instantly', async () => {
      const themeChanged = vi.fn();
      component.addEventListener('theme-changed', themeChanged);

      button('settings-theme-dark')?.click();
      await component.updateComplete;
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
      expect(localStorage.getItem('vibetunnel-theme')).toBe('dark');
      expect(themeChanged).toHaveBeenCalledOnce();
      expect(button('settings-theme-dark')?.getAttribute('aria-pressed')).toBe('true');

      button('settings-accent-violet')?.click();
      await component.updateComplete;
      expect(document.documentElement.getAttribute('data-accent')).toBe('violet');
      expect(localStorage.getItem('vibetunnel-accent')).toBe('violet');
      expect(button('settings-accent-violet')?.getAttribute('aria-pressed')).toBe('true');
    });

    it('follows theme and color changes made elsewhere', async () => {
      applyThemeMode('light');
      window.dispatchEvent(new CustomEvent('theme-changed', { detail: { theme: 'light' } }));
      applyAccent('gold');
      await component.updateComplete;

      expect(button('settings-theme-light')?.getAttribute('aria-pressed')).toBe('true');
      expect(button('settings-accent-gold')?.getAttribute('aria-pressed')).toBe('true');
    });
  });
});
