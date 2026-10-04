import { describe, expect, it } from 'vitest';
import { defaultLogFile } from './logger.js';

// Every server logged to ~/.vibetunnel/log.txt and deleted it on start: a second server with
// its own control dir (a test server) wiped the main server's log.
describe('defaultLogFile', () => {
  it('keeps the default server where it was and gives every other server its own file', () => {
    expect(defaultLogFile(undefined, '/Users/me')).toBe('/Users/me/.vibetunnel/log.txt');
    expect(defaultLogFile('/Users/me/.vibetunnel/control', '/Users/me')).toBe(
      '/Users/me/.vibetunnel/log.txt'
    );
    expect(defaultLogFile('/Users/me/.vibetunnel-staging/control', '/Users/me')).toBe(
      '/Users/me/.vibetunnel-staging/log.txt'
    );
    expect(defaultLogFile('/tmp/vtg.e7b7', '/Users/me')).toBe('/tmp/vtg.e7b7/log.txt');
  });
});
