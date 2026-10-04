// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';
import { TERMINAL_FONT_FAMILY, TERMINAL_NERD_FONT_FAMILY } from './terminal-constants';
import { getTerminalFont, setTerminalFont, terminalFontFamily } from './terminal-font';

describe('terminal font preference', () => {
  beforeEach(() => setupLocalStorageMock());
  afterEach(() => restoreLocalStorage());

  it('defaults to Hack Nerd Font Mono, with the system fonts behind it', () => {
    expect(getTerminalFont()).toBe('nerd');
    expect(terminalFontFamily()).toBe(TERMINAL_NERD_FONT_FAMILY);
    expect(TERMINAL_NERD_FONT_FAMILY).toBe(`"Hack Nerd Font Mono", ${TERMINAL_FONT_FAMILY}`);
  });

  it('the system monospace font once chosen, keeping other preferences', () => {
    localStorage.setItem(
      'vibetunnel_app_preferences',
      JSON.stringify({ useDirectKeyboard: false })
    );
    setTerminalFont('system');
    expect(getTerminalFont()).toBe('system');
    expect(terminalFontFamily()).toBe(TERMINAL_FONT_FAMILY);
    expect(TERMINAL_FONT_FAMILY).not.toContain('Hack Nerd Font');
    expect(JSON.parse(localStorage.getItem('vibetunnel_app_preferences') ?? '{}')).toEqual({
      useDirectKeyboard: false,
      terminalFont: 'system',
    });
    setTerminalFont('nerd');
    expect(getTerminalFont()).toBe('nerd');
  });

  it('an unknown or unreadable value means the default', () => {
    localStorage.setItem('vibetunnel_app_preferences', JSON.stringify({ terminalFont: 'comic' }));
    expect(getTerminalFont()).toBe('nerd');
    localStorage.setItem('vibetunnel_app_preferences', '{not json');
    expect(getTerminalFont()).toBe('nerd');
  });
});
