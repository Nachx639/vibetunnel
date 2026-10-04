/**
 * Terminal Component
 *
 * Browser terminal rendering + input via ghostty-web (WASM + canvas).
 *
 * @fires terminal-ready - When terminal is initialized and ready
 * @fires terminal-input - When user types (detail: { text: string })
 * @fires terminal-resize - When terminal is resized (detail: { cols: number, rows: number, isMobile: boolean, isHeightOnlyChange: boolean, source: string })
 */

import { FitAddon, Terminal as GhosttyTerminal } from 'ghostty-web';
import { html, LitElement, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LocaleController, t } from '../i18n/index.js';
import { KeyboardShortcutLinkProvider } from '../utils/keyboard-shortcut-link-provider.js';
import { createLogger } from '../utils/logger.js';
import { TERMINAL_FONT_FAMILY, TERMINAL_IDS } from '../utils/terminal-constants.js';
import { TerminalPreferencesManager } from '../utils/terminal-preferences.js';
import { TERMINAL_THEMES, type TerminalThemeId } from '../utils/terminal-themes.js';
import { getCurrentTheme } from '../utils/theme-utils.js';
import { createGhostty } from './terminal-ghostty.js';

const logger = createLogger('terminal');

/** How long after a touch ends mouse events count as iOS's emulation of that touch. */
const EMULATED_MOUSE_MS = 1000;

/** Our scrollbar stays this long after the view stops moving. */
const SCROLLBAR_HIDE_MS = 1000;
/** Gap above and below its thumb's travel, and the thumb's least height (CSS px). */
const SCROLLBAR_INSET = 3;
const SCROLLBAR_MIN_THUMB = 24;

type TerminalResizeDetail = {
  cols: number;
  rows: number;
  isMobile: boolean;
  isHeightOnlyChange: boolean;
  source: string;
};

/**
 * What ghostty draws of the cursor: its cell, whether the app shows it, and the blink phase
 * (its renderer's own cursorVisible, toggled every 530 ms; not in its typings).
 */
function cursorKey(term: GhosttyTerminal): string {
  const cursor = term.wasmTerm?.getCursor();
  const blinkOn = (term.renderer as unknown as { cursorVisible?: boolean } | undefined)
    ?.cursorVisible;
  return cursor ? `${cursor.x},${cursor.y},${cursor.visible},${blinkOn}` : 'none';
}

@customElement('vibe-terminal')
export class Terminal extends LitElement {
  createRenderRoot() {
    return this as unknown as HTMLElement;
  }

  protected readonly i18n = new LocaleController(this);

  @property({ type: String }) sessionId = '';
  @property({ type: String }) sessionStatus = 'running';
  @property({ type: Number }) cols = 80;
  @property({ type: Number }) rows = 24;
  @property({ type: Number }) fontSize = 14;
  @property({ type: Boolean }) fitHorizontally = false;
  @property({ type: Number }) maxCols = 0; // 0 = unlimited
  @property({ type: String }) theme: TerminalThemeId = 'auto';
  @property({ type: Boolean }) disableClick = false;
  /**
   * Phone with the soft keyboard down: a transparent textarea covers the terminal so a tap
   * lands on a real field. iOS ignores a scripted focus() once the page lost keyboard focus
   * (after Done, or right after loading), so only a native tap reliably raises the keyboard.
   * Touches still bubble to the container, so scrolling keeps working.
   */
  @property({ type: Boolean }) keyboardCatcher = false;
  private catcher: HTMLTextAreaElement | null = null;
  @property({ type: Boolean }) hideScrollButton = false;
  @property({ type: Number }) initialCols = 0;
  @property({ type: Number }) initialRows = 0;

  private originalFontSize = 14;
  userOverrideWidth = false;

  @state() private followCursorEnabled = true;
  /**
   * Output came while the user read back: the view stayed put and the scroll-to-bottom button
   * says "New output" until the view is back at the bottom (by hand or with the button).
   */
  @state() private newOutput = false;

  private container: HTMLElement | null = null;
  private terminal: GhosttyTerminal | null = null;
  private fitAddon: FitAddon | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private themeObserver: MutationObserver | null = null;
  private pasteInput: HTMLTextAreaElement | null = null;
  private pendingOutput: string[] = [];
  private pendingFollowCursor = true;
  private preservedScrollPosition: number | null = null;
  private touchStartX = 0;
  private touchStartY = 0;
  private lastTouchY = 0;
  private touchScrollRemainder = 0;
  private touchScrolling = false;
  /** The touch scroll in progress goes to the app as wheel events (mouse reporting). */
  private touchScrollsApp = false;
  private canvasElement: HTMLCanvasElement | null = null;
  /** What ghostty's canvas shows, as the render hook last painted it. */
  private canvasRows: { viewportY: number; selection: boolean; cursor?: string } | null = null;
  /** A link hover or a selection changed what is drawn without dirtying a row. */
  private canvasStale = false;
  /** Our scrollbar beside the text (see updateScrollbar) and its thumb. */
  private scrollbar: HTMLElement | null = null;
  private scrollbarThumb: HTMLElement | null = null;
  private scrollbarHideTimer: ReturnType<typeof setTimeout> | null = null;
  /** A mouse dragging our scrollbar: which pointer, and where on the thumb it holds it. */
  private scrollbarGrab: { pointerId: number; offset: number } | null = null;

  private isMobile = false;
  private lastCols = 0;
  private lastRows = 0;

  private pendingResizeSource: string | null = null;
  private pendingResizePrev: { cols: number; rows: number } | null = null;
  private initializationId = 0;

  connectedCallback() {
    const prefs = TerminalPreferencesManager.getInstance();
    this.theme = prefs.getTheme();
    super.connectedCallback();
    window.addEventListener('vibetunnel-accent-changed', this.handleAccentChange);

    this.originalFontSize = this.fontSize;
    // Make host focusable so browser shortcuts (Cmd/Ctrl+V) have a target.
    if (this.tabIndex < 0) this.tabIndex = 0;

    // Restore user override preference
    if (this.sessionId) {
      this.restoreUserOverrideWidthFromStorage(this.sessionId);
    }

    // Watch for system theme changes (only when using auto theme)
    this.themeObserver = new MutationObserver(() => {
      if (this.terminal && this.theme === 'auto') {
        this.applyTheme();
      }
    });
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    if (this.hasUpdated && !this.terminal) {
      this.pasteInput = this.querySelector('.terminal-paste-input') as HTMLTextAreaElement | null;
      this.initializeTerminal();
    }
  }

