/**
 * Removes finished (exited) sessions older than the user's `autoCleanupExitedAfterDays`.
 * Off unless the user picks a number of days in Settings. Each session goes through the same
 * cleanup path as the manual "Clear" (the whole control dir), and running sessions are never
 * touched.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Session } from '../../shared/types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('exited-session-cleanup');

export const AUTO_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ExitedSessionCleanupOptions {
  controlPath: string;
  /** Sessions with dead processes are marked exited by this listing. */
  listSessions: () => Session[];
  /** The manual "Clear" code path for one session. */
  cleanupSession: (sessionId: string) => void;
  /** The current setting; 0 (or anything not a positive number) means off. */
  getDays: () => number | undefined;
  now?: () => number;
  intervalMs?: number;
}

/** When a session finished: the latest of its output and its session.json (written on exit). */
function finishedAt(session: Session, controlPath: string): number {
  const times = [Date.parse(session.lastModified), Date.parse(session.startedAt)];
  try {
    times.push(fs.statSync(path.join(controlPath, session.id, 'session.json')).mtimeMs);
  } catch {
    // Gone already: the listing's times decide.
  }
  const valid = times.filter((time) => Number.isFinite(time));
  return valid.length > 0 ? Math.max(...valid) : Number.NaN;
}

export class ExitedSessionCleanup {
  private timer?: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(private readonly options: ExitedSessionCleanupOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Runs once now and then every hour; the timers never keep the process alive. */
  start(): void {
    if (this.timer) return;
    const firstRun = setTimeout(() => this.runSafely(), 0);
    firstRun.unref();
    this.timer = setInterval(
      () => this.runSafely(),
      this.options.intervalMs ?? AUTO_CLEANUP_INTERVAL_MS
    );
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Removes expired exited sessions; returns their ids. */
  run(): string[] {
    const days = this.options.getDays();
    if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) return [];

    const cutoff = this.now() - days * DAY_MS;
    const removed: string[] = [];
    let failed = 0;
    for (const session of this.options.listSessions()) {
      if (session.status !== 'exited' || !session.id) continue;
      const finished = finishedAt(session, this.options.controlPath);
      if (!Number.isFinite(finished) || finished > cutoff) continue;
      try {
        this.options.cleanupSession(session.id);
        removed.push(session.id);
      } catch (error) {
        failed++;
        logger.warn(`could not remove finished session ${session.id}:`, error);
      }
    }
    if (removed.length > 0 || failed > 0) {
      logger.log(
        `auto-cleanup removed ${removed.length} finished session(s) older than ${days} day(s)` +
          (failed > 0 ? `, ${failed} failed` : '')
      );
    }
    return removed;
  }

  private runSafely(): void {
    try {
      this.run();
    } catch (error) {
      logger.error('auto-cleanup of finished sessions failed:', error);
    }
  }
}
