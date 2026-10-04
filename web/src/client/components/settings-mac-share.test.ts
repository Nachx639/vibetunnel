// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';

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

import { MAC_SESSIONS_CHANGED_EVENT } from '../../shared/mac-sessions.js';
import { Settings } from './settings.js';

describe('Settings: Share with phone', () => {
  let component: Settings;
  const changed = vi.fn();
  const share = () => component.querySelector('[data-testid="settings-mac-share"]');
  const shareToggle = () =>
    component.querySelector('[data-testid="settings-mac-share-toggle"]') as HTMLButtonElement;
  const launcher = () =>
    component.querySelector(
      '[data-testid="settings-mac-share-launcher"]'
    ) as HTMLSelectElement | null;

  beforeEach(async () => {
    setupLocalStorageMock();
    updateConfig.mockReset();
    updateConfig.mockResolvedValue(undefined);
    changed.mockClear();
    window.addEventListener(MAC_SESSIONS_CHANGED_EVENT, changed);
    serverConfig.current = { repositoryBasePath: '~/' };
    component = new Settings();
    document.body.append(component);
  });

  afterEach(() => {
    window.removeEventListener(MAC_SESSIONS_CHANGED_EVENT, changed);
    component.remove();
    restoreLocalStorage();
  });

  /** Opens Settings on a macOS server with "On this computer" on, plus `config`. */
  async function showWith(config: Record<string, unknown>) {
    serverConfig.current = {
      repositoryBasePath: '~/',
      platform: 'darwin',
      macSessionsSupported: true,
      macSessions: true,
      ...config,
    };
    component.visible = false;
    await component.updateComplete;
    component.visible = true;
    await vi.waitFor(async () => {
      await component.updateComplete;
      expect(component.querySelector('[data-testid="settings-mac-sessions"]')).not.toBeNull();
    });
  }

  it('is off by default under "On this computer", and saves when turned on', async () => {
    await showWith({ macShareSupported: true });
    expect(shareToggle().getAttribute('aria-checked')).toBe('false');
    expect(share()?.textContent).toContain('Share Mac terminals with the phone');
    expect(launcher()).toBeNull();
    shareToggle().click();
    await vi.waitFor(() => expect(updateConfig).toHaveBeenCalledWith({ macShare: true }));
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    await component.updateComplete;
    expect(shareToggle().getAttribute('aria-checked')).toBe('true');
    expect(launcher()?.value).toBe('vt');
  });

  it('chooses how it reopens, with the shell hint', async () => {
    await showWith({ macShareSupported: true, macShare: true, macShareLauncher: 'shell' });
    expect(launcher()?.value).toBe('shell');
    expect([...(launcher()?.options ?? [])].map((option) => option.textContent?.trim())).toEqual([
      'vt',
      'My shell’s own command',
    ]);
    const field = launcher() as HTMLSelectElement;
    field.value = 'vt';
    field.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(updateConfig).toHaveBeenCalledWith({ macShareLauncher: 'vt' }));
  });

  it('is locked when forced at start, and says how', async () => {
    await showWith({
      macShareSupported: true,
      macShare: true,
      macShareLocked: true,
      macShareLockedBy: '--mac-share',
    });
    expect(shareToggle().disabled).toBe(true);
    expect(
      component.querySelector('[data-testid="settings-mac-share-locked"]')?.textContent
    ).toContain('--mac-share');
    shareToggle().click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('is hidden off macOS, and while "On this computer" is off', async () => {
    await showWith({ macShareSupported: false });
    expect(share()).toBeNull();
    await showWith({ macShareSupported: true, macSessions: false });
    expect(share()).toBeNull();
  });
});
