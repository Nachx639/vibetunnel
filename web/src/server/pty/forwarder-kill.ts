/**
 * The end of a kill of an external session: its program runs under another process, and the
 * server only knows its pid (session.json). A session opened with `vt <command>` in a terminal
 * window (isForwardedSession) runs its program as the child of the forwarder (vibetunnel-fwd),
 * which named the session after its own pid (`fwd_<ms>_<pid>`) and holds it in that window.
 *
 * "Kill" on such a session could leave it running while the server answered "Session killed".
 * Its forwarder had hung: no control socket, input never arrived, and it never reaped its
 * program, which stayed exiting ("?Es") after SIGKILL with zombie children. kill(pid, 0)
 * succeeds for such a process, so the kill never saw it end; only a SIGTERM to the forwarder,
 * sent by hand, ended both. Now, once the program has had its signals,
 * confirmExternalKill reads both processes with `ps`, signals the forwarder (SIGTERM, then
 * SIGKILL) only when that pid runs a forwarder and is the program's parent, and the kill counts
 * only when nothing of the session runs anymore.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../utils/logger.js';
import { isProcessRunning } from './process-utils.js';

const base = (word: string | undefined) => (word ?? '').split('/').pop() ?? '';

/**
 * Whether a command line is the forwarder `vt <command>` runs: the native vibetunnel-fwd, or
 * `vibetunnel fwd` (also through node or bun).
 */
export function isForwarderArgs(args: string): boolean {
  const words = args.trim().split(/\s+/);
  let index = 0;
  if (/^(node\d*|bun)$/.test(base(words[0]))) {
    index = words.findIndex((word, i) => i > 0 && !word.startsWith('-'));
    if (index < 0) return false;
  }
  const program = base(words[index]);
  return program === 'vibetunnel-fwd' || (program === 'vibetunnel' && words[index + 1] === 'fwd');
}

const logger = createLogger('forwarder-kill');
const execFileAsync = promisify(execFile);

/** SIGTERM to the forwarder, then SIGKILL after this long. */
const FORWARDER_TERM_GRACE_MS = 2000;
/** What ending takes once nothing more is sent: after a SIGKILL, or with nothing to signal. */
const SETTLE_MS = 1000;
/**
 * How long a forwarder whose program has ended may take to end by itself before it is
 * signalled: it flushes its window for up to 1 s (LOCAL_OUTPUT_FLUSH_TIMEOUT in vt-fwd), then
 * reaps its program and records the exit.
 */
const FORWARDER_EXIT_GRACE_MS = 2500;
const POLL_MS = 200;

/** What `ps` says about a process still in the process table, zombies included. */
export interface PsProcess {
  ppid: number;
  /** `ps` state: "S+", "Ss", "Z" for a zombie, "?Es" for one exiting on macOS… Empty: unknown. */
  stat: string;
  args: string;
}

/** The forwarder's pid in the id it gives its session, `fwd_<ms>_<pid>`; null in any other. */
export function forwarderPidOf(sessionId: string): number | null {
  const match = /^fwd_\d+_(\d+)$/.exec(sessionId);
  const pid = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

/**
 * The processes among `pids` still in the process table, read with one `ps`. Should `ps` fail,
 * they are there but nothing more is known (empty state). Arguments are never logged: they can
 * hold prompts and secrets.
 */
async function readProcesses(pids: number[]): Promise<Map<number, PsProcess>> {
  // macOS ps rejects the whole list over one pid it can't have (over 99999): live ones only.
  const live = pids.filter((pid) => isProcessRunning(pid));
  const processes = new Map<number, PsProcess>();
  if (live.length === 0) return processes;
  const args = ['-o', 'pid=,ppid=,stat=,args=', '-p', live.join(',')];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('ps', args, { timeout: 2000 }));
  } catch (error) {
    // Exit 1: some (Linux) or all (macOS) of them ended meanwhile; the others are printed.
    const failed = error as { code?: unknown; stdout?: unknown };
    if (failed.code !== 1) {
      for (const pid of live) processes.set(pid, { ppid: 0, stat: '', args: '' });
      return processes;
    }
    stdout = String(failed.stdout ?? '');
  }
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
    if (!match) continue;
    processes.set(Number(match[1]), {
      ppid: Number(match[2]),
      stat: match[3],
      args: (match[4] ?? '').trim(),
    });
  }
  return processes;
}

/**
 * A process that can't run anymore: a zombie ("Z"; "X" is a dead one on Linux), or one exiting
 * ("E" after the state's first letter on macOS: "?Es" is a program killed while its terminal
 * can't drain, its forwarder no longer reading).
 */
function isEnding(entry: PsProcess): boolean {
  return /^[ZX]/.test(entry.stat) || entry.stat.slice(1).includes('E');
}

