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
import { getVoicePreferences } from '../utils/voice-preferences.js';
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

  describe('voice', () => {
    const toggle = (key: string) =>
      component.querySelector(`[data-testid="settings-${key}"]`) as HTMLButtonElement | null;

    it('Voice starts on and Browser speech off; each switch is stored', async () => {
      expect(toggle('voice')?.getAttribute('aria-checked')).toBe('true');
      expect(toggle('browserSpeech')?.getAttribute('aria-checked')).toBe('false');

      toggle('voice')?.click();
      toggle('browserSpeech')?.click();
      await component.updateComplete;

      expect(toggle('voice')?.getAttribute('aria-checked')).toBe('false');
      expect(toggle('browserSpeech')?.getAttribute('aria-checked')).toBe('true');
      expect(getVoicePreferences()).toEqual({ voice: false, browserSpeech: true });
    });
  });
});
