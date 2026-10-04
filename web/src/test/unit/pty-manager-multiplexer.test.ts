import * as fs from 'fs';
import * as pty from 'node-pty';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProcessUtils } from '../../server/pty/process-utils';
import { PtyManager } from '../../server/pty/pty-manager';
import { PtyError } from '../../server/pty/types';
import { TmuxAttachTracker } from '../../server/services/tmux-attach-tracker';
import { TMUX_FIELD_SEPARATOR } from '../../server/services/tmux-manager';
import { type SessionMultiplexer, TitleMode } from '../../shared/types';

// node-pty is mocked (test setup), and the tracker talks to a fake tmux: nothing here reaches a
// real tmux server or process.
const SOCKET = '/tmp/vtm-unit/default';
const TMUX = '/usr/bin/tmux';
const ARGV = [
  TMUX,
  '-u',
  '-N',
  '-S',
  SOCKET,
  'attach-session',
  '-E',
  '-f',
  'ignore-size',
  '-t',
  '$3',
];

const multiplexer: SessionMultiplexer = {
  type: 'tmux',
  socketPath: SOCKET,
  serverPid: 90,
  serverStartedAt: 1_790_000_000,
  sessionId: '$3',
  sessionName: 'work',
  mode: 'control',
  sizing: 'others',
  source: 'mac-sessions',
};

/** The user's tmux server as far as VibeTunnel's client goes: lists it, applies its commands. */
function fakeTmux() {
  const client = {
    pid: 0,
    tty: '/dev/ttys042',
    paneId: '%8',
    panePid: 4300,
    cwd: '/Users/me/project',
    readOnly: false,
    ignoreSize: true,
    attached: true,
    onDetach: () => {},
  };
  const calls: Array<{ socketPath: string; args: string[] }> = [];
  const run = async (socketPath: string, args: string[]) => {
    calls.push({ socketPath, args });
    if (args[0] === 'list-clients') {
      if (!client.attached) return '';
      const flags = ['attached', ...(client.ignoreSize ? ['ignore-size'] : [])];
      if (client.readOnly) flags.push('read-only');
      return `${[
        'C',
        client.pid,
        client.tty,
        '$3',
        '@2',
        client.paneId,
        client.panePid,
        client.cwd,
        client.readOnly ? 1 : 0,
        flags.join(','),
        80,
        24,
        1_791_053_894,
      ].join(TMUX_FIELD_SEPARATOR)}\n`;
    }
    if (args[0] === 'switch-client') {
      // tmux 3.2+: -r sets or clears read-only and ignore-size together.
      client.readOnly = !client.readOnly;
      client.ignoreSize = client.readOnly;
    } else if (args[0] === 'refresh-client') {
      client.ignoreSize = args[4] === 'ignore-size';
    } else if (args[0] === 'detach-client') {
      client.attached = false;
      client.onDetach();
    }
    return '';
  };
  return { client, calls, run };
}

