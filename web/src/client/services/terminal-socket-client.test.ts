/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeWsV3Frame, decodeWsV3ResizePayload, WsV3MessageType } from '../../shared/ws-v3.js';
import { OFFLINE_INPUT_MAX_BYTES, TerminalSocketClient } from './terminal-socket-client.js';

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = '';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  sent: Uint8Array[] = [];
  send(data: ArrayBuffer) {
    this.sent.push(new Uint8Array(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

let visibility: DocumentVisibilityState = 'visible';

describe('TerminalSocketClient reconnect after the page was hidden', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ noAuth: true })))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reconnects as soon as the page is visible instead of waiting out the backoff', async () => {
    const client = new TerminalSocketClient();
    await client.initialize();
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeSocket.instances).toHaveLength(1);

    // The phone sleeps: every reconnect attempt fails, backoff grows to 30 s.
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    for (let i = 0; i < 6; i++) {
      FakeSocket.instances[FakeSocket.instances.length - 1].close();
      await vi.advanceTimersByTimeAsync(2 ** i * 1000);
    }
    FakeSocket.instances[FakeSocket.instances.length - 1].close();
    const attempts = FakeSocket.instances.length;

    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(FakeSocket.instances).toHaveLength(attempts + 1);
  });

  it('leaves a live socket alone when the page becomes visible', async () => {
    const client = new TerminalSocketClient();
    await client.initialize();
    await vi.advanceTimersByTimeAsync(100);
    const socket = FakeSocket.instances[0];
    socket.readyState = FakeSocket.OPEN;
    socket.onopen?.();

    document.dispatchEvent(new Event('visibilitychange'));
    expect(FakeSocket.instances).toHaveLength(1);
  });

  async function openClient() {
    const client = new TerminalSocketClient();
    await client.initialize();
    await vi.advanceTimersByTimeAsync(100);
    const socket = FakeSocket.instances[0];
    socket.readyState = FakeSocket.OPEN;
    socket.onopen?.();
    return { client, socket };
  }

  it('replaces a socket that stays OPEN but stops answering pings', async () => {
    const { client } = await openClient();

    // Wi-Fi to cellular: the old TCP connection is gone, no close event ever comes.
    await vi.advanceTimersByTimeAsync(70_000);

    expect(FakeSocket.instances).toHaveLength(2);
    expect(client.getConnectionStatus()).toBe(false);
  });

  it('keeps a socket that answers its pings', async () => {
    const { socket } = await openClient();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
      socket.onmessage?.({ data: new ArrayBuffer(0) });
    }
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('probes an OPEN socket when the page comes back and replaces it if silent', async () => {
    await openClient();
    await vi.advanceTimersByTimeAsync(10_000);

    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('keeps the socket when the foreground probe is answered', async () => {
    const { socket } = await openClient();
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(500);
    socket.onmessage?.({ data: new ArrayBuffer(0) });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  function framesSent(socket: FakeSocket, type: WsV3MessageType) {
    return socket.sent
      .map((raw) => decodeWsV3Frame(raw))
      .filter((frame) => frame?.type === type)
      .map((frame) => frame?.sessionId);
  }

  it('subscribes each session once after a reconnect, with no stale subscription frames', async () => {
    const { client, socket } = await openClient();
    const stopA = client.subscribe('a', { stdout: true });
    client.subscribe('b', { stdout: true });

    // Offline: the view for "a" closes, a new one for "c" opens, "b" also wants events.
    socket.close();
    stopA();
    client.subscribe('c', { stdout: true });
    client.subscribe('b', { events: true });

    await vi.advanceTimersByTimeAsync(1000);
    const next = FakeSocket.instances[FakeSocket.instances.length - 1];
    expect(next).not.toBe(socket);
    next.readyState = FakeSocket.OPEN;
    next.onopen?.();

    // One SUBSCRIBE (= one history replay) per live session, nothing for "a".
    expect(framesSent(next, WsV3MessageType.SUBSCRIBE).sort()).toEqual(['b', 'c']);
    expect(framesSent(next, WsV3MessageType.UNSUBSCRIBE)).toEqual([]);
  });

  function sentFrames(socket: FakeSocket) {
    return socket.sent.map((raw) => {
      const frame = decodeWsV3Frame(raw);
      if (!frame) throw new Error('undecodable frame');
      return frame;
    });
  }

  async function reopen() {
    await vi.advanceTimersByTimeAsync(1000);
    const next = FakeSocket.instances[FakeSocket.instances.length - 1];
    next.readyState = FakeSocket.OPEN;
    next.onopen?.();
    return next;
  }

  it('drops stale input queued while offline but keeps recent typing and the last size', async () => {
    const { client, socket } = await openClient();
    socket.close();

    client.sendInputText('s1', 'rm -rf build');
    client.sendInputKey('s1', 'enter');
    client.resize('s1', 80, 24);
    client.resize('s2', 100, 30);
    // Away for an hour: every reconnect attempt fails.
    for (let minute = 0; minute < 60; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      FakeSocket.instances[FakeSocket.instances.length - 1].close();
    }
    client.resize('s1', 40, 20);
    client.sendInputText('s1', 'ls');

    const next = await reopen();
    const frames = sentFrames(next).filter((f) => f.type !== WsV3MessageType.PING);
    const decoder = new TextDecoder();
    expect(
      frames.map((f) => [WsV3MessageType[f.type], f.sessionId, decoder.decode(f.payload)])
    ).toEqual([
      ['RESIZE', 's2', expect.any(String)],
      ['RESIZE', 's1', expect.any(String)],
      ['INPUT_TEXT', 's1', 'ls'],
    ]);
    // The size applied is the latest one, not the hour-old 80x24.
    expect(decodeWsV3ResizePayload(frames[1].payload)).toEqual({ cols: 40, rows: 20 });
    expect(decodeWsV3ResizePayload(frames[0].payload)).toEqual({ cols: 100, rows: 30 });
  });

  it('caps input queued while offline to the most recent 64 KB', async () => {
    const { client, socket } = await openClient();
    socket.close();
    const chunk = 'x'.repeat(1024);
    for (let i = 0; i < 100; i++) client.sendInputText('s1', `${i}:${chunk}`);

    const next = await reopen();
    const inputs = sentFrames(next)
      .filter((f) => f.type === WsV3MessageType.INPUT_TEXT)
      .map((f) => Number(new TextDecoder().decode(f.payload).split(':')[0]));
    const bytes = inputs.length * (chunk.length + 3);
    expect(bytes).toBeLessThanOrEqual(OFFLINE_INPUT_MAX_BYTES);
    expect(inputs.length).toBeGreaterThan(50);
    // The newest input, contiguous and in order.
    expect(inputs).toEqual(
      Array.from({ length: inputs.length }, (_, i) => 100 - inputs.length + i)
    );
  });
});
