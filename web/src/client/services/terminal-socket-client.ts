import {
  decodeWsV3Frame,
  encodeWsV3Frame,
  encodeWsV3ResizePayload,
  encodeWsV3SubscribePayload,
  VIEWING_REFRESH_MS,
  WsV3MessageType,
  WsV3SubscribeFlags,
} from '../../shared/ws-v3.js';
import { fetchAuthConfig } from '../utils/auth-config.js';
import { createLogger } from '../utils/logger.js';
import { TerminalRenderer } from '../utils/terminal-renderer.js';
import { authClient } from './auth-client.js';

const logger = createLogger('terminal-socket-client');

/**
 * Without a tap, key, scroll or wheel for this long the page is not being looked at: a
 * session left open on an unattended screen must not hold back notifications.
 */
export const VIEWING_IDLE_MS = 120_000;
const INTERACTION_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'scroll', 'wheel'] as const;

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
  private isConnected = false;
  private connectionStateHandlers: Set<(connected: boolean) => void> = new Set();

  private initialized = false;
  private noAuthMode: boolean | null = null;

  private sessions = new Map<string, SessionSubs>();
  /**
   * Session the session view shows; reported to the server (VIEWING) only while someone is
   * looking at the page, for "Skip notifications for the session on screen".
   */
  private viewingSessionId: string | null = null;
  private pageHidden = false;
  /** What the current socket was last told about the viewed session. */
  private sentViewing: string | null = null;
  /** Last tap, key, scroll or wheel (or coming back to the page). */
  private lastInteractionAt = 0;
  /** Repeats the VIEWING frame while a session is shown: the server forgets it otherwise. */
  private viewingTimer: number | null = null;
  private viewingListeners = false;
  private messageQueue: Uint8Array[] = [];
  private encoder = new TextEncoder();

  async initialize() {
    if (this.initialized) return;
    this.initialized = true;

    await this.checkNoAuthMode();
    setTimeout(() => this.connect(), 100);
  }

  private async checkNoAuthMode(): Promise<void> {
    try {
      // Shares the app's own request at startup (utils/auth-config.ts).
      const config = await fetchAuthConfig();
      if (config) {
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

      this.ws.onopen = () => {
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.setConnected(true);
        this.startPingPong();
        this.sentViewing = null; // a new socket starts with nothing viewed
        this.sendViewing();

        // Flush queued frames
        while (this.messageQueue.length > 0) {
          const msg = this.messageQueue.shift();
          if (msg) this.safeSend(msg);
        }

        // Re-subscribe all sessions (aggregate flags)
        for (const [sessionId, info] of this.sessions) {
          const payload = encodeWsV3SubscribePayload({ flags: info.flags });
          this.safeSend(encodeWsV3Frame({ type: WsV3MessageType.SUBSCRIBE, sessionId, payload }));
        }
      };

      this.ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          this.handleBinary(event.data);
        }
      };

      this.ws.onerror = (error) => {
        logger.debug('v3 socket error', error);
      };

      this.ws.onclose = () => {
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
      this.sendFrame(
        encodeWsV3Frame({ type: WsV3MessageType.PING, payload: this.encoder.encode('ping') })
      );
    }, 20000);
  }

  private stopPingPong() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private safeSend(buffer: Uint8Array) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const payload = new ArrayBuffer(buffer.byteLength);
      new Uint8Array(payload).set(buffer);
      this.ws.send(payload);
    } else {
      this.messageQueue.push(buffer);
      if (this.initialized && !this.ws) this.connect();
    }
  }

  private sendFrame(buffer: Uint8Array) {
    this.safeSend(buffer);
  }

  /**
   * Tell the server which session this page shows (null: none), so it can hold back
   * notifications about it while someone is looking, when the user turned that on. Re-sent on
   * every new socket and every VIEWING_REFRESH_MS while looked at; never queued.
   */
  setViewingSession(sessionId: string | null): void {
    this.viewingSessionId = sessionId || null;
    this.listenForViewing();
    // Opening a session is looking at it.
    if (this.viewingSessionId) this.lastInteractionAt = Date.now();
    if (this.viewingSessionId && this.viewingTimer === null) {
      this.viewingTimer = window.setInterval(() => this.sendViewing(true), VIEWING_REFRESH_MS);
    } else if (!this.viewingSessionId && this.viewingTimer !== null) {
      clearInterval(this.viewingTimer);
      this.viewingTimer = null;
    }
    this.sendViewing();
  }

  /** Clear the viewed session if it is still `sessionId` (a newer view may own it). */
  clearViewingSession(sessionId: string): void {
    if (this.viewingSessionId === sessionId) this.setViewingSession(null);
  }

  private listenForViewing() {
    if (this.viewingListeners || typeof window === 'undefined') return;
    this.viewingListeners = true;
    // Locking the phone or switching apps hides the page: stop claiming to watch.
    document.addEventListener('visibilitychange', this.handleViewingVisibility);
    // iOS may skip visibilitychange when Safari is closed or the tab discarded.
    window.addEventListener('pagehide', this.handlePageHide);
    window.addEventListener('pageshow', this.handlePageShow);
    // A frozen page (Chrome's lifecycle) runs nothing, so it can't keep saying it is viewed.
    document.addEventListener('freeze', this.handlePageHide);
    document.addEventListener('resume', this.handlePageShow);
    // Another window or app in front: nobody is looking at this page.
    window.addEventListener('blur', this.handleBlur);
    window.addEventListener('focus', this.handleLookingAgain);
    for (const type of INTERACTION_EVENTS) {
      window.addEventListener(type, this.handleInteraction, { capture: true, passive: true });
    }
  }

  private readonly handleViewingVisibility = () => {
    if (document.visibilityState === 'visible') this.lastInteractionAt = Date.now();
    this.sendViewing();
  };

  private readonly handlePageHide = () => {
    this.pageHidden = true;
    this.sendViewing();
  };

  private readonly handlePageShow = () => {
    this.pageHidden = false;
    this.lastInteractionAt = Date.now();
    this.sendViewing();
  };

  private readonly handleBlur = () => {
    this.sendViewing();
  };

  private readonly handleLookingAgain = () => {
    this.lastInteractionAt = Date.now();
    this.sendViewing();
  };

  private readonly handleInteraction = () => {
    this.lastInteractionAt = Date.now();
    // Only says something when this ends an idle spell (or nothing was claimed yet).
    this.sendViewing();
  };

  /**
   * Someone is looking at this page: visible, focused, and touched, typed in or scrolled
   * within VIEWING_IDLE_MS. A page left open on a locked computer or behind another window
   * is not.
   */
  private isLookedAt(): boolean {
    return (
      !this.pageHidden &&
      document.visibilityState === 'visible' &&
      document.hasFocus() &&
      Date.now() - this.lastInteractionAt < VIEWING_IDLE_MS
    );
  }

  /** Report what is viewed when it changed; `refresh` repeats a viewed session anyway. */
  private sendViewing(refresh = false) {
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const viewing = this.isLookedAt() ? this.viewingSessionId : null;
    if (viewing === this.sentViewing && !(refresh && viewing)) return;
    this.sentViewing = viewing;
    this.safeSend(encodeWsV3Frame({ type: WsV3MessageType.VIEWING, sessionId: viewing ?? '' }));
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
        this.sendFrame(encodeWsV3Frame({ type: WsV3MessageType.UNSUBSCRIBE, sessionId }));
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
    this.sendFrame(encodeWsV3Frame({ type: WsV3MessageType.SUBSCRIBE, sessionId, payload }));
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
      // Decoded on a microtask as before. A static import (terminal-renderer has no imports,
      // so there is no cycle): the dynamic one made esbuild code splitting move the renderer
      // into a separate chunk the main bundle had to fetch before starting.
      Promise.resolve({ TerminalRenderer })
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
