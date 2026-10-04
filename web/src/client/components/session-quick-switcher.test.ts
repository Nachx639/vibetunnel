// @vitest-environment happy-dom
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockSession } from '../../test/utils/lit-test-utils.js';
import { VibeTunnelApp } from '../app.js';
import { setLocale } from '../i18n/index.js';
import { es } from '../i18n/locales/es.js';
import {
  isQuickSwitcherEnabled,
  type SessionQuickSwitcher,
  setQuickSwitcherEnabled,
} from './session-quick-switcher.js';
import './session-quick-switcher.js';

describe('session-quick-switcher', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockImplementation((key) => store.get(key) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
      store.set(key, value);
    });
  });
  afterEach(async () => {
    store.clear();
    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.setItem).mockReset();
    await setLocale('en');
    fixtureCleanup();
  });

  it('filters by name, folder and command, and switches on Enter', async () => {
    const switcher = await fixture<SessionQuickSwitcher>(
      html`<session-quick-switcher
        visible
        .sessions=${[
          createMockSession({ id: 'a', name: 'api', workingDir: '/srv/api' }),
          createMockSession({ id: 'b', name: 'web', workingDir: '/srv/web' }),
        ]}
      ></session-quick-switcher>`
    );
    const selected = vi.fn();
    switcher.addEventListener('select-session', selected);
    const input = switcher.querySelector('input') as HTMLInputElement;
    input.value = 'web';
    input.dispatchEvent(new Event('input'));
    await switcher.updateComplete;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(selected.mock.calls[0][0].detail).toEqual({ sessionId: 'b' });
  });

  it('follows the chosen language', async () => {
    await setLocale('es');
    const switcher = await fixture<SessionQuickSwitcher>(
      html`<session-quick-switcher visible .sessions=${[createMockSession({ name: 'api' })]}></session-quick-switcher>`
    );
    const input = switcher.querySelector('input') as HTMLInputElement;
    expect(input.placeholder).toBe(es['switcher.quickPlaceholder']);
    input.value = 'zzz';
    input.dispatchEvent(new Event('input'));
    await switcher.updateComplete;
    expect(switcher.textContent).toContain(es['switcher.noMatches']);
  });

  it('Cmd+K is left alone unless the user turned the switcher on', () => {
    const app = new VibeTunnelApp() as unknown as {
      isAuthenticated: boolean;
      showQuickSwitcher: boolean;
      handleKeyDown(e: KeyboardEvent): void;
    };
    app.isAuthenticated = true;
    const press = () => {
      const event = new KeyboardEvent('keydown', { key: 'k', metaKey: true, cancelable: true });
      app.handleKeyDown(event);
      return event;
    };
    expect(isQuickSwitcherEnabled()).toBe(false);
    expect(press().defaultPrevented).toBe(false);
    expect(app.showQuickSwitcher).toBe(false);

    setQuickSwitcherEnabled(true);
    expect(press().defaultPrevented).toBe(true);
    expect(app.showQuickSwitcher).toBe(true);
  });

  describe('Cmd+K while a terminal has the keyboard', () => {
    type AppKeys = {
      isAuthenticated: boolean;
      showQuickSwitcher: boolean;
      currentView: string;
      keyboardCaptureActive: boolean;
      sessions: ReturnType<typeof createMockSession>[];
      selectedSessionId: string | null;
      handleKeyDown(e: KeyboardEvent): void;
    };
    const makeApp = (view: string, capture: boolean) => {
      const app = new VibeTunnelApp() as unknown as AppKeys;
      app.isAuthenticated = true;
      app.currentView = view;
      app.keyboardCaptureActive = capture;
      app.sessions = [createMockSession({ id: 's1', status: 'running' })];
      app.selectedSessionId = 's1';
      return app;
    };
    /** Presses Cmd+K with focus on `target` (dispatched, so composedPath() is real). */
    const pressOn = (app: AppKeys, target: HTMLElement) => {
      const event = new KeyboardEvent('keydown', {
        key: 'k',
        metaKey: true,
        cancelable: true,
        bubbles: true,
        composed: true,
      });
      const listener = (e: Event) => app.handleKeyDown(e as KeyboardEvent);
      document.addEventListener('keydown', listener);
      target.dispatchEvent(event);
      document.removeEventListener('keydown', listener);
      return event;
    };
    const placed: HTMLElement[] = [];
    const place = (el: HTMLElement) => {
      document.body.appendChild(el);
      placed.push(el);
      return el;
    };
    beforeEach(() => setQuickSwitcherEnabled(true));
    afterEach(() => {
      for (const el of placed.splice(0)) el.remove();
    });

    it('opens the switcher from the session list', () => {
      const app = makeApp('list', true);
      expect(pressOn(app, place(document.createElement('button'))).defaultPrevented).toBe(true);
      expect(app.showQuickSwitcher).toBe(true);
    });

    it('leaves Cmd+K to the terminal while keyboard capture is on in a session', () => {
      const app = makeApp('session', true);
      const event = pressOn(app, place(document.createElement('button')));
      expect(event.defaultPrevented).toBe(false);
      expect(app.showQuickSwitcher).toBe(false);
    });

    it('leaves Cmd+K to the terminal when focus is in the terminal, even with capture off', () => {
      const app = makeApp('session', false);
      const terminal = place(document.createElement('vibe-terminal'));
      const textarea = document.createElement('textarea');
      terminal.appendChild(textarea);
      expect(pressOn(app, textarea).defaultPrevented).toBe(false);
      expect(app.showQuickSwitcher).toBe(false);

      // The on-screen keyboard's hidden input belongs to the terminal too.
      const input = place(document.createElement('input'));
      input.dataset.terminalInput = '';
      expect(pressOn(app, input).defaultPrevented).toBe(false);
      expect(app.showQuickSwitcher).toBe(false);
    });

    it('opens the switcher from the session header while capture is off', () => {
      const app = makeApp('session', false);
      expect(pressOn(app, place(document.createElement('button'))).defaultPrevented).toBe(true);
      expect(app.showQuickSwitcher).toBe(true);
    });

    it('opens the switcher in an exited session, where nothing is captured', () => {
      const app = makeApp('session', true);
      app.sessions = [createMockSession({ id: 's1', status: 'exited' })];
      expect(pressOn(app, place(document.createElement('button'))).defaultPrevented).toBe(true);
      expect(app.showQuickSwitcher).toBe(true);
    });
  });
});
