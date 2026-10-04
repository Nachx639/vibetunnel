/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../shared/types.js';
import type { Terminal } from '../terminal.js';

type SubscribeOpts = {
  onStdout?: (data: Uint8Array) => void;
  onEvent?: (data: unknown) => void;
};

const subscriptions: SubscribeOpts[] = [];

vi.mock('../../services/terminal-socket-client.js', () => ({
  terminalSocketClient: {
    subscribe: vi.fn((_sessionId: string, opts: SubscribeOpts) => {
      subscriptions.push(opts);
      return () => {};
    }),
  },
}));

const { ConnectionManager } = await import('./connection-manager.js');

const encoder = new TextEncoder();

describe('ConnectionManager and the history replay', () => {
  let written: string[];
  let held: boolean;
  let terminal: { holdPaint: ReturnType<typeof vi.fn>; releasePaint: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    subscriptions.length = 0;
    written = [];
    held = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function connect() {
    const manager = new ConnectionManager(vi.fn(), vi.fn());
    terminal = {
      holdPaint: vi.fn(() => {
        held = true;
      }),
      releasePaint: vi.fn(() => {
        held = false;
      }),
    };
    manager.setTerminal({
      write: (data: string) => written.push(data),
      isPaintHeld: () => held,
      ...terminal,
    } as unknown as Terminal);
    manager.setSession({ id: 's1' } as Session);
    manager.setConnected(true);
    manager.connectToStream();
    // connectToStream() starts by closing any previous stream, which releases the paint.
    terminal.releasePaint.mockClear();
    return { manager, sub: subscriptions[0] };
  }

  it('holds the paint from a header that announces the end until the replay ends', async () => {
    const { sub } = connect();
    sub.onEvent?.({ kind: 'header', header: { width: 80, height: 24 }, replayEnd: true });
    expect(terminal.holdPaint).toHaveBeenCalledOnce();

    sub.onStdout?.(encoder.encode('history\r\n'));
    sub.onEvent?.({ kind: 'replay-end' });

    // Written before the paint is released, without waiting for the batch timer.
    expect(written.join('')).toBe('history\r\n');
    expect(terminal.releasePaint).toHaveBeenCalledOnce();
    expect(held).toBe(false);
  });

  it('never holds the paint for a server that does not mark the end of its replay', async () => {
    const { sub } = connect();
    sub.onEvent?.({ kind: 'header', header: { width: 80, height: 24 } });
    sub.onStdout?.(encoder.encode('hi'));
    await vi.advanceTimersByTimeAsync(20);

    expect(terminal.holdPaint).not.toHaveBeenCalled();
    expect(written.join('')).toBe('hi');
  });

  it('writes a held replay as it comes once 256 KB is queued', () => {
    const { sub } = connect();
    sub.onEvent?.({ kind: 'header', header: { width: 80, height: 24 }, replayEnd: true });

    sub.onStdout?.(encoder.encode('x'.repeat(100 * 1024)));
    expect(written).toHaveLength(0);
    sub.onStdout?.(encoder.encode('y'.repeat(200 * 1024)));
    expect(written.join('').length).toBe(300 * 1024);
  });

  it('keeps 16 ms batches for live output', async () => {
    const { sub } = connect();
    sub.onEvent?.({ kind: 'header', header: { width: 80, height: 24 }, replayEnd: true });
    sub.onEvent?.({ kind: 'replay-end' });

    sub.onStdout?.(encoder.encode('z'.repeat(300 * 1024)));
    expect(written).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(written.join('').length).toBe(300 * 1024);
  });

  it('releases the paint when the session exits or the stream is closed', () => {
    const first = connect();
    first.sub.onEvent?.({ kind: 'header', header: { width: 80, height: 24 }, replayEnd: true });
    first.sub.onEvent?.({ kind: 'exit', exitCode: 0 });
    expect(terminal.releasePaint).toHaveBeenCalled();

    subscriptions.length = 0;
    const second = connect();
    second.sub.onEvent?.({ kind: 'header', header: { width: 80, height: 24 }, replayEnd: true });
    expect(held).toBe(true);
    second.manager.cleanupStreamConnection();
    expect(held).toBe(false);
  });
});
