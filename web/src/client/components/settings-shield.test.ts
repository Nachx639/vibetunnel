// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';

const serverConfig = vi.hoisted(() => ({
  current: { repositoryBasePath: '~/' } as Record<string, unknown>,
}));
const updateConfig = vi.hoisted(() => vi.fn(async () => {}));

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
    loadConfig = vi.fn(async () => serverConfig.current);
    updateConfig = updateConfig;
    setAuthClient = vi.fn();
  },
}));

import { Settings } from './settings.js';

describe('Settings: shielded sessions', () => {
  let component: Settings;
  const toggle = () =>
    component.querySelector('[data-testid="settings-shield-new-toggle"]') as HTMLButtonElement;
  const restore = () =>
    component.querySelector('[data-testid="settings-shield-restore"]') as HTMLSelectElement;

  async function open(config: Record<string, unknown>) {
    serverConfig.current = { repositoryBasePath: '~/', ...config };
    component = new Settings();
    component.visible = true;
    document.body.append(component);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await component.updateComplete;
  }

  beforeEach(() => {
    setupLocalStorageMock();
    updateConfig.mockClear();
  });

  afterEach(() => {
    component.remove();
    restoreLocalStorage();
  });

  it('is hidden when tmux is not on the server', async () => {
    await open({ shieldAvailable: false });
    expect(toggle()).toBeNull();
  });

  it('is off by default, restores nothing, and saves turning it on', async () => {
    await open({ shieldAvailable: true });
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(restore().value).toBe('off');
    toggle().click();
    await vi.waitFor(() => expect(updateConfig).toHaveBeenCalledWith({ shieldNewSessions: true }));
    await component.updateComplete;
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });

  it('shows and saves what a restart restores', async () => {
    await open({ shieldAvailable: true, shieldNewSessions: true, shieldRestore: 'agents' });
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(restore().value).toBe('agents');
    restore().value = 'all';
    restore().dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(updateConfig).toHaveBeenCalledWith({ shieldRestore: 'all' }));
  });
});
