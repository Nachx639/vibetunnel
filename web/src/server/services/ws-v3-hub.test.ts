import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { ServerEvent } from '../../shared/types.js';
import { ServerEventType } from '../../shared/types.js';
import {
  decodeWsV3Frame,
  encodeWsV3Frame,
  encodeWsV3ResizePayload,
  encodeWsV3SubscribePayload,
  WsV3MessageType,
  WsV3SubscribeFlags,
} from '../../shared/ws-v3.js';
import type { PtyManager } from '../pty/index.js';
import type { SessionManager } from '../pty/session-manager.js';
import { CastOutputHub, type CastOutputHubListener } from './cast-output-hub.js';
import type { GitStatusHub, GitStatusHubListener } from './git-status-hub.js';
import type { SessionMonitor } from './session-monitor.js';
import type { TerminalManager } from './terminal-manager.js';
import {
  CLIENT_HEARTBEAT_INTERVAL_MS,
  MAX_CLIENT_BUFFERED_BYTES,
  type WebSocketRequestV3,
  WsV3Hub,
} from './ws-v3-hub.js';

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    log: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

class FakeWebSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent: Uint8Array[] = [];
  bufferedAmount = 0;
  send = vi.fn((data: Uint8Array) => {
    this.sent.push(new Uint8Array(data));
  });
  close = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  });
  terminate = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  });
  ping = vi.fn();
}

function decodeLastFrame(ws: FakeWebSocket) {
  const raw = ws.sent.at(-1);
  if (!raw) throw new Error('no ws sends');
  const frame = decodeWsV3Frame(raw);
  if (!frame) throw new Error('failed to decode ws v3 frame');
  return frame;
}

