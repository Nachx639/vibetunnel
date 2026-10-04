// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../shared/types.js';
import type { CompactMenu } from './compact-menu.js';
import './compact-menu.js';

// On a short phone the menu's last items were below the screen: the panel didn't fit nor scroll.
describe('compact menu on a short screen', () => {
  afterEach(() => vi.restoreAllMocks());

  it('takes the height left under the button and scrolls inside', async () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(560);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 90,
    } as DOMRect);
    const session = { id: 's1', status: 'running' } as Session;
    const menu = await fixture<CompactMenu>(
      html`<compact-menu .session=${session}></compact-menu>`
    );
    (menu.querySelector('button[data-menu-button]') as HTMLElement).click();
    await menu.updateComplete;
    const panel = menu.querySelector('#compact-menu-panel') as HTMLElement;
    expect(panel.style.maxHeight).toBe('458px');
    expect(panel.className).toContain('overflow-y-auto');
  });
});
