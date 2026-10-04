/**
 * Terminal Lifecycle Manager
 *
 * Handles terminal setup, initialization, resizing, and cleanup operations
 * for session view components.
 */

import type { Session } from '../../../shared/types.js';
import { HttpMethod } from '../../../shared/types.js';
import { authClient } from '../../services/auth-client.js';
import { terminalSocketClient } from '../../services/terminal-socket-client.js';
import { createLogger } from '../../utils/logger.js';
import { isPtySizeReclaimEnabled } from '../../utils/pty-size-reclaim.js';
import type { TerminalThemeId } from '../../utils/terminal-themes.js';
import type { Terminal } from '../terminal.js';
import type { ConnectionManager } from './connection-manager.js';
import type { InputManager } from './input-manager.js';

const logger = createLogger('terminal-lifecycle-manager');

/** How long after a client's last touch it counts as the one in use (see reclaimPtySize). */
const RECLAIM_ACTIVITY_MS = 60_000;
/** The wait after the PTY's last size change before taking it back. */
const RECLAIM_SETTLE_MS = 500;
/** How soon the same size is asked for again when the PTY kept another one. */
const RECLAIM_RETRY_MS = 10_000;

/**
 * Whether this client may take the PTY's size back from another one (see reclaimPtySize). Not
 * for a forwarded session (`vt` in a terminal window, id `fwd_…`): its size belongs to that
 * window, which the phone would shrink and garble, the two resizing in turns.
 */
export function takesBackPtySize(session: Pick<Session, 'id'> | null | undefined): boolean {
  if (!session) return false;
  return !session.id.startsWith('fwd_');
}

export interface TerminalEventHandlers {
  handleSessionExit: (e: Event) => void;
  handleTerminalResize: (e: Event) => void;
  handleTerminalPaste: (e: Event) => void;
}

export interface TerminalStateCallbacks {
  updateTerminalDimensions: (cols: number, rows: number) => void;
}

export class TerminalLifecycleManager {
  private session: Session | null = null;
  private terminal: Terminal | null = null;
  private connectionManager: ConnectionManager | null = null;
  private inputManager: InputManager | null = null;
  private connected = false;
  private terminalFontSize = 14;
  private terminalMaxCols = 0;
  private terminalTheme: TerminalThemeId = 'auto';
  private resizeTimeout: number | null = null;
  private lastResizeWidth = 0;
  private lastResizeHeight = 0;
  private ptySize: { cols: number; rows: number } | null = null;
  private lastActivityAt = 0;
  private reclaimTimer: ReturnType<typeof setTimeout> | null = null;
  private lastReclaim: { attempt: string; at: number } | null = null;
  private domElement: Element | null = null;
  private eventHandlers: TerminalEventHandlers | null = null;
  private stateCallbacks: TerminalStateCallbacks | null = null;

  setSession(session: Session | null) {
    this.session = session;
  }

  setTerminal(terminal: Terminal | null) {
    this.terminal = terminal;
  }

  setConnectionManager(connectionManager: ConnectionManager | null) {
    this.connectionManager = connectionManager;
  }

  setInputManager(inputManager: InputManager | null) {
    this.inputManager = inputManager;
  }

  setConnected(connected: boolean) {
    this.connected = connected;
  }

  setTerminalFontSize(fontSize: number) {
    this.terminalFontSize = fontSize;
  }

  setTerminalMaxCols(maxCols: number) {
    this.terminalMaxCols = maxCols;
  }

  setTerminalTheme(theme: TerminalThemeId) {
    this.terminalTheme = theme;
  }

  getTerminal(): Terminal | null {
    return this.terminal;
  }

  setDomElement(element: Element | null) {
    this.domElement = element;
  }

  setEventHandlers(handlers: TerminalEventHandlers | null) {
    this.eventHandlers = handlers;
  }

  setStateCallbacks(callbacks: TerminalStateCallbacks | null) {
    this.stateCallbacks = callbacks;
  }

  setupTerminal() {
    // Terminal element will be created in render()
    // We'll initialize it in updated() after first render
  }

