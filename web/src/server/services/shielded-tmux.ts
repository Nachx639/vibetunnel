/**
 * Shielded sessions: the command runs inside a detached tmux session on a VibeTunnel-only
 * tmux server, and the session's PTY is just a `tmux attach` client. Off by default: new
 * sessions are shielded only with config.json `"shieldNewSessions": true` (Settings) or a
 * request's `shielded: true`.
 *
 * Why tmux and not a detached forwarder: a web session's PTY is a node-pty child of the server.
 * When the server exits (deploy, crash, update) the PTY master closes, the kernel hangs up the
 * terminal and the shell (and Claude in it) gets SIGHUP; on the next start the session list sees
 * the dead pid and marks it exited. The tmux server daemonizes (fork + setsid), so it is not in
 * the VibeTunnel process tree or process group and outlives any restart; only the attach client
 * dies, and the next server start attaches a new one under the same session id. tmux also keeps
 * the screen and scrollback itself, so nothing has to be replayed from our side.
 *
 * The tmux server is private to the control directory (its socket lives in it), so the user's
 * own tmux is never touched and two VibeTunnel servers with different control dirs (tests) don't
 * share sessions. Every tmux call is execFile with an argument array: no shell.
 *
 * After a reboot the tmux server is gone. What happens to sessions that were still running
 * is the `shieldRestore` setting (see shieldRestorePlan): 'off' (default) marks them exited
 * and runs nothing; 'agents' resumes Claude Code conversations (`claude --resume <id>`);
 * 'all' also starts every other command again. A permission-bypass flag is never carried into
 * an unattended restore. Limits: this only happens when VibeTunnel itself starts, normally at
 * login; a boot-time PATH or keychain may differ from the user's shell, so a program needing
 * them can fail; that counts towards the restore loop guard.
 *
 * macOS: the tmux server is started by launchd as its own job (see startServerWithLaunchd).
 * A process stays in the coalition of the app that started it, across fork and setsid, and
 * when an app quits macOS ends its whole coalition a few seconds later, so quitting the app
 * for an update took the tmux server with it and every shielded session came back restarted
 * instead of re-attached. A launchd job has a coalition of its own and outlives the app. The
 * job's plist (0600, next to the socket) holds the environment the sessions get. It is booted
 * out when the last shielded session ends. VIBETUNNEL_SHIELD_LAUNCHD=0 turns launchd off.
 */
