import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type InitialInputDeps, typeWhenClaudeReady } from './claude-initial-input';

describe('typeWhenClaudeReady', () => {
  let status: string | undefined;
  let dialog: boolean;
  let running: boolean;
  let sent: Array<{ text: string } | { key: 'enter' }>;
  let deps: InitialInputDeps;

  beforeEach(() => {
    vi.useFakeTimers();
    status = undefined;
    dialog = false;
    running = true;
    sent = [];
    deps = {
      claudeStatus: async () => status,
      dialogOnScreen: async () => dialog,
      isRunning: () => running,
      send: (input) => sent.push(input),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for Claude to be idle before typing the text and Enter', async () => {
    const done = typeWhenClaudeReady('hello', deps);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual([]);

    status = 'idle';
    await vi.advanceTimersByTimeAsync(2000);
    await expect(done).resolves.toBe(true);
    expect(sent).toEqual([{ text: 'hello' }, { key: 'enter' }]);
  });

  it('waits while a startup dialog is on screen', async () => {
    status = 'idle';
    dialog = true;
    const done = typeWhenClaudeReady('hello', deps);
    await vi.advanceTimersByTimeAsync(3000);
    expect(sent).toEqual([]);

    dialog = false;
    await vi.advanceTimersByTimeAsync(2000);
    await expect(done).resolves.toBe(true);
    expect(sent).toEqual([{ text: 'hello' }, { key: 'enter' }]);
  });

  it('never types blind when Claude never becomes ready (a late dialog would take the Enter)', async () => {
    const onGiveUp = vi.fn();
    const done = typeWhenClaudeReady('hello', { ...deps, onGiveUp }, { timeoutMs: 30000 });
    await vi.advanceTimersByTimeAsync(31000);
    await expect(done).resolves.toBe(false);
    expect(sent).toEqual([]);
    expect(onGiveUp).toHaveBeenCalledWith('Claude never became ready');
  });

  it('keeps waiting while a dialog shows, then types once the user answers it', async () => {
    dialog = true;
    const done = typeWhenClaudeReady('hello', deps, { timeoutMs: 30000 });
    await vi.advanceTimersByTimeAsync(120_000); // the user takes two minutes
    expect(sent).toEqual([]);
    dialog = false;
    status = 'idle';
    await vi.advanceTimersByTimeAsync(2000);
    await expect(done).resolves.toBe(true);
    expect(sent).toEqual([{ text: 'hello' }, { key: 'enter' }]);
  });

  it('treats an unreadable screen as a dialog', async () => {
    status = 'idle';
    const done = typeWhenClaudeReady(
      'hello',
      { ...deps, dialogOnScreen: async () => Promise.reject(new Error('no screen')) },
      { timeoutMs: 3000 }
    );
    await vi.advanceTimersByTimeAsync(4000);
    await expect(done).resolves.toBe(false);
    expect(sent).toEqual([]);
  });

  it('does not press Enter into a dialog that is still open at the longest wait', async () => {
    dialog = true;
    const onGiveUp = vi.fn();
    const done = typeWhenClaudeReady(
      'hello',
      { ...deps, onGiveUp },
      { timeoutMs: 30000, maxWaitMs: 120_000 }
    );
    await vi.advanceTimersByTimeAsync(121_000);
    await expect(done).resolves.toBe(false);
    expect(sent).toEqual([]);
    expect(onGiveUp).toHaveBeenCalled();
  });

  it('gives up when the session exits', async () => {
    const done = typeWhenClaudeReady('hello', deps, { timeoutMs: 30000 });
    running = false;
    await vi.advanceTimersByTimeAsync(31000);
    await expect(done).resolves.toBe(false);
    expect(sent).toEqual([]);
  });

  it('sends multi-line text as a bracketed paste', async () => {
    status = 'idle';
    const done = typeWhenClaudeReady('one\ntwo', deps);
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(sent).toEqual([{ text: '\x1b[200~one\ntwo\x1b[201~' }, { key: 'enter' }]);
  });
});
