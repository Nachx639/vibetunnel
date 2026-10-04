// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';

const push = vi.hoisted(() => ({
  supported: true,
}));
const updateConfig = vi.hoisted(() => vi.fn(async (_updates: unknown) => {}));
const serverConfig = vi.hoisted(() => ({
  current: { repositoryBasePath: '~/' } as Record<string, unknown>,
}));

vi.mock('../services/push-notification-service.js', () => ({
  pushNotificationService: {
    waitForInitialization: vi.fn(async () => {}),
    getPermission: vi.fn(() => 'default'),
    getSubscription: vi.fn(() => null),
    loadPreferences: vi.fn(async () => ({ enabled: false })),
    getSubscriptionStatus: vi.fn(() => ({ hasPermission: false })),
    onPermissionChange: vi.fn(() => () => {}),
    onSubscriptionChange: vi.fn(() => () => {}),
    isSupported: vi.fn(() => push.supported),
    isSubscribed: vi.fn(() => false),
  },
}));

vi.mock('../services/server-config-service.js', () => ({
  ServerConfigService: class {
    loadConfig = vi.fn(async () => serverConfig.current);
    updateConfig = updateConfig;
    setAuthClient = vi.fn();
  },
}));

import { Settings } from './settings.js';

describe('Settings', () => {
  let component: Settings;

  beforeEach(async () => {
    setupLocalStorageMock();
    push.supported = true;
    serverConfig.current = { repositoryBasePath: '~/' };
    component = new Settings();
    component.visible = true;
    document.body.append(component);
    await component.updateComplete;
  });

  afterEach(() => {
    component.remove();
    restoreLocalStorage();
  });

  describe('finished-session cleanup', () => {
    const select = () =>
      component.querySelector('[data-testid="settings-auto-cleanup-select"]') as HTMLSelectElement;

    it('is off unless the user chose an age, and offers 1/3/7/30 days', async () => {
      await vi.waitFor(() => expect(select()).not.toBeNull());
      expect(select().value).toBe('0');
      expect([...select().options].map((option) => option.value)).toEqual([
        '0',
        '1',
        '3',
        '7',
        '30',
      ]);
    });

    it('saves the chosen age and turning it back off', async () => {
      updateConfig.mockClear();
      await vi.waitFor(() => expect(select()).not.toBeNull());

      select().value = '7';
      select().dispatchEvent(new Event('change', { bubbles: true }));
      await vi.waitFor(() =>
        expect(updateConfig).toHaveBeenCalledWith({ autoCleanupExitedAfterDays: 7 })
      );

      select().value = '0';
      select().dispatchEvent(new Event('change', { bubbles: true }));
      await vi.waitFor(() =>
        expect(updateConfig).toHaveBeenLastCalledWith({ autoCleanupExitedAfterDays: 0 })
      );
    });

    it('shows the age saved on the server', async () => {
      serverConfig.current = { repositoryBasePath: '~/', autoCleanupExitedAfterDays: 3 };
      component.visible = false;
      await component.updateComplete;
      component.visible = true;
      await vi.waitFor(async () => {
        await component.updateComplete;
        expect(select().value).toBe('3');
      });
    });
  });
});