  disconnectedCallback() {
    window.removeEventListener('vibetunnel-accent-changed', this.handleAccentChange);
    this.cleanup();
    this.themeObserver?.disconnect();
    this.themeObserver = null;
    super.disconnectedCallback();
  }

  firstUpdated() {
    this.pasteInput = this.querySelector('.terminal-paste-input') as HTMLTextAreaElement | null;
    this.initializeTerminal();
  }

  willUpdate(changed: PropertyValues) {
    // Back at the bottom, whatever brought it there: nothing below is new any more.
    if (changed.has('followCursorEnabled') && this.followCursorEnabled) this.newOutput = false;
  }

  updated(changed: PropertyValues) {
    if (changed.has('sessionId') && this.sessionId) {
      this.restoreUserOverrideWidthFromStorage(this.sessionId);
      this.requestResize('session-id-change');
    }

    if (changed.has('fontSize')) {
      if (!this.fitHorizontally) this.originalFontSize = this.fontSize;
      this.applyFontSize();
      this.requestResize('font-size-change');
    }

    if (changed.has('fitHorizontally')) {
      if (!this.fitHorizontally) this.fontSize = this.originalFontSize;
      this.requestResize('fit-mode-change');
    }

    if (changed.has('maxCols') || changed.has('initialCols') || changed.has('disableClick')) {
      this.requestResize('property-change');
    }

    if (changed.has('disableClick')) {
      this.syncNativeInputFocus();
    }

    if (changed.has('keyboardCatcher')) {
      this.syncKeyboardCatcher();
    }

    if (changed.has('theme')) {
      this.applyTheme();
    }
  }

  setUserOverrideWidth(override: boolean) {
    this.userOverrideWidth = override;

    if (this.sessionId) {
      try {
        localStorage.setItem(`terminal-width-override-${this.sessionId}`, String(override));
      } catch (error) {
        logger.warn('Failed to save terminal width preference to localStorage:', error);
      }
    }

    this.requestResize('user-override-width');
  }

  public handleFitToggle = () => {
    if (!this.fitHorizontally) this.originalFontSize = this.fontSize;
    this.fitHorizontally = !this.fitHorizontally;
    if (!this.fitHorizontally) this.fontSize = this.originalFontSize;
    this.requestResize('fit-toggle');
  };

  public write(data: string, followCursor = true) {
    if (!this.terminal) {
      this.pendingOutput.push(data);
      this.pendingFollowCursor = this.pendingFollowCursor && followCursor;
      return;
    }

    const shouldPreserveScroll = !this.followCursorEnabled && this.preservedScrollPosition === null;
    if (shouldPreserveScroll) {
      this.preservedScrollPosition = this.getScrollPosition();
    }

    if (this.preservedScrollPosition !== null) {
      const preservedScrollPosition = this.preservedScrollPosition;
      const anchor = this.historyAnchor(preservedScrollPosition);
      const lengthBefore = this.terminal.buffer.active.length;
      try {
        this.terminal.write(data);
        // ghostty-web scrolls to bottom synchronously during write(), so restore before paint.
        this.scrollToPosition(
          this.anchoredPosition(preservedScrollPosition, anchor, lengthBefore, data)
        );
        this.followCursorEnabled = false;
        this.newOutput = true;
        // The history grew: the thumb is a little shorter and higher.
        this.updateScrollbar(false);
      } finally {
        this.preservedScrollPosition = null;
      }
      return;
    }

    // ghostty-web already follows output; another smooth scroll per write queues badly on iOS.
    this.terminal.write(data);
  }

  /**
   * Up to 3 non-blank history rows among the top 12 of the view, as [rows below `top`, text]:
   * how write() finds the text the user was reading once the history drops its oldest rows.
   * Only history rows: those never change, and reading them is cheap. None (a blank top of the
   * view) keeps the plain index, as before.
   */
  private historyAnchor(top: number): Array<[number, string]> {
    const anchor: Array<[number, string]> = [];
    const terminal = this.terminal;
    if (!terminal) return anchor;
    const end = Math.min(this.getMaxScrollPosition(), top + Math.min(terminal.rows, 12));
    for (let row = top; row < end && anchor.length < 3; row++) {
      const text = terminal.buffer.active.getLine(row)?.translateToString(true);
      if (text) anchor.push([row - top, text]);
    }
    return anchor;
  }

  /**
   * Where the rows the view showed from `top` are after writing `data`. Usually the same
   * index, but ghostty-web keeps a small history (scrollbackLimit 10000 makes about 2000 rows at
   * 45 columns, 750 at 120) and makes room by dropping its oldest page at once (about 1000
   * rows at 45 columns): every row moves up by that many, and keeping the index jumped the
   * reader that far towards the bottom. The write can only have dropped between
   * -growth and (rows it could add) - growth rows, so only that window is searched.
   */
  private anchoredPosition(
    top: number,
    anchor: Array<[number, string]>,
    lengthBefore: number,
    data: string
  ): number {
    const terminal = this.terminal;
    if (!terminal || anchor.length === 0) return top;
    const buffer = terminal.buffer.active;
    const grown = buffer.length - lengthBefore;
    // At most one row per line feed and one per wrapped line.
    let feeds = 0;
    for (let i = data.indexOf('\n'); i !== -1; i = data.indexOf('\n', i + 1)) feeds++;
    const added = feeds + Math.ceil(data.length / Math.max(1, terminal.cols));
    const fewest = Math.max(0, -grown);
    const most = Math.min(top, Math.max(fewest, added - grown), fewest + 5000);
    for (let dropped = fewest; dropped <= most; dropped++) {
      const at = top - dropped;
      if (
        anchor.every(
          ([offset, text]) => buffer.getLine(at + offset)?.translateToString(true) === text
        )
      ) {
        return at;
      }
    }
    // The rows being read were dropped as well (even when a burst grew the history): the
    // oldest left are the nearest. If nothing could be dropped, the index stands.
    return most > 0 || fewest > 0 ? 0 : top;
  }

  public clear() {
    this.terminal?.clear();
    this.preservedScrollPosition = null;
    this.followCursorEnabled = true;
  }

  public setTerminalSize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;

