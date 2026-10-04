// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../shared/types.js';
import type { SessionHeader } from './session-header.js';
import './session-header.js';

const session = (id: string): Session =>
  ({
    id,
    name: `shell ${id}`,
    command: ['zsh'],
    workingDir: '/Users/test',
    status: 'running',
    startedAt: '2025-05-02T10:00:00Z',
    lastModified: '2025-05-02T10:00:00Z',
  }) as Session;

describe('session header on a phone', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockImplementation((key) => store.get(key) ?? null);
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'
    );
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  });
  afterEach(() => {
    store.clear();
    vi.mocked(localStorage.getItem).mockReset();
    vi.restoreAllMocks();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    document.body.querySelector('.psr-sheet-cancel')?.dispatchEvent(new Event('click'));
  });

  const renderHeader = () =>
    fixture<SessionHeader>(
      html`<session-header
        .session=${session('a')}
        .sessions=${[session('a'), session('b')]}
        .isMobile=${true}
      ></session-header>`
    );

  it('keeps the inline title editor with the classic layout (the default)', async () => {
    const header = await renderHeader();
    expect(header.querySelector('inline-edit')).toBeTruthy();
    expect(header.querySelector('[data-testid="header-phone-title"]')).toBeNull();
  });

  it('opens the switcher from the title with the compact layout and navigates there', async () => {
    store.set('vibetunnel_app_preferences', JSON.stringify({ phoneUi: 'compact' }));
    const header = await renderHeader();
    expect(header.querySelector('inline-edit')).toBeNull();
    const navigate = vi.fn();
    header.addEventListener('navigate-to-session', navigate);
    (header.querySelector('[data-testid="header-phone-title"]') as HTMLButtonElement).click();
    (document.body.querySelector('[data-testid="switcher-item"]') as HTMLButtonElement).click();
    expect(navigate.mock.calls[0][0].detail).toEqual({ sessionId: 'b' });
  });

  it('renames the session from the switcher', async () => {
    store.set('vibetunnel_app_preferences', JSON.stringify({ phoneUi: 'compact' }));
    vi.stubGlobal(
      'prompt',
      vi.fn(() => 'api server')
    );
    const header = await renderHeader();
    const rename = vi.fn();
    header.addEventListener('session-rename', rename);
    (header.querySelector('[data-testid="header-phone-title"]') as HTMLButtonElement).click();
    (document.body.querySelector('[data-testid="switcher-rename"]') as HTMLButtonElement).click();
    expect(rename.mock.calls[0][0].detail).toEqual({ sessionId: 'a', newName: 'api server' });
    vi.unstubAllGlobals();
  });
});
