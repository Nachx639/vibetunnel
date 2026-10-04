import {
  decodeWsV3Frame,
  encodeWsV3Frame,
  encodeWsV3ResizePayload,
  encodeWsV3SubscribePayload,
  WsV3MessageType,
  WsV3SubscribeFlags,
} from '../../shared/ws-v3.js';
import { createLogger } from '../utils/logger.js';
import { authClient } from './auth-client.js';

const logger = createLogger('terminal-socket-client');

const PING_INTERVAL_MS = 20000;
/** Two missed pongs: the server answers every PING, so silence means the socket is dead. */
const PONG_TIMEOUT_MS = 2 * PING_INTERVAL_MS + 5000;
/** Answer expected after coming back to the foreground before the socket is replaced. */
const PROBE_TIMEOUT_MS = 4000;
/** Typed input older than this when the socket comes back is dropped, not replayed. */
export const OFFLINE_INPUT_MAX_AGE_MS = 30_000;
/** Most recent typed input kept while offline; older bytes beyond it are dropped. */
export const OFFLINE_INPUT_MAX_BYTES = 64 * 1024;

type QueuedFrame = {
  frame: Uint8Array;
  type: WsV3MessageType | undefined;
  sessionId: string;
  queuedAt: number;
};

export interface BufferCell {
  char: string;
  width: number;
  fg?: number;
  bg?: number;
  attributes?: number;
}

export interface BufferSnapshot {
  cols: number;
  rows: number;
  viewportY: number;
  cursorX: number;
  cursorY: number;
  cells: BufferCell[][];
}

export type TerminalSocketEvent =
  | { kind: 'event'; sessionId: string; data: unknown }
  | { kind: 'error'; sessionId: string; message: string };

type Subscription = {
  wantStdout: boolean;
  wantSnapshots: boolean;
  wantEvents: boolean;
  onStdout?: (data: Uint8Array) => void;
  onSnapshot?: (snapshot: BufferSnapshot) => void;
  onEvent?: (data: unknown) => void;
  onError?: (message: string) => void;
};

type SessionSubs = {
  subs: Set<Subscription>;
  flags: number;
};

export class TerminalSocketClient {
  private ws: WebSocket | null = null;
  private isConnecting = false;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private pingInterval: number | null = null;
  private probeTimer: number | null = null;
  private lastInboundAt = 0;
  private isConnected = false;
  private connectionStateHandlers: Set<(connected: boolean) => void> = new Set();

  private initialized = false;
  private noAuthMode: boolean | null = null;

  private sessions = new Map<string, SessionSubs>();
  private messageQueue: QueuedFrame[] = [];
  private encoder = new TextEncoder();

  async initialize() {
    if (this.initialized) return;
    this.initialized = true;

    // Back from the background with the socket down: reconnect now instead of waiting out
    // the backoff (up to 30 s after a long sleep), so the terminal is live when you look.
    document.addEventListener('visibilitychange', this.handleVisibilityChange);

    await this.checkNoAuthMode();
    setTimeout(() => this.connect(), 100);
  }

  private readonly handleVisibilityChange = () => {
    if (document.visibilityState !== 'visible') return;
    if (this.reconnectTimer) {
      this.forceReconnect();
      return;
    }
    // After a lock or a Wi-Fi ↔ cellular switch the socket often still says OPEN while
    // its TCP connection is gone: nothing arrives and the terminal looks frozen. Ask.
    this.probeConnection();
  };

