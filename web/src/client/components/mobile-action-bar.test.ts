/**
 * @vitest-environment happy-dom
 */
import { fixture, html } from '@open-wc/testing';
import { describe, expect, it, vi } from 'vitest';
import type { MobileActionBar, MobileActionBarCallbacks } from './mobile-action-bar.js';
import './mobile-action-bar.js';

async function renderBar(callbacks: Partial<MobileActionBarCallbacks> = {}) {
  const onShowKeyboard = vi.fn();
  const bar = await fixture<MobileActionBar>(html`
    <mobile-action-bar
      .callbacks=${{ onShowKeyboard, ...callbacks } as unknown as MobileActionBarCallbacks}
    ></mobile-action-bar>
  `);
  // detectMobile() is false under happy-dom.
  (bar as unknown as { isMobile: boolean }).isMobile = true;
  await bar.updateComplete;
  const button = bar.querySelector<HTMLButtonElement>('button[aria-label="Keyboard"]');
  if (!button) throw new Error('keyboard button not rendered');
  return { bar, button, onShowKeyboard };
}

describe('MobileActionBar keyboard button', () => {
  it('opens the keyboard once from touchend, ignoring the pointer and click that follow', async () => {
    const { button, onShowKeyboard } = await renderBar();

    button.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    button.dispatchEvent(new Event('pointerup', { bubbles: true, cancelable: true }));
    expect(onShowKeyboard).not.toHaveBeenCalled();

    const touchEnd = new Event('touchend', { bubbles: true, cancelable: true });
    button.dispatchEvent(touchEnd);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(onShowKeyboard).toHaveBeenCalledOnce();
    expect(touchEnd.defaultPrevented).toBe(true);
  });

  it('opens the keyboard when a tap lands on the real field over the button', async () => {
    const { button, onShowKeyboard } = await renderBar();
    const proxy = button.parentElement?.querySelector('textarea');
    vi.useFakeTimers();

    try {
      proxy?.focus();
      // The click that follows the tap is swallowed, not a second activation.
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

      expect(onShowKeyboard).toHaveBeenCalledOnce();
    } finally {
      vi.runAllTimers();
      vi.useRealTimers();
    }
  });

  it('opens the keyboard from a mouse click', async () => {
    const { button, onShowKeyboard } = await renderBar();

    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(onShowKeyboard).toHaveBeenCalledOnce();
  });
});

describe('MobileActionBar more menu', () => {
  it('closes on a click outside the bar', async () => {
    const { bar } = await renderBar();
    const menu = bar as unknown as { isExpanded: boolean };

    menu.isExpanded = true;
    await bar.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.body.click();
    await bar.updateComplete;

    expect(menu.isExpanded).toBe(false);
  });

  it('registers no outside-click listener when the menu closes in the same tick', async () => {
    const { bar } = await renderBar();
    // isExpanded is private: set it the way the more button does.
    const menu = bar as unknown as { isExpanded: boolean };
    const add = vi.spyOn(document, 'addEventListener');

    menu.isExpanded = true;
    await bar.updateComplete;
    menu.isExpanded = false;
    await bar.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(add.mock.calls.filter(([type]) => type === 'click')).toHaveLength(0);
    add.mockRestore();
  });
});
