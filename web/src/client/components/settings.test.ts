// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';

const push = vi.hoisted(() => ({
  started: Promise.resolve(),
  enabled: false,
  permission: false,
  subscription: null as { endpoint: string } | null,
  forceRefresh: vi.fn(async () => {}),
  supported: true,
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
    isSupported: vi.fn(() => push.supported),
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
    push.supported = true;
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

  const renderWithUserAgent = async (userAgent: string) => {
    component.remove();
    push.supported = false;
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
    component = new Settings();
    component.visible = true;
    document.body.append(component);
    await component.updateComplete;
  };

  describe('notifications on iPhone', () => {
    afterEach(() => vi.restoreAllMocks());

    it('walks through Share, Add to Home Screen and reopening when not installed', async () => {
      await renderWithUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'
      );
      const steps = [
        ...component.querySelectorAll('[data-testid="settings-ios-install"] li > span:last-child'),
      ].map((li) => li.textContent?.trim());
      expect(steps).toEqual([
        "Tap Share (the square with an up arrow) in Safari's toolbar",
        'Choose "Add to Home Screen", then tap Add',
        'Open VibeTunnel from your Home Screen and turn notifications on here',
      ]);
      expect(
        component.querySelector('[data-testid="settings-ios-install"] svg path')?.namespaceURI
      ).toBe('http://www.w3.org/2000/svg');
    });

    it('in Chrome: install steps, not "unsupported", with the address to open in Safari', async () => {
      await renderWithUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1'
      );
      const install = component.querySelector('[data-testid="settings-ios-install"]');
      expect(install).not.toBeNull();
      expect(component.textContent).not.toContain('not supported');
      const steps = [...(install?.querySelectorAll('li > span:last-child') ?? [])].map((li) =>
        li.textContent?.trim()
      );
      expect(steps[0]).toBe('Tap Share (the icon in the address bar)');
      expect(steps[1]).toContain('iOS 16.4');
      const address = install?.querySelector('app-address-copy') as HTMLElement & {
        updateComplete: Promise<unknown>;
      };
      await address.updateComplete;
      expect(address.querySelector('[data-testid="app-address-value"]')?.textContent).toBe(
        window.location.origin
      );
      expect(address.textContent).toContain('open it in Safari');
    });

    it('a desktop browser keeps the plain "not supported" message', async () => {
      await renderWithUserAgent(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
      );
      expect(component.querySelector('[data-testid="settings-ios-install"]')).toBeNull();
    });
  });

  describe('reload after an update', () => {
    it('is off by default and the switch stores the choice', async () => {
      const toggle = button('settings-auto-reload');
      expect(toggle?.getAttribute('aria-checked')).toBe('false');
      toggle?.click();
      await component.updateComplete;
      expect(toggle?.getAttribute('aria-checked')).toBe('true');
      expect(JSON.parse(localStorage.getItem('vibetunnel_app_preferences') ?? '{}')).toMatchObject({
        autoReloadOnUpdate: true,
      });
    });
  });

  describe("clear the iPhone's top blur", () => {
    it('is on by default and the switch stores the choice', async () => {
      const toggle = button('settings-header-clearance');
      expect(toggle?.getAttribute('aria-checked')).toBe('true');
      toggle?.click();
      await component.updateComplete;
      expect(toggle?.getAttribute('aria-checked')).toBe('false');
      expect(JSON.parse(localStorage.getItem('vibetunnel_app_preferences') ?? '{}')).toMatchObject({
        headerClearance: false,
      });
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
