import { describe, expect, it } from 'vitest';
import { claudeHistoryBlock, claudeHistoryEnabled } from './claude-history-switch';

describe('claudeHistoryEnabled', () => {
  it('is off unless config.json or the environment turns it on', () => {
    expect(claudeHistoryEnabled({}, {})).toBe(false);
    expect(claudeHistoryEnabled({ claudeHistory: true }, {})).toBe(true);
    expect(claudeHistoryEnabled({}, { VIBETUNNEL_CLAUDE_HISTORY: '1' })).toBe(true);
    expect(claudeHistoryEnabled({ claudeHistory: true }, { VIBETUNNEL_CLAUDE_HISTORY: '0' })).toBe(
      false
    );
    expect(claudeHistoryEnabled({}, { VIBETUNNEL_CLAUDE_HISTORY: 'maybe' })).toBe(false);
  });

  it('is never available on a server without a login', () => {
    expect(claudeHistoryBlock({ claudeHistory: true }, { noAuth: true }, {})).toBe('no-auth');
    expect(claudeHistoryBlock({ claudeHistory: true }, { noAuth: false }, {})).toBeNull();
    expect(claudeHistoryBlock({}, { noAuth: false }, {})).toBe('disabled');
  });
});
