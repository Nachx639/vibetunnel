// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { holdSheetFocus } from './sheet-a11y.js';

describe('holdSheetFocus', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('focuses the sheet, keeps Tab inside, closes on Escape and returns focus', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const sheet = document.createElement('div');
    sheet.innerHTML = '<button id="a">a</button><button id="b">b</button>';
    document.body.appendChild(sheet);
    const onEscape = vi.fn();

    const release = holdSheetFocus(sheet, onEscape);
    expect(document.activeElement).toBe(sheet);

    (sheet.querySelector('#b') as HTMLElement).focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement?.id).toBe('a');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onEscape).toHaveBeenCalledTimes(1);

    release();
    expect(document.activeElement).toBe(opener);
  });

  it('leaves focus alone while the user is typing', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const sheet = document.createElement('div');
    document.body.appendChild(sheet);
    holdSheetFocus(sheet, () => {})();
    expect(document.activeElement).toBe(input);
  });
});