export interface ExternalKillState {
  /** Nothing of the session runs anymore. */
  ended: boolean;
  /** The program is gone, a zombie or exiting (its forwarder may still run). */
  programEnded: boolean;
  /** The forwarder, still running and verified: the pid to signal next. */
  forwarderToSignal: number | null;
  /** Why a forwarder still running may not be signalled. */
  refusal: string | null;
  /** Pids and `ps` states, for the log and the error: "program 52527 (?Es), forwarder 52509 (S)". */
  left: string;
}

const processLabel = (role: string, pid: number | undefined, entry: PsProcess | undefined) =>
  pid ? `${role} ${pid} (${entry ? entry.stat || '?' : 'gone'})` : `${role} (no pid)`;

/**
 * Where the kill of an external session stands, from `ps` (`processes`; a pid not in it is gone).
 * The program has ended once it is gone, a zombie or exiting. A forwarder still running holds the
 * session in its window: it may be signalled only when that pid runs a forwarder
 * (isForwarderArgs) whose child is the program, as a pid alone could belong to anything by now.
 * When that pid runs something else and is not the program's parent, the forwarder is gone.
 */
export function externalKillState(
  processes: ReadonlyMap<number, PsProcess>,
  programPid: number | undefined,
  forwarderPid: number | null
): ExternalKillState {
  const program = programPid ? processes.get(programPid) : undefined;
  const forwarder = forwarderPid ? processes.get(forwarderPid) : undefined;
  const parts = [processLabel('program', programPid, program)];
  if (forwarderPid) parts.push(processLabel('forwarder', forwarderPid, forwarder));
  const left = parts.join(', ');
  const programEnded = !program || isEnding(program);

  const settled = (ended: boolean): ExternalKillState => ({
    ended,
    programEnded,
    forwarderToSignal: null,
    refusal: null,
    left,
  });
  const holds = (refusal: string | null): ExternalKillState => ({
    ended: false,
    programEnded,
    forwarderToSignal: refusal ? null : forwarderPid,
    refusal,
    left: refusal ? `${left}; forwarder not signalled: ${refusal}` : left,
  });

  if (!forwarderPid || !forwarder) return settled(programEnded);
  if (!forwarder.stat) return holds(`ps could not be read for pid ${forwarderPid}`);
  if (isEnding(forwarder)) return settled(programEnded);
  const runsForwarder = isForwarderArgs(forwarder.args);
  const isParent = program?.ppid === forwarderPid;
  if (!runsForwarder && !isParent) return settled(programEnded);
  if (!runsForwarder) return holds(`pid ${forwarderPid} is not a VibeTunnel forwarder`);
  if (!program) {
    return holds(
      programPid
        ? `program ${programPid} is gone: pid ${forwarderPid} can't be checked as its parent`
        : `no program pid to check pid ${forwarderPid} against`
    );
  }
  if (!isParent) return holds(`pid ${forwarderPid} is not the parent of program ${programPid}`);
  return holds(null);
}

/** Sends `signal` to `pid`; false when it is gone already. */
function sendSignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/**
 * After an external session's program got its signals (SIGTERM, then SIGKILL): whether the
 * session has ended, signalling its forwarder first when one is left running. Never a process
 * group, and never a pid that isn't verified as the program's forwarder.
 */
export async function confirmExternalKill(
  sessionId: string,
  programPid: number | undefined
): Promise<ExternalKillState> {
  const forwarderPid = forwarderPidOf(sessionId);
  const pids = [programPid, forwarderPid].filter((pid): pid is number => !!pid && pid > 0);
  const look = async () => externalKillState(await readProcesses(pids), programPid, forwarderPid);
  const settle = async (ms: number) => {
    const until = Date.now() + ms;
    let state = await look();
    while (!state.ended && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      state = await look();
    }
    return state;
  };

  let state = await look();
  if (state.ended) return state;
  // A forwarder in its normal exit flush got SIGTERM (program a zombie under it)
  // or, its program already reaped, nothing at all and the kill failed after SETTLE_MS: a
  // false 500 for a session that was ending. A hung one is signalled after this grace.
  if (state.programEnded) {
    state = await settle(FORWARDER_EXIT_GRACE_MS);
    if (state.ended) return state;
  }
  // Nothing that may be signalled (`refusal` says why): it can only end by itself.
  if (state.forwarderToSignal === null) return settle(SETTLE_MS);

  logger.log(`session ${sessionId} still runs (${state.left}): SIGTERM to its forwarder`);
  sendSignal(state.forwarderToSignal, 'SIGTERM');
  state = await settle(FORWARDER_TERM_GRACE_MS);
  if (state.ended) return state;
  // Verified again on this `ps`: a forwarder that exited meanwhile left its pid to anyone.
  if (state.forwarderToSignal !== null) {
    logger.warn(`forwarder of session ${sessionId} outlived SIGTERM (${state.left}): SIGKILL`);
    sendSignal(state.forwarderToSignal, 'SIGKILL');
  }
  return settle(SETTLE_MS);
}
