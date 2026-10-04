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
import type { TerminalThemeId } from '../../utils/terminal-themes.js';
import type { Terminal } from '../terminal.js';
import type { ConnectionManager } from './connection-manager.js';
import type { InputManager } from './input-manager.js';

const logger = createLogger('terminal-lifecycle-manager');

/** The wait before a new size goes to the PTY, coalescing the resizes in between. */
export const RESIZE_DEBOUNCE_MS = 250;
/**
 * The same for a phone's soft keyboard going up or down (height only). The terminal already
 * shows the new rows locally, the bottom kept in place (terminal-grow.ts), so this only decides
 * when the app redraws for them: once, after the keyboard's resizes have settled. It was 400 ms,
 * which with the app's round trip left Claude's frame stale ~500 ms after the keyboard went
 * down. Any viewport resize meanwhile restarts the wait (keyboardStillMoving), so a keyboard
 * animation still ends in a single resize.
 */
export const KEYBOARD_RESIZE_DEBOUNCE_MS = 150;

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
  /** The pending PTY resize, run again later by keyboardStillMoving. */
  private pendingResize: (() => Promise<void>) | null = null;
  private pendingResizeDelay = 0;
  private lastResizeWidth = 0;
  private lastResizeHeight = 0;
  private localSizeDiverged = false;
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

    // Height-only changes on mobile come from the soft keyboard opening/closing. They must
    // reach the PTY: if the client shows fewer rows than the PTY has, full-screen TUIs such
    // as Claude Code draw below the visible area and the overflow piles up on the last row.
    // Each new size restarts the wait, so a keyboard animation makes a single resize.
    const debounceMs =
      isMobile && isHeightOnlyChange ? KEYBOARD_RESIZE_DEBOUNCE_MS : RESIZE_DEBOUNCE_MS;
    logger.debug(`scheduling resize ${cols}x${rows} in ${debounceMs}ms (source: ${source})`);

    // The local terminal may shrink and grow back within the debounce window (keyboard shown
    // and hidden quickly). The PTY never changed size, so the app never redraws, yet the local
    // shrink already pushed rows into scrollback and left the screen mangled.
    if (cols !== this.lastResizeWidth || rows !== this.lastResizeHeight) {
      this.localSizeDiverged = true;
    }

    this.schedulePtyResize(debounceMs, async () => {
      if (!this.session || this.session.status === 'exited') return;

      if (cols === this.lastResizeWidth && rows === this.lastResizeHeight) {
        if (!this.localSizeDiverged) {
          logger.debug(`skipping redundant resize request: ${cols}x${rows}`);
          return;
        }
        // Same final size: a same-size TIOCSWINSZ raises no SIGWINCH, so nudge the height
        // to make the app repaint for the size the client shows.
        logger.debug(`local size diverged and came back to ${cols}x${rows}; forcing a redraw`);
        if (rows > 1 && !(await this.sendResize(cols, rows - 1))) return;
      }

      if (await this.sendResize(cols, rows)) {
        this.localSizeDiverged = false;
      }
    });
  }

  /** Runs `send` after `delay` ms, in place of a resize still waiting. */
  private schedulePtyResize(delay: number, send: () => Promise<void>) {
    if (this.resizeTimeout) clearTimeout(this.resizeTimeout);
    this.pendingResize = send;
    this.pendingResizeDelay = delay;
    this.resizeTimeout = window.setTimeout(() => {
      this.resizeTimeout = null;
      this.pendingResize = null;
      window.visualViewport?.removeEventListener('resize', this.keyboardStillMoving);
      void send();
    }, delay) as unknown as number;
    window.visualViewport?.addEventListener('resize', this.keyboardStillMoving);
  }

  /**
   * The visual viewport changed again while a resize waits (the keyboard still animating, at
   * the same row count): the wait starts over, so the app redraws once, for where it lands.
   */
  private keyboardStillMoving = () => {
    if (!this.resizeTimeout || !this.pendingResize) {
      window.visualViewport?.removeEventListener('resize', this.keyboardStillMoving);
      return;
    }
    this.schedulePtyResize(this.pendingResizeDelay, this.pendingResize);
  };

  private async sendResize(cols: number, rows: number): Promise<boolean> {
    if (!this.session) return false;
    try {
      logger.debug(
        `sending resize request: ${cols}x${rows} (was ${this.lastResizeWidth}x${this.lastResizeHeight})`
      );
      const sent = terminalSocketClient.resize(this.session.id, cols, rows);
      if (!sent) {
        const response = await fetch(`/api/sessions/${this.session.id}/resize`, {
          method: HttpMethod.POST,
          headers: { 'Content-Type': 'application/json', ...authClient.getAuthHeader() },
          body: JSON.stringify({ cols, rows }),
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
      this.inputManager.sendPastedText(text);
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
    this.pendingResize = null;
    window.visualViewport?.removeEventListener('resize', this.keyboardStillMoving);

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
