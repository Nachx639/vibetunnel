/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeWsV3Frame, VIEWING_REFRESH_MS, WsV3MessageType } from '../../shared/ws-v3.js';
import { TerminalSocketClient, VIEWING_IDLE_MS } from './terminal-socket-client.js';

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
let focused = true;

function viewingFrames(socket: FakeSocket) {
  return socket.sent
    .map((raw) => decodeWsV3Frame(raw))
    .filter((frame) => frame?.type === WsV3MessageType.VIEWING)
    .map((frame) => frame?.sessionId);
}

describe('TerminalSocketClient viewing reports', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    visibility = 'visible';
    focused = true;
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
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

  async function openClient() {
    const client = new TerminalSocketClient();
    await client.initialize();
    await vi.advanceTimersByTimeAsync(100);
    const socket = FakeSocket.instances[0];
    socket.readyState = FakeSocket.OPEN;
    socket.onopen?.();
    return { client, socket };
  }

  it('reports the viewed session while the page is visible, and again after a reconnect', async () => {
    const { client, socket } = await openClient();

    client.setViewingSession('s1');
    expect(viewingFrames(socket)).toEqual(['s1']);

    // Phone locked: hidden page means nobody is looking.
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(viewingFrames(socket)).toEqual(['s1', '']);

    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(viewingFrames(socket)).toEqual(['s1', '', 's1']);

    // Safari closed / tab discarded.
    window.dispatchEvent(new Event('pagehide'));
    expect(viewingFrames(socket)).toEqual(['s1', '', 's1', '']);
    window.dispatchEvent(new Event('pageshow'));
    expect(viewingFrames(socket)).toEqual(['s1', '', 's1', '', 's1']);

    // A new socket knows nothing: the viewed session is sent again on open.
    socket.close();
    await vi.advanceTimersByTimeAsync(1000);
    const next = FakeSocket.instances[FakeSocket.instances.length - 1];
    expect(next).not.toBe(socket);
    next.readyState = FakeSocket.OPEN;
    next.onopen?.();
    expect(viewingFrames(next)).toEqual(['s1']);

    // Leaving the session view (an older view clearing late does not undo a newer one).
    client.clearViewingSession('other');
    client.clearViewingSession('s1');
    expect(viewingFrames(next)).toEqual(['s1', '']);
  });

  it('does not queue viewing reports while offline', async () => {
    const client = new TerminalSocketClient();
    await client.initialize();
    await vi.advanceTimersByTimeAsync(100);
    client.setViewingSession('s1');
    client.setViewingSession('s2');
    const socket = FakeSocket.instances[0];
    socket.readyState = FakeSocket.OPEN;
    socket.onopen?.();
    expect(viewingFrames(socket)).toEqual(['s2']);
  });

  it('repeats the viewed session every 20 s while someone keeps using the page', async () => {
    const { client, socket } = await openClient();
    client.setViewingSession('s1');
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(VIEWING_REFRESH_MS / 2);
      window.dispatchEvent(new Event('pointerdown'));
      await vi.advanceTimersByTimeAsync(VIEWING_REFRESH_MS / 2);
    }
    expect(viewingFrames(socket)).toEqual(['s1', 's1', 's1', 's1']);
    // Taps between refreshes add no frames of their own.
    window.dispatchEvent(new Event('keydown'));
    expect(viewingFrames(socket)).toHaveLength(4);

    // Leaving the session stops the repeats.
    client.setViewingSession(null);
    await vi.advanceTimersByTimeAsync(3 * VIEWING_REFRESH_MS);
    expect(viewingFrames(socket)).toEqual(['s1', 's1', 's1', 's1', '']);
  });

  it('says nothing is viewed once the page sits untouched, and again on the next tap', async () => {
    const { client, socket } = await openClient();
    client.setViewingSession('s1');
    await vi.advanceTimersByTimeAsync(VIEWING_IDLE_MS + VIEWING_REFRESH_MS);
    const frames = viewingFrames(socket);
    expect(frames.at(-1)).toBe('');
    expect(frames.filter((frame) => frame === '')).toHaveLength(1);

    // Still untouched: '' was said once, the repeats stay quiet.
    await vi.advanceTimersByTimeAsync(5 * VIEWING_REFRESH_MS);
    expect(viewingFrames(socket)).toEqual(frames);

    window.dispatchEvent(new Event('wheel'));
    expect(viewingFrames(socket)).toEqual([...frames, 's1']);
  });

  it('says nothing is viewed when the window loses focus or the page is frozen', async () => {
    const { client, socket } = await openClient();
    client.setViewingSession('s1');

    focused = false;
    window.dispatchEvent(new Event('blur'));
    expect(viewingFrames(socket)).toEqual(['s1', '']);
    await vi.advanceTimersByTimeAsync(3 * VIEWING_REFRESH_MS);
    expect(viewingFrames(socket)).toEqual(['s1', '']);
    focused = true;
    window.dispatchEvent(new Event('focus'));
    expect(viewingFrames(socket)).toEqual(['s1', '', 's1']);

    document.dispatchEvent(new Event('freeze'));
    expect(viewingFrames(socket)).toEqual(['s1', '', 's1', '']);
    document.dispatchEvent(new Event('resume'));
    expect(viewingFrames(socket)).toEqual(['s1', '', 's1', '', 's1']);
  });
});
