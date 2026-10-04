// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composerHeightFor, TerminalChatView } from './terminal-chat-view.js';

/** Phone chat composer: how the field and its row behave while typing. */
describe('TerminalChatView phone composer layout', () => {
  let component: TerminalChatView;
  const field = () =>
    component.shadowRoot?.querySelector<HTMLTextAreaElement>('textarea.composer-input') ?? null;

  beforeEach(async () => {
    localStorage.clear();
    component = new TerminalChatView();
    component.composerOnly = true;
    component.active = true;
    component.sessionId = 'layout-test';
    document.body.append(component);
    await component.updateComplete;
  });

  afterEach(() => {
    component.remove();
    vi.restoreAllMocks();
  });

  describe('composerHeightFor', () => {
    const style = (boxSizing: string) => ({
      boxSizing,
      paddingTop: '12px',
      paddingBottom: '12px',
      borderTopWidth: '1px',
      borderBottomWidth: '1px',
    });

    it('does not count the padding twice on a content-box field', () => {
      // One line of 21.6 px text plus 24 px of padding.
      expect(composerHeightFor(45.6, style('content-box'))).toBeCloseTo(21.6);
    });

    it('adds only the borders on a border-box field', () => {
      expect(composerHeightFor(45.6, style('border-box'))).toBeCloseTo(47.6);
    });
  });

  it('keeps one typed line exactly as tall as the empty field', async () => {
    const input = field();
    if (!input) throw new Error('no composer');
    // happy-dom does no layout: give the field iPhone WebKit's numbers.
    Object.defineProperty(input, 'scrollHeight', { configurable: true, get: () => 46 });
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
      const computed = real(el, pseudo);
      if (el !== input) return computed;
      return {
        ...computed,
        boxSizing: 'content-box',
        paddingTop: '12px',
        paddingBottom: '12px',
        borderTopWidth: '1px',
        borderBottomWidth: '1px',
      } as CSSStyleDeclaration;
    });

    input.value = 'hello';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));

    // 46 px here would be content height + padding again: an empty extra line under the text.
    expect(input.style.height).toBe('22px');
  });

  it('announces its focus so the conversation can scroll to the end', () => {
    const seen = vi.fn();
    document.addEventListener('composer-focus', seen);
    field()?.dispatchEvent(new FocusEvent('focus'));
    document.removeEventListener('composer-focus', seen);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('pads its bottom with the clearance the session view hands it', () => {
    const css = TerminalChatView.styles.toString();
    expect(css).toMatch(
      /:host\(\[composerOnly\]\) \.chat-input-container \{[^}]*padding-bottom: calc\(0\.625rem \+ var\(--composer-safe-bottom, 0px\)\)/
    );
  });
});
