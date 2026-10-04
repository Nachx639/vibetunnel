/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VibeTunnelApp } from './app.js';

type AppInternals = HTMLElement & {
  loading: boolean;
  currentView: string;
  isAuthenticated: boolean;
  servicesInitialized: boolean;
  initializeServices(noAuth: boolean): Promise<void>;
  loadSessions(): Promise<boolean>;
  startAutoRefresh(): void;
  handleAuthSuccess(): Promise<void>;
};

describe('logging in', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the list as loading, not empty, until the sessions arrive', async () => {
    const app = new VibeTunnelApp() as unknown as AppInternals;
    app.currentView = 'auth';
    // Services take a while to start right after logging in.
    vi.spyOn(app, 'initializeServices').mockReturnValue(new Promise(() => {}));
    void app.handleAuthSuccess();
    await Promise.resolve();
    expect(app.currentView).toBe('list');
    expect(app.loading).toBe(true);
  });

  it('leaves the login screen after a 401 sent it back there (services already running)', async () => {
    const app = new VibeTunnelApp() as unknown as AppInternals;
    app.currentView = 'auth';
    app.isAuthenticated = false;
    app.servicesInitialized = true;
    vi.spyOn(app, 'initializeServices').mockResolvedValue(undefined);
    const loadSessions = vi.spyOn(app, 'loadSessions').mockResolvedValue(true);
    vi.spyOn(app, 'startAutoRefresh').mockImplementation(() => {});
    await app.handleAuthSuccess();
    expect(app.currentView).toBe('list');
    expect(loadSessions).toHaveBeenCalled();
  });
});
