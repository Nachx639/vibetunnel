// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';

vi.mock('../services/push-notification-service.js', () => ({
  pushNotificationService: {
    waitForInitialization: vi.fn(async () => {}),
    getPermission: vi.fn(() => 'default'),
    getSubscription: vi.fn(() => null),
    loadPreferences: vi.fn(async () => ({ enabled: false })),
    getSubscriptionStatus: vi.fn(() => ({ hasPermission: false })),
    forceRefreshSubscription: vi.fn(async () => {}),
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

  describe('phone layout', () => {
    it('is Classic until Compact is picked, and remembers the choice', async () => {
      expect(button('settings-phone-layout-classic')?.getAttribute('aria-pressed')).toBe('true');
      button('settings-phone-layout-compact')?.click();
      await component.updateComplete;
      expect(button('settings-phone-layout-compact')?.getAttribute('aria-pressed')).toBe('true');
      expect(JSON.parse(localStorage.getItem('vibetunnel_app_preferences') ?? '{}').phoneUi).toBe(
        'compact'
      );
    });
  });

  describe('system text size', () => {
    async function mountWith(touchWebKit: boolean) {
      vi.stubGlobal('CSS', {
        supports: (property: string) => touchWebKit && property === '-webkit-touch-callout',
      });
      const settings = new Settings();
      settings.visible = true;
      document.body.append(settings);
      await settings.updateComplete;
      return settings;
    }

    afterEach(() => {
      vi.unstubAllGlobals();
      document.documentElement.removeAttribute('data-text-size');
    });

    it('is an Appearance switch, off by default, that sets the root font from Dynamic Type', async () => {
      const settings = await mountWith(true);
      const toggle = settings.querySelector<HTMLButtonElement>(
        '[data-testid="settings-appearance"] [data-testid="settings-system-text-size-toggle"]'
      );
      expect(toggle?.getAttribute('aria-checked')).toBe('false');
      const label = settings.querySelector(`#${toggle?.getAttribute('aria-labelledby')}`);
      expect(label?.textContent?.trim()).toBe('Use the system text size');

      toggle?.click();
      await settings.updateComplete;
      expect(toggle?.getAttribute('aria-checked')).toBe('true');
      expect(document.documentElement.getAttribute('data-text-size')).toBe('system');
      expect(localStorage.getItem('vt-system-text-size')).toBe('on');

      toggle?.click();
      await settings.updateComplete;
      expect(document.documentElement.hasAttribute('data-text-size')).toBe(false);
      settings.remove();
    });

    it('is not offered where it would do nothing (a Mac, other browsers)', async () => {
      const settings = await mountWith(false);
      expect(settings.querySelector('[data-testid="settings-system-text-size"]')).toBeNull();
      settings.remove();
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
