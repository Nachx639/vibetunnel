import { describe, expect, it, vi } from 'vitest';
import type { ClaudeStatus } from './claude-chat.js';
import { ClaudeStatusNotifier, FORGET_AFTER_UNSEEN_TICKS } from './claude-status-notifier.js';

describe('ClaudeStatusNotifier', () => {
  it('notifies when Claude finishes or starts waiting, never on first sighting', async () => {
    let status: ClaudeStatus = { status: 'busy' };
    const notify = vi.fn();
    const notifier = new ClaudeStatusNotifier(
      () => [{ id: 's1', name: 'claude (~/p)', pid: 42, status: 'running' }],
      notify,
      async () => new Map([[42, status]])
    );

    await notifier.tick();
    expect(notify).not.toHaveBeenCalled();

    status = {
      status: 'idle',
      title: 'Fix login',
      preview: { role: 'assistant', text: 'Done: login fixed.' },
    };
    await notifier.tick();
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'claude-finished',
        title: '✅ Claude finished · Fix login',
        body: 'Done: login fixed.',
        tag: 'vibetunnel-claude-s1',
        data: expect.objectContaining({ sessionId: 's1' }),
      })
    );

    await notifier.tick();
    expect(notify).toHaveBeenCalledTimes(1);

    status = { status: 'waiting', waitingFor: 'permission to run Bash' };
    await notifier.tick();
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'claude-waiting',
        body: 'permission to run Bash',
        requireInteraction: true,
      })
    );

    // Waiting -> idle (the user answered and Claude was not working) is not news.
    status = { status: 'idle' };
    await notifier.tick();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("names the session by Claude's conversation title, over the session name", async () => {
    let status: ClaudeStatus = { status: 'busy' };
    const notify = vi.fn();
    const notifier = new ClaudeStatusNotifier(
      () => [{ id: 's1', name: 'claude (~/p)', pid: 42, status: 'running' }],
      notify,
      async () => new Map([[42, status]])
    );

    await notifier.tick();
    status = { status: 'idle', title: 'Fix login' };
    await notifier.tick();
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: '✅ Claude finished · Fix login',
        data: expect.objectContaining({ where: 'Fix login' }),
      })
    );
  });

  it('survives a failing status read instead of rejecting', async () => {
    const onError = vi.fn();
    const notifier = new ClaudeStatusNotifier(
      () => [{ id: 's1', name: 'x', pid: 42, status: 'running' }],
      vi.fn(),
      async () => {
        throw new Error('ps: fork failed');
      },
      onError
    );

    await expect(notifier.tick()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'ps: fork failed' }));
  });
});

