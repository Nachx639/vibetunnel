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

  // "Compact list" for the compact phone list (utils/phone-list-layout.ts).
  describe('compact list', () => {
    const IPHONE =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
    async function mountOnPhone(width: number, height: number, phoneUi = 'compact') {
      component.remove();
      localStorage.setItem('vibetunnel_app_preferences', JSON.stringify({ phoneUi }));
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE);
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(width);
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(height);
      Object.defineProperty(window.screen, 'width', { configurable: true, get: () => width });
      Object.defineProperty(window.screen, 'height', { configurable: true, get: () => height });
      component = new Settings();
      component.visible = true;
      document.body.append(component);
      await component.updateComplete;
      return button('settings-compact-list-toggle');
    }
    afterEach(() => vi.restoreAllMocks());

    it('is on by default on a screen up to 700 pt tall, off on a larger phone', async () => {
      expect((await mountOnPhone(375, 667))?.getAttribute('aria-checked')).toBe('true');
      expect((await mountOnPhone(393, 852))?.getAttribute('aria-checked')).toBe('false');
    });

    it('a tap stores an explicit choice the list follows', async () => {
      const toggle = await mountOnPhone(375, 667);
      const changed = vi.fn();
      window.addEventListener('vibetunnel-compact-list-changed', changed);
      toggle?.click();
      await component.updateComplete;
      window.removeEventListener('vibetunnel-compact-list-changed', changed);
      expect(toggle?.getAttribute('aria-checked')).toBe('false');
      expect(JSON.parse(localStorage.getItem('vibetunnel_app_preferences') ?? '{}')).toEqual({
        phoneUi: 'compact',
        compactList: false,
      });
      expect(changed).toHaveBeenCalledOnce();
    });

    it('classic unchanged: not offered with the classic phone layout', async () => {
      expect(await mountOnPhone(375, 667, 'classic')).toBeNull();
    });

    it('appears as soon as Compact is picked on a phone', async () => {
      await mountOnPhone(375, 667, 'classic');
      button('settings-phone-layout-compact')?.click();
      await component.updateComplete;
      expect(button('settings-compact-list-toggle')).not.toBeNull();
    });

    it('is not offered on a desktop', () => {
      expect(button('settings-compact-list-toggle')).toBeNull();
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
