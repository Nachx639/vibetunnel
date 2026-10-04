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
import { getPhoneUi } from '../utils/phone-ui.js';
import { applyThemeMode } from '../utils/theme-mode.js';
import { getTerminalTouchScroll } from '../utils/touch-scroll-preference.js';
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

  describe('phone layout', () => {
    const option = (value: string) =>
      component.querySelector(`[data-phone-ui="${value}"]`) as HTMLButtonElement | null;

    it('starts on Classic and stores Compact when chosen', async () => {
      expect(option('classic')?.getAttribute('aria-pressed')).toBe('true');

      option('compact')?.click();
      await component.updateComplete;

      expect(option('compact')?.getAttribute('aria-pressed')).toBe('true');
      expect(getPhoneUi()).toBe('compact');
    });
  });

  describe('smooth touch scrolling', () => {
    const option = (value: string) =>
      component.querySelector(`[data-touch-scroll="${value}"]`) as HTMLButtonElement | null;

    it('starts on Classic and stores Smooth when chosen', async () => {
      expect(option('classic')?.getAttribute('aria-pressed')).toBe('true');
      expect(getTerminalTouchScroll()).toBe('classic');

      option('smooth')?.click();
      await component.updateComplete;

      expect(option('smooth')?.getAttribute('aria-pressed')).toBe('true');
      expect(getTerminalTouchScroll()).toBe('smooth');

      option('classic')?.click();
      await component.updateComplete;
      expect(getTerminalTouchScroll()).toBe('classic');
    });
  });
});