function sendBinaryFrame(ws: FakeWebSocket, frame: Uint8Array) {
  ws.emit('message', Buffer.from(frame), true);
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

describe('WsV3Hub', () => {
  type BufferChangeListener = Parameters<TerminalManager['subscribeToBufferChanges']>[1];

  let ptyManager: PtyManager;
  let terminalManager: TerminalManager;
  let castOutputHub: CastOutputHub;
  let gitStatusHub: GitStatusHub;
  let sessionMonitor: EventEmitter;
  let hub: WsV3Hub;

  let castListener: CastOutputHubListener | undefined;
  let castUnsubscribe: Mock<() => void> | undefined;
  let snapshotListener: BufferChangeListener | undefined;
  let gitListener: GitStatusHubListener | undefined;

  beforeEach(() => {
    castListener = undefined;
    snapshotListener = undefined;
    gitListener = undefined;

    type PtySessionStub = { gitRepoPath?: string; workingDir?: string } | null;
    const getSession = vi.fn<(sessionId: string) => PtySessionStub>(() => null);

    ptyManager = {
      getSession,
      sendInput: vi.fn<PtyManager['sendInput']>(),
      resizeSession: vi.fn<PtyManager['resizeSession']>(),
      killSession: vi.fn<PtyManager['killSession']>(async () => {}),
      resetSessionSize: vi.fn<PtyManager['resetSessionSize']>(),
    } as unknown as PtyManager;

    type SubscribeToBufferChangesFn = (
      sessionId: string,
      listener: BufferChangeListener
    ) => Promise<() => void>;

    terminalManager = {
      subscribeToBufferChanges: vi.fn<SubscribeToBufferChangesFn>(async (_sessionId, cb) => {
        snapshotListener = cb;
        return vi.fn();
      }),
      encodeSnapshot: vi.fn(() => Buffer.from([9, 9, 9])),
    } as unknown as TerminalManager;

    type CastSubscribeFn = (sessionId: string, listener: CastOutputHubListener) => () => void;
    castOutputHub = {
      subscribe: vi.fn<CastSubscribeFn>((_sessionId, listener) => {
        castListener = listener;
        castUnsubscribe = vi.fn<() => void>();
        return castUnsubscribe;
      }),
    } as unknown as CastOutputHub;

    type GitStartWatchingFn = GitStatusHub['startWatching'];
    type GitAddClientFn = GitStatusHub['addClient'];
    type GitRemoveClientFn = GitStatusHub['removeClient'];
    gitStatusHub = {
      startWatching: vi.fn<GitStartWatchingFn>(),
      addClient: vi.fn<GitAddClientFn>((_sessionId, listener) => {
        gitListener = listener;
      }),
      removeClient: vi.fn<GitRemoveClientFn>(),
    } as unknown as GitStatusHub;

    sessionMonitor = new EventEmitter();

    hub = new WsV3Hub({
      ptyManager,
      terminalManager,
      castOutputHub,
      gitStatusHub,
      sessionMonitor: sessionMonitor as unknown as SessionMonitor,
      remoteRegistry: null,
      isHQMode: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends WELCOME on connect', () => {
    const ws = new FakeWebSocket();
    hub.handleClientConnection(
      ws as unknown as WebSocket,
      { userId: 'u', authMethod: 'token' } as unknown as WebSocketRequestV3
    );
    const first = ws.sent[0];
    if (!first) throw new Error('expected welcome frame');
    const frame = decodeWsV3Frame(first);
    expect(frame?.type).toBe(WsV3MessageType.WELCOME);
  });

  it('acks global events subscription + broadcasts sessionMonitor events', async () => {
    const ws = new FakeWebSocket();
    hub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);

    sendBinaryFrame(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.SUBSCRIBE,
        sessionId: '',
        payload: encodeWsV3SubscribePayload({ flags: WsV3SubscribeFlags.Events }),
      })
    );
    await flush();

    const ack = decodeLastFrame(ws);
    expect(ack.type).toBe(WsV3MessageType.EVENT);
    expect(ack.sessionId).toBe('');
    expect(JSON.parse(new TextDecoder().decode(ack.payload))).toMatchObject({ type: 'connected' });

    const evt: ServerEvent = {
      type: ServerEventType.SessionExit,
      sessionId: 's1',
      exitCode: 0,
      timestamp: new Date().toISOString(),
    };
    sessionMonitor.emit('notification', evt);
    await flush();

    const forwarded = decodeLastFrame(ws);
    expect(forwarded.type).toBe(WsV3MessageType.EVENT);
    expect(forwarded.sessionId).toBe('s1');
    expect(JSON.parse(new TextDecoder().decode(forwarded.payload))).toMatchObject({
      type: ServerEventType.SessionExit,
      exitCode: 0,
      sessionId: 's1',
    });
  });

  it('forwards stdout events when subscribed', async () => {
    const ws = new FakeWebSocket();
    hub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);

    sendBinaryFrame(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.SUBSCRIBE,
        sessionId: 's1',
        payload: encodeWsV3SubscribePayload({ flags: WsV3SubscribeFlags.Stdout }),
      })
    );
    await flush();

    expect(castOutputHub.subscribe).toHaveBeenCalledWith('s1', expect.any(Function));
    expect(castListener).toBeTypeOf('function');

    if (!castListener) throw new Error('expected cast listener');
    castListener({ kind: 'output', data: 'hello' });
    await flush();
    const stdout = decodeLastFrame(ws);
    expect(stdout.type).toBe(WsV3MessageType.STDOUT);
    expect(stdout.sessionId).toBe('s1');
    expect(new TextDecoder().decode(stdout.payload)).toBe('hello');

    castListener({ kind: 'exit', exitCode: 0 });
    await flush();
    const exitEvt = decodeLastFrame(ws);
    expect(exitEvt.type).toBe(WsV3MessageType.EVENT);
    expect(exitEvt.sessionId).toBe('s1');
    expect(JSON.parse(new TextDecoder().decode(exitEvt.payload))).toEqual({
      kind: 'exit',
      exitCode: 0,
    });

    castListener({ kind: 'error', message: 'boom' });
    await flush();
    const err = decodeLastFrame(ws);
    expect(err.type).toBe(WsV3MessageType.ERROR);
    expect(err.sessionId).toBe('s1');
    expect(JSON.parse(new TextDecoder().decode(err.payload))).toEqual({ message: 'boom' });
  });

  it('drops a client that stopped reading instead of buffering its output forever', async () => {
    const ws = new FakeWebSocket();
    hub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);
    sendBinaryFrame(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.SUBSCRIBE,
        sessionId: 's1',
        payload: encodeWsV3SubscribePayload({ flags: WsV3SubscribeFlags.Stdout }),
      })
    );
    await flush();
    if (!castListener) throw new Error('expected cast listener');

    // The phone's link stalls while `yes` runs: unsent bytes pile up in the socket.
    ws.bufferedAmount = MAX_CLIENT_BUFFERED_BYTES + 1;
    const sentBefore = ws.sent.length;
    castListener({ kind: 'output', data: 'y\n'.repeat(1000), historical: false });
    await flush();

    expect(ws.terminate).toHaveBeenCalled();
    expect(ws.sent.length).toBe(sentBefore);
    expect(castUnsubscribe).toHaveBeenCalled();
  });

  it('sends a history replay larger than the buffer limit without dropping the viewer', async () => {
    // The replay goes out in one synchronous loop, so nothing drains meanwhile.
    // A session with more than 16 MB since the last clear tripped the limit on every
    // (re)connect: the client was terminated, reconnected, got the same replay, forever.
    const ws = new FakeWebSocket();
    ws.send = vi.fn((data: Uint8Array) => {
      ws.sent.push(data);
      ws.bufferedAmount += data.length;
    });
    hub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);
    sendBinaryFrame(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.SUBSCRIBE,
        sessionId: 's1',
        payload: encodeWsV3SubscribePayload({ flags: WsV3SubscribeFlags.Stdout }),
      })
    );
    await flush();
    if (!castListener) throw new Error('expected cast listener');

    const chunk = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 24; i++) castListener({ kind: 'output', data: chunk, historical: true });
    // Live output right after the replay, while the history is still queued.
    castListener({ kind: 'output', data: 'live', historical: false });

    expect(ws.terminate).not.toHaveBeenCalled();
    expect(ws.sent.length).toBe(26); // WELCOME + 24 history frames + the live one

    // The history drains; a client that then stops reading live output is still dropped.
    ws.bufferedAmount = 0;
    castListener({ kind: 'output', data: 'y', historical: false });
    ws.bufferedAmount = MAX_CLIENT_BUFFERED_BYTES + 1;
    castListener({ kind: 'output', data: 'y', historical: false });
    expect(ws.terminate).toHaveBeenCalled();
  });

  it('drops a client that stalls on live output queued behind a large replay', async () => {
    const ws = new FakeWebSocket();
    ws.send = vi.fn((data: Uint8Array) => {
      ws.sent.push(data);
      ws.bufferedAmount += data.length;
    });
    hub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);
    sendBinaryFrame(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.SUBSCRIBE,
        sessionId: 's1',
        payload: encodeWsV3SubscribePayload({ flags: WsV3SubscribeFlags.Stdout }),
      })
    );
    await flush();
    if (!castListener) throw new Error('expected cast listener');

    const chunk = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 24; i++) castListener({ kind: 'output', data: chunk, historical: true });
    // Nothing drains: the replay allowance does not cover more than the limit of live bytes.
    for (let i = 0; i < 17 && !ws.terminate.mock.calls.length; i++) {
      castListener({ kind: 'output', data: chunk, historical: false });
    }
    expect(ws.terminate).toHaveBeenCalled();
  });

  it('unsubscribes a client that vanished without closing, but keeps one that answers', async () => {
    vi.useFakeTimers();
    try {
      const gone = new FakeWebSocket();
      const answersPings = new FakeWebSocket();
      answersPings.ping = vi.fn(() => answersPings.emit('pong'));
      const pingsItself = new FakeWebSocket();
      for (const ws of [gone, answersPings, pingsItself]) {
        hub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);
      }
      sendBinaryFrame(
        gone,
        encodeWsV3Frame({
          type: WsV3MessageType.SUBSCRIBE,
          sessionId: 's1',
          payload: encodeWsV3SubscribePayload({ flags: WsV3SubscribeFlags.Stdout }),
        })
      );
      await vi.advanceTimersByTimeAsync(0);
      const goneUnsubscribe = castUnsubscribe;

      // The phone leaves Wi-Fi: no FIN, no frames, no pongs. The client's own 20 s PING
      // frames keep the other socket alive even without protocol pongs.
      for (let t = 0; t < 60_000; t += 20_000) {
        await vi.advanceTimersByTimeAsync(20_000);
        sendBinaryFrame(
          pingsItself,
          encodeWsV3Frame({ type: WsV3MessageType.PING, payload: new Uint8Array() })
        );
      }

      expect(gone.terminate).toHaveBeenCalled();
      expect(goneUnsubscribe).toHaveBeenCalled();
      expect(answersPings.terminate).not.toHaveBeenCalled();
      expect(pingsItself.terminate).not.toHaveBeenCalled();
      expect(2 * CLIENT_HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(60_000);
    } finally {
      hub.dispose();
      vi.useRealTimers();
    }
  });

  it('forwards VT snapshots when subscribed', async () => {
    const ws = new FakeWebSocket();
    hub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);

    sendBinaryFrame(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.SUBSCRIBE,
        sessionId: 's1',
        payload: encodeWsV3SubscribePayload({ flags: WsV3SubscribeFlags.Snapshots }),
      })
    );
    await flush();

    expect(terminalManager.subscribeToBufferChanges).toHaveBeenCalledWith(
      's1',
      expect.any(Function)
    );
    expect(snapshotListener).toBeTypeOf('function');

    if (!snapshotListener) throw new Error('expected snapshot listener');
    snapshotListener('s1', {
      cols: 80,
      rows: 24,
      viewportY: 0,
      cursorX: 0,
      cursorY: 0,
      cells: [],
    });
    await flush();

    const snap = decodeLastFrame(ws);
    expect(snap.type).toBe(WsV3MessageType.SNAPSHOT_VT);
    expect(snap.sessionId).toBe('s1');
    expect(Array.from(snap.payload)).toEqual([9, 9, 9]);
  });

  it('routes input/resize/kill to PtyManager for local sessions', async () => {
    const ws = new FakeWebSocket();
    hub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);

    sendBinaryFrame(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.INPUT_TEXT,
        sessionId: 's1',
        payload: new TextEncoder().encode('ls'),
      })
    );
    sendBinaryFrame(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.RESIZE,
        sessionId: 's1',
        payload: encodeWsV3ResizePayload(80, 24),
      })
    );
    sendBinaryFrame(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.KILL,
        sessionId: 's1',
        payload: new TextEncoder().encode('SIGKILL'),
      })
    );
    await flush();

    expect(ptyManager.sendInput).toHaveBeenCalledWith('s1', { text: 'ls' });
    expect(ptyManager.resizeSession).toHaveBeenCalledWith('s1', 80, 24);
    expect(ptyManager.killSession).toHaveBeenCalledWith('s1', 'SIGKILL');
  });

  it('sends ERROR for invalid SUBSCRIBE payload', async () => {
    const ws = new FakeWebSocket();
    hub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);

    sendBinaryFrame(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.SUBSCRIBE,
        sessionId: 's1',
        payload: new Uint8Array([1, 2, 3]),
      })
    );
    await flush();

    const err = decodeLastFrame(ws);
    expect(err.type).toBe(WsV3MessageType.ERROR);
    expect(err.sessionId).toBe('s1');
    expect(JSON.parse(new TextDecoder().decode(err.payload)).message).toContain(
      'Invalid SUBSCRIBE payload'
    );
  });

  it('unsubscribes old listeners on re-subscribe', async () => {
    const ws = new FakeWebSocket();
    hub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);

    sendBinaryFrame(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.SUBSCRIBE,
        sessionId: 's1',
        payload: encodeWsV3SubscribePayload({ flags: WsV3SubscribeFlags.Stdout }),
      })
    );
    await flush();

    const unsubscribeStdout = castOutputHub.subscribe.mock.results[0]?.value;
    expect(typeof unsubscribeStdout).toBe('function');

    sendBinaryFrame(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.SUBSCRIBE,
        sessionId: 's1',
        payload: encodeWsV3SubscribePayload({ flags: WsV3SubscribeFlags.Snapshots }),
      })
    );
    await flush();

    expect(unsubscribeStdout).toHaveBeenCalled();
  });

  it('keeps the stdout stream, without a second replay, when only the other flags change', async () => {
    const ws = new FakeWebSocket();
    hub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);
    const subscribe = (flags: number) =>
      sendBinaryFrame(
        ws,
        encodeWsV3Frame({
          type: WsV3MessageType.SUBSCRIBE,
          sessionId: 's1',
          payload: encodeWsV3SubscribePayload({ flags }),
        })
      );

    subscribe(WsV3SubscribeFlags.Stdout | WsV3SubscribeFlags.Events);
    await flush();
    // Another view of the session (a preview's snapshots) joins: this used to replay the
    // whole history (up to 16 MB) again to the terminal that already showed it.
    subscribe(WsV3SubscribeFlags.Stdout | WsV3SubscribeFlags.Events | WsV3SubscribeFlags.Snapshots);
    await flush();

    expect(castOutputHub.subscribe).toHaveBeenCalledOnce();
    expect(castUnsubscribe).not.toHaveBeenCalled();
    expect(terminalManager.subscribeToBufferChanges).toHaveBeenCalledOnce();

    // The stream still follows the flags: the end of the replay is an event.
    castListener?.({ kind: 'replay-end' });
    const frame = decodeLastFrame(ws);
    expect(frame.type).toBe(WsV3MessageType.EVENT);
    expect(JSON.parse(new TextDecoder().decode(frame.payload))).toEqual({ kind: 'replay-end' });

    // Without stdout it is a new subscription again.
    subscribe(WsV3SubscribeFlags.Snapshots);
    await flush();
    expect(castUnsubscribe).toHaveBeenCalledOnce();
  });

  it('streams git-status updates as EVENT frames when enabled', async () => {
    ptyManager.getSession.mockReturnValue({
      gitRepoPath: '/repo',
      workingDir: '/repo',
    });

    const ws = new FakeWebSocket();
    hub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);

    sendBinaryFrame(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.SUBSCRIBE,
        sessionId: 's1',
        payload: encodeWsV3SubscribePayload({ flags: WsV3SubscribeFlags.Events }),
      })
    );
    await flush();

    expect(gitStatusHub.startWatching).toHaveBeenCalledWith('s1', '/repo', '/repo');
    expect(gitListener).toBeTypeOf('function');

    if (!gitListener) throw new Error('expected git listener');
    gitListener({ kind: 'git-status-update', gitBranch: 'main' });
    await flush();
    const evt = decodeLastFrame(ws);
    expect(evt.type).toBe(WsV3MessageType.EVENT);
    expect(evt.sessionId).toBe('s1');
    expect(JSON.parse(new TextDecoder().decode(evt.payload))).toMatchObject({
      kind: 'git-status-update',
      gitBranch: 'main',
    });
  });
});