describe('ClaudeStatusNotifier with background agents', () => {
  function notifierWith(read: () => ClaudeStatus) {
    const notify = vi.fn();
    const notifier = new ClaudeStatusNotifier(
      () => [{ id: 's1', name: 'x', pid: 42, status: 'running' }],
      notify,
      async () => new Map([[42, read()]])
    );
    return { notifier, notify };
  }
  const reply = { role: 'assistant' as const, text: 'Done; the agent keeps going.' };

  it('sends one "replied" when the turn ends while background agents run, then the usual "finished"', async () => {
    let status: ClaudeStatus = { status: 'busy', since: 1000, title: 'Agents' };
    const { notifier, notify } = notifierWith(() => status);
    await notifier.tick();

    status = {
      status: 'busy',
      since: 1000,
      title: 'Agents',
      waitingForBackground: true,
      preview: reply,
    };
    await notifier.tick();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'claude-replied',
        title: '💬 Claude replied · Agents',
        body: 'Done; the agent keeps going.',
        tag: 'vibetunnel-claude-s1',
        requireInteraction: false,
        data: expect.objectContaining({
          type: 'claude-replied',
          detail: 'Done; the agent keeps going.',
        }),
      })
    );

    // Still waiting for the agents: busy → busy is not news, and never a "finished".
    await notifier.tick();
    await notifier.tick();
    expect(notify).toHaveBeenCalledTimes(1);

    // A task notification starts a turn (no push), its reply ends again: one more "replied".
    status = { status: 'busy', since: 1000, title: 'Agents' };
    await notifier.tick();
    status = {
      status: 'busy',
      since: 1000,
      title: 'Agents',
      waitingForBackground: true,
      preview: reply,
    };
    await notifier.tick();
    expect(notify).toHaveBeenCalledTimes(2);

    // Everything ended: Claude goes idle, and that is still the usual "finished".
    status = { status: 'idle', since: 9000, title: 'Agents', preview: reply };
    await notifier.tick();
    expect(notify).toHaveBeenCalledTimes(3);
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'claude-finished' }));
  });

  it('sends no "replied" from idle or on first sighting', async () => {
    let status: ClaudeStatus = { status: 'busy', since: 1000, waitingForBackground: true };
    const { notifier, notify } = notifierWith(() => status);
    await notifier.tick();
    status = { status: 'idle', since: 2000 };
    await notifier.tick();
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'claude-finished' }));
    status = { status: 'busy', since: 3000, waitingForBackground: true };
    await notifier.tick();
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('ClaudeStatusNotifier across looks that miss Claude', () => {
  function notifierWith(read: () => Promise<Map<number, ClaudeStatus>>) {
    const notify = vi.fn();
    const notifier = new ClaudeStatusNotifier(
      () => [{ id: 's1', name: 'x', pid: 42, status: 'running' }],
      notify,
      read
    );
    return { notifier, notify };
  }

  it('still sends "finished" when one look between busy and idle did not see Claude', async () => {
    let status: ClaudeStatus | null = { status: 'busy', since: 1000 };
    const { notifier, notify } = notifierWith(async () => new Map(status ? [[42, status]] : []));
    await notifier.tick();
    // ps ran mid-fork, or the session file was read mid-write: Claude is not seen once.
    status = null;
    await notifier.tick();
    status = { status: 'idle', since: 2000 };
    await notifier.tick();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'claude-finished' }));
  });

  it('notices idle → busy → idle hidden by a short gap, by the new since', async () => {
    let status: ClaudeStatus | null = { status: 'idle', since: 1000 };
    const { notifier, notify } = notifierWith(async () => new Map(status ? [[42, status]] : []));
    await notifier.tick();
    status = null;
    await notifier.tick();
    await notifier.tick();
    status = { status: 'idle', since: 3000 };
    await notifier.tick();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'claude-finished' }));
  });

  it('stays silent when a new program takes over the session (new pid)', async () => {
    let pid = 42;
    let status: ClaudeStatus | null = { status: 'busy', since: 1000 };
    const notify = vi.fn();
    const notifier = new ClaudeStatusNotifier(
      () => [{ id: 's1', name: 'x', pid, status: 'running' }],
      notify,
      async () => new Map(status ? [[pid, status]] : [])
    );
    await notifier.tick();
    // Claude was relaunched in the session: a new Claude, idle.
    status = null;
    await notifier.tick();
    pid = 77;
    status = { status: 'idle', since: 5000 };
    await notifier.tick();
    expect(notify).not.toHaveBeenCalled();
    // From then on it is watched as usual.
    status = { status: 'busy', since: 6000 };
    await notifier.tick();
    status = { status: 'idle', since: 7000 };
    await notifier.tick();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'claude-finished' }));
  });

  it('forgets a session unseen for several looks: its next sighting is a first one again', async () => {
    let status: ClaudeStatus | null = { status: 'busy', since: 1000 };
    const { notifier, notify } = notifierWith(async () => new Map(status ? [[42, status]] : []));
    await notifier.tick();
    status = null;
    for (let i = 0; i < FORGET_AFTER_UNSEEN_TICKS; i++) await notifier.tick();
    status = { status: 'idle', since: 2000 };
    await notifier.tick();
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not count a failed read as a look that missed Claude', async () => {
    let status: ClaudeStatus | null = { status: 'busy', since: 1000 };
    const { notifier, notify } = notifierWith(async () => {
      if (!status) throw new Error('ps: fork failed');
      return new Map([[42, status]]);
    });
    await notifier.tick();
    status = null;
    for (let i = 0; i < FORGET_AFTER_UNSEEN_TICKS + 2; i++) await notifier.tick();
    status = { status: 'idle', since: 2000 };
    await notifier.tick();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'claude-finished' }));
  });
});

describe('ClaudeStatusNotifier log of what it drops', () => {
  it('logs a Claude lost and found again, once each, and never its text', async () => {
    let status: ClaudeStatus | null = { status: 'busy', since: 1000 };
    const log = vi.fn();
    const notifier = new ClaudeStatusNotifier(
      () => [{ id: 's1', name: 'x', pid: 42, status: 'running' }],
      vi.fn(),
      async () => new Map(status ? [[42, status]] : []),
      undefined,
      undefined,
      { log }
    );
    await notifier.tick();
    await notifier.tick();
    status = {
      status: 'idle',
      since: 2000,
      preview: { role: 'assistant', text: 'secret reply text' },
    };
    await notifier.tick();
    expect(log).not.toHaveBeenCalled();

    status = null;
    await notifier.tick();
    await notifier.tick();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenLastCalledWith(
      'Claude status: session s1 not seen (last idle, after 3 looks with it)'
    );
    status = { status: 'busy', since: 3000 };
    await notifier.tick();
    await notifier.tick();
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenLastCalledWith(
      'Claude status: session s1 seen again (busy) after 2 looks without it'
    );
    expect(log.mock.calls.flat().join('\n')).not.toContain('secret');
  });
});

describe('ClaudeStatusNotifier switch', () => {
  it('reads nothing while off, and starts from a first sighting when turned on', async () => {
    let on = false;
    let status: ClaudeStatus = { status: 'busy' };
    const notify = vi.fn();
    const read = vi.fn(async () => new Map([[42, status]]));
    const notifier = new ClaudeStatusNotifier(
      () => [{ id: 's1', name: 'x', pid: 42, status: 'running' }],
      notify,
      read,
      undefined,
      undefined,
      { enabled: () => on }
    );
    await notifier.tick();
    status = { status: 'idle' };
    await notifier.tick();
    expect(read).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();

    on = true;
    await notifier.tick(); // first sighting: idle, no push
    status = { status: 'busy' };
    await notifier.tick();
    status = { status: 'idle' };
    await notifier.tick();
    expect(notify).toHaveBeenCalledTimes(1);

    // Off again: what was seen is forgotten, so a status change meanwhile is no push.
    on = false;
    status = { status: 'busy' };
    await notifier.tick();
    on = true;
    status = { status: 'idle' };
    await notifier.tick();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('runs no read when no session is running', async () => {
    const read = vi.fn(async () => new Map());
    const notifier = new ClaudeStatusNotifier(() => [], vi.fn(), read);
    await notifier.tick();
    expect(read).not.toHaveBeenCalled();
  });
});
