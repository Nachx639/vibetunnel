/**
 * Push notifications from Claude Code's own status: "finished" when a session goes from
 * busy to idle, "needs you" when it starts waiting for the user (permission, question),
 * and "replied" when a turn ends while background agents keep Claude "busy" (its "finished"
 * only comes once they all end, maybe an hour later).
 * The phone is usually locked while Claude works; this is the moment to look at it.
 */
import { compactDetail, type ScreenChoices } from '../../shared/claude-screen.js';
import { type ClaudeStatus, readClaudeStatuses } from './claude-chat.js';
import { menuKeyHash } from './menu-key-hash.js';
import type { NotificationPayload } from './push-notification-service.js';

export interface WatchedSession {
  id: string;
  name: string;
  pid?: number;
  status: string;
}

/** A session as the PTY manager lists it, and how it finds the program running in one. */
export interface WatchedSessionSource {
  listSessions(): Array<{
    id: string;
    name: string;
    pid?: number;
    status: string;
    shielded?: boolean;
  }>;
  programRootPid(session: { id: string; pid?: number; shielded?: boolean }): number | undefined;
}

/**
 * The sessions to watch, each with the pid its agent runs under: the program inside tmux for
 * a shielded session (its own pid is tmux's client there, with no Claude under it).
 */
export function watchedSessions(source: WatchedSessionSource): WatchedSession[] {
  return source.listSessions().map((session) => ({
    id: session.id,
    name: session.name,
    pid: source.programRootPid(session),
    status: session.status,
  }));
}

type Notify = (payload: NotificationPayload) => void;

/** Busy only because background agents or tasks run: the reply is over. */
const BACKGROUND = 'busy:background';

/** Claude's status as the notifier tracks it: busy split into a turn and background work. */
function trackedStatus(claude: ClaudeStatus): string {
  return claude.status === 'busy' && claude.waitingForBackground ? BACKGROUND : claude.status;
}

export interface ClaudeStatusNotifierOptions {
  /**
   * One line for what the notifier loses sight of (a Claude
   * that stops being seen and comes back): a silent session can then be told apart from a
   * Claude that never finished. Session ids, statuses and counts only, never screen text.
   */
  log?: (message: string) => void;
  /**
   * Asked before each look: while it answers false nothing is read (no `ps`, no transcript)
   * and what was seen is forgotten, so turning it on again starts from a first sighting.
   */
  enabled?: () => boolean;
  /**
   * Awaited before each look: brings the pids `listSessions` answers up to date (a shielded
   * session's program runs inside tmux, see PtyManager.refreshProgramPids). A failure is
   * reported and the look goes on.
   */
  refreshPids?: () => Promise<void>;
}

/**
 * Looks in a row without seeing a session's Claude before its last status is forgotten (15 s
 * at the 3 s tick). One look can miss it: a `ps` that ran while it forked, its session file
 * read while Claude rewrote it. Forgetting on that one miss made the next look a silent
 * "first sighting" that swallowed the "finished" in between.
 */
export const FORGET_AFTER_UNSEEN_TICKS = 5;

/**
 * The on-screen choices as they travel in a push: small (Web Push rejects payloads over
 * ~4 KB), and only what the answer sheet shows before it re-reads the live screen.
 */
export function pushChoices(
  choices: ScreenChoices | null | undefined
): { question: string; options: string[]; detail?: string[]; keyHash?: string } | undefined {
  if (!choices || choices.options.length < 2) return undefined;
  return {
    question: choices.question.slice(0, 160),
    options: choices.options.slice(0, 9).map((option) => option.slice(0, 80)),
    ...(choices.detail ? { detail: choices.detail.map((line) => line.slice(0, 120)) } : {}),
    // What an answer from the push's own choices is checked by (see menuKeyHash).
    ...(choices.key ? { keyHash: menuKeyHash(choices.key) } : {}),
  };
}