describe('WsV3Hub history replay through a real CastOutputHub', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it('opens a session whose cast holds more than the buffer limit since the last clear', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-v3-replay-'));
    const stdoutPath = path.join(tmpDir, 'stdout');
    const line = JSON.stringify([0.1, 'o', `${'y'.repeat(64 * 1024 - 1)}\n`]);
    const lines = [JSON.stringify({ version: 2, width: 80, height: 24 })];
    const count = Math.ceil((MAX_CLIENT_BUFFERED_BYTES * 1.25) / line.length);
    for (let i = 0; i < count; i++) lines.push(line);
    fs.writeFileSync(stdoutPath, `${lines.join('\n')}\n`);

    const sessionManager = {
      getSessionPaths: () => ({ stdoutPath }),
      loadSessionInfo: () => ({}),
      saveSessionInfo: vi.fn(),
    } as unknown as SessionManager;
    const realHub = new WsV3Hub({
      ptyManager: { getSession: () => null } as unknown as PtyManager,
      terminalManager: {} as unknown as TerminalManager,
      // Replays are capped (CAST_REPLAY_MAX_BYTES); this one may send all of its history.
      castOutputHub: new CastOutputHub(sessionManager, { replayMaxBytes: 2 * count * line.length }),
      gitStatusHub: {} as unknown as GitStatusHub,
      sessionMonitor: null,
      remoteRegistry: null,
      isHQMode: false,
    });

    // A link slower than the replay loop: nothing drains while the history is sent.
    const ws = new FakeWebSocket();
    let stdoutBytes = 0;
    ws.send = vi.fn((data: Uint8Array) => {
      ws.bufferedAmount += data.length;
      const frame = decodeWsV3Frame(data);
      if (frame?.type === WsV3MessageType.STDOUT) stdoutBytes += frame.payload.length;
    });
    realHub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);
    sendBinaryFrame(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.SUBSCRIBE,
        sessionId: 's1',
        payload: encodeWsV3SubscribePayload({ flags: WsV3SubscribeFlags.Stdout }),
      })
    );

    await vi.waitFor(
      () => {
        if (!ws.terminate.mock.calls.length) expect(stdoutBytes).toBe(count * 64 * 1024);
      },
      { timeout: 10_000 }
    );
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(stdoutBytes).toBeGreaterThan(MAX_CLIENT_BUFFERED_BYTES);
    realHub.dispose();
  });

  it('marks where the history replay ends, before live output', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-v3-replay-end-'));
    const stdoutPath = path.join(tmpDir, 'stdout');
    const lines = [
      JSON.stringify({ version: 2, width: 80, height: 24 }),
      JSON.stringify([0.1, 'o', 'one\r\n']),
      JSON.stringify([0.2, 'o', 'two\r\n']),
    ];
    fs.writeFileSync(stdoutPath, `${lines.join('\n')}\n`);
    const sessionManager = {
      getSessionPaths: () => ({ stdoutPath }),
      loadSessionInfo: () => ({}),
      saveSessionInfo: vi.fn(),
    } as unknown as SessionManager;
    const realHub = new WsV3Hub({
      ptyManager: { getSession: () => null } as unknown as PtyManager,
      terminalManager: {} as unknown as TerminalManager,
      castOutputHub: new CastOutputHub(sessionManager),
      gitStatusHub: {} as unknown as GitStatusHub,
      sessionMonitor: null,
      remoteRegistry: null,
      isHQMode: false,
    });
    const ws = new FakeWebSocket();
    realHub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);
    sendBinaryFrame(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.SUBSCRIBE,
        sessionId: 's1',
        payload: encodeWsV3SubscribePayload({
          flags: WsV3SubscribeFlags.Stdout | WsV3SubscribeFlags.Events,
        }),
      })
    );

    const decoder = new TextDecoder();
    const stream = () =>
      ws.sent
        .map((raw) => decodeWsV3Frame(raw))
        .filter((frame) => frame && frame.type !== WsV3MessageType.WELCOME)
        .map((frame) => {
          const text = decoder.decode(frame?.payload);
          return frame?.type === WsV3MessageType.EVENT ? JSON.parse(text).kind : text;
        });
    await vi.waitFor(() => expect(stream()).toContain('replay-end'), { timeout: 5_000 });
    expect(stream()).toEqual(['header', 'one\r\ntwo\r\n', 'replay-end']);
    // The header tells the client that this server marks the end of the replay.
    const header = ws.sent
      .map((raw) => decodeWsV3Frame(raw))
      .find((frame) => frame?.type === WsV3MessageType.EVENT);
    expect(JSON.parse(decoder.decode(header?.payload))).toMatchObject({
      kind: 'header',
      replayEnd: true,
    });
    realHub.dispose();
  });
});