  async initializeTerminal() {
    if (!this.domElement) {
      logger.warn('Cannot initialize terminal - missing DOM element');
      return;
    }

    // First try to find terminal inside terminal-renderer, then fallback to direct query
    const terminalElement = (this.domElement.querySelector('terminal-renderer vibe-terminal') ||
      this.domElement.querySelector('vibe-terminal')) as Terminal;

    logger.debug('Terminal search results:', {
      hasTerminalRenderer: !!this.domElement.querySelector('terminal-renderer'),
      hasDirectTerminal: !!this.domElement.querySelector('vibe-terminal'),
      hasNestedTerminal: !!this.domElement.querySelector('terminal-renderer vibe-terminal'),
      foundElement: !!terminalElement,
      sessionId: this.session?.id,
    });

    if (!terminalElement || !this.session) {
      logger.warn(`Cannot initialize terminal - missing element or session`);
      return;
    }

    this.terminal = terminalElement;

    // Update connection manager with terminal reference
    if (this.connectionManager) {
      this.connectionManager.setTerminal(this.terminal);
      this.connectionManager.setSession(this.session);
    }

    // Configure terminal for interactive session
    this.terminal.cols = 80;
    this.terminal.rows = 24;
    this.terminal.fontSize = this.terminalFontSize; // Apply saved font size preference
    this.terminal.fitHorizontally = false; // Allow natural terminal sizing
    this.terminal.maxCols = this.terminalMaxCols; // Apply saved max width preference
    this.terminal.theme = this.terminalTheme;

    if (this.eventHandlers) {
      // Listen for session exit events
      this.terminal.addEventListener(
        'session-exit',
        this.eventHandlers.handleSessionExit as EventListener
      );

      // Listen for terminal resize events to capture dimensions
      this.terminal.addEventListener(
        'terminal-resize',
        this.eventHandlers.handleTerminalResize as unknown as EventListener
      );

      // Listen for paste events from terminal
      this.terminal.addEventListener(
        'terminal-paste',
        this.eventHandlers.handleTerminalPaste as EventListener
      );
    }

    // Connect to stream directly without artificial delays
    // Use setTimeout to ensure we're still connected after all synchronous updates
    setTimeout(() => {
      if (this.connected && this.connectionManager) {
        logger.debug('Connecting to stream for terminal', {
          terminalElement: !!this.terminal,
          sessionId: this.session?.id,
          connected: this.connected,
        });
        this.connectionManager.connectToStream();
      } else {
        logger.warn(`Component disconnected before stream connection`);
      }
    }, 0);
  }

  async handleTerminalResize(event: Event) {
    const customEvent = event as CustomEvent;
    // Update terminal dimensions for display
    const { cols, rows, isMobile, isHeightOnlyChange, source } = customEvent.detail;

    // Debug logging for terminal resize events
    logger.debug('Terminal resize event:', {
      cols,
      rows,
      source,
      sessionId: this.session?.id,
    });

    // Notify the session view to update its state
    if (this.stateCallbacks) {
      this.stateCallbacks.updateTerminalDimensions(cols, rows);
    }

    // On mobile, skip sending height-only changes to the server (keyboard events)
    if (isMobile && isHeightOnlyChange) {
      logger.debug(
        `skipping mobile height-only resize to server: ${cols}x${rows} (source: ${source})`
      );
      return;
    }

    // Debounce resize requests to prevent jumpiness
    if (this.resizeTimeout) {
      clearTimeout(this.resizeTimeout);
    }

    this.resizeTimeout = window.setTimeout(async () => {
      this.resizeTimeout = null;
      // Only send resize request if dimensions actually changed
      if (cols === this.lastResizeWidth && rows === this.lastResizeHeight) {
        logger.debug(`skipping redundant resize request: ${cols}x${rows}`);
        return;
      }

      // Send resize request to backend if session is active
      if (this.session && this.session.status !== 'exited') {
        logger.debug(
          `sending resize request: ${cols}x${rows} (was ${this.lastResizeWidth}x${this.lastResizeHeight})`
        );
        await this.sendResize(cols, rows);
      }
    }, 250) as unknown as number; // 250ms debounce delay
  }

  /**
   * The PTY's size as the stream reports it. Another client may have resized it; while this
   * one is in use, it takes the PTY back to its own size (see reclaimPtySize).
   */
  handlePtySize(size: { cols: number; rows: number }) {
    this.ptySize = size;
    this.scheduleReclaim();
  }

  /**
   * The user touched or typed in this session, or brought it back into view: the PTY should
   * have this client's size again if another client changed it meanwhile.
   */
  noteUserActivity() {
    this.lastActivityAt = Date.now();
    this.scheduleReclaim();
  }