    if (!this.terminal) return;
    this.requestResizeMeta('explicit-set-size');
    this.terminal.resize(cols, rows);
  }

  public scrollToBottom() {
    this.terminal?.scrollToBottom();
    this.followCursorEnabled = true;
  }

  /**
   * Whether the viewport is at (or near) the bottom, i.e. auto-following new output.
   * Becomes false when the user scrolls up to read history (incl. touch scroll), so
   * callers can avoid yanking the view back to the bottom while the user is reading.
   */
  public isFollowingCursor(): boolean {
    return this.followCursorEnabled;
  }

  public scrollToPosition(position: number) {
    if (!this.terminal) return;
    const max = this.getMaxScrollPosition();
    const clamped = Math.max(0, Math.min(max, Math.floor(position)));
    this.terminal.scrollToLine(max - clamped);
  }

  public queueCallback(callback: () => void) {
    requestAnimationFrame(() => callback());
  }

  /** True when the running app asked for bracketed paste (DECSET 2004). */
  public isBracketedPasteEnabled(): boolean {
    try {
      return this.terminal?.hasBracketedPaste() ?? false;
    } catch {
      return false;
    }
  }

  public getTerminalSize(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  public getVisibleRows(): number {
    return this.rows;
  }

  public getBufferSize(): number {
    if (!this.terminal) return 0;
    return this.terminal.buffer.active.length;
  }

  public getMaxScrollPosition(): number {
    if (!this.terminal) return 0;
    return Math.max(0, this.terminal.buffer.active.length - this.terminal.rows);
  }

  public getScrollPosition(): number {
    if (!this.terminal) return 0;
    const max = this.getMaxScrollPosition();
    const viewportFromBottom = this.terminal.getViewportY();
    return Math.round(Math.max(0, Math.min(max, max - viewportFromBottom)));
  }

  /**
   * Text of the last `maxLines` lines with empty cells read as spaces. Apps such as Claude
   * Code position words with cursor moves instead of writing spaces, and
   * translateToString() skips those empty cells ("Doyouwanttoproceed?").
   */
  public getScreenText(maxLines = 30): string {
    if (!this.terminal) return '';
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let row = Math.max(0, buffer.length - maxLines); row < buffer.length; row++) {
      const line = buffer.getLine(row);
      if (!line) continue;
      let text = '';
      for (let col = 0; col < line.length; col++) {
        const cell = line.getCell(col);
        if (!cell || cell.getWidth() === 0) continue;
        text += cell.getChars() || ' ';
      }
      lines.push(text.trimEnd());
    }
    return lines.join('\n');
  }

  // e2e-only debug API (canvas has no textContent)
  public getDebugText(options?: { maxLines?: number; trimRight?: boolean }): string {
    if (!this.terminal) return '';
    const maxLines = options?.maxLines ?? 250;
    const trimRight = options?.trimRight ?? true;

    const buffer = this.terminal.buffer.active;
    const end = buffer.length;
    const start = Math.max(0, end - maxLines);
    const lines: string[] = [];
    for (let i = start; i < end; i++) {
      const line = buffer.getLine(i);
      lines.push(line ? line.translateToString(trimRight) : '');
    }
    return lines.join('\n');
  }

  private restoreUserOverrideWidthFromStorage(sessionId: string) {
    try {
      const stored = localStorage.getItem(`terminal-width-override-${sessionId}`);
      if (stored !== null) this.userOverrideWidth = stored === 'true';
    } catch (error) {
      logger.warn('Failed to load terminal width preference from localStorage:', error);
    }
  }

  private handleTerminalTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      this.resetTouchScroll();
      return;
    }

    const touch = event.touches[0];
    this.touchStartX = touch.clientX;
    this.touchStartY = touch.clientY;
    this.lastTouchY = touch.clientY;
    this.touchScrollRemainder = 0;
    this.touchScrolling = false;
  };

  private handleTerminalTouchMove = (event: TouchEvent) => {
    if (event.touches.length !== 1) return;

    const touch = event.touches[0];
    const totalX = touch.clientX - this.touchStartX;
    const totalY = touch.clientY - this.touchStartY;

    if (!this.touchScrolling) {
      if (Math.abs(totalY) <= 6 || Math.abs(totalY) <= Math.abs(totalX)) return;
      this.touchScrolling = true;
      this.touchScrollsApp = this.appHandlesScrolling();
    }

    if (event.cancelable) event.preventDefault();

    this.touchScrollRows(touch.clientX, touch.clientY);
  };

  /**
   * One whole row each time the finger crosses a row's height. Apps that report the mouse get
   * those rows as wheel steps.
   */
  private touchScrollRows(clientX: number, clientY: number) {
    const lineHeight = this.rowHeight();
    this.touchScrollRemainder += this.lastTouchY - clientY;
    const lines = Math.trunc(this.touchScrollRemainder / lineHeight);
    this.lastTouchY = clientY;
    if (lines === 0) return;
    this.touchScrollRemainder -= lines * lineHeight;
    if (this.touchScrollsApp) {
      this.sendWheel(lines > 0 ? 'down' : 'up', Math.abs(lines), clientX, clientY);
    } else {
      this.terminal?.scrollLines(lines);
    }
  }

  private rowHeight(): number {
    return Math.max(1, this.terminal?.renderer?.getMetrics().height ?? this.fontSize * 1.2);
  }

  /** ghostty-web's canvas (the peek row is a canvas too); it keeps the same one while open. */
  private getCanvas(): HTMLCanvasElement | null {
    if (this.canvasElement?.parentElement !== this.container || !this.container) {
      this.canvasElement =
        this.container?.querySelector<HTMLCanvasElement>('canvas:not(.terminal-peek-row)') ?? null;
    }
    return this.canvasElement;
  }

  /** At the live bottom: no rows back. */
  private isAtBottom(): boolean {
    return (this.terminal?.getViewportY() ?? 0) <= 0.5;
  }

  /**
   * Full-screen apps that turn on mouse reporting (Claude Code, vim with mouse=a, htop)
   * scroll their own content. For them the local scrollback only holds stale copies of
   * earlier repaints, which is why scrolling up showed Claude Code's banner repeated.
   */
  private appHandlesScrolling(): boolean {
    try {
      return this.terminal?.hasMouseTracking() ?? false;
    } catch {
      return false;
    }
  }

  /** Encode a mouse report for the app at the pointer's cell (SGR or legacy X10). */
  private mouseReport(button: number, clientX: number, clientY: number, release = false): string {
    const terminal = this.terminal;
    if (!terminal) return '';
    const rect = this.getCanvas()?.getBoundingClientRect();
    const cell = (offset: number, size: number, count: number) =>
      rect && size > 0 ? Math.min(count, Math.max(1, Math.floor((offset / size) * count) + 1)) : 1;
    const col = cell(clientX - (rect?.left ?? 0), rect?.width ?? 0, terminal.cols);
    const row = cell(clientY - (rect?.top ?? 0), rect?.height ?? 0, terminal.rows);
    // DEC 9 (X10 compatibility) reports presses only.
    if (release && ![1000, 1002, 1003].some((mode) => terminal.getMode(mode))) return '';
    if (terminal.getMode(1006)) return `\x1b[<${button};${col};${row}${release ? 'm' : 'M'}`;
    // X10 has no per-button release: release is button 3. Reports travel as UTF-8 text, so
    // coordinates are capped at 95 to keep each byte below 128.
    const code = release ? 3 : button;
    return `\x1b[M${String.fromCharCode(32 + code, 32 + Math.min(col, 95), 32 + Math.min(row, 95))}`;
  }

  private sendToApp(text: string) {
    if (!text) return;
    this.dispatchEvent(new CustomEvent('terminal-input', { detail: { text }, bubbles: true }));
  }

  /** Report wheel steps to the app at the pointer's cell. */
  private sendWheel(direction: 'up' | 'down', steps: number, clientX: number, clientY: number) {
    if (steps <= 0) return;
    this.sendToApp(this.mouseReport(direction === 'up' ? 64 : 65, clientX, clientY).repeat(steps));
  }

  /**
   * A tap or plain click is a left click for apps that track the mouse, so on-screen
   * controls (Claude Code's "Jump to bottom", its input cursor) react where you touched.
   */
  private sendClick(clientX: number, clientY: number) {
    if (!this.appHandlesScrolling()) return;
    this.sendToApp(
      this.mouseReport(0, clientX, clientY) + this.mouseReport(0, clientX, clientY, true)
    );
  }

  private mouseDownAt: { x: number; y: number } | null = null;

  /** When the last touch ended; iOS follows a tap with emulated mouse events at the same spot. */
  private lastTouchEndAt = Number.NEGATIVE_INFINITY;

  private noteTouchEnd = () => {
    this.lastTouchEndAt = performance.now();
  };

  /**
   * A tap used to send apps two clicks, one from touchend and one from the mouse events iOS
   * emulates right after it. Claude Code read them as a double click and selected a word (or,
   * after two taps, a whole line) and copied it. The touch already sent its click, so mouse
   * events this soon after a touch are ignored.
   */
  private isEmulatedMouse(): boolean {
    return performance.now() - this.lastTouchEndAt < EMULATED_MOUSE_MS;
  }

  private handleContainerMouseDown = (event: MouseEvent) => {
    this.mouseDownAt =
      event.button === 0 && !this.isEmulatedMouse() ? { x: event.clientX, y: event.clientY } : null;
  };

  private handleContainerMouseUp = (event: MouseEvent) => {
    const start = this.mouseDownAt;
    this.mouseDownAt = null;
    // Drags select text; only a still, unmodified click goes to the app (Shift/Cmd/Ctrl/Alt
    // keep it local, as in native terminals).
    if (!start || Math.abs(event.clientX - start.x) > 3 || Math.abs(event.clientY - start.y) > 3) {
      return;
    }
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    this.sendClick(event.clientX, event.clientY);
  };

  private wheelRemainder = 0;

  private handleWheel = (event: WheelEvent): boolean => {
    // Shift+wheel scrolls the local scrollback even when the app tracks the mouse.
    if (event.shiftKey || !this.appHandlesScrolling()) return false;
    const rowHeight = this.terminal?.renderer?.getMetrics().height ?? this.fontSize * 1.2;
    const delta =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * rowHeight
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * rowHeight * (this.terminal?.rows ?? 24)
          : event.deltaY;
    this.wheelRemainder += delta;
    const steps = Math.trunc(this.wheelRemainder / rowHeight);
    if (steps !== 0) {
      this.wheelRemainder -= steps * rowHeight;
      this.sendWheel(steps > 0 ? 'down' : 'up', Math.abs(steps), event.clientX, event.clientY);
    }
    return true;
  };

  private resetTouchScroll = () => {
    this.touchScrolling = false;
    this.touchScrollRemainder = 0;
  };

  private handleTerminalTouchEnd = (event: TouchEvent) => {
    const touch = event.changedTouches[0];
    const isTap =
      !this.touchScrolling &&
      event.touches.length === 0 &&
      touch !== undefined &&
      Math.abs(touch.clientX - this.touchStartX) < 10 &&
      Math.abs(touch.clientY - this.touchStartY) < 10;
    this.resetTouchScroll();
    if (isTap && touch) this.sendClick(touch.clientX, touch.clientY);
    if (isTap) {
      // Dispatched synchronously inside touchend so listeners can still open the iOS keyboard.
      // With the catcher up, the tap focuses it natively and that opens the keyboard.
      this.dispatchEvent(
        new CustomEvent('terminal-tap', {
          bubbles: true,
          composed: true,
          detail: { keyboardCatcher: this.keyboardCatcher },
        })
      );
    }
  };

  /**
   * ghostty-web focuses its own textarea on every canvas touchend. When the session view owns
   * the soft keyboard (disableClick: mobile direct-keyboard mode) that opened the iOS keyboard
   * without quick keys, with the form-assistant bar, and with the layout never adjusting.
   */
  private syncNativeInputFocus() {
    // ghostty-web also makes its container contenteditable and focuses it on open: when
    // that happened inside a gesture (swiping to another session) iOS raised its own
    // keyboard for the container.
    const container = this.container;
    if (container) {
      container.setAttribute('contenteditable', this.disableClick ? 'false' : 'true');
      if (this.disableClick && document.activeElement === container) container.blur();
    }
    const textarea = container?.querySelector('textarea');
    if (!textarea) return;
    if (this.disableClick) {
      textarea.readOnly = true;
      textarea.tabIndex = -1;
      textarea.setAttribute('inputmode', 'none');
      textarea.focus = () => {};
      if (document.activeElement === textarea) textarea.blur();
    } else {
      Reflect.deleteProperty(textarea, 'focus');
      textarea.readOnly = false;
      textarea.tabIndex = 0;
      textarea.removeAttribute('inputmode');
    }
  }

  private syncKeyboardCatcher() {
    const container = this.container;
    if (!container) return;
    if (!this.catcher) {
      const catcher = document.createElement('textarea');
      catcher.className = 'keyboard-catcher';
      catcher.rows = 1;
      catcher.tabIndex = -1;
      catcher.setAttribute('aria-hidden', 'true');
      catcher.setAttribute('autocomplete', 'off');
      catcher.setAttribute('autocapitalize', 'none');
      catcher.setAttribute('autocorrect', 'off');
      catcher.setAttribute('spellcheck', 'false');
      catcher.style.cssText =
        'position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0;border:0;outline:none;' +
        'resize:none;opacity:0.01;font-size:16px;color:transparent;background:transparent;' +
        'caret-color:transparent;z-index:2;-webkit-user-select:none;user-select:none;' +
        '-webkit-touch-callout:none;touch-action:pinch-zoom;';
      catcher.addEventListener('focus', () => {
        this.dispatchEvent(
          new CustomEvent('terminal-keyboard-request', { bubbles: true, composed: true })
        );
      });
      this.catcher = catcher;
    }
    if (this.catcher.parentElement !== container) {
      if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
      container.appendChild(this.catcher);
    }
    this.catcher.style.display = this.keyboardCatcher ? 'block' : 'none';
    if (!this.keyboardCatcher && document.activeElement === this.catcher) this.catcher.blur();
  }

  private attachTouchScrollHandlers() {
    this.container?.addEventListener('touchstart', this.handleTerminalTouchStart, {
      passive: true,
    });
    this.container?.addEventListener('touchmove', this.handleTerminalTouchMove, {
      passive: false,
    });
    this.container?.addEventListener('touchend', this.handleTerminalTouchEnd, { passive: true });
    this.container?.addEventListener('touchend', this.noteTouchEnd, { passive: true });
    this.container?.addEventListener('mousedown', this.handleContainerMouseDown);
    this.container?.addEventListener('mouseup', this.handleContainerMouseUp);
    this.container?.addEventListener('touchcancel', this.resetTouchScroll, { passive: true });
  }

  private detachTouchScrollHandlers() {
    this.container?.removeEventListener('touchstart', this.handleTerminalTouchStart);
    this.container?.removeEventListener('touchmove', this.handleTerminalTouchMove);
    this.container?.removeEventListener('touchend', this.handleTerminalTouchEnd);
    this.container?.removeEventListener('touchend', this.noteTouchEnd);
    this.container?.removeEventListener('mousedown', this.handleContainerMouseDown);
    this.container?.removeEventListener('mouseup', this.handleContainerMouseUp);
    this.container?.removeEventListener('touchcancel', this.resetTouchScroll);
  }

  private cleanup() {
    this.initializationId++;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.detachTouchScrollHandlers();
    this.canvasElement = null;
    this.canvasRows = null;
    this.canvasStale = false;
    if (this.scrollbarHideTimer) clearTimeout(this.scrollbarHideTimer);
    this.scrollbarHideTimer = null;
    this.scrollbar = null;
    this.scrollbarThumb = null;
    this.scrollbarGrab = null;

    this.terminal?.dispose();
    this.terminal = null;
    this.fitAddon = null;
    this.catcher?.remove();
    this.catcher = null;
    this.container = null;
    this.pasteInput = null;
    this.preservedScrollPosition = null;
  }

  private requestResize(source: string) {
    requestAnimationFrame(() => this.fitTerminal(source));
  }

  private requestResizeMeta(source: string) {
    this.pendingResizeSource = source;
    this.pendingResizePrev = { cols: this.lastCols || this.cols, rows: this.lastRows || this.rows };
  }

  private applyFontSize() {
    if (!this.terminal) return;
    this.terminal.options.fontSize = this.fontSize;
  }

  private getResolvedTheme() {
    const effectiveTheme = this.theme === 'auto' ? getCurrentTheme() : this.theme;
    const themeId: TerminalThemeId = effectiveTheme === 'dark' ? 'dark' : 'light';

    const selected =
      this.theme === 'auto'
        ? TERMINAL_THEMES.find((t) => t.id === themeId)
        : TERMINAL_THEMES.find((t) => t.id === this.theme);

    // ghostty-web paints on a canvas, which can't resolve var(--color-*): resolve them here.
    const colors = selected?.colors ?? {};
    const root = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      Object.entries(colors).map(([key, value]) => {
        const name = typeof value === 'string' ? /^var\((--[\w-]+)\)$/.exec(value)?.[1] : undefined;
        return [key, name ? root.getPropertyValue(name).trim() || value : value];
      })
    ) as typeof colors;
  }

  /** The cursor follows the color theme. */
  private handleAccentChange = () => this.applyTheme();

  private applyTheme() {
    if (!this.terminal) return;
    const theme = this.getResolvedTheme();
    this.terminal.options.theme = theme;
    // The canvas is a whole number of cells wide; paint the leftover strip in the terminal
    // background instead of the page background.
    if (this.container && theme.background) this.container.style.background = theme.background;
  }

  private detectMobile() {
    const MOBILE_BREAKPOINT = 768;
    this.isMobile = window.innerWidth < MOBILE_BREAKPOINT;
  }

  private applyHorizontalFit() {
    if (!this.terminal || !this.container) return;
    const renderer = this.terminal.renderer;
    if (!renderer) return;

    const metrics = renderer.getMetrics();
    const charWidth = metrics?.width || renderer.charWidth || 8;
    const containerWidth = this.container.clientWidth || 0;
    if (containerWidth <= 0 || charWidth <= 0 || this.cols <= 0) return;

    const targetCharWidth = containerWidth / this.cols;
    const scale = targetCharWidth / charWidth;
    const newFontSize = Math.max(8, Math.min(32, this.fontSize * scale));
    if (!Number.isFinite(newFontSize)) return;
    this.fontSize = newFontSize;
    this.terminal.options.fontSize = newFontSize;
  }

  private computeConstrainedCols(proposedCols: number): number {
    const calculatedCols = Math.max(20, Math.floor(proposedCols));
    const isTunneledSession = this.sessionId.startsWith('fwd_');

    if (this.maxCols > 0) return Math.min(calculatedCols, this.maxCols);
    if (this.userOverrideWidth) return calculatedCols;
    if (this.initialCols > 0 && isTunneledSession)
      return Math.min(calculatedCols, this.initialCols);
    return calculatedCols;
  }

  public fitTerminal(source = 'unknown') {
    if (!this.terminal || !this.fitAddon) return;
    this.detectMobile();

    if (this.fitHorizontally) {
      this.applyHorizontalFit();
    }

    const proposed = this.fitAddon.proposeDimensions();
    if (!proposed) return;

    const cols = this.computeConstrainedCols(proposed.cols);
    const rows = Math.max(6, Math.floor(proposed.rows));

    const prevCols = this.lastCols || this.terminal.cols;
    const prevRows = this.lastRows || this.terminal.rows;

    if (cols === prevCols && rows === prevRows) return;

    this.requestResizeMeta(source);
    this.terminal.resize(cols, rows);
  }

  private async initializeTerminal() {
    if (this.terminal) return;
    const initializationId = ++this.initializationId;

    const container = this.querySelector(
      `#${TERMINAL_IDS.TERMINAL_CONTAINER}`
    ) as HTMLElement | null;
    if (!container) return;
    this.container = container;

    try {
      // A WASM instance of its own: on one shared instance, a new terminal could show the
      // previous session's text (see createGhostty). Only the terminal keeps it, so it goes
      // when the terminal is disposed, or right away if this initialization is abandoned.
      const ghostty = await createGhostty();
      if (
        initializationId !== this.initializationId ||
        !this.isConnected ||
        this.container !== container
      )
        return;

      const theme = this.getResolvedTheme();
      const term = new GhosttyTerminal({
        cols: this.cols,
        rows: this.rows,
        fontSize: this.fontSize,
        fontFamily: TERMINAL_FONT_FAMILY,
        theme,
        cursorBlink: true,
        smoothScrollDuration: 120,
        disableStdin: true,
        ghostty,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      term.onData((text) => {
        this.dispatchEvent(new CustomEvent('terminal-input', { detail: { text }, bubbles: true }));
      });

      term.onResize(({ cols, rows }) => {
        const prev = this.pendingResizePrev ?? {
          cols: this.lastCols || cols,
          rows: this.lastRows || rows,
        };
        const source = this.pendingResizeSource ?? 'unknown';
        this.pendingResizePrev = null;
        this.pendingResizeSource = null;

        const isHeightOnlyChange = cols === prev.cols && rows !== prev.rows;

        this.lastCols = cols;
        this.lastRows = rows;
        this.cols = cols;
        this.rows = rows;

        const detail: TerminalResizeDetail = {
          cols,
          rows,
          isMobile: this.isMobile,
          isHeightOnlyChange,
          source,
        };

        this.dispatchEvent(new CustomEvent('terminal-resize', { detail, bubbles: true }));
      });

      term.onScroll(() => {
        if (this.preservedScrollPosition !== null) return;
        this.followCursorEnabled = this.isAtBottom();
        this.updateScrollbar(true);
      });

      // Fresh mount
      container.innerHTML = '';
      term.open(container);
      this.hookRenders(term);
      this.dropGhosttyScrollbar(term, container);
      this.createScrollbar(container);
      term.registerLinkProvider(new KeyboardShortcutLinkProvider(term, this.handleShortcutClick));
      term.attachCustomWheelEventHandler(this.handleWheel);

      this.terminal = term;
      this.fitAddon = fitAddon;

      // Size first, then initialize every cell. That alone left another session's text in the
      // history; the terminal's own WASM instance (createGhostty) is what keeps it out.
      this.fitTerminal('initial');
      term.clear();

      // ghostty-web does not translate touch pans into scrollback movement.
      this.attachTouchScrollHandlers();
      this.syncNativeInputFocus();
      this.syncKeyboardCatcher();
      this.applyTheme();

      if (this.pendingOutput.length > 0) {
        const pending = this.pendingOutput.join('');
        const followCursor = this.pendingFollowCursor;
        this.pendingOutput = [];
        this.pendingFollowCursor = true;
        this.terminal.write(pending, () => {
          if (followCursor && this.followCursorEnabled) {
            this.terminal?.scrollToBottom();
          }
        });
      }

      this.setAttribute('data-ready', 'true');

      // Follow up after layout settles; this should normally be a no-op.
      this.requestResize('initial');

      this.dispatchEvent(new CustomEvent('terminal-ready', { bubbles: true }));

      // Observe container resizes
      this.resizeObserver = new ResizeObserver(() => this.requestResize('resize-observer'));
      this.resizeObserver.observe(this.container);
    } catch (error) {
      logger.error('failed to initialize ghostty terminal', error);
    }
  }

  /**
   * Wraps ghostty-web's renderer.render, which its requestAnimationFrame loop calls on every
   * frame. ghostty-web 0.4 redraws every row on each call while the view is scrolled back
   * (render() marks all rows dirty when viewportY > 0), even when nothing changed: reading the
   * history kept a phone redrawing rows × cols glyphs 60 times a second, fetching each row from
   * the WASM again, and a touch scroll had to share the main thread with that. A frame
   * identical to the last one painted is skipped: same scrolled-back line, nothing written
   * since (the WASM's dirty state), no selection, no link hover change. ghostty's scrollbar
   * fade loops render on their own every frame for 200 ms: as its scrollbar is never painted
   * (see dropGhosttyScrollbar), those frames are skipped too. At the bottom ghostty only
   * redraws what changed (and the blinking cursor): left alone.
   */
  private hookRenders(term: GhosttyTerminal) {
    const renderer = term.renderer;
    if (!renderer) return;
    const render = renderer.render.bind(renderer);
    this.canvasRows = null;
    // Hovering a link (desktop) or selecting changes what is drawn without dirtying a row.
    const setHoveredHyperlinkId = renderer.setHoveredHyperlinkId.bind(renderer);
    renderer.setHoveredHyperlinkId = (id) => {
      this.canvasStale = true;
      setHoveredHyperlinkId(id);
    };
    const setHoveredLinkRange = renderer.setHoveredLinkRange.bind(renderer);
    renderer.setHoveredLinkRange = (range) => {
      this.canvasStale = true;
      setHoveredLinkRange(range);
    };
    term.onSelectionChange(() => {
      this.canvasStale = true;
    });

    renderer.render = (buffer, forceAll, viewportY, scrollback) => {
      const line = viewportY ?? term.getViewportY();
      // A selection ghostty clears says nothing: one more paint after it takes the highlight off.
      const selection = term.hasSelection();
      // At the bottom ghostty draws the cursor, and with cursorBlink it repainted the cursor's
      // row on every frame (reading the whole screen from the WASM for it): in a full-screen
      // app such as Claude Code, where a touch scroll only sends wheel steps, a phone rendered
      // the canvas on almost every frame. What it draws only changes with the cursor's place
      // or visibility, or a blink (every 530 ms).
      const cursor = line > 0 ? undefined : cursorKey(term);
      const painted = this.canvasRows;
      if (
        !forceAll &&
        !this.canvasStale &&
        !selection &&
        painted !== null &&
        !painted.selection &&
        painted.viewportY === line &&
        painted.cursor === cursor &&
        term.wasmTerm?.isDirty() === false
      ) {
        return;
      }
      this.canvasStale = false;
      this.canvasRows = { viewportY: line, selection, cursor };
      // Scrollbar opacity 0: ghostty paints none on the canvas (see dropGhosttyScrollbar).
      render(buffer, forceAll, line, scrollback, 0);
    };
  }

  /**
   * ghostty-web paints its scrollbar on the canvas, over the last columns, after clearing a
   * 14 px strip of them with the background (renderScrollbar): while it showed, the last
   * letters of every row were gone. The render hook never lets it paint (opacity 0); its mouse
   * zone goes too (the last 12 px of the canvas, where a click scrolled instead of selecting).
   * Ours stands beside the text instead (updateScrollbar).
   */
  private dropGhosttyScrollbar(term: GhosttyTerminal, container: HTMLElement) {
    const onMouseDown = (term as unknown as { handleMouseDown?: EventListener }).handleMouseDown;
    if (typeof onMouseDown === 'function') {
      container.removeEventListener('mousedown', onMouseDown, { capture: true });
    }
  }

  private createScrollbar(container: HTMLElement) {
    const bar = document.createElement('div');
    bar.className = 'terminal-scrollbar';
    bar.setAttribute('aria-hidden', 'true');
    const thumb = document.createElement('div');
    thumb.className = 'terminal-scrollbar-thumb';
    bar.appendChild(thumb);
    bar.addEventListener('pointerdown', this.handleScrollbarPointerDown);
    bar.addEventListener('pointermove', this.handleScrollbarPointerMove);
    bar.addEventListener('pointerup', this.handleScrollbarPointerUp);
    bar.addEventListener('pointercancel', this.handleScrollbarPointerUp);
    container.appendChild(bar);
    this.scrollbar = bar;
    this.scrollbarThumb = thumb;
  }

  /** Where our scrollbar and its thumb go for the view as it is now; null: no history. */
  private scrollbarLayout() {
    const term = this.terminal;
    const metrics = term?.renderer?.getMetrics();
    const history = this.getMaxScrollPosition();
    if (!term || !metrics || history <= 0) return null;
    const height = term.rows * metrics.height;
    const track = Math.max(0, height - SCROLLBAR_INSET * 2);
    const thumb = Math.min(
      track,
      Math.max(SCROLLBAR_MIN_THUMB, (track * term.rows) / (history + term.rows))
    );
    // How far the top of the view is from the oldest row.
    const fromTop = (history - Math.round(term.getViewportY())) * metrics.height;
    const fraction = Math.max(0, Math.min(1, fromTop / (history * metrics.height)));
    const ratio = window.devicePixelRatio || 1;
    return {
      // Right of the last column: FitAddon leaves 15 px there when it counts the columns, so
      // the bar showing or not never changes them.
      left: term.cols * metrics.width,
      height,
      track,
      thumb,
      top: Math.round((SCROLLBAR_INSET + (track - thumb) * fraction) * ratio) / ratio,
      history,
    };
  }

  /** Lays our scrollbar out for the view; `flash` shows it until the view rests a second. */
  private updateScrollbar(flash: boolean) {
    const bar = this.scrollbar;
    const thumb = this.scrollbarThumb;
    if (!bar || !thumb) return;
    const layout = this.scrollbarLayout();
    if (!layout) {
      bar.classList.remove('visible');
      return;
    }
    bar.style.left = `${layout.left}px`;
    bar.style.height = `${layout.height}px`;
    thumb.style.height = `${layout.thumb}px`;
    thumb.style.transform = `translate3d(0, ${layout.top}px, 0)`;
    if (!flash) return;
    bar.classList.add('visible');
    if (this.scrollbarHideTimer) clearTimeout(this.scrollbarHideTimer);
    this.scrollbarHideTimer = setTimeout(() => {
      this.scrollbarHideTimer = null;
      bar.classList.remove('visible');
    }, SCROLLBAR_HIDE_MS);
  }

  /** A mouse drags our scrollbar; it takes no touches (fingers scroll the terminal through it). */
  private handleScrollbarPointerDown = (event: PointerEvent) => {
    const bar = this.scrollbar;
    const layout = this.scrollbarLayout();
    if (!bar || !layout || event.pointerType === 'touch' || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const y = event.clientY - bar.getBoundingClientRect().top;
    const onThumb = y >= layout.top && y <= layout.top + layout.thumb;
    // Off the thumb, it jumps under the pointer first, as ghostty's did on its track.
    this.scrollbarGrab = {
      pointerId: event.pointerId,
      offset: onThumb ? y - layout.top : layout.thumb / 2,
    };
    bar.setPointerCapture?.(event.pointerId);
    bar.classList.add('dragging');
    if (!onThumb) this.dragScrollbarTo(y);
  };

  private handleScrollbarPointerMove = (event: PointerEvent) => {
    const bar = this.scrollbar;
    if (!bar || this.scrollbarGrab?.pointerId !== event.pointerId) return;
    this.dragScrollbarTo(event.clientY - bar.getBoundingClientRect().top);
  };

  private handleScrollbarPointerUp = (event: PointerEvent) => {
    if (this.scrollbarGrab?.pointerId !== event.pointerId) return;
    this.scrollbarGrab = null;
    this.scrollbar?.classList.remove('dragging');
    this.updateScrollbar(true);
  };

  /** Scrolls so that the point the mouse holds on the thumb sits `y` px down the bar. */
  private dragScrollbarTo(y: number) {
    const layout = this.scrollbarLayout();
    const grab = this.scrollbarGrab;
    if (!layout || !grab || layout.track <= layout.thumb) return;
    const fraction = (y - grab.offset - SCROLLBAR_INSET) / (layout.track - layout.thumb);
    this.scrollToPosition(Math.round(Math.max(0, Math.min(1, fraction)) * layout.history));
  }

  private handleScrollToBottom = () => this.scrollToBottom();

  private handleShortcutClick = (controlCharacter: string) => {
    if (this.disableClick) return;

    this.dispatchEvent(
      new CustomEvent('terminal-input', {
        detail: { text: controlCharacter },
        bubbles: true,
      })
    );
  };

  private handleClick = (e: MouseEvent) => {
    if (this.disableClick) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('a[href]')) {
      // Keep native link behavior (especially important on mobile browsers).
      return;
    }
    const selection = document.getSelection();
    if (selection && selection.toString().length > 0) return;
    this.focus();
    this.pasteInput?.focus();
    this.pasteInput?.select();
  };

  private handlePaste = (e: ClipboardEvent) => {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) return; // let file/image paste handlers run

    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;

    e.preventDefault();
    e.stopPropagation();

    // Clear hidden textarea so it doesn't accumulate text
    if (this.pasteInput) this.pasteInput.value = '';

    this.dispatchEvent(new CustomEvent('terminal-paste', { detail: { text }, bubbles: true }));
  };

  /**
   * Return the rendered cursor position relative to the session terminal.
   * Desktop IME inputs use this to place the native candidate window at the cursor.
   */
  public getCursorInfo(): { x: number; y: number } | null {
    if (!this.terminal || !this.container) return null;

    try {
      const renderer = this.terminal.renderer;
      if (!renderer) return null;

      const metrics = renderer.getMetrics();
      const charWidth = metrics?.width || renderer.charWidth || 8;
      const charHeight = metrics?.height || renderer.charHeight || this.fontSize * 1.2;
      if (charWidth <= 0 || charHeight <= 0) return null;

      const buffer = this.terminal.buffer.active;
      const terminalRect = this.container.getBoundingClientRect();
      const absoluteX = terminalRect.left + buffer.cursorX * charWidth;
      const absoluteY = terminalRect.top + buffer.cursorY * charHeight;

      const sessionTerminal = document.getElementById(TERMINAL_IDS.SESSION_TERMINAL);
      if (!sessionTerminal) {
        return { x: absoluteX, y: absoluteY };
      }

      const sessionRect = sessionTerminal.getBoundingClientRect();
      return {
        x: absoluteX - sessionRect.left,
        y: absoluteY - sessionRect.top,
      };
    } catch (error) {
      logger.warn('Failed to get terminal cursor position:', error);
      return null;
    }
  }

  /**
   * Get the current input line (text the user has typed on the current line).
   * Used to sync chat mode input with the terminal state.
   */
  public getCurrentInputLine(): string {
    if (!this.terminal) return '';

    try {
      const buffer = this.terminal.buffer.active;
      const lineIndex = buffer.baseY + buffer.cursorY;
      const line = buffer.getLine(lineIndex);
      if (!line) return '';

      const lineText = line.translateToString(true).replace(/\s+$/g, '');
      if (!lineText.trim()) return '';

      const promptMatch = lineText.match(/[>$#%➜❯]\s*([^>$#%➜❯│┃|]*)/);
      if (promptMatch?.[1]) {
        const input = promptMatch[1]
          .replace(/[│┃┆┇┊┋|]/g, '')
          .replace(/\s+$/g, '')
          .trim();
        if (input && this.isPlaceholderText(input)) return '';
        return input;
      }

      return '';
    } catch (error) {
      logger.warn('Failed to get current input line:', error);
      return '';
    }
  }

  private isPlaceholderText(text: string): boolean {
    const lowerText = text.toLowerCase();

    if (
      lowerText.startsWith('type your message') ||
      lowerText.startsWith('type a message') ||
      lowerText.includes('@path/to/file') ||
      lowerText.includes('@path to file')
    ) {
      return true;
    }

    if (lowerText.startsWith('try "') || lowerText.startsWith("try '")) {
      return true;
    }

    if (
      lowerText.startsWith('enter your') ||
      lowerText.startsWith('enter a ') ||
      lowerText.startsWith('press enter') ||
      lowerText.startsWith('type here')
    ) {
      return true;
    }

    return false;
  }

  render() {
    return html`
      <style>
        vibe-terminal {
          display: block;
          width: 100%;
          height: 100%;
        }
        .terminal-root {
          position: relative;
          width: 100%;
          height: 100%;
        }
        .terminal-container {
          width: 100%;
          height: 100%;
          overflow: hidden;
          font-family: ${TERMINAL_FONT_FAMILY};
          /* Own one-finger pans for scrollback while retaining two-finger page zoom. */
          touch-action: pinch-zoom;
          -webkit-user-select: text;
          user-select: text;
        }
        .terminal-paste-input {
          position: absolute;
          left: -9999px;
          top: 0;
          width: 1px;
          height: 1px;
          opacity: 0;
          pointer-events: none;
        }
        /* Own class: the global .scroll-to-bottom styles (legacy 48px box, text-2xl,
           left-anchored) overflowed this button off the left edge on phones. */
        .terminal-scroll-bottom {
          position: absolute;
          right: 12px;
          bottom: 12px;
          z-index: 20;
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 6px 12px;
          font: 500 13px/1 ${TERMINAL_FONT_FAMILY};
          color: #fff;
          background: rgba(0, 0, 0, 0.6);
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 999px;
          -webkit-user-select: none;
          user-select: none;
          touch-action: manipulation;
        }
        .terminal-scroll-bottom.has-new-output {
          background: var(--color-primary, #10b981);
          border-color: transparent;
        }
        /* Beside the text, never over it (see updateScrollbar); fingers scroll through it. */
        .terminal-scrollbar {
          position: absolute;
          top: 0;
          width: 12px;
          z-index: 1;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.3s ease-out;
        }
        .terminal-scrollbar.visible {
          opacity: 1;
          transition: none;
        }
        .terminal-scrollbar-thumb {
          position: absolute;
          top: 0;
          left: 4px;
          width: 4px;
          border-radius: 2px;
          background: rgba(128, 128, 128, 0.6);
        }
        /* A mouse can grab it: the strip beside the last column holds no text. */
        @media (hover: hover) and (pointer: fine) {
          .terminal-scrollbar {
            pointer-events: auto;
          }
          .terminal-scrollbar:hover,
          .terminal-scrollbar.dragging {
            opacity: 1;
            transition: none;
          }
          .terminal-scrollbar:hover .terminal-scrollbar-thumb,
          .terminal-scrollbar.dragging .terminal-scrollbar-thumb {
            left: 3px;
            width: 6px;
            border-radius: 3px;
          }
        }
      </style>

      <div class="terminal-root" @click=${this.handleClick} @paste=${this.handlePaste}>
        <textarea
          id=${TERMINAL_IDS.TERMINAL_INPUT}
          class="terminal-paste-input"
          aria-label=${t('terminal.input')}
          data-testid="terminal-input"
          tabindex="-1"
          autocapitalize="off"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
          @paste=${this.handlePaste}
        ></textarea>
        <div
          id=${TERMINAL_IDS.TERMINAL_CONTAINER}
          class="terminal-container"
          style="view-transition-name: session-${this.sessionId};"
        ></div>

        ${
          !this.hideScrollButton && !this.followCursorEnabled
            ? html`
              <button
                type="button"
                class="terminal-scroll-bottom ${this.newOutput ? 'has-new-output' : ''}"
                data-testid="terminal-scroll-bottom"
                aria-label=${t(this.newOutput ? 'terminal.scrollToNewOutput' : 'terminal.scrollToBottom')}
                @click=${this.handleScrollToBottom}
              >
                ↓ ${t(this.newOutput ? 'terminal.newOutput' : 'terminal.bottom')}
              </button>
            `
            : null
        }
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'vibe-terminal': Terminal;
  }
}
