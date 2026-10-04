/**
 * @vitest-environment happy-dom
 */
import { nothing, render } from 'lit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../shared/types.js';
import { VibeTunnelApp } from './app.js';

vi.mock('./services/terminal-socket-client.js', () => ({
  terminalSocketClient: {
    initialize: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    getConnectionStatus: vi.fn(() => true),
    onConnectionStateChange: vi.fn(() => () => {}),
    sendInputText: vi.fn(() => true),
    sendInputKey: vi.fn(() => true),
    sendResize: vi.fn(() => true),
    sendResetSize: vi.fn(() => true),
    setViewingSession: vi.fn(),
    clearViewingSession: vi.fn(),
  },
}));

type AppState = {
  sessions: Session[];
  currentView: string;
  selectedSessionId: string | null;
  showSettings: boolean;
};

const running = {
  id: 'open-1',
  name: 'claude',
  command: ['claude'],
  workingDir: '/tmp',
  status: 'running',
  startedAt: new Date().toISOString(),
  lastModified: new Date().toISOString(),
} as Session;

/** The session view and the sheets are a chunk the list doesn't wait for (utils/lazy-views.ts). */
describe('views loaded after the list', () => {
  let container: HTMLElement;

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({}))
    );
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    render(nothing, container);
    container.remove();
    vi.unstubAllGlobals();
  });

  it('opening a session before its chunk arrived shows a spinner, then the session', async () => {
    expect(customElements.get('session-view')).toBeUndefined();
    const app = new VibeTunnelApp();
    const state = app as unknown as AppState;
    state.sessions = [running];
    state.selectedSessionId = running.id;
    state.currentView = 'session';
    const update = vi.spyOn(app, 'requestUpdate');

    render(app.render(), container, { host: app });
    expect(container.querySelector('[data-testid="view-loading"]')).not.toBeNull();
    expect(container.querySelector('session-view')).toBeNull();
    // Hidden modals wait for the chunk too, without fetching it themselves.
    expect(container.querySelector('vt-settings')).toBeNull();

    await vi.waitFor(() => expect(update).toHaveBeenCalled(), { timeout: 10_000 });
    render(app.render(), container, { host: app });
    expect(container.querySelector('session-view')).not.toBeNull();
    expect(container.querySelector('[data-testid="view-loading"]')).toBeNull();
    expect(container.querySelector('vt-settings')).not.toBeNull();
  });
});