  /**
   * A client only sends its size when its own terminal changes, so after another client
   * resized the PTY it keeps a terminal of its old size, into which the app draws for the
   * other one (a phone at 45 columns under a PTY at 53: the app's longer rows lose their tails
   * on the phone, and its menus cannot be answered there). With `reclaimPtySize` on, the
   * client in use (touched in the last minute, and visible) sends its size again, a moment
   * after the PTY's last change so its own resizes' echoes settle first. Only on use: two open
   * clients that always took the PTY back would resize it in turns forever. Never where
   * another terminal owns the size (takesBackPtySize).
   */
  private scheduleReclaim() {
    if (!isPtySizeReclaimEnabled()) return;
    if (this.reclaimTimer) clearTimeout(this.reclaimTimer);
    this.reclaimTimer = setTimeout(() => {
      this.reclaimTimer = null;
      void this.reclaimPtySize();
    }, RECLAIM_SETTLE_MS);
  }

  private async reclaimPtySize() {
    const pty = this.ptySize;
    const cols = this.lastResizeWidth;
    const rows = this.lastResizeHeight;
    if (!isPtySizeReclaimEnabled()) return;
    if (!pty || cols <= 0 || rows <= 0 || this.resizeTimeout) return;
    if (!this.session || this.session.status === 'exited') return;
    if (!takesBackPtySize(this.session)) return;
    if (pty.cols === cols && pty.rows === rows) return;
    const now = Date.now();
    if (now - this.lastActivityAt > RECLAIM_ACTIVITY_MS) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    // Once per size the PTY has: a server that keeps its size gets no request on every tap.
    const attempt = `${pty.cols}x${pty.rows}>${cols}x${rows}`;
    if (this.lastReclaim?.attempt === attempt && now - this.lastReclaim.at < RECLAIM_RETRY_MS) {
      return;
    }
    this.lastReclaim = { attempt, at: now };
    logger.log(`PTY is ${pty.cols}x${pty.rows} from another client; taking back ${cols}x${rows}`);
    await this.sendResize(cols, rows);
  }

  private async sendResize(cols: number, rows: number): Promise<boolean> {
    if (!this.session) return false;
    try {
      const sent = terminalSocketClient.resize(this.session.id, cols, rows);
      if (!sent) {
        const response = await fetch(`/api/sessions/${this.session.id}/resize`, {
          method: HttpMethod.POST,
          headers: { 'Content-Type': 'application/json', ...authClient.getAuthHeader() },
          body: JSON.stringify({ cols: cols, rows: rows }),
        });

        if (!response.ok) {
          logger.warn(`failed to resize session: ${response.status}`);
          return false;
        }
      }

      this.lastResizeWidth = cols;
      this.lastResizeHeight = rows;
      return true;
    } catch (error) {
      logger.warn('failed to send resize request', error);
      return false;
    }
  }

  handleTerminalPaste(e: Event) {
    const customEvent = e as CustomEvent;
    const text = customEvent.detail?.text;
    if (text && this.session && this.inputManager) {
      this.inputManager.sendInputText(text);
    }
  }

  async resetTerminalSize() {
    if (!this.session) {
      logger.warn('resetTerminalSize called but no session available');
      return;
    }

    logger.log('Sending reset-size request for session', this.session.id);

    try {
      const response = await fetch(`/api/sessions/${this.session.id}/reset-size`, {
        method: HttpMethod.POST,
        headers: {
          'Content-Type': 'application/json',
          ...authClient.getAuthHeader(),
        },
      });

      if (!response.ok) {
        logger.error('failed to reset terminal size', {
          status: response.status,
          sessionId: this.session.id,
        });
      } else {
        logger.log('terminal size reset successfully for session', this.session.id);
      }
    } catch (error) {
      logger.error('error resetting terminal size', {
        error,
        sessionId: this.session.id,
      });
    }
  }

  cleanup() {
    if (this.resizeTimeout) {
      clearTimeout(this.resizeTimeout);
      this.resizeTimeout = null;
    }
    if (this.reclaimTimer) {
      clearTimeout(this.reclaimTimer);
      this.reclaimTimer = null;
    }
    this.ptySize = null;

    if (this.terminal && this.eventHandlers) {
      this.terminal.removeEventListener(
        'session-exit',
        this.eventHandlers.handleSessionExit as EventListener
      );
      this.terminal.removeEventListener(
        'terminal-resize',
        this.eventHandlers.handleTerminalResize as EventListener
      );
      this.terminal.removeEventListener(
        'terminal-paste',
        this.eventHandlers.handleTerminalPaste as EventListener
      );
    }

    this.terminal = null;
    this.connectionManager?.setTerminal(null);
    this.lastResizeWidth = 0;
    this.lastResizeHeight = 0;
  }
}
