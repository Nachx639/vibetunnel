import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../shared/types.js';
import { AsciinemaWriter } from '../pty/asciinema-writer.js';
import { PtyManager } from '../pty/pty-manager.js';
import {
  findTmuxBinary,
  lastCastSize,
  newSessionArgs,
  SHIELD_RESTORE_LIMIT,
  SHIELD_RESTORED_BANNER,
  ShieldTmux,
  shieldClientEndReason,
  shieldLaunchdLabel,
  shieldLaunchdPlist,
  shieldReopenPlan,
  shieldRestoreMode,
  shieldRestorePlan,
  shieldSocketArgs,
  shieldStartupAction,
  shieldTmuxName,
  shieldUsesLaunchd,
  tmuxEnv,
} from './shielded-tmux.js';
import { setShuttingDown } from './shutdown-state.js';

describe('shield tmux server under launchd (macOS)', () => {
  it('is used on macOS, not on Linux, never by tests unless asked, and can be turned off', () => {
    expect(shieldUsesLaunchd({}, 'darwin')).toBe(true);
    expect(shieldUsesLaunchd({}, 'linux')).toBe(false);
    expect(shieldUsesLaunchd({ VITEST: 'true' }, 'darwin')).toBe(false);
    expect(shieldUsesLaunchd({ VITEST: 'true', VIBETUNNEL_SHIELD_LAUNCHD: '1' }, 'darwin')).toBe(
      true
    );
    expect(shieldUsesLaunchd({ VIBETUNNEL_SHIELD_LAUNCHD: '0' }, 'darwin')).toBe(false);
  });

  it('has one label per control dir', () => {
    const label = shieldLaunchdLabel('/Users/me/.vibetunnel/control');
    expect(label).toMatch(/^sh\.vibetunnel\.shield-tmux\.[0-9a-f]{12}$/);
    expect(shieldLaunchdLabel('/Users/me/.vibetunnel/control/')).toBe(label);
    expect(shieldLaunchdLabel('/Users/me/.vibetunnel-test/control')).not.toBe(label);
  });

  it('writes a foreground tmux job: Interactive, not kept alive, with the global environment', () => {
    const plist = shieldLaunchdPlist({
      label: 'sh.vibetunnel.shield-tmux.abc',
      programArguments: ['/opt/homebrew/bin/tmux', '-S', '/c/.shield-tmux', '-D'],
      env: {
        PATH: '/opt/homebrew/bin:/usr/bin',
        ODD: 'a&b <c> "d"',
        VIBETUNNEL_SESSION_ID: 'per-session',
        COLORTERM: 'truecolor',
        BAD: 'bell\x07',
      },
      workingDirectory: '/Users/me',
    });
    expect(plist).toContain('<string>-D</string>');
    expect(plist).toContain('<key>ProcessType</key><string>Interactive</string>');
    expect(plist).toContain('<key>KeepAlive</key><false/>');
    expect(plist).toContain('<key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>');
    expect(plist).toContain('<key>ODD</key><string>a&amp;b &lt;c&gt; "d"</string>');
    expect(plist).not.toContain('VIBETUNNEL_SESSION_ID');
    expect(plist).not.toContain('COLORTERM');
    expect(plist).not.toContain('BAD');
  });

  // Starts a real launchd job; run with VT_LAUNCHD_IT=1 on a Mac.
  it.runIf(process.platform === 'darwin' && process.env.VT_LAUNCHD_IT === '1')(
    'starts the server as its own launchd job, which outlives whoever started it',
    async () => {
      const controlPath = fs.mkdtempSync('/tmp/vt-ld-');
      const label = shieldLaunchdLabel(controlPath);
      const domain = `gui/${process.getuid?.()}`;
      try {
        const shield = new ShieldTmux(controlPath, findTmuxBinary(), true);
        await shield.create({
          sessionId: 'ld-1',
          command: ['sh', '-c', 'exec sleep 60'],
          cwd: '/tmp',
          env: { ...(process.env as Record<string, string>), VIBETUNNEL_SESSION_ID: 'ld-1' },
        });
        expect(await shield.has('ld-1')).toBe(true);
        const job = execFileSync('launchctl', ['print', `${domain}/${label}`], {
          encoding: 'utf8',
        });
        expect(job).toMatch(/^\tstate = running$/m);
        const jobPid = Number(/^\tpid = (\d+)$/m.exec(job)?.[1]);
        const programPid = (await shield.panePid('ld-1')) as number;
        // The program's parent is the tmux server launchd runs, not anything of ours.
        const parent = Number(
          execFileSync('ps', ['-o', 'ppid=', '-p', String(programPid)], { encoding: 'utf8' })
        );
        expect(parent).toBe(jobPid);
        // A second session joins the same server.
        await shield.create({
          sessionId: 'ld-2',
          command: ['sh', '-c', 'exec sleep 60'],
          cwd: '/tmp',
          env: process.env as Record<string, string>,
        });
        expect(await shield.has('ld-2')).toBe(true);
      } finally {
        try {
          execFileSync('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
        } catch {
          // Not loaded.
        }
        fs.rmSync(controlPath, { recursive: true, force: true });
      }
    },
    20_000
  );
});

describe('shieldStartupAction', () => {
  it('re-attaches a shielded session whose tmux session survived, whatever was recorded', () => {
    expect(shieldStartupAction({ shielded: true, status: 'running' }, true)).toBe('reattach');
    // A server shutting down may have recorded the SIGHUP of its client as an exit.
    expect(shieldStartupAction({ shielded: true, status: 'exited' }, true)).toBe('reattach');
  });

  it('recreates a shielded session that was still running when its tmux went away', () => {
    // Mac rebooted while the server was down or killed without recording anything.
    expect(shieldStartupAction({ shielded: true, status: 'running' }, false)).toBe('restore');
    // The tmux server died under a running server, which recorded it.
    expect(
      shieldStartupAction({ shielded: true, status: 'exited', shieldEnd: 'tmux-lost' }, false)
    ).toBe('restore');
  });

  it('never revives a session the user killed or whose program ended by itself', () => {
    for (const shieldEnd of ['killed', 'program-exit', 'restore-failed'] as const) {
      expect(shieldStartupAction({ shielded: true, status: 'exited', shieldEnd }, false)).toBe(
        'ignore'
      );
      // A crash between recording the kill and the exit leaves "running": finish it.
      expect(shieldStartupAction({ shielded: true, status: 'running', shieldEnd }, false)).toBe(
        'mark-exited'
      );
    }
    // Exited before this field existed: finished.
    expect(shieldStartupAction({ shielded: true, status: 'exited' }, false)).toBe('ignore');
  });

  it('stops restoring a session that keeps dying (restore loop)', () => {
    const now = 10 * 60 * 60 * 1000;
    const recent = Array.from({ length: SHIELD_RESTORE_LIMIT }, (_, i) => now - (i + 1) * 60_000);
    expect(
      shieldStartupAction({ shielded: true, status: 'running', shieldRestores: recent }, false, now)
    ).toBe('give-up');
    // Restores older than an hour don't count.
    const old = recent.map((t) => t - 60 * 60 * 1000);
    expect(
      shieldStartupAction({ shielded: true, status: 'running', shieldRestores: old }, false, now)
    ).toBe('restore');
  });

  it('leaves normal sessions to the existing cleanup', () => {
    expect(shieldStartupAction({ status: 'running' }, false)).toBe('ignore');
    expect(shieldStartupAction({ shielded: false, status: 'running' }, true)).toBe('ignore');
  });
});

describe('tmux arguments', () => {
  it('runs the command as argv, never through a shell', () => {
    const args = newSessionArgs({
      sessionId: 'abc',
      command: ['claude', '--resume', 'x; rm -rf ~'],
      cwd: '/tmp/a b',
      cols: 90,
      rows: 20,
      sessionEnv: { VIBETUNNEL_SESSION_ID: 'abc' },
    });
    expect(args).toEqual([
      'new-session',
      '-d',
      '-s',
      'vt-abc',
      '-c',
      '/tmp/a b',
      '-x',
      '90',
      '-y',
      '20',
      '-e',
      'VIBETUNNEL_SESSION_ID=abc',
      '--',
      'claude',
      '--resume',
      'x; rm -rf ~',
    ]);
    // tmux hands a single argument to `sh -c`: one-word commands go through env instead.
    expect(
      newSessionArgs({ sessionId: 'a', command: ['zsh'], cwd: '/', sessionEnv: {} }).slice(-2)
    ).toEqual(['/usr/bin/env', 'zsh']);
  });

  it('keeps the socket in the control dir, or a derived name when that path is too long', () => {
    expect(shieldSocketArgs('/tmp/ctl')).toEqual(['-S', '/tmp/ctl/.shield-tmux']);
    const long = shieldSocketArgs(`/tmp/${'x'.repeat(120)}`);
    expect(long[0]).toBe('-L');
    expect(long[1]).toMatch(/^vibetunnel-[0-9a-f]{12}$/);
  });

  it('never passes $TMUX on (a client inside tmux refuses to attach)', () => {
    expect(tmuxEnv({ TMUX: '/x,1,0', TMUX_PANE: '%1', PATH: '/bin' })).toEqual({ PATH: '/bin' });
  });
});

describe('shieldReopenPlan', () => {
  it('continues a Claude conversation and replaces the old session', () => {
    expect(
      shieldReopenPlan({
        command: ['/opt/homebrew/bin/claude', '--dangerously-skip-permissions'],
        claudeSessionId: 'c1',
      })
    ).toEqual({
      command: ['claude', '--resume', 'c1', '--dangerously-skip-permissions'],
      replacesOld: true,
    });
  });

  it('starts anything else again and keeps the old session', () => {
    expect(shieldReopenPlan({ command: ['zsh', '-l'], claudeSessionId: 'c1' })).toEqual({
      command: ['zsh', '-l'],
      replacesOld: false,
    });
  });
});

describe('shieldRestorePlan', () => {
  it('runs nothing after a restart unless shieldRestore says so (off by default)', () => {
    expect(shieldRestoreMode(undefined)).toBe('off');
    expect(shieldRestoreMode('everything')).toBe('off');
    expect(shieldRestoreMode('agents')).toBe('agents');
    expect(shieldRestoreMode('all')).toBe('all');
    expect(shieldRestorePlan({ command: ['claude'], claudeSessionId: 'c1' }, 'off')).toBeNull();
    expect(shieldRestorePlan({ command: ['/bin/zsh', '-l'] }, 'off')).toBeNull();
  });

  it('resumes the Claude conversation, never carrying --dangerously-skip-permissions', () => {
    expect(
      shieldRestorePlan(
        {
          command: ['/opt/homebrew/bin/claude', '--dangerously-skip-permissions'],
          claudeSessionId: 'c1',
        },
        'agents'
      )
    ).toEqual({
      command: ['/opt/homebrew/bin/claude', '--resume', 'c1'],
      kind: 'claude-resume',
    });
    // Started through the shell (an alias or function): resumed the same way.
    expect(
      shieldRestorePlan(
        { command: ['/bin/zsh', '-i', '-c', 'claude'], claudeSessionId: 'c3' },
        'all'
      )?.command
    ).toEqual(['claude', '--resume', 'c3']);
    expect(
      shieldRestorePlan({ command: ['claude'], claudeSessionId: 'c2' }, 'agents')?.command
    ).toEqual(['claude', '--resume', 'c2']);
  });

  it("restores only agents under 'agents': a shell or an unknown conversation stays finished", () => {
    expect(
      shieldRestorePlan({ command: ['/bin/zsh', '-l'], claudeSessionId: 'c1' }, 'agents')
    ).toBeNull();
    expect(shieldRestorePlan({ command: ['/x/claude'] }, 'agents')).toBeNull();
  });

  it("starts anything else again, as a fresh one, only under 'all'", () => {
    expect(
      shieldRestorePlan({ command: ['/bin/zsh', '-l'], claudeSessionId: 'c1' }, 'all')
    ).toEqual({
      command: ['/bin/zsh', '-l'],
      kind: 'same-command',
    });
    expect(shieldRestorePlan({ command: ['/x/claude'] }, 'all')).toEqual({
      command: ['/x/claude'],
      kind: 'same-command',
    });
  });

  it('writes the restored line in English', () => {
    expect(SHIELD_RESTORED_BANNER).toContain('session restored after a restart');
  });
});

describe('shieldTmuxName', () => {
  it('refuses a session id that is not a plain id (tmux target syntax, paths)', () => {
    expect(shieldTmuxName('2f1c-ab_9')).toBe('vt-2f1c-ab_9');
    for (const bad of ['', 'a:b', 'a.b', '../x', 'a b', '=x', '-x']) {
      expect(() => shieldTmuxName(bad)).toThrow();
    }
  });
});

describe('launchd job release', () => {
  it('unloads the job and removes its plist once the last shielded session is gone', async () => {
    const dir = fs.mkdtempSync('/tmp/vt-rel-');
    const calls: string[][] = [];
    try {
      fs.writeFileSync(path.join(dir, '.shield-tmux.plist'), '<plist/>', { mode: 0o600 });
      // A tmux binary that has no server to talk to; launchctl is a fake: nothing real runs.
      const shield = new ShieldTmux(dir, '/usr/bin/false', true, async (args) => {
        calls.push(args);
        return '';
      });
      await shield.releaseIfIdle();
      expect(calls).toEqual([['bootout', `gui/${process.getuid?.()}/${shieldLaunchdLabel(dir)}`]]);
      expect(fs.existsSync(path.join(dir, '.shield-tmux.plist'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does nothing without launchd', async () => {
    const calls: string[][] = [];
    const shield = new ShieldTmux('/tmp/none', '/usr/bin/false', false, async (args) => {
      calls.push(args);
      return '';
    });
    await shield.releaseIfIdle();
    expect(calls).toEqual([]);
  });
});

describe('shieldClientEndReason', () => {
  it('tells a lost tmux server from a session that ended', () => {
    expect(shieldClientEndReason('\x1b[?1049l[exited]\r\n')).toBe('session-ended');
    expect(shieldClientEndReason('\x1b[?2031l[server exited]\r\n')).toBe('server-lost');
    expect(shieldClientEndReason('[server exited unexpectedly]\n')).toBe('server-lost');
    expect(shieldClientEndReason('[lost server]\n')).toBe('server-lost');
    expect(shieldClientEndReason('$ ')).toBe('unknown');
  });
});

describe('lastCastSize', () => {
  const dir = fs.mkdtempSync('/tmp/vt-size-');
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('uses the last resize, else the header', () => {
    const file = path.join(dir, 'stdout');
    fs.writeFileSync(file, `${JSON.stringify({ version: 2, width: 100, height: 40 })}\n`);
    expect(lastCastSize(file)).toEqual({ cols: 100, rows: 40 });
    fs.appendFileSync(file, '[1.0,"r","90x20"]\n[2.0,"o","hello"]\n[3.0,"r","70x25"]\n');
    expect(lastCastSize(file)).toEqual({ cols: 70, rows: 25 });
    expect(lastCastSize(path.join(dir, 'missing'))).toBeNull();
  });
});

describe('AsciinemaWriter.resume', () => {
  const dir = fs.mkdtempSync('/tmp/vt-cast-');
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('appends to the existing cast after a half-written line', async () => {
    const file = path.join(dir, 'stdout');
    const first = AsciinemaWriter.create(file, 80, 24);
    first.writeOutput(Buffer.from('before\r\n'));
    await first.close();
    fs.appendFileSync(file, '[1.5, "o", "cut'); // server killed mid-write

    const resumed = AsciinemaWriter.resume(file);
    resumed.writeOutput(Buffer.from('after'));
    await resumed.close();

    const lines = fs.readFileSync(file, 'utf8').split('\n');
    expect(JSON.parse(lines[0]).version).toBe(2);
    expect(lines.filter((line) => line.includes('before'))).toHaveLength(1);
    expect(JSON.parse(lines.filter(Boolean).at(-1) ?? '')[2]).toBe('after');
  });
});

// The integration test needs real PTYs (the test setup mocks node-pty).
vi.unmock('node-pty');

const tmux = findTmuxBinary();

describe.skipIf(!tmux)('shielded session survives a server restart (real tmux)', () => {
  let controlPath: string;
  const managers: PtyManager[] = [];

  beforeAll(async () => {
    await PtyManager.initialize();
  });

  afterEach(() => {
    try {
      execFileSync(tmux as string, [...shieldSocketArgs(controlPath), 'kill-server'], {
        stdio: 'ignore',
      });
    } catch {
      // No server left.
    }
    fs.rmSync(controlPath, { recursive: true, force: true });
  });

  it('re-attaches the same program under the same id', async () => {
    controlPath = fs.mkdtempSync('/tmp/vt-sh-');
    const first = new PtyManager(controlPath);
    managers.push(first);
    const { sessionId } = await first.createSession(['sh', '-c', 'echo before; exec sleep 60'], {
      sessionId: 'shield-it',
      workingDir: '/tmp',
      cols: 80,
      rows: 24,
      shielded: true,
    });
    const shield = new ShieldTmux(controlPath);
    const programPid = await shield.panePid(sessionId);
    expect(programPid).toBeGreaterThan(0);

    // "Server shuts down": its tmux client goes away with it.
    const clientPid = first.getSession(sessionId)?.pid as number;
    setShuttingDown(true);
    try {
      process.kill(clientPid, 'SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      setShuttingDown(false);
    }
    expect(await shield.has(sessionId)).toBe(true);

    const second = new PtyManager(controlPath);
    managers.push(second);
    const result = await second.reattachShieldedSessions();
    expect(result.reattached).toEqual([sessionId]);
    expect(await shield.panePid(sessionId)).toBe(programPid);
    const session = second.getSession(sessionId);
    expect(session?.status).toBe('running');
    expect(session?.pid).not.toBe(clientPid);
    expect(fs.readFileSync(path.join(controlPath, sessionId, 'stdout'), 'utf8')).toContain(
      'before'
    );

    // Closing it ends the program too.
    await second.killSession(sessionId);
    expect(await shield.has(sessionId)).toBe(false);
  }, 20_000);

  /** Server goes down (its client dies), then the whole tmux server: a Mac reboot. */
  async function simulateReboot(manager: PtyManager, sessionIds: string[]) {
    setShuttingDown(true);
    try {
      for (const id of sessionIds) {
        const pid = manager.getSession(id)?.pid;
        if (pid) process.kill(pid, 'SIGKILL');
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      setShuttingDown(false);
    }
    try {
      execFileSync(tmux as string, [...shieldSocketArgs(controlPath), 'kill-server'], {
        stdio: 'ignore',
      });
    } catch {
      // Already gone.
    }
  }

  it('recreates running sessions after a reboot, but not the one the user killed', async () => {
    controlPath = fs.mkdtempSync('/tmp/vt-sh-');
    const binDir = fs.mkdtempSync('/tmp/vt-bin-');
    const argsFile = path.join(binDir, 'args');
    // A fake `claude` that records its arguments: the real one is never run.
    fs.writeFileSync(
      path.join(binDir, 'claude'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argsFile}'\necho fake-claude "$@"\nexec sleep 60\n`,
      { mode: 0o755 }
    );
    const savedPath = process.env.PATH;
    process.env.PATH = `${binDir}:${savedPath}`;
    try {
      const first = new PtyManager(controlPath);
      managers.push(first);
      const shell = await first.createSession(['sh', '-c', 'echo before; exec sleep 60'], {
        sessionId: 'shield-shell',
        name: 'my shell',
        workingDir: '/tmp',
        cols: 80,
        rows: 24,
        shielded: true,
      });
      const claude = await first.createSession(
        [path.join(binDir, 'claude'), '--dangerously-skip-permissions'],
        { sessionId: 'shield-claude', workingDir: binDir, cols: 80, rows: 24, shielded: true }
      );
      first.setClaudeSessionId(claude.sessionId, 'conv-123');
      const killed = await first.createSession(['sh', '-c', 'exec sleep 60'], {
        sessionId: 'shield-killed',
        workingDir: '/tmp',
        cols: 80,
        rows: 24,
        shielded: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await first.killSession(killed.sessionId);
      await simulateReboot(first, [shell.sessionId, claude.sessionId]);
      const shield = new ShieldTmux(controlPath);
      expect(await shield.has(shell.sessionId)).toBe(false);

      const second = new PtyManager(controlPath, { shieldRestoreMode: () => 'all' });
      managers.push(second);
      const result = await second.reattachShieldedSessions();
      expect(result.restored.sort()).toEqual(['shield-claude', 'shield-shell']);
      expect(result.reattached).toEqual([]);

      const restoredShell = second.getSession(shell.sessionId);
      expect(restoredShell?.status).toBe('running');
      expect(restoredShell?.name).toBe('my shell');
      expect(restoredShell?.restoredFrom).toBe('reboot');
      expect(restoredShell?.shieldRestores).toHaveLength(1);
      expect(await shield.has(shell.sessionId)).toBe(true);
      expect(second.getSession(killed.sessionId)?.status).toBe('exited');
      expect(second.getSession(killed.sessionId)?.shieldEnd).toBe('killed');
      expect(await shield.has(killed.sessionId)).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(fs.readFileSync(argsFile, 'utf8').trim().split('\n')).toEqual([
        '--dangerously-skip-permissions',
        // An unattended restore never carries the permission bypass.
        '--resume conv-123',
      ]);
      const cast = fs.readFileSync(path.join(controlPath, shell.sessionId, 'stdout'), 'utf8');
      expect(cast).toContain('before');
      expect(cast).toContain('session restored after a restart');
      expect(cast.indexOf('before')).toBeLessThan(cast.indexOf('session restored'));

      await second.killSession(shell.sessionId);
      await second.killSession(claude.sessionId);
    } finally {
      process.env.PATH = savedPath;
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('runs nothing after a reboot by default: the lost sessions are marked exited', async () => {
    controlPath = fs.mkdtempSync('/tmp/vt-sh-');
    const first = new PtyManager(controlPath);
    managers.push(first);
    const { sessionId } = await first.createSession(['sh', '-c', 'echo before; exec sleep 60'], {
      sessionId: 'shield-off',
      workingDir: '/tmp',
      cols: 80,
      rows: 24,
      shielded: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await simulateReboot(first, [sessionId]);

    const second = new PtyManager(controlPath);
    managers.push(second);
    const result = await second.reattachShieldedSessions();
    expect(result.restored).toEqual([]);
    expect(result.finished).toEqual([sessionId]);
    expect(second.getSession(sessionId)?.status).toBe('exited');
    expect(second.getSession(sessionId)?.shieldEnd).toBe('not-restored');
    expect(await new ShieldTmux(controlPath).has(sessionId)).toBe(false);
    // Turning restores on later never brings back a session left finished this way.
    const third = new PtyManager(controlPath, { shieldRestoreMode: () => 'all' });
    managers.push(third);
    expect((await third.reattachShieldedSessions()).restored).toEqual([]);
  }, 20_000);

  it('gives up on a session restored too often and marks it exited', async () => {
    controlPath = fs.mkdtempSync('/tmp/vt-sh-');
    const first = new PtyManager(controlPath);
    managers.push(first);
    const { sessionId } = await first.createSession(['sh', '-c', 'exec sleep 60'], {
      sessionId: 'shield-loop',
      workingDir: '/tmp',
      cols: 80,
      rows: 24,
      shielded: true,
    });
    await simulateReboot(first, [sessionId]);
    const infoPath = path.join(controlPath, sessionId, 'session.json');
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    info.shieldRestores = Array.from({ length: SHIELD_RESTORE_LIMIT }, () => Date.now() - 1000);
    fs.writeFileSync(infoPath, JSON.stringify(info));

    const second = new PtyManager(controlPath, { shieldRestoreMode: () => 'all' });
    managers.push(second);
    const result = await second.reattachShieldedSessions();
    expect(result.restored).toEqual([]);
    expect(result.finished).toEqual([sessionId]);
    expect(second.getSession(sessionId)?.status).toBe('exited');
    expect(second.getSession(sessionId)?.shieldEnd).toBe('restore-failed');
    expect(await new ShieldTmux(controlPath).has(sessionId)).toBe(false);
  }, 20_000);

  it('records a program that ended by itself so it is never revived', async () => {
    controlPath = fs.mkdtempSync('/tmp/vt-sh-');
    const manager = new PtyManager(controlPath);
    managers.push(manager);
    const { sessionId } = await manager.createSession(['sh', '-c', 'sleep 0.5'], {
      sessionId: 'shield-done',
      workingDir: '/tmp',
      cols: 80,
      rows: 24,
      shielded: true,
    });
    for (let i = 0; i < 40 && manager.getSession(sessionId)?.status !== 'exited'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const info = manager.getSession(sessionId);
    expect(info?.status).toBe('exited');
    expect(info?.shieldEnd).toBe('program-exit');
    expect(shieldStartupAction(info as Session, false)).toBe('ignore');
  }, 20_000);
});