import { execFile, execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import type { Session, SessionInfo } from '../../shared/types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('shielded-tmux');
const execFileAsync = promisify(execFile);

const TMUX_CANDIDATES = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'];
/** macOS caps unix socket paths at 104 bytes. */
const MAX_SOCKET_PATH = 100;

let cachedTmux: string | null | undefined;

/** The tmux binary, or null when tmux isn't installed (shielding is then unavailable). */
export function findTmuxBinary(): string | null {
  if (cachedTmux !== undefined) return cachedTmux;
  const fromEnv = process.env.VIBETUNNEL_TMUX_BIN;
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const candidates = [
    ...(fromEnv ? [fromEnv] : []),
    ...TMUX_CANDIDATES,
    ...pathDirs.map((dir) => path.join(dir, 'tmux')),
  ];
  cachedTmux = candidates.find((candidate) => isExecutable(candidate)) ?? null;
  return cachedTmux;
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Session ids that may name a tmux session (UUIDs and the like; never a tmux target syntax). */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** tmux session name of a VibeTunnel session. */
export function shieldTmuxName(sessionId: string): string {
  if (!SAFE_SESSION_ID.test(sessionId)) {
    throw new Error(`invalid session id for a shielded session: ${JSON.stringify(sessionId)}`);
  }
  return `vt-${sessionId}`;
}

/**
 * Socket selection args for the shield tmux server of a control dir: `-S <controlDir>/.shield-tmux`
 * (or `-L` with a name derived from it when that path is too long for a unix socket).
 */
export function shieldSocketArgs(controlPath: string): string[] {
  const socketPath = path.join(controlPath, '.shield-tmux');
  if (socketPath.length <= MAX_SOCKET_PATH) return ['-S', socketPath];
  const hash = crypto.createHash('sha1').update(controlPath).digest('hex').slice(0, 12);
  return ['-L', `vibetunnel-${hash}`];
}

/**
 * Oldest tmux shielded sessions run on: `tmux -D` (the launchd job) and `terminal-features`
 * are 3.2. An older tmux makes the shield unavailable, so a default shield falls back to a
 * plain session instead of failing.
 */
export const SHIELD_MIN_TMUX_VERSION: readonly [number, number] = [3, 2];

/**
 * The version in `tmux -V` output, or null when it names none (`tmux master`, an OS build).
 * `tmux 3.2a` and `tmux next-3.4` give [3, 2] and [3, 4].
 */
export function parseTmuxVersion(output: string): [number, number] | null {
  const match = /^tmux\s+(?:next-)?(\d+)\.(\d+)/.exec(output.trim());
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/** Why the tmux that printed `versionOutput` can't run shielded sessions, or null if it can. */
export function tmuxVersionProblem(versionOutput: string): string | null {
  const version = parseTmuxVersion(versionOutput);
  // No number: a development or OS build, which tracks current tmux.
  if (!version) return null;
  const [minMajor, minMinor] = SHIELD_MIN_TMUX_VERSION;
  const [major, minor] = version;
  if (major > minMajor || (major === minMajor && minor >= minMinor)) return null;
  return `Shielded sessions need tmux ${minMajor}.${minMinor} or newer; the server has ${versionOutput.trim()}`;
}

/** `tmux -V` is asked once per binary. */
const tmuxProblems = new Map<string, string | null>();

function tmuxBinaryProblem(tmuxBin: string): string | null {
  const cached = tmuxProblems.get(tmuxBin);
  if (cached !== undefined) return cached;
  let problem: string | null;
  try {
    const output = execFileSync(tmuxBin, ['-V'], { encoding: 'utf8', timeout: 5_000 });
    problem = tmuxVersionProblem(output);
  } catch (error) {
    problem = `Shielded sessions need tmux, and ${tmuxBin} -V failed: ${error instanceof Error ? error.message : error}`;
  }
  if (problem) logger.warn(problem);
  tmuxProblems.set(tmuxBin, problem);
  return problem;
}

/**
 * Options of the shield tmux server: tmux must be invisible. No status bar, no prefix key (every
 * key reaches the program), no mouse capture (the web terminal scrolls), no escape delay, and no
 * alternate screen on the outside so output scrolls into the web terminal's scrollback.
 * Every one is `set-option -q`: tmux stops a `;` chain at the first failing command, so one
 * option a tmux doesn't know would otherwise abort the `new-session` after it.
 */
export const SHIELD_SERVER_OPTIONS: string[][] = [
  ['set-option', '-q', '-g', 'status', 'off'],
  ['set-option', '-q', '-g', 'prefix', 'None'],
  ['set-option', '-q', '-g', 'prefix2', 'None'],
  ['set-option', '-q', '-g', 'mouse', 'off'],
  ['set-option', '-q', '-s', 'escape-time', '0'],
  ['set-option', '-q', '-g', 'history-limit', '50000'],
  ['set-option', '-q', '-g', 'default-terminal', 'tmux-256color'],
  ['set-option', '-q', '-s', 'terminal-overrides', '*:smcup@:rmcup@'],
  ['set-option', '-q', '-s', 'terminal-features', 'xterm*:RGB:clipboard:title:focus'],
  ['set-option', '-q', '-s', 'set-clipboard', 'on'],
  ['set-option', '-q', '-s', 'focus-events', 'on'],
  ['set-option', '-q', '-g', 'set-titles', 'on'],
  ['set-option', '-q', '-g', 'set-titles-string', '#{pane_title}'],
  ['set-option', '-q', '-g', 'allow-passthrough', 'on'],
  ['set-option', '-q', '-g', 'allow-rename', 'off'],
  ['set-option', '-q', '-g', 'bell-action', 'any'],
  ['set-option', '-q', '-g', 'visual-bell', 'off'],
  ['set-option', '-q', '-g', 'remain-on-exit', 'off'],
  ['set-option', '-q', '-g', 'destroy-unattached', 'off'],
  ['set-option', '-q', '-g', 'detach-on-destroy', 'on'],
  ['set-option', '-q', '-g', 'window-size', 'latest'],
];

/** Variables each session gets with `new-session -e`; never part of the server's environment. */
const PER_SESSION_ENV = ['VIBETUNNEL_SESSION_ID', 'TERM_PROGRAM', 'COLORTERM'];

/**
 * Whether the shield tmux server is started by launchd: on macOS, unless
 * VIBETUNNEL_SHIELD_LAUNCHD=0. Tests start and kill throwaway tmux servers, so under vitest
 * only with VIBETUNNEL_SHIELD_LAUNCHD=1.
 */
export function shieldUsesLaunchd(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== 'darwin' || env.VIBETUNNEL_SHIELD_LAUNCHD === '0') return false;
  return env.VIBETUNNEL_SHIELD_LAUNCHD === '1' || !env.VITEST;
}

/** launchd label of a control dir's shield tmux server (one per control dir). */
export function shieldLaunchdLabel(controlPath: string): string {
  const hash = crypto.createHash('sha1').update(path.resolve(controlPath)).digest('hex');
  return `sh.vibetunnel.shield-tmux.${hash.slice(0, 12)}`;
}

const xmlText = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// biome-ignore lint/suspicious/noControlCharactersInRegex: XML 1.0 can't carry these
const XML_UNSAFE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

/**
 * The launchd job of the shield tmux server: `tmux -S <socket> -D` (in the foreground, so
 * launchd owns it), as an Interactive process (no background CPU/IO throttling for Claude)
 * that is not restarted when it ends (the next shielded session starts it again). Its
 * environment is the one sessions get (the tmux global environment), without per-session
 * variables; the plist is written 0600 next to the socket.
 */
export function shieldLaunchdPlist(options: {
  label: string;
  programArguments: string[];
  env: Record<string, string>;
  workingDirectory: string;
}): string {
  const env = Object.entries(options.env).filter(
    ([key, value]) =>
      !PER_SESSION_ENV.includes(key) &&
      key !== 'TMUX' &&
      key !== 'TMUX_PANE' &&
      !XML_UNSAFE.test(key) &&
      !XML_UNSAFE.test(value)
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${xmlText(options.label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...options.programArguments.map((arg) => `    <string>${xmlText(arg)}</string>`),
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><false/>',
    '  <key>ProcessType</key><string>Interactive</string>',
    '  <key>AbandonProcessGroup</key><true/>',
    `  <key>WorkingDirectory</key><string>${xmlText(options.workingDirectory)}</string>`,
    '  <key>StandardOutPath</key><string>/dev/null</string>',
    '  <key>StandardErrorPath</key><string>/dev/null</string>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...env.map(
      ([key, value]) => `    <key>${xmlText(key)}</key><string>${xmlText(value)}</string>`
    ),
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** Join tmux commands into one invocation (`a ; b ; c`, each `;` its own argument). */
export function chainTmuxCommands(commands: string[][]): string[] {
  return commands.flatMap((command, index) => (index === 0 ? command : [';', ...command]));
}

/** The environment tmux commands run with: never inside another tmux. */
export function tmuxEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && key !== 'TMUX' && key !== 'TMUX_PANE') env[key] = value;
  }
  return env;
}

/**
 * Argument list for `tmux new-session`. With more than one argument tmux execs the command
 * directly (no shell), so a one-word command goes through /usr/bin/env.
 */
export function newSessionArgs(options: {
  sessionId: string;
  command: string[];
  cwd: string;
  cols?: number;
  rows?: number;
  sessionEnv: Record<string, string>;
}): string[] {
  const command =
    options.command.length === 1 ? ['/usr/bin/env', options.command[0]] : options.command;
  return [
    'new-session',
    '-d',
    '-s',
    shieldTmuxName(options.sessionId),
    '-c',
    options.cwd,
    '-x',
    String(options.cols ?? 120),
    '-y',
    String(options.rows ?? 30),
    ...Object.entries(options.sessionEnv).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    '--',
    ...command,
  ];
}

/** Runs `launchctl` with an argument array (tests pass a fake; nothing else ever calls it). */
export type LaunchctlRunner = (args: string[]) => Promise<string>;

const runLaunchctl: LaunchctlRunner = async (args) =>
  (await execFileAsync('launchctl', args, { timeout: 10_000 })).stdout;

export class ShieldTmux {
  /** A launchd start in progress (two sessions created at once share it). */
  private launchdStart: Promise<boolean> | null = null;

  constructor(
    private readonly controlPath: string,
    private readonly tmuxBin: string | null = findTmuxBinary(),
    private readonly useLaunchd: boolean = shieldUsesLaunchd(),
    private readonly launchctl: LaunchctlRunner = runLaunchctl
  ) {}

  isAvailable(): boolean {
    return this.unavailableReason() === null;
  }

  /** Why shielded sessions can't run here (no tmux, or one that is too old), or null. */
  unavailableReason(): string | null {
    if (!this.tmuxBin) return 'Shielded sessions need tmux, which is not installed';
    return tmuxBinaryProblem(this.tmuxBin);
  }

  private bin(): string {
    if (!this.tmuxBin) throw new Error('tmux is not installed: shielded sessions need tmux');
    return this.tmuxBin;
  }

  private async run(args: string[], env?: Record<string, string>): Promise<string> {
    const { stdout } = await execFileAsync(
      this.bin(),
      [...shieldSocketArgs(this.controlPath), ...args],
      { env: tmuxEnv(env ?? process.env), timeout: 10_000 }
    );
    return stdout;
  }

  /** Start `command` in a detached tmux session for `sessionId`. */
  async create(options: {
    sessionId: string;
    command: string[];
    cwd: string;
    cols?: number;
    rows?: number;
    /** Environment of the program (the tmux server inherits it when this call starts it). */
    env: Record<string, string>;
  }): Promise<void> {
    // Per-session variables: the tmux server's global environment is whatever the first
    // session's call had, so the ones that differ per session are set on the session itself.
    const sessionEnv: Record<string, string> = {};
    for (const key of ['VIBETUNNEL_SESSION_ID', 'TERM_PROGRAM', 'COLORTERM']) {
      if (options.env[key]) sessionEnv[key] = options.env[key];
    }
    sessionEnv.COLORTERM ??= 'truecolor';
    if (this.useLaunchd) {
      this.launchdStart ??= this.startServerWithLaunchd(options.env).finally(() => {
        this.launchdStart = null;
      });
      await this.launchdStart;
    }
    const args = chainTmuxCommands([
      // A no-op when the server runs (launchd started it); otherwise it starts here.
      ['start-server'],
      ...SHIELD_SERVER_OPTIONS,
      newSessionArgs({ ...options, sessionEnv }),
    ]);
    await this.run(args, options.env);
    logger.log(`shielded tmux session ${shieldTmuxName(options.sessionId)} started`);
  }

  /** Whether the shield tmux server answers on its socket (it never starts one). */
  private async serverUp(): Promise<boolean> {
    try {
      await this.run(['show-options', '-s', 'escape-time']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * macOS: when no shield tmux server runs, start it as its own launchd job in the user's GUI
   * domain (own coalition: it outlives the app; GUI session: keychain access for Claude).
   * False when that didn't work; create() then starts it the old way. A server already
   * running (an older one started without launchd) is used as it is.
   */
  private async startServerWithLaunchd(env: Record<string, string>): Promise<boolean> {
    const tmuxBin = this.tmuxBin;
    const uid = process.getuid?.();
    if (!tmuxBin || uid === undefined) return false;
    if (await this.serverUp()) return true;
    const label = shieldLaunchdLabel(this.controlPath);
    const domain = `gui/${uid}`;
    const plistPath = path.join(this.controlPath, '.shield-tmux.plist');
    try {
      const loaded = await this.launchctl(['print', `${domain}/${label}`]).then(
        (stdout) => stdout,
        () => null
      );
      if (loaded !== null) {
        if (/^\tstate = running$/m.test(loaded)) {
          logger.warn(`launchd job ${label} runs but its tmux socket doesn't answer`);
          return false;
        }
        // Loaded but its tmux ended: unload it so the new plist (environment) is used.
        await this.launchctl(['bootout', `${domain}/${label}`]).catch(() => {});
      }
      fs.writeFileSync(
        plistPath,
        shieldLaunchdPlist({
          label,
          programArguments: [tmuxBin, ...shieldSocketArgs(this.controlPath), '-D'],
          env: tmuxEnv(env),
          workingDirectory: env.HOME || os.homedir(),
        }),
        { mode: 0o600 }
      );
      fs.chmodSync(plistPath, 0o600);
      await this.launchctl(['bootstrap', domain, plistPath]);
      for (let attempt = 0; attempt < 50; attempt++) {
        if (await this.serverUp()) {
          logger.log(`shield tmux server started by launchd (${label})`);
          return true;
        }
        // With the screen locked launchd may not run RunAtLoad on its own; an explicit
        // kickstart does.
        if (attempt === 10) {
          await this.launchctl(['kickstart', `${domain}/${label}`]).catch(() => {});
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      logger.error(`launchd job ${label} started but its tmux socket never answered`);
      return false;
    } catch (error) {
      logger.warn(
        `could not start the shield tmux server with launchd (${label}): ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  /** Whether the tmux session of `sessionId` is still alive. */
  async has(sessionId: string): Promise<boolean> {
    if (!this.tmuxBin) return false;
    try {
      await this.run(['has-session', '-t', `=${shieldTmuxName(sessionId)}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** pid of the program in the session's pane (the user's shell or Claude). */
  async panePid(sessionId: string): Promise<number | null> {
    try {
      const out = await this.run([
        'display-message',
        '-p',
        '-t',
        `=${shieldTmuxName(sessionId)}:`,
        '#{pane_pid}',
      ]);
      const pid = Number.parseInt(out.trim(), 10);
      return Number.isFinite(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  /** Current window size, so a re-attached client starts at the size the program has. */
  async windowSize(sessionId: string): Promise<{ cols: number; rows: number } | null> {
    try {
      const out = await this.run([
        'display-message',
        '-p',
        '-t',
        `=${shieldTmuxName(sessionId)}:`,
        '#{window_width} #{window_height}',
      ]);
      const [cols, rows] = out.trim().split(' ').map(Number);
      return cols > 0 && rows > 0 ? { cols, rows } : null;
    } catch {
      return null;
    }
  }

  /** End the session and its program (SIGHUP to the pane, like closing a terminal). */
  async kill(sessionId: string): Promise<void> {
    if (!this.tmuxBin) return;
    try {
      await this.run(['kill-session', '-t', `=${shieldTmuxName(sessionId)}`]);
    } catch {
      // Already gone.
    }
    await this.releaseIfIdle();
  }

  /**
   * After the last shielded session ended: unload the launchd job (tmux exits with its last
   * session, but the job stays loaded) and remove its plist, which holds the environment.
   * Nothing to do while sessions remain, or without launchd.
   */
  async releaseIfIdle(): Promise<void> {
    if (!this.useLaunchd || !this.tmuxBin) return;
    if (await this.serverUp()) {
      const sessions = await this.run(['list-sessions', '-F', '#{session_name}']).catch(() => '');
      if (sessions.trim()) return;
    }
    const uid = process.getuid?.();
    if (uid === undefined) return;
    const label = shieldLaunchdLabel(this.controlPath);
    await this.launchctl(['bootout', `gui/${uid}/${label}`]).catch(() => {});
    fs.rmSync(path.join(this.controlPath, '.shield-tmux.plist'), { force: true });
    logger.log(`last shielded session ended: launchd job ${label} unloaded`);
  }

  /** Command + args for the PTY: a tmux client attached to the session. */
  attachCommand(sessionId: string): { command: string; args: string[] } {
    return {
      command: this.bin(),
      args: [
        ...shieldSocketArgs(this.controlPath),
        'attach-session',
        '-t',
        `=${shieldTmuxName(sessionId)}`,
      ],
    };
  }
}

export type ShieldStartupAction = 'reattach' | 'restore' | 'give-up' | 'mark-exited' | 'ignore';

/** At most this many automatic restores of one session per hour (a command that dies at once). */
export const SHIELD_RESTORE_LIMIT = 3;
export const SHIELD_RESTORE_WINDOW_MS = 60 * 60 * 1000;

/** Restores of a session within the loop-guard window. */
export function recentShieldRestores(
  info: Pick<SessionInfo, 'shieldRestores'>,
  now = Date.now()
): number[] {
  return (info.shieldRestores ?? []).filter(
    (t) => typeof t === 'number' && now - t < SHIELD_RESTORE_WINDOW_MS && t <= now
  );
}

/**
 * What a server start does with a session from disk. Shielded sessions whose tmux session is
 * alive are attached again whatever their recorded status (a dying server may have recorded
 * "exited" when its attach client got SIGHUP). When the tmux session is gone, a session that
 * was still running (the Mac rebooted, tmux was killed) is recreated under the same id, unless
 * it was restored too often in the last hour ('give-up'). Sessions the user killed, whose
 * program ended by itself, or that already exited for any other recorded reason stay finished.
 * Other sessions are left to the existing cleanup.
 */
export function shieldStartupAction(
  info: Pick<SessionInfo, 'shielded' | 'status' | 'shieldEnd' | 'shieldRestores'>,
  tmuxAlive: boolean,
  now = Date.now()
): ShieldStartupAction {
  if (!info.shielded) return 'ignore';
  if (tmuxAlive) return 'reattach';
  if (info.shieldEnd && info.shieldEnd !== 'tmux-lost') {
    return info.status === 'exited' ? 'ignore' : 'mark-exited';
  }
  if (info.status === 'exited' && info.shieldEnd !== 'tmux-lost') return 'ignore';
  if (recentShieldRestores(info, now).length >= SHIELD_RESTORE_LIMIT) return 'give-up';
  return 'restore';
}

/**
 * Why a shielded session's tmux client ended, from the last thing it printed: `[exited]` when
 * the tmux session ended (program exited or kill-session), `[server exited]` /
 * `[server exited unexpectedly]` / `[lost server]` when the tmux server itself went away.
 */
export function shieldClientEndReason(
  outputTail: string
): 'session-ended' | 'server-lost' | 'unknown' {
  if (/\[(server exited|lost server)/.test(outputTail)) return 'server-lost';
  if (outputTail.includes('[exited]')) return 'session-ended';
  return 'unknown';
}

/** A restored program that ends this soon counts as a failed restore, not a normal exit. */
export const SHIELD_RESTORE_GRACE_MS = 10_000;

/** Line written into the session history when a lost session is recreated. */
export const SHIELD_RESTORED_BANNER =
  '\r\n\x1b[2m— VibeTunnel: session restored after a restart —\x1b[0m\r\n';

/**
 * What a server start does with shielded sessions whose tmux session is gone while they were
 * still running (config.json `shieldRestore`): 'off' runs nothing and marks them exited,
 * 'agents' resumes Claude Code conversations only, 'all' also starts other commands again.
 */
export type ShieldRestoreMode = 'off' | 'agents' | 'all';

export function shieldRestoreMode(value: unknown): ShieldRestoreMode {
  return value === 'agents' || value === 'all' ? value : 'off';
}

type BypassAgent = 'claude' | 'codex' | 'gemini';

/** Flags that turn an agent's permission prompts off; each with the values that do so. */
const BYPASS_FLAGS: Record<BypassAgent, { flags: string[]; valued: Record<string, string[]> }> = {
  claude: {
    flags: ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions'],
    valued: { '--permission-mode': ['bypassPermissions'] },
  },
  codex: {
    flags: ['--dangerously-bypass-approvals-and-sandbox', '--yolo'],
    valued: {
      '--sandbox': ['danger-full-access'],
      '-s': ['danger-full-access'],
      '--ask-for-approval': ['never'],
      '-a': ['never'],
    },
  },
  gemini: {
    flags: ['--yolo', '-y'],
    valued: { '--approval-mode': ['yolo'] },
  },
};

/** The agent a command-line word starts (`claude`, `/x/codex`, `@google/gemini-cli`), if any. */
function bypassAgent(word: string): BypassAgent | null {
  const name = word.split('/').pop() ?? '';
  const match = /^(claude|codex|gemini)(?:-cli)?(?:@[\w.-]+)?$/.exec(name);
  return match ? (match[1] as BypassAgent) : null;
}

/**
 * `command` without the flags that turn an agent's permission prompts off (Claude Code's
 * `--dangerously-skip-permissions`, Codex's `--dangerously-bypass-approvals-and-sandbox` or
 * `--yolo`, Gemini's `--yolo` or `-y`, and their sandbox/approval-mode spellings), for a
 * restore that runs with nobody watching. Null when such a flag sits inside a shell command
 * string (`zsh -c "codex --yolo"`), which can't be edited safely: that session isn't restored.
 */
export function withoutPermissionBypass(command: string[]): string[] | null {
  const agentAt = command.findIndex((word) => bypassAgent(word) !== null);
  if (agentAt === -1) {
    const bypassWord =
      /(^|\s)(--dangerously-skip-permissions|--allow-dangerously-skip-permissions|--permission-mode[=\s]+bypassPermissions|--dangerously-bypass-approvals-and-sandbox|--yolo|-y|--approval-mode[=\s]+yolo|--sandbox[=\s]+danger-full-access)(\s|$)/;
    const inShellString = command.some(
      (word) => /\s/.test(word) && /(claude|codex|gemini)/.test(word) && bypassWord.test(word)
    );
    return inShellString ? null : command;
  }
  const { flags, valued } = BYPASS_FLAGS[bypassAgent(command[agentAt]) as BypassAgent];
  const kept = command.slice(0, agentAt + 1);
  const rest = command.slice(agentAt + 1);
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i];
    if (word === '--') {
      kept.push(...rest.slice(i));
      break;
    }
    if (flags.includes(word)) continue;
    const [name, inlineValue] = word.split(/=(.*)/s, 2);
    const values = valued[name];
    if (values) {
      if (inlineValue !== undefined && values.includes(inlineValue)) continue;
      if (inlineValue === undefined && values.includes(rest[i + 1])) {
        i++;
        continue;
      }
    }
    kept.push(word);
  }
  return kept;
}

/**
 * What a lost shielded session runs when it is recreated, or null when `mode` says nothing
 * runs. Claude resumes its conversation (`claude --resume <id>`); under 'all' anything else
 * runs its original command again. An unattended restore never carries a permission-bypass
 * flag (see withoutPermissionBypass): the user can add it back in the session.
 */
export function shieldRestorePlan(
  info: Pick<SessionInfo, 'command' | 'claudeSessionId'>,
  mode: ShieldRestoreMode
): { command: string[]; kind: 'claude-resume' | 'same-command' } | null {
  if (mode === 'off') return null;
  const first = info.command[0] ?? '';
  const claude = shieldReopenPlan(info);
  if (claude.replacesOld) {
    // Keep the executable the session was started with (a boot-time PATH may lack it).
    const executable = first.split('/').pop() === 'claude' ? first : 'claude';
    const args = claude.command.slice(1).filter((arg) => arg !== SKIP_PERMISSIONS_FLAG);
    return { command: [executable, ...args], kind: 'claude-resume' };
  }
  if (mode !== 'all') return null;
  const command = withoutPermissionBypass(info.command);
  return command ? { command, kind: 'same-command' } : null;
}

/** Last size recorded in a cast file (resize events, else the header), for a recreated pane. */
export function lastCastSize(castPath: string): { cols: number; rows: number } | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(castPath, 'r');
    const size = fs.fstatSync(fd).size;
    const headerBuf = Buffer.alloc(Math.min(size, 4096));
    fs.readSync(fd, headerBuf, 0, headerBuf.length, 0);
    let result: { cols: number; rows: number } | null = null;
    try {
      const header = JSON.parse(headerBuf.toString('utf8').split('\n')[0]);
      if (header.width > 0 && header.height > 0) {
        result = { cols: header.width, rows: header.height };
      }
    } catch {
      // No usable header.
    }
    const tailLength = Math.min(size, 512 * 1024);
    const tailBuf = Buffer.alloc(tailLength);
    fs.readSync(fd, tailBuf, 0, tailLength, size - tailLength);
    const resizes = [...tailBuf.toString('utf8').matchAll(/,\s*"r"\s*,\s*"(\d+)x(\d+)"\s*\]/g)];
    const last = resizes[resizes.length - 1];
    if (last) result = { cols: Number(last[1]), rows: Number(last[2]) };
    return result;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions';

/**
 * What "Shield" starts for a running session, at the user's request: its Claude conversation
 * resumed (replacing the old session, two Claudes on one conversation would collide), keeping
 * the session's own permission flag, or the same command again.
 */
export function shieldReopenPlan(session: Pick<Session, 'command' | 'claudeSessionId'>): {
  command: string[];
  replacesOld: boolean;
} {
  const commandLine = session.command.join(' ');
  if (session.claudeSessionId && /(^|[\s/])claude(\s|$)/.test(commandLine)) {
    return {
      command: [
        'claude',
        '--resume',
        session.claudeSessionId,
        ...(commandLine.includes(SKIP_PERMISSIONS_FLAG) ? [SKIP_PERMISSIONS_FLAG] : []),
      ],
      replacesOld: true,
    };
  }
  return { command: session.command, replacesOld: false };
}
