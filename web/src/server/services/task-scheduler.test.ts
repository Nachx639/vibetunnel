import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_SCHEDULED_TASKS,
  TASK_LATE_GRACE_MS,
  TaskError,
  type TaskRecord,
} from '../../shared/tasks.js';
import type { ClaudeStatus } from './claude-chat.js';
import { ClaudeStatusNotifier } from './claude-status-notifier.js';
import type { NotificationPayload } from './push-notification-service.js';
import { type NewTask, TaskScheduler } from './task-scheduler.js';

const T0 = new Date('2030-01-15T12:00:00Z').getTime();

function task(overrides: Partial<NewTask> = {}): NewTask {
  return {
    name: 'Fix the tests',
    prompt: 'Review the tests in {folder} and fix the failing ones',
    workingDir: '/home/user/projects/app',
    command: ['claude', '--model', 'opus'],
    agent: 'claude',
    notify: true,
    ...overrides,
  };
}

describe('TaskScheduler', () => {
  let dir: string;
  let store: string;
  let launch: ReturnType<typeof vi.fn>;
  let notify: ReturnType<typeof vi.fn>;
  let statuses: Map<string, string>;
  let schedulers: TaskScheduler[];

  const make = (options: { runOverdueOnStart?: boolean } = {}) => {
    const scheduler = new TaskScheduler({
      storePath: store,
      launch: launch as unknown as (t: TaskRecord, p: string) => Promise<{ sessionId: string }>,
      notify: notify as unknown as (p: NotificationPayload) => void,
      sessionStatus: (id) => statuses.get(id),
      runOverdueOnStart: () => options.runOverdueOnStart === true,
      now: () => Date.now(),
    });
    schedulers.push(scheduler);
    return scheduler;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-tasks-'));
    store = path.join(dir, 'tasks.json');
    let n = 0;
    launch = vi.fn(async () => ({ sessionId: `s${++n}` }));
    notify = vi.fn();
    statuses = new Map();
    schedulers = [];
  });

  afterEach(() => {
    for (const scheduler of schedulers) scheduler.stop();
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs a task for now at once, with the filled prompt and its command unchanged', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const created = await scheduler.create(task());
    expect(created.state).toBe('running');
    expect(created.sessionId).toBe('s1');
    const [record, prompt] = launch.mock.calls[0];
    expect(prompt).toBe('Review the tests in app and fix the failing ones');
    // Nothing is added to the user's command (no permission flags, no prompt in argv).
    expect(record.command).toEqual(['claude', '--model', 'opus']);
  });

  it('is inert with no tasks: no file written, no timer armed', async () => {
    const scheduler = make();
    await scheduler.start();
    expect(fs.existsSync(store)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('checks for ended sessions only while a task runs', async () => {
    const scheduler = make();
    await scheduler.start(1000);
    expect(vi.getTimerCount()).toBe(0);
    await scheduler.create(task());
    expect(vi.getTimerCount()).toBe(1);
    statuses.set('s1', 'exited');
    await vi.advanceTimersByTimeAsync(1000);
    expect(scheduler.list()[0].state).toBe('finished');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps tasks.json readable by the user only', async () => {
    const scheduler = make();
    await scheduler.start(0);
    await scheduler.create(task({ runAt: new Date(T0 + 60_000) }));
    expect(fs.statSync(store).mode & 0o777).toBe(0o600);
  });

  it(`refuses more than ${MAX_SCHEDULED_TASKS} scheduled tasks`, async () => {
    const scheduler = make();
    await scheduler.start(0);
    for (let i = 0; i < MAX_SCHEDULED_TASKS; i++) {
      await scheduler.create(task({ runAt: new Date(T0 + 60_000 + i) }));
    }
    await expect(scheduler.create(task({ runAt: new Date(T0 + 60_000) }))).rejects.toMatchObject({
      code: 'tooMany',
    });
  });

  it('ignores saved records that are not Claude tasks or whose command is not a list of strings', async () => {
    fs.writeFileSync(
      store,
      JSON.stringify({
        version: 1,
        tasks: [
          {
            id: 'a',
            prompt: 'p',
            command: ['codex'],
            agent: 'codex',
            runAt: new Date(T0).toISOString(),
            state: 'scheduled',
          },
          {
            id: 'b',
            prompt: 'p',
            command: [['sh']],
            agent: 'claude',
            runAt: new Date(T0).toISOString(),
            state: 'scheduled',
          },
        ],
      })
    );
    const scheduler = make({ runOverdueOnStart: true });
    await scheduler.start(0);
    expect(scheduler.list()).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
  });

  it('fires a scheduled task at its time, not before', async () => {
    const scheduler = make();
    await scheduler.start(0);
    await scheduler.create(task({ runAt: new Date(T0 + 60_000) }));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(launch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(scheduler.list()[0].state).toBe('running');
  });

  it('persists scheduled tasks and re-arms them after a restart', async () => {
    const first = make();
    await first.start(0);
    await first.create(task({ runAt: new Date(T0 + 60_000) }));
    first.stop();
    expect(JSON.parse(fs.readFileSync(store, 'utf8')).tasks).toHaveLength(1);

    const second = make();
    await second.start(0);
    expect(second.list()[0].state).toBe('scheduled');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('by default runs nothing missed while the server was down: marks it missed and says so', async () => {
    const first = make();
    await first.start(0);
    await first.create(task({ runAt: new Date(T0 + 60_000) }));
    first.stop();
    vi.setSystemTime(T0 + 60_000 + 5 * 60_000);
    const second = make();
    await second.start(0);
    expect(launch).not.toHaveBeenCalled();
    expect(second.list()[0].state).toBe('missed');
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'task-missed', title: expect.stringContaining('Fix the') })
    );
  });

  it('with runOverdueOnStart runs on start a task less than 6 h late', async () => {
    const first = make();
    await first.start(0);
    await first.create(task({ runAt: new Date(T0 + 60_000) }));
    first.stop();
    vi.setSystemTime(T0 + 60_000 + 5 * 3600_000);
    const second = make({ runOverdueOnStart: true });
    await second.start(0);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('with runOverdueOnStart still marks a task more than 6 h late as missed', async () => {
    const first = make();
    await first.start(0);
    await first.create(task({ runAt: new Date(T0 + 60_000) }));
    first.stop();
    vi.setSystemTime(T0 + 60_000 + TASK_LATE_GRACE_MS + 1);
    const second = make({ runOverdueOnStart: true });
    await second.start(0);
    expect(launch).not.toHaveBeenCalled();
    expect(second.list()[0].state).toBe('missed');
  });

  it('sends no "Task not run" push for a task that asked for no pushes', async () => {
    const first = make();
    await first.start(0);
    await first.create(task({ notify: false, runAt: new Date(T0 + 60_000) }));
    first.stop();
    vi.setSystemTime(T0 + 3600_000);
    const second = make();
    await second.start(0);
    expect(second.list()[0].state).toBe('missed');
    expect(notify).not.toHaveBeenCalled();
  });

  it('marks a task that was starting when the server stopped as interrupted', async () => {
    fs.writeFileSync(
      store,
      JSON.stringify({
        version: 1,
        tasks: [
          {
            id: 'a',
            name: 'n',
            prompt: 'p',
            workingDir: '/tmp',
            command: ['claude'],
            agent: 'claude',
            notify: true,
            runAt: new Date(T0).toISOString(),
            createdAt: new Date(T0).toISOString(),
            state: 'running',
          },
        ],
      })
    );
    const scheduler = make();
    await scheduler.start(0);
    expect(scheduler.list()[0]).toMatchObject({ state: 'failed', errorCode: 'interrupted' });
  });

  it('cancels a scheduled task', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const created = await scheduler.create(task({ runAt: new Date(T0 + 60_000) }));
    expect(scheduler.remove(created.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(launch).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(store, 'utf8')).tasks).toHaveLength(0);
  });

  it('edits the time of a scheduled task', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const created = await scheduler.create(task({ runAt: new Date(T0 + 60_000) }));
    scheduler.update(created.id, { runAt: new Date(T0 + 600_000) });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(launch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(480_000);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('turns the first "Claude finished" of a task session into one "Task finished"', async () => {
    const scheduler = make();
    await scheduler.start(0);
    await scheduler.create(task());
    const finished: NotificationPayload = {
      type: 'claude-finished',
      title: '✅ Claude finished · app',
      body: 'All 12 tests pass',
      data: { sessionId: 's1', detail: 'All 12 tests pass' },
    };
    const first = scheduler.rewriteFinished(finished);
    expect(first.type).toBe('task-finished');
    expect(first.title).toBe('✅ Task finished: Fix the tests');
    expect(first.body).toBe('All 12 tests pass');
    expect(first.data).toMatchObject({ sessionId: 's1' });
    // The next reply in that session is a normal one again.
    expect(scheduler.rewriteFinished(finished)).toBe(finished);
    // A session that ends afterwards doesn't send it a second time.
    scheduler.checkExited();
    expect(notify).not.toHaveBeenCalled();
  });

  it('leaves other sessions alone', async () => {
    const scheduler = make();
    await scheduler.start(0);
    await scheduler.create(task());
    const other: NotificationPayload = {
      type: 'claude-finished',
      title: 'x',
      body: 'y',
      data: { sessionId: 'other' },
    };
    expect(scheduler.rewriteFinished(other)).toBe(other);
  });

  it('reports a task whose session ended before Claude finished, once', async () => {
    const scheduler = make();
    await scheduler.start(0);
    await scheduler.create(task());
    statuses.set('s1', 'running');
    scheduler.checkExited();
    expect(notify).not.toHaveBeenCalled();
    statuses.set('s1', 'exited');
    scheduler.checkExited();
    scheduler.checkExited();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ type: 'task-finished' });
  });

  it('sends no task push when the user turned it off', async () => {
    const scheduler = make();
    await scheduler.start(0);
    await scheduler.create(task({ notify: false }));
    const finished: NotificationPayload = {
      type: 'claude-finished',
      title: 't',
      body: 'b',
      data: { sessionId: 's1' },
    };
    expect(scheduler.rewriteFinished(finished)).toBe(finished);
  });

  it('marks a task failed when its session cannot start, with a code the app translates', async () => {
    launch.mockRejectedValueOnce(new Error('spawn failed'));
    launch.mockRejectedValueOnce(new TaskError('disabled', 'Agent chat is off'));
    const scheduler = make();
    await scheduler.start(0);
    const created = await scheduler.create(task());
    expect(created).toMatchObject({
      state: 'failed',
      error: 'spawn failed',
      errorCode: 'startFailed',
    });
    const second = await scheduler.create(task());
    expect(second).toMatchObject({ state: 'failed', errorCode: 'disabled' });
  });

  it('the status notifier sends one task push instead of "Claude finished"', async () => {
    const scheduler = make();
    await scheduler.start(0);
    await scheduler.create(task());
    let status: ClaudeStatus = { status: 'idle' };
    const sent: NotificationPayload[] = [];
    const notifier = new ClaudeStatusNotifier(
      () => [{ id: 's1', name: 'claude (~/app)', pid: 7, status: 'running' }],
      (payload) => sent.push(payload),
      async () => new Map([[7, status]])
    );
    notifier.setPayloadRewriter((payload) => scheduler.rewriteFinished(payload));
    await notifier.tick();
    status = { status: 'busy' };
    await notifier.tick();
    status = { status: 'idle', preview: { role: 'assistant', text: 'Fixed 2 tests' } };
    await notifier.tick();
    expect(sent.map((p) => p.type)).toEqual(['task-finished']);
    expect(sent[0].body).toBe('Fixed 2 tests');
  });
});
