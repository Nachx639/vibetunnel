// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FullHeader } from './full-header.js';
import './full-header.js';

describe('full-header on a phone', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockImplementation((key) => store.get(key) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
      store.set(key, value);
    });
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'
    );
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  });
  afterEach(() => {
    store.clear();
    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.setItem).mockReset();
    vi.restoreAllMocks();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  });

  it('keeps every button with the classic layout (the default)', async () => {
    const header = await fixture<FullHeader>(html`<full-header></full-header>`);
    expect(header.querySelector('[data-testid="file-browser-button"]')).toBeTruthy();
    expect(header.querySelector('[data-testid="header-more-button"]')).toBeNull();
  });

  it('folds settings, files, tmux and logout into "More" with the compact layout', async () => {
    store.set('vibetunnel_app_preferences', JSON.stringify({ phoneUi: 'compact' }));
    const header = await fixture<FullHeader>(
      html`<full-header .currentUser=${'alice'} .authMethod=${'password'}></full-header>`
    );
    expect(header.querySelector('[data-testid="file-browser-button"]')).toBeNull();
    const more = header.querySelector('[data-testid="header-more-button"]') as HTMLButtonElement;
    more.click();
    await header.updateComplete;
    const items = [...header.querySelectorAll('.phone-menu-item')].map((item) =>
      item.textContent?.trim()
    );
    expect(items).toEqual(['Settings', 'Browse Files', 'tmux Sessions', 'Logout']);
    const settings = vi.fn();
    header.addEventListener('open-settings', settings);
    (header.querySelector('.phone-menu-item') as HTMLButtonElement).click();
    expect(settings).toHaveBeenCalledTimes(1);
    await header.updateComplete;
    expect(header.querySelector('.phone-menu')).toBeNull();
  });
});
