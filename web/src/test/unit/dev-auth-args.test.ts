import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { devServerAuthArgs } = require('../../../scripts/dev-auth-args.js');

describe('dev server auth arguments', () => {
  it('leaves plain `pnpm run dev` open for local hacking', () => {
    expect(devServerAuthArgs([])).toEqual(['--no-auth']);
    expect(devServerAuthArgs(['--'])).toEqual(['--no-auth']);
  });

  it('never opens a server the Mac app launched in password mode, token or not', () => {
    // DevServerManager.buildDevServerArguments, password mode, without a local token.
    expect(devServerAuthArgs(['--port', '4020', '--bind', '127.0.0.1'])).toEqual([]);
    expect(
      devServerAuthArgs([
        '--port',
        '4020',
        '--bind',
        '127.0.0.1',
        '--allow-local-bypass',
        '--local-auth-token',
        't',
      ])
    ).toEqual([]);
  });

  it('adds nothing when the caller disables auth itself', () => {
    expect(devServerAuthArgs(['--port', '4020', '--no-auth'])).toEqual([]);
  });
});
