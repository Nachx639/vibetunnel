import { describe, expect, it } from 'vitest';
import { isTmuxAttachment } from './tmux-attachment.js';

describe('isTmuxAttachment', () => {
  it('is true for the sessions the tmux dialog opens, as the server tells them apart', () => {
    expect(isTmuxAttachment({ name: 'tmux: main', command: ['tmux', 'attach-session'] })).toBe(
      true
    );
    expect(isTmuxAttachment({ name: 'work', command: ['tmux attach'] })).toBe(true);
  });

  it('is false for other sessions, a tmux started inside one included', () => {
    expect(isTmuxAttachment({ name: 'zsh', command: ['zsh'] })).toBe(false);
    expect(isTmuxAttachment({ name: 'tmux', command: ['tmux'] })).toBe(false);
    expect(isTmuxAttachment(null)).toBe(false);
  });
});
