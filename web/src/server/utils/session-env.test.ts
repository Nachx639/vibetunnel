import { describe, expect, it } from 'vitest';
import { terminalSessionEnv } from './session-env.js';

describe('terminalSessionEnv', () => {
  it("drops the launching Claude Code session's identity but keeps user configuration", () => {
    const env = terminalSessionEnv(
      {
        PATH: '/usr/bin',
        CLAUDECODE: '1',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_CODE_SESSION_ID: 'abc',
        CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/1.sock',
        ANTHROPIC_OAUTH_TOKEN: 'launcher-token',
        ANTHROPIC_API_KEY: 'user-key',
        CLAUDE_CODE_USE_BEDROCK: '1',
      },
      { TERM: 'xterm-256color', VIBETUNNEL_SESSION_ID: 's1' }
    );

    expect(env).toEqual({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'user-key',
      CLAUDE_CODE_USE_BEDROCK: '1',
      TERM: 'xterm-256color',
      VIBETUNNEL_SESSION_ID: 's1',
    });
  });

  it('never passes the server’s login password to a session', () => {
    const env = terminalSessionEnv(
      { VIBETUNNEL_PASSWORD: 'hunter2', VIBETUNNEL_USERNAME: 'alice', PATH: '/usr/bin' },
      { TERM: 'xterm-256color' }
    );
    expect(env.VIBETUNNEL_PASSWORD).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('never passes the token signing secret or the ngrok token to a session', () => {
    const env = terminalSessionEnv(
      { JWT_SECRET: 'f00d', NGROK_AUTHTOKEN: 'ngrok-token', PATH: '/usr/bin' },
      { TERM: 'xterm-256color' }
    );
    expect(env).toEqual({ PATH: '/usr/bin', TERM: 'xterm-256color' });
  });
});