  private probeConnection() {
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.probeTimer) return;
    const sentAt = Date.now();
    this.sendPing();
    this.probeTimer = window.setTimeout(() => {
      this.probeTimer = null;
      if (this.ws === socket && this.lastInboundAt < sentAt) this.dropDeadSocket(socket);
    }, PROBE_TIMEOUT_MS);
  }

  /** Abandon a socket that stopped answering and reconnect right away. */
  private dropDeadSocket(socket: WebSocket) {
    if (this.ws !== socket) return;
    logger.warn('v3 socket stopped answering, reconnecting');
    this.ws = null;
    this.isConnecting = false;
    this.stopPingPong();
    this.setConnected(false);
    try {
      socket.close();
    } catch {
      // already gone
    }
    this.reconnectAttempts = 0;
    this.connect();
  }

  private async checkNoAuthMode(): Promise<void> {
    try {
      const response = await fetch('/api/auth/config');
      if (response.ok) {
        const config = await response.json();
        this.noAuthMode = config.noAuth === true;
      }
    } catch (error) {
      logger.warn('Failed to check auth config:', error);
      this.noAuthMode = false;
    }
  }

  private isNoAuthMode(): boolean {
    return this.noAuthMode === true;
  }

  private connect() {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) return;

    const currentUser = authClient.getCurrentUser();
    const token = currentUser?.token;

    if (!token && !this.isNoAuthMode()) {
      logger.debug('No auth token available yet, postponing v3 socket connect');
      setTimeout(() => {
        if (this.initialized && !this.ws) this.connect();
      }, 500);
      return;
    }

    this.isConnecting = true;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let wsUrl = `${protocol}//${window.location.host}/ws`;
    if (token) wsUrl += `?token=${encodeURIComponent(token)}`;

    try {
      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = 'arraybuffer';
      // Capture this socket instance so late-firing handlers from a previous socket
      // can't clobber a newer one (e.g. when reconnecting after iOS background).
      const socket = this.ws;

      socket.onopen = () => {
        if (this.ws !== socket) return;
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.lastInboundAt = Date.now();
        this.setConnected(true);
        this.startPingPong();

        // Flush queued frames
        const queued = this.trimOfflineQueue(this.messageQueue);
        this.messageQueue = [];
        for (const item of queued) this.safeSend(item.frame);

        // Re-subscribe all sessions (aggregate flags)
        for (const [sessionId, info] of this.sessions) {
          const payload = encodeWsV3SubscribePayload({ flags: info.flags });
          this.safeSend(encodeWsV3Frame({ type: WsV3MessageType.SUBSCRIBE, sessionId, payload }));
        }
      };

      socket.onmessage = (event) => {
        if (this.ws !== socket) return;
        this.lastInboundAt = Date.now();
        if (event.data instanceof ArrayBuffer) {
          this.handleBinary(event.data);
        }
      };

      socket.onerror = (error) => {
        logger.debug('v3 socket error', error);
      };

      socket.onclose = () => {
        // Only react if this is still the active socket. A stale onclose (from a
        // socket we already replaced) must not null out the new reference.
        if (this.ws !== socket) return;
        this.isConnecting = false;
        this.stopPingPong();
        this.setConnected(false);
        this.ws = null;
        this.scheduleReconnect();
      };
    } catch (error) {
      logger.error('failed to create v3 websocket', error);
      this.isConnecting = false;
      this.setConnected(false);
      this.scheduleReconnect();
    }
  }

  getConnectionStatus(): boolean {
    return this.isConnected;
  }

  /**
   * Force an immediate reconnection attempt, bypassing the exponential backoff.
   * Used when the page is restored from the iOS/Safari bfcache (pageshow.persisted),
   * where the old socket is typically dead but timers were frozen while backgrounded.
   * If the current socket is genuinely OPEN it is left alone (ping/pong will catch a
   * dead one); otherwise we reset backoff and reconnect now.
   */
  forceReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    this.isConnecting = false;
    this.connect();
  }

  onConnectionStateChange(handler: (connected: boolean) => void): () => void {
    this.connectionStateHandlers.add(handler);
    return () => this.connectionStateHandlers.delete(handler);
  }

  private setConnected(connected: boolean) {
    if (this.isConnected === connected) return;
    this.isConnected = connected;
    for (const handler of this.connectionStateHandlers) {
      try {
        handler(connected);
      } catch (error) {
        logger.debug('connection state handler error', error);
      }
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
    this.reconnectAttempts++;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startPingPong() {
    if (this.pingInterval) return;
    this.pingInterval = window.setInterval(() => {
      // Pings went out but nobody checked for the pong, so a half-open
      // socket (network switch, NAT timeout) froze the terminal until a reload.
      const socket = this.ws;
      if (socket && Date.now() - this.lastInboundAt > PONG_TIMEOUT_MS) {
        this.dropDeadSocket(socket);
        return;
      }
      this.sendPing();
    }, PING_INTERVAL_MS);
  }

  private sendPing() {
    this.sendFrame(
      encodeWsV3Frame({ type: WsV3MessageType.PING, payload: this.encoder.encode('ping') })
    );
  }

  private stopPingPong() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
  }

  private safeSend(buffer: Uint8Array) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const payload = new ArrayBuffer(buffer.byteLength);
      new Uint8Array(payload).set(buffer);
      this.ws.send(payload);
    } else {
      const frame = decodeWsV3Frame(buffer);
      this.messageQueue.push({
        frame: buffer,
        type: frame?.type,
        sessionId: frame?.sessionId ?? '',
        queuedAt: Date.now(),
      });
      this.messageQueue = this.trimOfflineQueue(this.messageQueue);
      if (this.initialized && !this.ws) this.connect();
    }
  }

  /**
   * The offline queue was never trimmed, so a phone that came back after an
   * hour replayed every old keystroke into the session (and every intermediate resize).
   * Keep typed input from the last 30 s, at most 64 KB of it (newest first), and only
   * the last resize per session; pings are pointless on a new socket.
   */
  private trimOfflineQueue(queue: QueuedFrame[]): QueuedFrame[] {
    const now = Date.now();
    const lastSizeIndex = new Map<string, number>();
    queue.forEach((item, index) => {
      if (item.type === WsV3MessageType.RESIZE || item.type === WsV3MessageType.RESET_SIZE) {
        lastSizeIndex.set(item.sessionId, index);
      }
    });

    let inputBytes = 0;
    let inputFull = false;
    const keep = new Array<boolean>(queue.length).fill(false);
    for (let index = queue.length - 1; index >= 0; index--) {
      const item = queue[index];
      switch (item.type) {
        case WsV3MessageType.PING:
          break;
        case WsV3MessageType.RESIZE:
        case WsV3MessageType.RESET_SIZE:
          keep[index] = lastSizeIndex.get(item.sessionId) === index;
          break;
        case WsV3MessageType.INPUT_TEXT:
        case WsV3MessageType.INPUT_KEY:
        case WsV3MessageType.KILL:
          // Walking newest to oldest: once the budget is spent, nothing older is kept,
          // so the kept input is one contiguous recent stretch.
          if (inputFull || now - item.queuedAt > OFFLINE_INPUT_MAX_AGE_MS) break;
          if (inputBytes + item.frame.byteLength > OFFLINE_INPUT_MAX_BYTES) {
            inputFull = true;
            break;
          }
          inputBytes += item.frame.byteLength;
          keep[index] = true;
          break;
        default:
          keep[index] = true;
      }
    }
    if (keep.every(Boolean)) return queue;
    const dropped = keep.filter((k) => !k).length;
    logger.debug(`dropped ${dropped} stale frame(s) queued while offline`);
    return queue.filter((_, index) => keep[index]);
  }

  private sendFrame(buffer: Uint8Array) {
    this.safeSend(buffer);
  }

  /**
   * Subscription changes only matter to the socket they are sent on: a new socket starts
   * with no subscriptions and `onopen` subscribes every session with its current flags.
   * Queuing them too made a reconnect send SUBSCRIBE twice per session, and
   * the server answered each with a full history replay.
   */
  private sendSubscriptionFrame(buffer: Uint8Array) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.safeSend(buffer);
    } else if (this.initialized && !this.ws) {
      this.connect();
    }
  }

  subscribe(
    sessionId: string,
    opts: {
      stdout?: boolean;
      snapshots?: boolean;
      events?: boolean;
      onStdout?: (data: Uint8Array) => void;
      onSnapshot?: (snapshot: BufferSnapshot) => void;
      onEvent?: (data: unknown) => void;
      onError?: (message: string) => void;
    }
  ): () => void {
    if (!this.initialized) this.initialize();

    const subscription: Subscription = {
      wantStdout: opts.stdout === true,
      wantSnapshots: opts.snapshots === true,
      wantEvents: opts.events === true,
      onStdout: opts.onStdout,
      onSnapshot: opts.onSnapshot,
      onEvent: opts.onEvent,
      onError: opts.onError,
    };

    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { subs: new Set(), flags: 0 };
      this.sessions.set(sessionId, session);
    }

    session.subs.add(subscription);
    this.updateSessionFlagsAndNotify(sessionId);

    return () => {
      const s = this.sessions.get(sessionId);
      if (!s) return;
      s.subs.delete(subscription);
      if (s.subs.size === 0) {
        this.sessions.delete(sessionId);
        this.sendSubscriptionFrame(
          encodeWsV3Frame({ type: WsV3MessageType.UNSUBSCRIBE, sessionId })
        );
      } else {
        this.updateSessionFlagsAndNotify(sessionId);
      }
    };
  }

  private updateSessionFlagsAndNotify(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) return;

    let flags = 0;
    for (const sub of s.subs) {
      if (sub.wantStdout) flags |= WsV3SubscribeFlags.Stdout;
      if (sub.wantSnapshots) flags |= WsV3SubscribeFlags.Snapshots;
      if (sub.wantEvents) flags |= WsV3SubscribeFlags.Events;
    }

    if (flags === s.flags) return;
    s.flags = flags;
    const payload = encodeWsV3SubscribePayload({ flags });
    this.sendSubscriptionFrame(
      encodeWsV3Frame({ type: WsV3MessageType.SUBSCRIBE, sessionId, payload })
    );
  }

  sendInputText(sessionId: string, text: string): boolean {
    if (!sessionId) return false;
    const payload = this.encoder.encode(text);
    this.sendFrame(encodeWsV3Frame({ type: WsV3MessageType.INPUT_TEXT, sessionId, payload }));
    return true;
  }

  sendInputKey(sessionId: string, key: string): boolean {
    if (!sessionId) return false;
    const payload = this.encoder.encode(key);
    this.sendFrame(encodeWsV3Frame({ type: WsV3MessageType.INPUT_KEY, sessionId, payload }));
    return true;
  }

  resize(sessionId: string, cols: number, rows: number): boolean {
    if (!sessionId) return false;
    const payload = encodeWsV3ResizePayload(cols, rows);
    this.sendFrame(encodeWsV3Frame({ type: WsV3MessageType.RESIZE, sessionId, payload }));
    return true;
  }

  kill(sessionId: string, signal: string): boolean {
    if (!sessionId) return false;
    const payload = this.encoder.encode(signal);
    this.sendFrame(encodeWsV3Frame({ type: WsV3MessageType.KILL, sessionId, payload }));
    return true;
  }

  resetSize(sessionId: string): boolean {
    if (!sessionId) return false;
    this.sendFrame(encodeWsV3Frame({ type: WsV3MessageType.RESET_SIZE, sessionId }));
    return true;
  }

  private handleBinary(data: ArrayBuffer) {
    const frame = decodeWsV3Frame(new Uint8Array(data));
    if (!frame) return;

    const session = this.sessions.get(frame.sessionId);
    const globalEvents = frame.sessionId !== '' ? this.sessions.get('') : null;

    if (frame.type === WsV3MessageType.STDOUT) {
      if (!session) return;
      const bytes = frame.payload;
      for (const sub of session.subs) {
        if (sub.wantStdout) sub.onStdout?.(bytes);
      }
      return;
    }

    if (frame.type === WsV3MessageType.EVENT) {
      let obj: unknown = null;
      try {
        obj = JSON.parse(new TextDecoder().decode(frame.payload));
      } catch {
        obj = new TextDecoder().decode(frame.payload);
      }

      if (session) {
        for (const sub of session.subs) {
          if (sub.wantEvents) sub.onEvent?.(obj);
        }
      }

      if (globalEvents) {
        for (const sub of globalEvents.subs) {
          if (sub.wantEvents) sub.onEvent?.(obj);
        }
      }
      return;
    }

    if (frame.type === WsV3MessageType.ERROR) {
      let message = new TextDecoder().decode(frame.payload);
      try {
        const parsed = JSON.parse(message) as { message?: string };
        if (parsed?.message) message = parsed.message;
      } catch {
        // ignore
      }

      if (session) {
        for (const sub of session.subs) sub.onError?.(message);
      }
      if (globalEvents) {
        for (const sub of globalEvents.subs) sub.onError?.(message);
      }
      return;
    }

    if (frame.type === WsV3MessageType.SNAPSHOT_VT) {
      if (!session) return;
      // Avoid circular dependency; decode lazily.
      import('../utils/terminal-renderer.js')
        .then(({ TerminalRenderer }) => {
          try {
            const payload = frame.payload;
            // TerminalRenderer expects ArrayBuffer (not SharedArrayBuffer). Copy to detach.
            const copy = new Uint8Array(payload.byteLength);
            copy.set(payload);
            const snapshot = TerminalRenderer.decodeBinaryBuffer(copy.buffer);
            for (const sub of session.subs) {
              if (sub.wantSnapshots) sub.onSnapshot?.(snapshot);
            }
          } catch (error) {
            logger.error('failed to decode snapshot', error);
          }
        })
        .catch((error) => {
          logger.error('failed to import terminal renderer', error);
        });
    }
  }
}

export const terminalSocketClient = new TerminalSocketClient();
