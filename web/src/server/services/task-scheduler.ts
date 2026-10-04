/**
 * Tasks launched from the phone: a prompt for Claude Code in a folder, now or at a set time,
 * with a push when the agent finishes its first reply.
 *
 * Scheduled tasks are kept in `<control dir>/tasks.json` (0600) so they survive a server
 * restart. Nothing runs while there are none: one timer is armed for the nearest scheduled
 * task, and the exit check runs only while a task's session is running.
 *
 * A task whose time passed while the server was down is marked missed (a "Task not run" push
 * goes out if the task asked for pushes). Only with `runOverdueOnStart` does one at most
 * TASK_LATE_GRACE_MS late run on start instead.
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  fillTaskPlaceholders,
  MAX_SCHEDULED_TASKS,
  TASK_LATE_GRACE_MS,
  type TaskAgent,
  TaskError,
  type TaskRecord,
} from '../../shared/tasks.js';
import type { NotificationPayload } from './push-notification-service.js';

/** Longest delay setTimeout accepts; farther tasks re-arm when it fires. */
const MAX_TIMER_MS = 2_147_483_647;
/** Finished, missed and failed tasks kept for the list. */
const HISTORY_LIMIT = 30;

export interface NewTask {
  name: string;
  prompt: string;
  workingDir: string;
  command: string[];
  agent: TaskAgent;
  notify: boolean;
  /** When to run; missing or not in the future = now. */
  runAt?: Date;
}

export interface TaskSchedulerDeps {
  /** JSON file the tasks live in. */
  storePath: string;
  /** Start the task's session; the server types `prompt` into it once the agent is ready. */
  launch: (task: TaskRecord, prompt: string) => Promise<{ sessionId: string }>;
  notify: (payload: NotificationPayload) => void;
  /** The session's status, or undefined once it is gone. */
  sessionStatus: (sessionId: string) => string | undefined;
  /** config.json `runOverdueOnStart`: run tasks missed while the server was down (≤ 6 h late). */
  runOverdueOnStart?: () => boolean;
  now?: () => number;
  onError?: (message: string, error?: unknown) => void;
}

