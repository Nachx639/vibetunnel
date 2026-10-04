import { describe, expect, it } from 'vitest';
import { claudeWaitingLabel } from './claude-waiting-label.js';

describe('claudeWaitingLabel', () => {
  it('translates the reasons Claude Code reports and keeps unknown ones as written', () => {
    expect(claudeWaitingLabel('permission prompt')).toBe('Permission request');
    expect(claudeWaitingLabel('something new')).toBe('something new');
    expect(claudeWaitingLabel(undefined)).toBeUndefined();
  });
});
