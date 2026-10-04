import { type ChildProcess, spawn } from 'child_process';
import type { Request, Response } from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSessionRoutes } from '../routes/sessions.js';
import { externalKillState, type PsProcess } from './forwarder-kill.js';
import { PtyManager } from './pty-manager.js';

// A hung forwarder: it started its program, then its event loop
// never turned again, so it reaps nothing (its killed program stays a zombie under it) and, with
// "ignore-term", it outlives SIGTERM too. Hung for 30 s at most: nothing outlives a dead test.
const HUNG_PARENT = `
const { spawn } = require('child_process');
const fs = require('fs');
const [, , mode, readyFile, ...command] = process.argv;
if (mode === 'ignore-term') process.on('SIGTERM', () => {});
const child = spawn(command[0], command.slice(1), { stdio: 'ignore' });
fs.writeFileSync(readyFile, String(child.pid));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
`;

// The session's program: ignores SIGTERM like a busy agent, and quits by itself once orphaned
// (or after 30 s), so it never outlives its parent.
const PROGRAM = `
process.on('SIGTERM', () => {});
const parent = process.ppid;
setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 100);
setTimeout(() => process.exit(0), 30000);
`;

type HungMode = 'dies-on-term' | 'ignore-term';

describe.concurrent('killing a session opened with vt whose forwarder hung', () => {
  let root: string;

  beforeAll(async () => {
    await PtyManager.initialize();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-fwdkill-'));
    // The forwarder's real name, so `ps` shows it as one; any other name is not a forwarder.
    fs.writeFileSync(path.join(root, 'vibetunnel-fwd'), HUNG_PARENT);
    fs.writeFileSync(path.join(root, 'hung-parent'), HUNG_PARENT);
    fs.writeFileSync(path.join(root, 'program.js'), PROGRAM);
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Starts `script` (a forwarder or not) with a program under it; resolves once both run. */
  async function startParent(script: 'vibetunnel-fwd' | 'hung-parent', mode: HungMode) {
    const ready = path.join(root, `ready-${Math.random().toString(36).slice(2)}`);
    const parent = spawn(
      process.execPath,
      [path.join(root, script), mode, ready, process.execPath, path.join(root, 'program.js')],
      { stdio: 'ignore' }
    );
    const programPid = await vi.waitFor(
      () => {
        const pid = Number(fs.readFileSync(ready, 'utf8'));
        if (!pid) throw new Error('program not started yet');
        return pid;
      },
      { timeout: 5000, interval: 20 }
    );
    return { parent, programPid };
  }

  /** A control dir holding `sessionId`, recorded as running `programPid`, and its manager. */
  function sessionOf(sessionId: string, programPid: number) {
    const controlPath = fs.mkdtempSync(path.join(root, 'control-'));
    fs.mkdirSync(path.join(controlPath, sessionId));
    const info = {
      id: sessionId,
      name: 'program',
      command: ['node', 'program.js'],
      workingDir: root,
      status: 'running',
      startedAt: new Date().toISOString(),
      pid: programPid,
    };
    fs.writeFileSync(path.join(controlPath, sessionId, 'session.json'), JSON.stringify(info));
    const ptyManager = new PtyManager(controlPath);
    const exited = vi.fn();
    ptyManager.on('sessionExited', exited);
    const status = () =>
      JSON.parse(fs.readFileSync(path.join(controlPath, sessionId, 'session.json'), 'utf8'))
        .status as string;
    return { ptyManager, exited, status };
  }

  const ended = (child: ChildProcess) => child.exitCode ?? child.signalCode;
  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  /** Only processes this test started; a program left alone quits once orphaned. */
  const stop = (...children: ChildProcess[]) => {
    for (const child of children) if (ended(child) === null) child.kill('SIGKILL');
  };

  it.for([
    ['dies-on-term', 'SIGTERM'],
    ['ignore-term', 'SIGKILL'],
  ] as const)(
    'ends the program and its forwarder (%s: %s), and only then says the session exited',
    { timeout: 15_000 },
    async ([mode, endedBy], { expect }) => {
      const { parent: forwarder, programPid } = await startParent('vibetunnel-fwd', mode);
      const sessionId = `fwd_${Date.now()}_${forwarder.pid}`;
      const { ptyManager, exited, status } = sessionOf(sessionId, programPid);
      try {
        await ptyManager.killSession(sessionId);

        await vi.waitFor(() => expect(ended(forwarder)).toBe(endedBy), { timeout: 2000 });
        await vi.waitFor(() => expect(isAlive(programPid)).toBe(false), { timeout: 2000 });
        expect(status()).toBe('exited');
        expect(exited).toHaveBeenCalledExactlyOnceWith(sessionId, 'program', 0);
      } finally {
        stop(forwarder);
      }
    }
  );

  it('never signals a pid that runs no forwarder, and fails instead of saying "killed"', async ({
    expect,
  }) => {
    // Its program's parent, as the id says, but not a forwarder: a pid can belong to anything.
    const { parent, programPid } = await startParent('hung-parent', 'dies-on-term');
    const sessionId = `fwd_${Date.now()}_${parent.pid}`;
    const { ptyManager, exited, status } = sessionOf(sessionId, programPid);
    try {
      const failure = await ptyManager.killSession(sessionId).catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: 'KILL_FAILED' });
      expect((failure as Error).message).toContain(`program ${programPid}`);
      expect((failure as Error).message).toContain(`pid ${parent.pid} is not a`);
      // It dies on SIGTERM: still running, it got no signal.
      expect(ended(parent)).toBeNull();
      expect(status()).toBe('running');
      expect(exited).not.toHaveBeenCalled();
    } finally {
      stop(parent);
    }
  }, 15_000);

  it("never signals a forwarder that is not the program's parent; DELETE answers an error", async ({
    expect,
  }) => {
    const { parent: forwarder } = await startParent('vibetunnel-fwd', 'dies-on-term');
    const { parent: other, programPid } = await startParent('hung-parent', 'dies-on-term');
    const sessionId = `fwd_${Date.now()}_${forwarder.pid}`;
    const { ptyManager, exited, status } = sessionOf(sessionId, programPid);
    const router = createSessionRoutes({
      ptyManager,
      terminalManager: {} as never,
      remoteRegistry: null,
      isHQMode: false,
    }) as unknown as {
      stack: Array<{
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
        };
      }>;
    };
    const route = router.stack.find(
      (layer) => layer.route?.path === '/sessions/:sessionId' && layer.route.methods.delete
    )?.route;
    if (!route) throw new Error('no DELETE /sessions/:sessionId');
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    try {
      await route.stack[0].handle(
        { params: { sessionId } } as unknown as Request,
        res as unknown as Response
      );

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ error: 'Failed to kill session' })
      );
      expect(res.json.mock.calls[0][0].details).toContain(
        `pid ${forwarder.pid} is not the parent of program ${programPid}`
      );
      // Both die on SIGTERM: still running, neither got one.
      expect(ended(forwarder)).toBeNull();
      expect(ended(other)).toBeNull();
      expect(status()).toBe('running');
      expect(exited).not.toHaveBeenCalled();
    } finally {
      stop(forwarder, other);
    }
  }, 15_000);
});

describe('externalKillState', () => {
  // `ps -o pid=,ppid=,stat=,args=` of a real case: the forwarder hung, its program killed
  // but still exiting under it. A zombie it never reaped is the same case.
  const forwarder: PsProcess = {
    ppid: 52480,
    stat: 'S+',
    args: '/Applications/VibeTunnel.app/Contents/Resources/vibetunnel-fwd /bin/zsh -i -c claude',
  };
  const program = (stat: string, ppid: number): PsProcess => ({ ppid, stat, args: '' });

  it.for([
    '?Es',
    'Z',
  ])('counts a program left %s as ended once its forwarder is gone, not before', (stat) => {
    const hung = new Map([
      [52509, forwarder],
      [52527, program(stat, 52509)],
    ]);
    expect(externalKillState(hung, 52527, 52509)).toMatchObject({
      ended: false,
      forwarderToSignal: 52509,
      refusal: null,
    });
    // The forwarder gone, launchd holds the program: it can't run anymore.
    const orphaned = new Map([[52527, program(stat, 1)]]);
    expect(externalKillState(orphaned, 52527, 52509).ended).toBe(true);
  });
});