describe('PtyManager sessions attached to a tmux session', () => {
  let controlPath: string;
  let tmux: ReturnType<typeof fakeTmux>;
  let tracker: TmuxAttachTracker;
  let manager: PtyManager;
  let counter = 0;

  beforeAll(async () => {
    await PtyManager.initialize();
  });

  beforeEach(() => {
    // Short: session folders hold unix sockets.
    controlPath = fs.mkdtempSync('/tmp/vtp.');
    tmux = fakeTmux();
    tracker = new TmuxAttachTracker({ run: tmux.run });
    manager = new PtyManager(controlPath, { attachTracker: tracker });
    vi.mocked(pty.spawn).mockClear();
  });

  afterEach(async () => {
    await manager.shutdown();
    vi.restoreAllMocks();
    fs.rmSync(controlPath, { recursive: true, force: true });
  });

  async function open(options: { seed?: boolean } = {}) {
    const { sessionId } = await manager.createSession(ARGV, {
      sessionId: `m${++counter}`,
      name: 'tmux: work',
      workingDir: controlPath,
      cols: 80,
      rows: 24,
      titleMode: TitleMode.STATIC,
      multiplexer,
      ...(options.seed === false ? {} : { attachSeed: { panePid: 4242, paneId: '%7' } }),
    });
    const pid = manager.getSession(sessionId)?.pid as number;
    tmux.client.pid = pid;
    return { sessionId, pid };
  }

  it('spawns its tmux client as given, never inside the tmux the server runs in', async () => {
    const resolveCommand = vi.spyOn(ProcessUtils, 'resolveCommand');
    const saved = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
    process.env.TMUX = '/tmp/tmux-501/default,1234,0';
    process.env.TMUX_PANE = '%1';
    try {
      const { sessionId } = await open();
      const [command, args, spawnOptions] = vi.mocked(pty.spawn).mock.calls[0];
      expect([command, ...(args as string[])]).toEqual(ARGV);
      expect(resolveCommand).not.toHaveBeenCalled();
      const env = (spawnOptions as { env: Record<string, string> }).env;
      expect(env.TMUX).toBeUndefined();
      expect(env.TMUX_PANE).toBeUndefined();
      expect(env.VIBETUNNEL_SESSION_ID).toBe(sessionId);
      expect(manager.getInternalSession(sessionId)?.isTmuxAttachment).toBe(true);
      expect(manager.getSession(sessionId)?.multiplexer).toEqual(multiplexer);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("finds what runs in the pane its client shows: the opened one, then tmux's", async () => {
    const { sessionId, pid } = await open();
    const session = manager.getSession(sessionId);
    expect(tracker.isTracked(sessionId)).toBe(true);
    expect(manager.programRootPid({ id: sessionId, pid })).toBe(4242);
    expect(session && manager.programRootPid(session)).toBe(4242);

    await tracker.refresh();
    expect(manager.programRootPid({ id: sessionId, pid })).toBe(4300);
    // Other sessions keep their own pid.
    expect(manager.programRootPid({ id: 'other', pid: 77 })).toBe(77);
  });

  it("detaches its own client on the session's socket, and stops tracking it once it ends", async () => {
    const { sessionId } = await open();
    // The mocked PTY never runs: a detached client exits, and nothing else is ever checked.
    vi.spyOn(ProcessUtils, 'isProcessRunning').mockReturnValue(false);
    tmux.client.onDetach = () => manager.getPtyForSession(sessionId)?.kill();
    const exited = new Promise<void>((resolve) =>
      manager.on('sessionExited', (id: string) => id === sessionId && resolve())
    );

    await manager.killSession(sessionId);
    expect(tmux.calls.map((call) => [call.socketPath, ...call.args])).toContainEqual([
      SOCKET,
      'detach-client',
      '-t',
      '/dev/ttys042',
    ]);
    await exited;
    expect(tracker.isTracked(sessionId)).toBe(false);
    expect(manager.getSession(sessionId)?.status).toBe('exited');
  });

  it('keeps its mode and folder as tmux reports them', async () => {
    const { sessionId } = await open();
    // A key bound to switch-client -r, and a cd in the pane.
    tmux.client.readOnly = true;
    tmux.client.cwd = '/Users/me/other';
    await tracker.refresh();
    const session = manager.getSession(sessionId);
    expect(session?.multiplexer).toMatchObject({ mode: 'watch', sizing: 'others' });
    expect(session?.workingDir).toBe('/Users/me/other');
  });

  it('switches to watch and back, and records it', async () => {
    const { sessionId } = await open();
    expect(await manager.setAttachedMode(sessionId, { mode: 'watch' })).toEqual({
      mode: 'watch',
      sizing: 'others',
    });
    expect(manager.getSession(sessionId)?.multiplexer?.mode).toBe('watch');
    expect(tmux.client.readOnly).toBe(true);

    expect(await manager.setAttachedMode(sessionId, { mode: 'control', sizing: 'here' })).toEqual({
      mode: 'control',
      sizing: 'here',
    });
    expect(manager.getSession(sessionId)?.multiplexer).toMatchObject({
      mode: 'control',
      sizing: 'here',
    });
    expect(tmux.client).toMatchObject({ readOnly: false, ignoreSize: false });
  });

  it('switches only sessions attached to a tmux session', async () => {
    const { sessionId } = await manager.createSession(['sleep', '30'], {
      sessionId: `m${++counter}`,
      workingDir: controlPath,
      cols: 80,
      rows: 24,
    });
    const error = await manager.setAttachedMode(sessionId, { mode: 'watch' }).catch((e) => e);
    expect(error).toBeInstanceOf(PtyError);
    expect(error).toMatchObject({ code: 'NOT_ATTACHED' });
    expect(tmux.calls).toEqual([]);
    expect(manager.programRootPid({ id: sessionId, pid: 55 })).toBe(55);
  });
});
