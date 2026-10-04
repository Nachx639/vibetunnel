import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

// src/test/setup.ts keeps server tests off a VibeTunnel server running on this machine.
// HEAD on a path no server has: should the guard ever regress, this test changes nothing on
// the developer's server it then reaches.
describe('tests and a local VibeTunnel server', () => {
  it.each([
    'http://localhost:4020/__vt-test-guard',
    'http://127.0.0.1:4021/__vt-test-guard',
    'http://[::1]:4020/__vt-test-guard',
  ])('refuses %s', async (url) => {
    await expect(fetch(url, { method: 'HEAD' })).rejects.toThrow(/local VibeTunnel server/);
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
  it("run with a temporary HOME inside the run's directory, removed when the run ends", () => {
    expect(process.env.HOME?.startsWith(tmpdir())).toBe(true);
    expect(homedir().startsWith(tmpdir())).toBe(true);
    expect(process.env.HOME?.startsWith(`${process.env.VIBETUNNEL_TEST_RUN_DIR}/`)).toBe(true);
  });

  it("ignore the shell's Claude, Codex and Gemini folder overrides", () => {
    expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(process.env.CODEX_HOME).toBeUndefined();
    expect(process.env.GEMINI_CLI_HOME).toBeUndefined();
  });

  it('talk to a fake tailscale binary', () => {
    expect(process.env.VIBETUNNEL_TAILSCALE_BIN).toBe(
      `${process.env.VIBETUNNEL_TEST_RUN_DIR}/tailscale`
    );
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
