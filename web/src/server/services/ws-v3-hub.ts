import type { IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import type { ServerEvent, SpecialKey } from '../../shared/types.js';
import {
  decodeWsV3Frame,
  decodeWsV3ResizePayload,
  decodeWsV3SubscribePayload,
  encodeWsV3Frame,
  encodeWsV3ResizePayload,
  encodeWsV3SubscribePayload,
  WsV3MessageType,
  WsV3SubscribeFlags,
} from '../../shared/ws-v3.js';
import type { PtyManager } from '../pty/index.js';
import { createLogger } from '../utils/logger.js';
import type { CastOutputHub, CastOutputHubListener } from './cast-output-hub.js';
import type { GitStatusHub, GitStatusHubListener } from './git-status-hub.js';
import type { RemoteRegistry } from './remote-registry.js';
import type { SessionMonitor } from './session-monitor.js';
import type { TerminalManager } from './terminal-manager.js';

const logger = createLogger('ws-v3-hub');

/** Unsent bytes a client may fall behind by before it is disconnected. */
export const MAX_CLIENT_BUFFERED_BYTES = 16 * 1024 * 1024;
/** STDOUT a remote forwards this long after a client subscribes counts as its replay. */
export const REMOTE_REPLAY_WINDOW_MS = 10_000;
/**
 * How often the server checks that each client is still there. A client that sent nothing
 * (no frame, not even its own 20 s PING) and answered no protocol ping for two intervals
 * is terminated, so a phone that vanished is unsubscribed within ~50 s.
 */
export const CLIENT_HEARTBEAT_INTERVAL_MS = 25_000;
const utf8Decoder = new TextDecoder();
const utf8Encoder = new TextEncoder();

export interface WebSocketRequestV3 extends IncomingMessage {
  pathname?: string;
  searchParams?: URLSearchParams;
  userId?: string;
  authMethod?: string;
}

type ClientSessionSub = {
  flags: number;
  unsubscribeStdout?: () => void;
  unsubscribeSnapshots?: () => void;
  unsubscribeGit?: () => void;
  remoteId?: string;
  /** Frames forwarded from a remote before this time are its history replay. */
  remoteReplayUntil?: number;
};

type ClientState = {
  subs: Map<string, ClientSessionSub>;
  /** Heard from since the last heartbeat tick (any frame or a pong). */
  alive: boolean;
  /**
   * Upper bound of the history replay bytes still queued in the socket. They do not count
   * towards MAX_CLIENT_BUFFERED_BYTES; the bound only shrinks as the socket drains.
   */
  replayAllowance: number;
};

type RemoteConn = {
  ws: WebSocket;
  remoteId: string;
  remoteName: string;
  remoteUrl: string;
  token: string;
  openPromise: Promise<void>;
  reconnecting: boolean;
  // aggregated per session (OR across downstream clients)
  sessionFlags: Map<string, number>;
};

export class WsV3Hub {
  private clients = new WeakMap<WebSocket, ClientState>();
  private clientSockets = new Set<WebSocket>();
  private sessionMonitorListener: ((event: ServerEvent) => void) | null = null;

  private remoteConnections: Map<string, RemoteConn> = new Map();
  private remoteSessionSubscribers: Map<string, Set<WebSocket>> = new Map();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    private config: {
      ptyManager: PtyManager;
      terminalManager: TerminalManager;
      castOutputHub: CastOutputHub;
      gitStatusHub: GitStatusHub;
      sessionMonitor: SessionMonitor | null;
      remoteRegistry: RemoteRegistry | null;
      isHQMode: boolean;
    }
  ) {
    this.attachSessionMonitor();
  }

  /** Stop the heartbeat (server shutdown). */
  dispose() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) return;
    // Nothing on the server noticed a client that vanished without a FIN (a phone that left
    // Wi-Fi, a tab iOS froze): its subscriptions and queued frames stayed until the OS TCP
    // keepalive gave up, hours later. Ping and drop clients that stop answering.
    this.heartbeatTimer = setInterval(() => this.heartbeat(), CLIENT_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private heartbeat() {
    for (const ws of this.clientSockets) {
      const state = this.getClientState(ws);
      if (!state) continue;
      if (!state.alive) {
        logger.warn('dropping v3 client: no answer to heartbeat');
        ws.terminate();
        continue;
      }
      state.alive = false;
      try {
        ws.ping();
      } catch {
        // closing; the close handler cleans up
      }
    }
    if (this.clientSockets.size === 0) this.dispose();
  }

  handleClientConnection(ws: WebSocket, req: WebSocketRequestV3) {
    const clientState: ClientState = { subs: new Map(), alive: true, replayAllowance: 0 };
    this.clients.set(ws, clientState);
    this.clientSockets.add(ws);
    this.startHeartbeat();
    ws.on('pong', () => {
      clientState.alive = true;
    });

    logger.log(
      `v3 client connected (user=${req.userId || 'unknown'}, auth=${req.authMethod || 'unknown'})`
    );

    // Small welcome (optional)
    this.safeSend(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.WELCOME,
        payload: utf8Encoder.encode(JSON.stringify({ ok: true, version: 3 })),
      })
    );

    ws.on('message', async (message: Buffer, isBinary: boolean) => {
      clientState.alive = true;
      if (!isBinary) return;

      const frame = decodeWsV3Frame(message);
      if (!frame) return;

      try {
        await this.handleClientFrame(ws, frame.type, frame.sessionId, frame.payload);
      } catch (error) {
        logger.error('v3 frame handler error:', error);
        this.safeSend(
          ws,
          encodeWsV3Frame({
            type: WsV3MessageType.ERROR,
            sessionId: frame.sessionId,
            payload: utf8Encoder.encode(
              JSON.stringify({ message: error instanceof Error ? error.message : String(error) })
            ),
          })
        );
      }
    });

    ws.on('close', () => {
      this.clientSockets.delete(ws);
      this.cleanupClient(ws);
    });

    ws.on('error', (error) => {
      logger.error('v3 client ws error:', error);
    });
  }

  private async handleClientFrame(
    ws: WebSocket,
    type: WsV3MessageType,
    sessionId: string,
    payload: Uint8Array
  ) {
    switch (type) {
      case WsV3MessageType.PING: {
        this.safeSend(ws, encodeWsV3Frame({ type: WsV3MessageType.PONG, payload }));
        return;
      }

      case WsV3MessageType.SUBSCRIBE: {
        const sub = decodeWsV3SubscribePayload(payload);
        if (!sub) throw new Error('Invalid SUBSCRIBE payload');
        await this.subscribe(ws, sessionId, sub.flags);
        return;
      }

      case WsV3MessageType.UNSUBSCRIBE: {
        this.unsubscribe(ws, sessionId);
        return;
      }

      case WsV3MessageType.INPUT_TEXT: {
        if (!sessionId) throw new Error('Missing sessionId for INPUT_TEXT');
        const text = utf8Decoder.decode(payload);
        this.forwardInput(sessionId, { text });
        return;
      }

      case WsV3MessageType.INPUT_KEY: {
        if (!sessionId) throw new Error('Missing sessionId for INPUT_KEY');
        const key = utf8Decoder.decode(payload) as SpecialKey;
        this.forwardInput(sessionId, { key });
        return;
      }

      case WsV3MessageType.RESIZE: {
        if (!sessionId) throw new Error('Missing sessionId for RESIZE');
        const dims = decodeWsV3ResizePayload(payload);
        if (!dims) throw new Error('Invalid RESIZE payload');
        await this.forwardResize(sessionId, dims.cols, dims.rows);
        return;
      }

      case WsV3MessageType.KILL: {
        if (!sessionId) throw new Error('Missing sessionId for KILL');
        const signal = utf8Decoder.decode(payload) || 'SIGTERM';
        await this.forwardKill(sessionId, signal);
        return;
      }

      case WsV3MessageType.RESET_SIZE: {
        if (!sessionId) throw new Error('Missing sessionId for RESET_SIZE');
        this.forwardResetSize(sessionId);
        return;
      }

      default:
        return;
    }
  }

  private getClientState(ws: WebSocket): ClientState | null {
    return this.clients.get(ws) ?? null;
  }

  private async subscribe(ws: WebSocket, sessionId: string, flags: number) {
    const state = this.getClientState(ws);
    if (!state) return;

    const existing = state.subs.get(sessionId);
    if (existing?.unsubscribeStdout && flags & WsV3SubscribeFlags.Stdout) {
      // Still streaming stdout: only the snapshots and events change. Resubscribing replayed
      // the whole history (up to 16 MB) again to a terminal that already shows it, whenever
      // another view of the same session subscribed or left.
      existing.unsubscribeSnapshots?.();
      existing.unsubscribeGit?.();
      existing.unsubscribeSnapshots = undefined;
      existing.unsubscribeGit = undefined;
      existing.flags = flags;
      await this.attachSnapshotsAndEvents(ws, state, sessionId, existing);
      return;
    }
    if (existing) {
      // Update flags (unsubscribe/resubscribe as needed)
      this.unsubscribe(ws, sessionId);
    }

    // Global subscription (empty sessionId): only EVENT frames (ServerEvent stream).
    if (!sessionId) {
      const sub: ClientSessionSub = { flags };
      state.subs.set(sessionId, sub);
      if (flags & WsV3SubscribeFlags.Events) {
        this.attachSessionMonitor();
        // Ack so clients/tests can confirm the global event channel is live.
        this.safeSend(
          ws,
          encodeWsV3Frame({
            type: WsV3MessageType.EVENT,
            payload: utf8Encoder.encode(
              JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })
            ),
          })
        );
      }
      return;
    }

    const isRemote =
      this.config.isHQMode && this.config.remoteRegistry
        ? this.config.remoteRegistry.getRemoteBySessionId(sessionId)
        : undefined;

    if (isRemote) {
      state.subs.set(sessionId, {
        flags,
        remoteId: isRemote.id,
        remoteReplayUntil: Date.now() + REMOTE_REPLAY_WINDOW_MS,
      });
      this.addRemoteSubscriber(ws, sessionId, flags, isRemote.id);
      return;
    }

    const sub: ClientSessionSub = { flags };
    state.subs.set(sessionId, sub);

    if (flags & WsV3SubscribeFlags.Stdout) {
      const stdoutListener: CastOutputHubListener = (event) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (event.kind === 'output') {
          this.safeSend(
            ws,
            encodeWsV3Frame({
              type: WsV3MessageType.STDOUT,
              sessionId,
              payload: utf8Encoder.encode(event.data),
            }),
            event.historical
          );
        } else if (event.kind === 'exit') {
          this.safeSend(
            ws,
            encodeWsV3Frame({
              type: WsV3MessageType.EVENT,
              sessionId,
              payload: utf8Encoder.encode(
                JSON.stringify({ kind: 'exit', exitCode: event.exitCode })
              ),
            })
          );
        } else if (event.kind === 'error') {
          this.safeSend(
            ws,
            encodeWsV3Frame({
              type: WsV3MessageType.ERROR,
              sessionId,
              payload: utf8Encoder.encode(JSON.stringify({ message: event.message })),
            })
          );
        } else if (event.kind === 'resize') {
          // optional: send resize as event (clients may ignore to avoid loops)
          if (sub.flags & WsV3SubscribeFlags.Events) {
            this.safeSend(
              ws,
              encodeWsV3Frame({
                type: WsV3MessageType.EVENT,
                sessionId,
                payload: utf8Encoder.encode(
                  JSON.stringify({ kind: 'resize', dimensions: event.dimensions })
                ),
              })
            );
          }
        } else if (event.kind === 'replay-end') {
          if (sub.flags & WsV3SubscribeFlags.Events) {
            this.safeSend(
              ws,
              encodeWsV3Frame({
                type: WsV3MessageType.EVENT,
                sessionId,
                payload: utf8Encoder.encode(JSON.stringify({ kind: 'replay-end' })),
              }),
              true
            );
          }
        } else if (event.kind === 'header') {
          if (sub.flags & WsV3SubscribeFlags.Events) {
            this.safeSend(
              ws,
              encodeWsV3Frame({
                type: WsV3MessageType.EVENT,
                sessionId,
                // replayEnd: a replay-end event follows the history, so a client may hold
                // its paint until then (older servers send none).
                payload: utf8Encoder.encode(
                  JSON.stringify({ kind: 'header', header: event.header, replayEnd: true })
                ),
              })
            );
          }
        }
      };

      sub.unsubscribeStdout = this.config.castOutputHub.subscribe(sessionId, stdoutListener);
    }

    await this.attachSnapshotsAndEvents(ws, state, sessionId, sub);
  }

  private async attachSnapshotsAndEvents(
    ws: WebSocket,
    state: ClientState,
    sessionId: string,
    sub: ClientSessionSub
  ) {
    const flags = sub.flags;
    if (flags & WsV3SubscribeFlags.Snapshots) {
      sub.unsubscribeSnapshots = await this.config.terminalManager.subscribeToBufferChanges(
        sessionId,
        (sessionIdFromCb, snapshot) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const currentFlags = state.subs.get(sessionId)?.flags ?? 0;
          if (!(currentFlags & WsV3SubscribeFlags.Snapshots)) return;
          try {
            const encoded = this.config.terminalManager.encodeSnapshot(snapshot);
            this.safeSend(
              ws,
              encodeWsV3Frame({
                type: WsV3MessageType.SNAPSHOT_VT,
                sessionId: sessionIdFromCb,
                payload: encoded,
              })
            );
          } catch (error) {
            logger.error('failed to encode snapshot:', error);
          }
        }
      );
    }

    if (flags & WsV3SubscribeFlags.Events) {
      this.attachGitWatcher(ws, sessionId, sub);
    }
  }

  private attachGitWatcher(ws: WebSocket, sessionId: string, sub: ClientSessionSub) {
    try {
      const session = this.config.ptyManager.getSession(sessionId);
      if (!session?.gitRepoPath || !session.workingDir) return;

      this.config.gitStatusHub.startWatching(sessionId, session.workingDir, session.gitRepoPath);

      const listener: GitStatusHubListener = (event) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const current = this.getClientState(ws);
        if (!current) return;
        const s = current.subs.get(sessionId);
        if (!s || !(s.flags & WsV3SubscribeFlags.Events)) return;

        this.safeSend(
          ws,
          encodeWsV3Frame({
            type: WsV3MessageType.EVENT,
            sessionId,
            payload: utf8Encoder.encode(JSON.stringify(event)),
          })
        );
      };

      this.config.gitStatusHub.addClient(sessionId, listener);
      sub.unsubscribeGit = () => this.config.gitStatusHub.removeClient(sessionId, listener);
    } catch (error) {
      logger.error(`failed to attach git watcher for ${sessionId}:`, error);
    }
  }

  private unsubscribe(ws: WebSocket, sessionId: string) {
    const state = this.getClientState(ws);
    if (!state) return;

    const sub = state.subs.get(sessionId);
    if (!sub) return;

    if (!sessionId) {
      state.subs.delete(sessionId);
      return;
    }

    if (sub.remoteId) {
      this.removeRemoteSubscriber(ws, sessionId, sub.remoteId);
    }

    sub.unsubscribeStdout?.();
    sub.unsubscribeSnapshots?.();
    sub.unsubscribeGit?.();

    state.subs.delete(sessionId);
  }

  private cleanupClient(ws: WebSocket) {
    const state = this.getClientState(ws);
    if (!state) return;

    for (const sessionId of state.subs.keys()) {
      this.unsubscribe(ws, sessionId);
    }
  }

  private forwardInput(sessionId: string, input: { text?: string; key?: SpecialKey }) {
    const remote =
      this.config.isHQMode && this.config.remoteRegistry
        ? this.config.remoteRegistry.getRemoteBySessionId(sessionId)
        : undefined;

    if (remote) {
      const type =
        input.text !== undefined ? WsV3MessageType.INPUT_TEXT : WsV3MessageType.INPUT_KEY;
      const payload =
        input.text !== undefined
          ? utf8Encoder.encode(input.text)
          : utf8Encoder.encode(input.key ?? '');
      this.sendToRemote(remote.id, encodeWsV3Frame({ type, sessionId, payload }));
      return;
    }

    this.config.ptyManager.sendInput(sessionId, input);
  }

  private async forwardResize(sessionId: string, cols: number, rows: number) {
    const remote =
      this.config.isHQMode && this.config.remoteRegistry
        ? this.config.remoteRegistry.getRemoteBySessionId(sessionId)
        : undefined;

    if (remote) {
      this.sendToRemote(
        remote.id,
        encodeWsV3Frame({
          type: WsV3MessageType.RESIZE,
          sessionId,
          payload: encodeWsV3ResizePayload(cols, rows),
        })
      );
      return;
    }

    this.config.ptyManager.resizeSession(sessionId, cols, rows);
  }

  private async forwardKill(sessionId: string, signal: string | number) {
    const remote =
      this.config.isHQMode && this.config.remoteRegistry
        ? this.config.remoteRegistry.getRemoteBySessionId(sessionId)
        : undefined;

    if (remote) {
      this.sendToRemote(
        remote.id,
        encodeWsV3Frame({
          type: WsV3MessageType.KILL,
          sessionId,
          payload: utf8Encoder.encode(String(signal)),
        })
      );
      return;
    }

    await this.config.ptyManager.killSession(sessionId, signal);
  }

  private forwardResetSize(sessionId: string) {
    const remote =
      this.config.isHQMode && this.config.remoteRegistry
        ? this.config.remoteRegistry.getRemoteBySessionId(sessionId)
        : undefined;

    if (remote) {
      this.sendToRemote(
        remote.id,
        encodeWsV3Frame({ type: WsV3MessageType.RESET_SIZE, sessionId })
      );
      return;
    }

    this.config.ptyManager.resetSessionSize(sessionId);
  }

  private async ensureRemoteConnection(remoteId: string): Promise<RemoteConn | null> {
    const registry = this.config.remoteRegistry;
    if (!registry) return null;

    const remote = registry.getRemote(remoteId);
    if (!remote) return null;

    const existing = this.remoteConnections.get(remoteId);
    if (existing?.ws.readyState === WebSocket.OPEN) return existing;
    if (existing?.reconnecting) return existing;

    const wsUrl = `${remote.url.replace(/^http/, 'ws')}/ws`;

    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${remote.token}` },
    });

    const openPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('remote ws connect timeout')), 5000);
      ws.on('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    const conn: RemoteConn = {
      ws,
      remoteId,
      remoteName: remote.name,
      remoteUrl: remote.url,
      token: remote.token,
      openPromise,
      reconnecting: true,
      sessionFlags: existing?.sessionFlags ?? new Map(),
    };

    this.remoteConnections.set(remoteId, conn);

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      const frame = decodeWsV3Frame(data);
      if (!frame) return;
      this.forwardRemoteFrame(frame.type, frame.sessionId, frame.payload);
    });

    ws.on('close', () => {
      conn.reconnecting = false;
      this.remoteConnections.delete(remoteId);
    });

    ws.on('error', (error) => {
      logger.error(`remote ws error (${remote.name}):`, error);
    });

    try {
      await openPromise;
      conn.reconnecting = false;
      logger.debug(`remote ws connected: ${remote.name}`);

      // Re-apply aggregated subscriptions
      for (const [sessionId, flags] of conn.sessionFlags) {
        this.safeSend(
          conn.ws,
          encodeWsV3Frame({
            type: WsV3MessageType.SUBSCRIBE,
            sessionId,
            payload: encodeWsV3SubscribePayload({ flags }),
          })
        );
      }
    } catch (error) {
      logger.error(`failed to connect remote ws (${remote.name}):`, error);
      try {
        ws.close();
      } catch {
        // ignore
      }
      this.remoteConnections.delete(remoteId);
      return null;
    }

    return conn;
  }

  private addRemoteSubscriber(ws: WebSocket, sessionId: string, _flags: number, remoteId: string) {
    if (!this.remoteSessionSubscribers.has(sessionId))
      this.remoteSessionSubscribers.set(sessionId, new Set());
    this.remoteSessionSubscribers.get(sessionId)?.add(ws);

    // Update aggregated flags on upstream
    this.updateRemoteSubscription(remoteId, sessionId);
  }

  private removeRemoteSubscriber(ws: WebSocket, sessionId: string, remoteId: string) {
    const set = this.remoteSessionSubscribers.get(sessionId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) this.remoteSessionSubscribers.delete(sessionId);
    }

    this.updateRemoteSubscription(remoteId, sessionId);
  }

  private computeAggregatedFlagsForRemoteSession(remoteId: string, sessionId: string): number {
    let flags = 0;
    // WeakMap is not iterable: compute from subscriber set + per-client state.
    const subs = this.remoteSessionSubscribers.get(sessionId);
    if (!subs) return 0;

    for (const clientWs of subs) {
      const st = this.getClientState(clientWs);
      const sub = st?.subs.get(sessionId);
      if (sub?.remoteId === remoteId) flags |= sub.flags;
    }
    return flags;
  }

  private async updateRemoteSubscription(remoteId: string, sessionId: string) {
    const aggregatedFlags = this.computeAggregatedFlagsForRemoteSession(remoteId, sessionId);
    const conn = await this.ensureRemoteConnection(remoteId);
    if (!conn) return;

    const prev = conn.sessionFlags.get(sessionId) ?? 0;
    if (aggregatedFlags === prev) return;

    if (aggregatedFlags === 0) {
      conn.sessionFlags.delete(sessionId);
      this.sendToRemote(
        remoteId,
        encodeWsV3Frame({ type: WsV3MessageType.UNSUBSCRIBE, sessionId })
      );
      return;
    }

    conn.sessionFlags.set(sessionId, aggregatedFlags);
    this.sendToRemote(
      remoteId,
      encodeWsV3Frame({
        type: WsV3MessageType.SUBSCRIBE,
        sessionId,
        payload: encodeWsV3SubscribePayload({ flags: aggregatedFlags }),
      })
    );
  }

  private async sendToRemote(remoteId: string, data: Uint8Array) {
    const conn = await this.ensureRemoteConnection(remoteId);
    if (!conn) return;
    await conn.openPromise.catch(() => {});
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    this.safeSend(conn.ws, data);
  }

  private forwardRemoteFrame(type: WsV3MessageType, sessionId: string, payload: Uint8Array) {
    const subs = this.remoteSessionSubscribers.get(sessionId);
    if (!subs) return;

    for (const clientWs of subs) {
      if (clientWs.readyState !== WebSocket.OPEN) continue;
      const state = this.getClientState(clientWs);
      const s = state?.subs.get(sessionId);
      if (!s) continue;

      if (type === WsV3MessageType.STDOUT && !(s.flags & WsV3SubscribeFlags.Stdout)) continue;
      if (type === WsV3MessageType.SNAPSHOT_VT && !(s.flags & WsV3SubscribeFlags.Snapshots))
        continue;
      if (
        (type === WsV3MessageType.EVENT || type === WsV3MessageType.ERROR) &&
        !(s.flags & WsV3SubscribeFlags.Events)
      ) {
        // Still forward ERROR to help debugging even if Events not requested.
        if (type !== WsV3MessageType.ERROR) continue;
      }

      // The remote does not mark its replay; what arrives right after subscribing is it.
      const historical = type === WsV3MessageType.STDOUT && Date.now() < (s.remoteReplayUntil ?? 0);
      this.safeSend(clientWs, encodeWsV3Frame({ type, sessionId, payload }), historical);
    }
  }

  /**
   * Send a frame, dropping a client that fell more than MAX_CLIENT_BUFFERED_BYTES behind.
   * `historical` frames (a history replay) are exempt: the replay goes out in one
   * synchronous loop, so a session with more history than the limit would otherwise drop
   * every viewer on every (re)connect and its terminal would never open.
   */
  private safeSend(ws: WebSocket, data: Uint8Array, historical = false) {
    if (ws.readyState !== WebSocket.OPEN) return;
    const state = this.getClientState(ws);
    if (historical) {
      this.rawSend(ws, data);
      if (state) state.replayAllowance = Math.max(state.replayAllowance, ws.bufferedAmount);
      return;
    }
    // Replay bytes stay queued after the replay ends, ahead of live frames. Socket buffers
    // are FIFO and the allowance only ever shrinks to what is still queued, so it never
    // exceeds the history left; live bytes beyond it still face the limit. (bufferedAmount
    // mixes compressed and pending uncompressed bytes under permessage-deflate, so the
    // allowance is tracked in the same units rather than counted per frame.)
    const buffered = ws.bufferedAmount;
    let allowance = 0;
    if (state) {
      allowance = Math.min(state.replayAllowance, buffered);
      state.replayAllowance = allowance;
    }
    if (buffered - allowance > MAX_CLIENT_BUFFERED_BYTES) {
      // A phone on a stalled link (or a frozen tab) kept every frame of a fast
      // session queued here, growing server memory ~10 MB/s. Drop it: when it reconnects it
      // re-subscribes and gets a fresh replay, which is all it could still use anyway.
      logger.warn(`dropping v3 client: ${buffered} bytes unsent (${allowance} of them history)`);
      ws.terminate();
      return;
    }
    this.rawSend(ws, data);
  }

  private rawSend(ws: WebSocket, data: Uint8Array) {
    try {
      ws.send(data);
    } catch (error) {
      logger.debug(`ws send failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private attachSessionMonitor() {
    const monitor = this.config.sessionMonitor;
    if (!monitor) return;
    if (this.sessionMonitorListener) return;

    this.sessionMonitorListener = (event: ServerEvent) => this.broadcastGlobalServerEvent(event);
    monitor.on('notification', this.sessionMonitorListener);
  }

  private broadcastGlobalServerEvent(event: ServerEvent) {
    if (this.clientSockets.size === 0) return;

    const payload = utf8Encoder.encode(JSON.stringify(event));
    const frame = encodeWsV3Frame({
      type: WsV3MessageType.EVENT,
      sessionId: event.sessionId ?? '',
      payload,
    });

    for (const ws of this.clientSockets) {
      const state = this.getClientState(ws);
      const globalSub = state?.subs.get('');
      if (!globalSub || !(globalSub.flags & WsV3SubscribeFlags.Events)) continue;
      this.safeSend(ws, frame);
    }
  }
}
