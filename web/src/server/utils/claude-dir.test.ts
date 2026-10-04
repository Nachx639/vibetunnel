import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { claudeConfigDir } from './claude-dir.js';

describe('claudeConfigDir', () => {
  it('is CLAUDE_CONFIG_DIR when it is set', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/data/claude' })).toBe('/data/claude');
  });

  it('trims the variable', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '  /data/claude \n' })).toBe('/data/claude');
  });

  it('falls back to ~/.claude when the variable is unset or blank', () => {
    const home = path.join(os.homedir(), '.claude');
    expect(claudeConfigDir({})).toBe(home);
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '' })).toBe(home);
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '   ' })).toBe(home);
  });
});