export class TaskScheduler {
  private tasks: TaskRecord[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private exitTimer: ReturnType<typeof setInterval> | null = null;
  private exitCheckMs = 5000;
  private readonly now: () => number;

  constructor(private deps: TaskSchedulerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Load the saved tasks, mark (or, with `runOverdueOnStart`, run) the overdue ones, and arm
   * the timer. With no saved tasks this only reads the file: no timer, no write.
   */
  async start(exitCheckMs = 5000): Promise<void> {
    this.exitCheckMs = exitCheckMs;
    this.tasks = this.load();
    const now = this.now();
    let changed = false;
    // The server stopped while one was starting: its session may not exist.
    for (const task of this.tasks) {
      if (task.state === 'running' && !task.sessionId) {
        task.state = 'failed';
        task.error = 'server stopped while starting';
        task.errorCode = 'interrupted';
        task.finishedAt = new Date(now).toISOString();
        changed = true;
      }
    }
    const overdue = this.tasks.filter(
      (task) => task.state === 'scheduled' && Date.parse(task.runAt) <= now
    );
    const runOverdue = this.deps.runOverdueOnStart?.() === true;
    for (const task of overdue) {
      if (runOverdue && now - Date.parse(task.runAt) <= TASK_LATE_GRACE_MS) {
        await this.run(task);
      } else {
        task.state = 'missed';
        task.finishedAt = new Date(now).toISOString();
        changed = true;
        if (task.notify) this.deps.notify(this.missedPayload(task));
      }
    }
    if (changed) this.save();
    this.arm();
    this.watchExits();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.exitTimer) clearInterval(this.exitTimer);
    this.timer = null;
    this.exitTimer = null;
  }

  list(): TaskRecord[] {
    return this.tasks.map((task) => ({ ...task }));
  }

  get(id: string): TaskRecord | undefined {
    const task = this.tasks.find((entry) => entry.id === id);
    return task ? { ...task } : undefined;
  }

  /** Add a task; one due now runs right away (the result carries its sessionId). */
  async create(input: NewTask): Promise<TaskRecord> {
    const now = this.now();
    if (this.tasks.filter((task) => task.state === 'scheduled').length >= MAX_SCHEDULED_TASKS) {
      throw new TaskError('tooMany', `At most ${MAX_SCHEDULED_TASKS} scheduled tasks`);
    }
    const runAt = input.runAt && input.runAt.getTime() > now ? input.runAt : new Date(now);
    const task: TaskRecord = {
      id: randomUUID(),
      name: input.name,
      prompt: input.prompt,
      workingDir: input.workingDir,
      command: input.command,
      agent: input.agent,
      notify: input.notify,
      runAt: runAt.toISOString(),
      createdAt: new Date(now).toISOString(),
      state: 'scheduled',
    };
    this.tasks.push(task);
    this.save();
    if (runAt.getTime() <= now) await this.run(task);
    else this.arm();
    return { ...task };
  }

  /** Change a task that has not run yet. Returns undefined when there is none to change. */
  update(
    id: string,
    patch: Partial<Omit<NewTask, 'runAt'>> & { runAt?: Date }
  ): TaskRecord | undefined {
    const task = this.tasks.find((entry) => entry.id === id && entry.state === 'scheduled');
    if (!task) return undefined;
    const { runAt, ...rest } = patch;
    Object.assign(task, rest);
    if (runAt) task.runAt = runAt.toISOString();
    this.save();
    this.arm();
    return { ...task };
  }

  /** Cancel a scheduled task, or drop a finished one from the list. */
  remove(id: string): boolean {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((task) => task.id !== id);
    if (this.tasks.length === before) return false;
    this.save();
    this.arm();
    return true;
  }

  /**
   * The push for a task session whose agent just finished: the first busy → idle after the
   * prompt becomes "Task finished" instead of the plain "Claude finished" (never both).
   * Later replies in the same session go back to the usual push.
   */
  rewriteFinished(payload: NotificationPayload): NotificationPayload {
    if (payload.type !== 'claude-finished') return payload;
    const sessionId = payload.data?.sessionId;
    const task = this.tasks.find(
      (entry) => entry.state === 'running' && entry.sessionId === sessionId
    );
    if (!task) return payload;
    this.finish(task);
    if (!task.notify) return payload;
    const detail = typeof payload.data?.detail === 'string' ? payload.data.detail : '';
    return this.finishedPayload(task, detail);
  }

  /** A task whose session ended before the agent finished still reports back. */
  checkExited(): void {
    for (const task of this.tasks) {
      if (task.state !== 'running' || !task.sessionId) continue;
      const status = this.deps.sessionStatus(task.sessionId);
      if (status === 'running') continue;
      this.finish(task);
      if (task.notify) this.deps.notify(this.finishedPayload(task, ''));
    }
    this.watchExits();
  }

  /** The exit check runs only while a task's session is running. */
  private watchExits(): void {
    const running = this.tasks.some((task) => task.state === 'running' && task.sessionId);
    if (running && !this.exitTimer && this.exitCheckMs > 0) {
      this.exitTimer = setInterval(() => this.checkExited(), this.exitCheckMs);
      this.exitTimer.unref?.();
    } else if (!running && this.exitTimer) {
      clearInterval(this.exitTimer);
      this.exitTimer = null;
    }
  }

  private finish(task: TaskRecord): void {
    task.state = 'finished';
    task.finishedAt = new Date(this.now()).toISOString();
    this.save();
  }

  private finishedPayload(task: TaskRecord, detail: string): NotificationPayload {
    const type = 'task-finished';
    return {
      type,
      title: `✅ Task finished: ${task.name}`,
      body: detail || 'Open the session to see the result',
      icon: '/apple-touch-icon.png',
      badge: '/favicon-32.png',
      tag: `vibetunnel-task-${task.id}`,
      actions: [
        { action: 'view-session', title: 'Open' },
        { action: 'dismiss', title: 'Dismiss' },
      ],
      data: {
        type,
        sessionId: task.sessionId,
        taskId: task.id,
        where: task.name,
        detail: detail.slice(0, 200),
        timestamp: new Date(this.now()).toISOString(),
      },
    };
  }

  private missedPayload(task: TaskRecord): NotificationPayload {
    const type = 'task-missed';
    return {
      type,
      title: `⚠️ Task not run: ${task.name}`,
      body: 'The server was off at its time',
      icon: '/apple-touch-icon.png',
      badge: '/favicon-32.png',
      tag: `vibetunnel-task-${task.id}`,
      actions: [{ action: 'dismiss', title: 'Dismiss' }],
      data: {
        type,
        taskId: task.id,
        where: task.name,
        detail: '',
        timestamp: new Date(this.now()).toISOString(),
      },
    };
  }

  private async run(task: TaskRecord): Promise<void> {
    const prompt = fillTaskPlaceholders(task.prompt, {
      folder: task.workingDir,
      now: new Date(this.now()),
    });
    // Marked before the launch resolves so an overlapping timer can't start it twice.
    task.state = 'running';
    try {
      const { sessionId } = await this.deps.launch({ ...task }, prompt);
      task.sessionId = sessionId;
      task.startedAt = new Date(this.now()).toISOString();
    } catch (error) {
      task.state = 'failed';
      task.error = error instanceof Error ? error.message : String(error);
      task.errorCode = error instanceof TaskError ? error.code : 'startFailed';
      task.finishedAt = new Date(this.now()).toISOString();
      this.deps.onError?.(`task ${task.id} failed to start`, error);
    }
    this.save();
    this.watchExits();
  }

  /** Arm one timer for the nearest scheduled task. */
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const next = this.tasks
      .filter((task) => task.state === 'scheduled')
      .map((task) => Date.parse(task.runAt))
      .sort((a, b) => a - b)[0];
    if (next === undefined) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, next - this.now()));
    this.timer = setTimeout(() => void this.fireDue(), delay);
    this.timer.unref?.();
  }

  private async fireDue(): Promise<void> {
    this.timer = null;
    const now = this.now();
    const due = this.tasks.filter(
      (task) => task.state === 'scheduled' && Date.parse(task.runAt) <= now
    );
    for (const task of due) await this.run(task);
    this.arm();
  }

  private load(): TaskRecord[] {
    try {
      const data = JSON.parse(fs.readFileSync(this.deps.storePath, 'utf8'));
      return Array.isArray(data?.tasks)
        ? data.tasks.filter(
            (task: TaskRecord) =>
              task &&
              typeof task.id === 'string' &&
              typeof task.prompt === 'string' &&
              Array.isArray(task.command) &&
              task.command.every((arg: unknown) => typeof arg === 'string') &&
              task.agent === 'claude' &&
              !Number.isNaN(Date.parse(task.runAt))
          )
        : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.deps.onError?.('could not read saved tasks', error);
      }
      return [];
    }
  }

  private save(): void {
    // Keep every pending task and only the latest finished ones.
    const done = this.tasks.filter(
      (task) => task.state !== 'scheduled' && task.state !== 'running'
    );
    if (done.length > HISTORY_LIMIT) {
      const drop = new Set(
        done
          .sort((a, b) => Date.parse(a.finishedAt ?? a.runAt) - Date.parse(b.finishedAt ?? b.runAt))
          .slice(0, done.length - HISTORY_LIMIT)
          .map((task) => task.id)
      );
      this.tasks = this.tasks.filter((task) => !drop.has(task.id));
    }
    try {
      fs.mkdirSync(path.dirname(this.deps.storePath), { recursive: true });
      const tmp = `${this.deps.storePath}.${process.pid}.tmp`;
      // Prompts and folders are the user's: readable by the user only.
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, tasks: this.tasks }, null, 2), {
        mode: 0o600,
      });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.deps.storePath);
    } catch (error) {
      this.deps.onError?.('could not save tasks', error);
    }
  }
}