export class ClaudeStatusNotifier {
  /**
   * Per session: the status last seen, when Claude set it (its statusUpdatedAt), how many
   * looks in a row saw it before that, and how many in a row have not seen it since.
   */
  private last = new Map<
    string,
    { status: string; since?: number; seen: number; unseen: number; pid?: number }
  >();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private listSessions: () => WatchedSession[],
    private notify: Notify,
    private readStatuses: (pids: number[]) => Promise<Map<number, ClaudeStatus>> = (pids) =>
      readClaudeStatuses(pids),
    private onError?: (error: unknown) => void,
    /** The prompt on the session's screen (numbered menu or yes/no), for the push. */
    private readChoices?: (sessionId: string) => Promise<ScreenChoices | null>,
    private options: ClaudeStatusNotifierOptions = {}
  ) {}

  start(intervalMs = 3000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    if (this.options.enabled && !this.options.enabled()) {
      this.last.clear();
      return;
    }
    this.ticking = true;
    try {
      await this.options.refreshPids?.().catch((error) => this.onError?.(error));
      const sessions = this.listSessions().filter((s) => s.status === 'running' && s.pid);
      if (sessions.length === 0) {
        this.last.clear();
        return;
      }
      // A read that fails outright (ps error) throws to the catch below: that look saw nothing,
      // so it counts against no session.
      const statuses = await this.readStatuses(sessions.map((s) => s.pid as number));
      const seen = new Set<string>();
      for (const session of sessions) {
        const claude = statuses.get(session.pid as number);
        if (!claude) continue;
        seen.add(session.id);
        const seenBefore = this.last.get(session.id);
        const status = trackedStatus(claude);
        if (seenBefore?.unseen) {
          this.options.log?.(
            `Claude status: session ${session.id} seen again (${claude.status}) after ${seenBefore.unseen} looks without it`
          );
        }
        this.last.set(session.id, {
          status,
          since: claude.since,
          seen: seenBefore && !seenBefore.unseen ? seenBefore.seen + 1 : 1,
          unseen: 0,
          pid: session.pid,
        });
        // A new program in the session (a relaunched Claude, a respawned process) is a first
        // sighting too: comparing it with the old one sent "finished" for turns that never ran.
        if (seenBefore?.pid !== undefined && seenBefore.pid !== session.pid) {
          this.options.log?.(
            `Claude status: session ${session.id} has a new program (pid ${seenBefore.pid} → ${session.pid}); taking it as a first look`
          );
          continue;
        }
        // First sighting only records the state: no burst of alerts after a server restart.
        // A session missed for a few looks still has its status from before the gap, so
        // busy → (unseen) → idle with a new `since` is a "finished".
        if (seenBefore === undefined) continue;
        let previous = seenBefore.status;
        if (previous === status) {
          // The same status set again in between two looks (3 s apart): a quick answer went
          // idle → busy → idle unseen, and its "finished" never came. A new
          // waiting is a new question. Busy again says nothing about what was in between.
          const again =
            claude.since !== undefined &&
            seenBefore.since !== undefined &&
            claude.since !== seenBefore.since;
          if (!again || claude.status === 'busy') continue;
          previous = 'busy';
        }
        const payload = this.payloadFor(session, claude, previous, status);
        if (!payload) continue;
        if (claude.status === 'waiting' && this.readChoices) {
          // A failed screen read still sends the push, just without choices.
          const read = await this.readChoices(session.id).catch(() => null);
          const choices = pushChoices(read);
          if (choices) payload.data = { ...payload.data, choices };
          // What it asks to do ("Create empty file notes.txt · touch notes.txt"), on the lock
          // screen instead of "permission prompt": enough to decide before opening anything.
          if (read?.detail?.length) {
            const asks = compactDetail(read.detail).slice(0, 200);
            payload.body = asks;
            payload.data = { ...payload.data, detail: asks };
          }
        }
        this.notify(payload);
      }
      for (const [id, entry] of this.last) {
        if (seen.has(id)) continue;
        entry.unseen++;
        if (entry.unseen === 1) {
          this.options.log?.(
            `Claude status: session ${id} not seen (last ${entry.status}, after ${entry.seen} looks with it)`
          );
        }
        if (entry.unseen >= FORGET_AFTER_UNSEEN_TICKS) {
          this.last.delete(id);
          this.options.log?.(
            `Claude status: session ${id} forgotten after ${entry.unseen} looks without it`
          );
        }
      }
    } catch (error) {
      // Runs on a timer: an unhandled rejection here would take the whole server down
      // (cli.ts exits on them). A failed ps or a vanished transcript just skips this tick.
      this.onError?.(error);
    } finally {
      this.ticking = false;
    }
  }

  private payloadFor(
    session: WatchedSession,
    claude: ClaudeStatus,
    previous: string,
    status: string
  ): NotificationPayload | null {
    const where = claude.title || session.name;
    let title: string;
    let body: string;
    let type: string;
    if (claude.status === 'waiting') {
      type = 'claude-waiting';
      title = `⏳ Claude needs you · ${where}`;
      body = (claude.waitingFor || 'Waiting for your answer').slice(0, 200);
    } else if (claude.status === 'idle' && (previous === 'busy' || previous === BACKGROUND)) {
      // Background work ending is still Claude's busy → idle: the usual "finished".
      type = 'claude-finished';
      title = `✅ Claude finished · ${where}`;
      body = claude.preview?.role === 'assistant' ? claude.preview.text : 'Your turn';
    } else if (status === BACKGROUND && previous === 'busy') {
      // Once per reply: background work going on (busy → busy) is not a "finished". Only
      // from a turn seen running, never from idle (a summary that still has the last turn).
      type = 'claude-replied';
      title = `💬 Claude replied · ${where}`;
      body =
        claude.preview?.role === 'assistant'
          ? claude.preview.text
          : 'Background agents are still running';
    } else {
      return null;
    }
    return {
      type,
      title,
      body,
      icon: '/apple-touch-icon.png',
      badge: '/favicon-32.png',
      // One notification per session: a newer state replaces the older one.
      tag: `vibetunnel-claude-${session.id}`,
      requireInteraction: type === 'claude-waiting',
      // "Answer" opens the answer sheet, like tapping the notification: never answers by itself.
      actions: [
        type === 'claude-waiting'
          ? { action: 'answer', title: 'Answer' }
          : { action: 'view-session', title: 'Open' },
        { action: 'dismiss', title: 'Dismiss' },
      ],
      // Raw fields so the service worker can rebuild the text in the user's language.
      data: {
        type,
        sessionId: session.id,
        timestamp: new Date().toISOString(),
        where,
        // Capped: Web Push payloads over ~4 KB are rejected outright.
        detail: (type === 'claude-waiting'
          ? claude.waitingFor || ''
          : claude.preview?.role === 'assistant'
            ? claude.preview.text
            : ''
        ).slice(0, 200),
      },
    };
  }
}
