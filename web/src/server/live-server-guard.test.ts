import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

// src/test/setup.ts keeps server tests off a VibeTunnel server running on this machine.
describe('tests and a local VibeTunnel server', () => {
  it.each([
    'http://localhost:4020/api/git/event',
    'http://127.0.0.1:4021/',
    'http://[::1]:4020/',
  ])('refuses %s', async (url) => {
    await expect(fetch(url, { method: 'POST' })).rejects.toThrow(/local VibeTunnel server/);
  });

  it("still reaches a test's own server", async () => {
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('ok');
    } finally {
      server.close();
    }
  });
});

describe("tests and the developer's home", () => {
  it('run with a temporary HOME', () => {
    expect(process.env.HOME?.startsWith(tmpdir())).toBe(true);
    expect(homedir().startsWith(tmpdir())).toBe(true);
  });

  it("ignore the shell's Claude, Codex and Gemini folder overrides", () => {
    expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(process.env.CODEX_HOME).toBeUndefined();
    expect(process.env.GEMINI_CLI_HOME).toBeUndefined();
  });

  it('talk to a fake tailscale binary', () => {
    expect(process.env.VIBETUNNEL_TAILSCALE_BIN).toMatch(/vibetunnel-fake-tailscale-/);
  });
});

describe("tests and the developer's tmux", () => {
  it('never inherit TMUX, so a bare tmux command cannot reach the outer server', () => {
    expect(process.env.TMUX).toBeUndefined();
    expect(process.env.TMUX_PANE).toBeUndefined();
  });

  it('never inherit the VibeTunnel session they were started from', () => {
    expect(process.env.VIBETUNNEL_SESSION_ID).toBeUndefined();
  });
});
