/**
 * Phone Session Row
 *
 * One session as a chat-list row (think messaging app): avatar, name, time and the working
 * directory. Used by session-list in the compact phone layout (utils/phone-ui.ts) instead of
 * the large terminal-preview cards, which fit two sessions per screen.
 *
 * Swipe left reveals Rename / Kill (Clear when exited) behind the row.
 * Long-press (or the ⋯ button) opens actions: open, rename, pin, and kill a running session
 * (after a confirmation step) or clear an exited one.
 *
 * @fires session-select - When the row is tapped (detail: Session)
 * @fires session-killed - When the session was killed or cleared (detail: { sessionId, session })
 * @fires session-kill-error - When killing failed (detail: { sessionId, error })
 * @fires session-renamed - When the session was renamed (detail: { sessionId, newName })
 * @fires session-rename-error - When renaming failed (detail: { sessionId, error })
 * @fires session-pin-toggle - Pin/Unpin from the action sheet (detail: { sessionId, pinned })
 */

import { html, LitElement, nothing, render } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { compactDetail } from '../../shared/claude-screen.js';
import type { Session } from '../../shared/types.js';
import { getLocale, LocaleController, t } from '../i18n/index.js';
import type { AuthClient } from '../services/auth-client.js';
import { sessionActionService } from '../services/session-action-service.js';
import { formatActivity, isBackgroundWait, sessionActivity } from '../utils/claude-activity.js';
import { resumeClaudeConversation } from '../utils/claude-resume.js';
import { claudeWaitingLabel } from '../utils/claude-waiting-label.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { announceMacSessionsChanged } from '../utils/mac-sessions.js';
import { formatPathForDisplay } from '../utils/path-utils.js';
import { endsADrag } from '../utils/pointer-drag.js';
import { renameSession } from '../utils/session-actions.js';
import { focusSheet, holdSheetFocus } from '../utils/sheet-a11y.js';
import { isTmuxAttachment } from '../utils/tmux-attachment.js';

const LONG_PRESS_MS = 550;
/** Width of one swipe action button. */
const SWIPE_ACTION_PX = 84;
/** Horizontal travel before a touch counts as a swipe (and not a tap or a scroll). */
const SWIPE_SLOP_PX = 12;

/** Only one row shows its swipe actions at a time, like Mail and Messages. */
let swipeOpenRow: PhoneSessionRow | null = null;

/** "now", "5 min", "14:02" (today), "Mon", or "3 Oct": like a chat list. */
export function formatRowTime(iso: string | undefined, now = new Date()): string {
  if (!iso) return '';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60000);
  if (minutes < 1) return t('sessions.row.now');
  if (minutes < 60) return t('sessions.row.minutes', { n: minutes });
  if (then.toDateString() === now.toDateString()) {
    return then.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
  }
  if (minutes < 6 * 24 * 60) return then.toLocaleDateString(getLocale(), { weekday: 'short' });
  return then.toLocaleDateString(getLocale(), { day: 'numeric', month: 'short' });
}

const timedRows = new Set<RowTime>();
let rowTimer: ReturnType<typeof setInterval> | undefined;
/** Relative times move by the minute; 30 s keeps them at most half a minute behind. */
const ROW_TIME_TICK_MS = 30_000;

function tickRowTimes() {
  if (typeof document !== 'undefined' && document.hidden) return;
  for (const element of timedRows) element.refresh();
}

/**
 * `<vt-row-time at="ISO">`: a row's "now / 5 min / 14:02", rewriting its own text. One shared
 * timer for every row, paused while the page is hidden, so a list whose sessions did not change
 * never re-renders just to move its clocks (and rows don't say "now" for hours).
 */
export class RowTime extends HTMLElement {
  static get observedAttributes() {
    return ['at'];
  }

  connectedCallback() {
    this.refresh();
    timedRows.add(this);
    rowTimer ??= setInterval(tickRowTimes, ROW_TIME_TICK_MS);
  }

  disconnectedCallback() {
    timedRows.delete(this);
    if (rowTimer && !timedRows.size) {
      clearInterval(rowTimer);
      rowTimer = undefined;
    }
  }

  attributeChangedCallback() {
    if (this.isConnected) this.refresh();
  }

  refresh() {
    const text = formatRowTime(this.getAttribute('at') ?? undefined);
    if (this.textContent !== text) this.textContent = text;
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('vt-row-time')) {
  customElements.define('vt-row-time', RowTime);
}

export const SHELLS = new Set(['zsh', 'bash', 'fish', 'sh', 'nu', 'pwsh', '']);
const WRAPPER_FLAGS = /^-/;

/**
 * The program a session runs: "claude" for ["zsh", "-lic", "claude --resume x"] or
 * ["/opt/homebrew/bin/gemini"], "zsh" for a plain shell.
 */
export function sessionTool(
  session: Pick<Session, 'command' | 'codexActive' | 'geminiActive'>
): string {
  // `codex` or `gemini` typed inside a shell: the server spots its process (agent chat).
  if (session.codexActive) return 'codex';
  if (session.geminiActive) return 'gemini';
  const argv = Array.isArray(session.command) ? session.command : [];
  const base = (word: string) => word.split('/').pop()?.toLowerCase() ?? '';
  const first = base(argv[0] ?? '');
  if (SHELLS.has(first)) {
    // A shell running a command string (zsh -lic "claude ...") is that command.
    const script = argv.slice(1).find((arg) => !WRAPPER_FLAGS.test(arg));
    if (script) return base(script.trim().split(/\s+/)[0] ?? '');
  }
  return first;
}

/** A stable color per tool so different programs are told apart at a glance. */
export function toolHue(tool: string): number {
  let hash = 0;
  for (const char of tool) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

export type RowState = 'running' | 'exited' | 'working' | 'waiting';

/** Claude Code's status, when the server reports one (agent chat on), else running/exited. */
export function rowState(session: Pick<Session, 'status' | 'claudeStatus'>): RowState {
  if (session.status === 'exited') return 'exited';
  const claude = session.claudeStatus?.status;
  if (claude === 'waiting') return 'waiting';
  // Busy only for background agents: the reply is over, so the row rests like an idle one.
  if (claude === 'busy' && !isBackgroundWait(session.claudeStatus)) return 'working';
  return 'running';
}

/** Avatar for a session: a prompt for shells, else the program's initial on its own color. */
export function renderToolAvatar(session: Session, size?: number) {
  const tool = sessionTool(session);
  const shell = SHELLS.has(tool);
  const sizeStyle = size ? `width: ${size}px; height: ${size}px;` : '';
  return html`<span
    class="psr-avatar ${shell ? 'psr-avatar-shell' : 'psr-avatar-tool'}"
    style="${sizeStyle}${shell ? '' : ` --tool-hue: ${toolHue(tool)}`}"
    aria-hidden="true"
  >
    ${
      shell
        ? html`<span class="psr-prompt">&gt;_</span>`
        : html`<span class="psr-initial">${tool.charAt(0).toUpperCase() || '?'}</span>`
    }
    <span class="psr-dot psr-dot-${rowState(session)}"></span>
  </span>`;
}

@customElement('phone-session-row')
export class PhoneSessionRow extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ type: Object }) session!: Session;
  @property({ type: Object }) authClient!: AuthClient;
  @property({ type: Boolean }) selected = false;
  /** Pinned to the top of the list on this device (session-list owns the set). */
  @property({ type: Boolean }) pinned = false;
  /**
   * Changes whenever anything shown changes. The app may keep the same Session object
   * across polls, which alone would not re-render this row.
   */
  @property({ type: String }) stamp = '';
  @state() private killing = false;
  @state() private resuming = false;
  /** The quick answer on its way (its option number), until the next poll replaces the prompt. */
  @state() private answering: number | null = null;
  /**
   * Why the last quick answer did nothing: another answer was on its way, the prompt changed, or
   * the session was opened to watch only (its tmux client is read-only).
   */
  @state() private answerFailed: false | 'busy' | 'changed' | 'watching' = false;
  private answerTimer: ReturnType<typeof setTimeout> | null = null;
  protected readonly i18n = new LocaleController(this);

  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressed = false;

  /** How far the row is slid left to show its swipe actions (0 = closed). */
  @state() private swipeX = 0;
  @state() private swiping = false;
  private swipeStart: { x: number; y: number; base: number; id: number } | null = null;
  /** The gesture went sideways or vertical; decided once per touch. */
  private swipeAxis: 'x' | 'y' | null = null;
  /** The click that ends a swipe (or closes the actions) must not also open the session. */
  private swallowClick = false;
  private swipeActionAt = 0;
  private sheetOpenedAt = 0;
  private sheetActionAt = 0;

  private swipeWidth(): number {
    return this.session.status === 'exited' ? SWIPE_ACTION_PX : SWIPE_ACTION_PX * 2;
  }

  closeSwipe() {
    this.swipeX = 0;
    if (swipeOpenRow === this) swipeOpenRow = null;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.answerTimer) clearTimeout(this.answerTimer);
    this.answerTimer = null;
    this.cancelPress();
    if (swipeOpenRow === this) swipeOpenRow = null;
    // repeat() moves rows when their order changes (disconnect + reconnect in the same task);
    // only a row that is really gone takes its open sheet with it.
    setTimeout(() => {
      if (!this.isConnected) this.closeSheet();
    }, 0);
  }

  private cancelPress() {
    if (this.pressTimer) clearTimeout(this.pressTimer);
    this.pressTimer = null;
  }

  private handlePointerDown = (e: PointerEvent) => {
    this.longPressed = false;
    this.cancelPress();
    // Touching another row puts away the actions an open row is showing.
    if (swipeOpenRow && swipeOpenRow !== this) swipeOpenRow.closeSwipe();
    this.swipeStart = { x: e.clientX, y: e.clientY, base: this.swipeX, id: e.pointerId };
    this.swipeAxis = null;
    // Touch browsers often send no click after a drag; don't let a stale flag eat this tap.
    this.swallowClick = false;
    this.pressTimer = setTimeout(() => {
      this.longPressed = true;
      navigator.vibrate?.(15);
      this.openSheet();
    }, LONG_PRESS_MS);
  };

  private handlePointerMove = (e: PointerEvent) => {
    const start = this.swipeStart;
    if (!start || start.id !== e.pointerId) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!this.swipeAxis) {
      // Only a clearly sideways move is a swipe, so scrolling the list stays a scroll.
      if (Math.abs(dy) > SWIPE_SLOP_PX && Math.abs(dy) >= Math.abs(dx)) this.swipeAxis = 'y';
      else if (Math.abs(dx) > SWIPE_SLOP_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
        this.swipeAxis = 'x';
        this.cancelPress();
        this.swiping = true;
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      }
      if (Math.abs(dy) > SWIPE_SLOP_PX) this.cancelPress();
    }
    if (this.swipeAxis !== 'x') return;
    // Follows the finger, with a little rubber band past the buttons.
    const raw = start.base + dx;
    const width = this.swipeWidth();
    this.swipeX = Math.min(0, raw < -width ? -width + (raw + width) / 3 : raw);
  };

  private handlePointerEnd = () => {
    this.cancelPress();
    const swiped = this.swipeAxis === 'x';
    this.swipeStart = null;
    this.swipeAxis = null;
    if (!swiped) return;
    this.swiping = false;
    this.swallowClick = true;
    if (this.swipeX < -this.swipeWidth() / 2) {
      this.swipeX = -this.swipeWidth();
      swipeOpenRow = this;
    } else {
      this.closeSwipe();
    }
  };

  private handleClick = () => {
    this.cancelPress();
    if (this.swallowClick) {
      this.swallowClick = false;
      return;
    }
    // A tap on a row showing its actions just puts them away.
    if (this.swipeX) {
      this.closeSwipe();
      return;
    }
    // The click that ends a long press must not also open the session.
    if (this.longPressed) {
      this.longPressed = false;
      return;
    }
    this.openSession();
  };

  private openSession() {
    this.longPressed = false;
    this.dispatchEvent(
      new CustomEvent('session-select', { detail: this.session, bubbles: true, composed: true })
    );
  }

  private handleMenuClick = (e: Event) => {
    e.stopPropagation();
    this.openSheet();
  };

  /**
   * Action sheet (open, rename, pin, kill/clear), rendered into <body>: the phone sidebar
   * slides with a transform, which would turn position:fixed into "fixed to the sidebar".
   */
  private sheetHost: HTMLElement | null = null;
  private releaseSheetFocus: (() => void) | null = null;

  private openSheet(confirmKill = false) {
    if (this.sheetHost) return;
    this.sheetOpenedAt = Date.now();
    this.sheetHost = document.createElement('div');
    document.body.appendChild(this.sheetHost);
    this.renderSheet(confirmKill);
    // A long press leaves focus wherever it was: hand it back to the row's own button.
    const opener = this.contains(document.activeElement)
      ? document.activeElement
      : this.querySelector('.psr-main');
    this.releaseSheetFocus = holdSheetFocus(
      this.sheetHost.querySelector<HTMLElement>('.psr-sheet'),
      this.closeSheet,
      opener
    );
    requestAnimationFrame(() => this.sheetHost?.querySelector('.psr-sheet')?.classList.add('open'));
  }

  /** The click finishing the tap that opened the sheet can land on the new backdrop. */
  private handleBackdropClick = () => {
    if (Date.now() - this.sheetOpenedAt > 400) this.closeSheet();
  };

  private closeSheet = () => {
    if (!this.sheetHost) return;
    render(nothing, this.sheetHost);
    this.sheetHost.remove();
    this.sheetHost = null;
    this.releaseSheetFocus?.();
    this.releaseSheetFocus = null;
  };

  /**
   * `confirmKill` swaps the actions for a "Kill “name”?" step: killing a running session ends
   * its process, so it never happens on a single, possibly stray, tap.
   */
  private renderSheet(confirmKill = false) {
    if (!this.sheetHost) return;
    const exited = this.session.status === 'exited';
    // Attached to a tmux session: ending it only detaches, the tmux session keeps running.
    const disconnects = isTmuxAttachment(this.session);
    // The click finishing the tap that opened the sheet lands on whatever is now under the
    // finger: near the bottom of the screen that is the sheet's own (red) Kill button.
    const action = (fn: () => void) => () => {
      if (Date.now() - this.sheetOpenedAt < 500) return;
      this.closeSheet();
      fn();
    };
    // Touch acts on pointerup (iOS can swallow the first click on a fresh button, see the
    // swipe actions); the click that may follow it is ignored. Mouse and keyboard use click.
    const touchAction = (fn: () => void) => ({
      handleEvent: (e: Event) => {
        if (Date.now() - this.sheetOpenedAt < 500) return;
        if (e.type === 'pointerup') {
          if ((e as PointerEvent).pointerType === 'mouse') return;
          // A scroll that started on the button ends here too: not a tap.
          if (endsADrag(e as PointerEvent)) return;
          this.sheetActionAt = Date.now();
          swallowNextClick();
        } else if (Date.now() - this.sheetActionAt < 700) {
          return;
        }
        this.closeSheet();
        fn();
      },
    });
    if (confirmKill && !exited) {
      render(
        html`
          <div class="psr-sheet-backdrop" @click=${this.handleBackdropClick}></div>
          <div class="psr-sheet open" role="alertdialog" aria-modal="true" aria-label=${this.displayTitle()}>
            <div class="psr-sheet-group">
              <div class="psr-sheet-title question">
                <bdi>${t(disconnects ? 'sessions.row.disconnectConfirm' : 'sessions.row.killConfirm', { name: this.displayTitle() })}</bdi>
              </div>
              <button class="destructive" data-testid="psr-kill-confirm" @click=${action(() => void this.kill())}>
                ${t(disconnects ? 'sessions.row.disconnect' : 'sessions.row.kill')}
              </button>
            </div>
            <button class="psr-sheet-cancel" @click=${this.handleBackdropClick}>${t('common.cancel')}</button>
          </div>
        `,
        this.sheetHost
      );
      // The confirm step replaced the focused button: start a screen reader at its question.
      focusSheet(this.sheetHost.querySelector<HTMLElement>('.psr-sheet'));
      return;
    }
    render(
      html`
        <div class="psr-sheet-backdrop" @click=${this.handleBackdropClick}></div>
        <div class="psr-sheet" role="dialog" aria-modal="true" aria-label=${this.displayTitle()}>
          <div class="psr-sheet-group">
            <div class="psr-sheet-title"><bdi>${this.displayTitle()}</bdi></div>
            <button @click=${action(() => this.openSession())}>${t('sessions.row.open')}</button>
            ${
              exited
                ? nothing
                : html`<button
                    data-testid="psr-rename"
                    @click=${action(() => void this.promptRename())}
                  >
                    ${t('sessions.row.rename')}
                  </button>`
            }
            <button
              data-testid="psr-pin"
              @pointerup=${touchAction(() => this.togglePin())}
              @click=${touchAction(() => this.togglePin())}
            >
              ${t(this.pinned ? 'organize.unpin' : 'organize.pin')}
            </button>
            ${
              exited && this.session.claudeSessionId && this.session.claudeResumable && !disconnects
                ? html`<button data-testid="psr-sheet-resume" @click=${action(() => void this.resumeClaude())}>
                    ${t('sessions.row.resume')}
                  </button>`
                : nothing
            }
            <button
              class="destructive"
              @click=${
                exited
                  ? action(() => void this.kill())
                  : () => {
                      // The confirm button takes this one's place: a double tap mustn't kill.
                      this.sheetOpenedAt = Date.now();
                      this.renderSheet(true);
                    }
              }
            >
              ${t(exited ? 'sessions.row.clear' : disconnects ? 'sessions.row.disconnect' : 'sessions.row.kill')}
            </button>
          </div>
          <button class="psr-sheet-cancel" @click=${this.closeSheet}>${t('common.cancel')}</button>
        </div>
      `,
      this.sheetHost
    );
  }

  private togglePin() {
    this.dispatchEvent(
      new CustomEvent('session-pin-toggle', {
        detail: { sessionId: this.session.id, pinned: !this.pinned },
        bubbles: true,
        composed: true,
      })
    );
  }

  private displayTitle(): string {
    return (
      this.session.claudeStatus?.title ||
      this.session.claudeTitle ||
      this.session.codexTitle ||
      this.session.geminiTitle ||
      this.session.name ||
      this.session.command?.join(' ') ||
      ''
    );
  }

  /**
   * Answer Claude's on-screen prompt by its option number, without opening the session. The
   * server re-checks that this prompt is still the one on screen before pressing any key.
   */
  private async answer(
    option: number,
    choices: { question: string; options: string[]; detail?: string[]; key?: string },
    e: Event
  ) {
    e.stopPropagation();
    if (this.answering !== null) return;
    this.answering = option;
    this.answerFailed = false;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(this.session.id)}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authClient?.getAuthHeader() },
        // The options and what the menu is about tell it apart from the next prompt.
        body: JSON.stringify({
          option,
          question: choices.question,
          options: choices.options,
          key: choices.key,
        }),
      });
      if (!response.ok) {
        const error =
          response.status === 409
            ? ((await response.json().catch(() => ({}))) as { error?: string }).error
            : undefined;
        this.answerFailed =
          error === 'busy' ? 'busy' : error === 'read-only' ? 'watching' : 'changed';
      }
    } catch {
      this.answerFailed = 'changed';
    }
    // On success the next poll replaces the prompt; keep the button marked until then.
    this.answerTimer = setTimeout(
      () => {
        this.answering = null;
        this.answerTimer = null;
      },
      this.answerFailed ? 0 : 3000
    );
  }

  /** Quick answers: the menu Claude waits on, answered from the list. */
  private renderChoices() {
    const choices = this.session.claudeStatus?.choices;
    if (this.session.claudeStatus?.status !== 'waiting' || !choices) return nothing;
    return html`
      <div class="psr-choices" @pointerdown=${(e: Event) => e.stopPropagation()}>
        ${
          // What an answer approves ("Edit file · notes.txt"): the same question may come next
          // for another command.
          choices.detail?.length
            ? html`<div class="psr-choices-detail" dir="ltr">${compactDetail(choices.detail)}</div>`
            : nothing
        }
        <div class="psr-choices-q"><bdi>${choices.question}</bdi></div>
        ${
          this.answerFailed
            ? html`<div class="psr-choices-error">
                ${t(
                  this.answerFailed === 'busy'
                    ? 'screenMenu.sending'
                    : this.answerFailed === 'watching'
                      ? 'macSessions.error.watching'
                      : 'sessions.row.promptChanged'
                )}
              </div>`
            : nothing
        }
        ${choices.options.map(
          (option, index) => html`
            <button
              class="psr-choice ${this.answering === index + 1 ? 'sending' : ''}"
              ?disabled=${this.answering !== null}
              @click=${(e: Event) => this.answer(index + 1, choices, e)}
            >
              <span class="psr-choice-n">${index + 1}</span><bdi>${option}</bdi>
            </button>
          `
        )}
      </div>
    `;
  }

  /** What the row says under its title: Claude's state and last message, or the folder. */
  /**
   * Continue an exited Claude session's conversation (`claude --resume <id>`) in a new session.
   * Never with the permission-prompt bypass: that is only offered, ticked by the user, in
   * History.
   */
  private async resumeClaude() {
    const { claudeSessionId, workingDir, name } = this.session;
    if (!claudeSessionId || this.resuming) return;
    this.resuming = true;
    try {
      const result = await resumeClaudeConversation({
        claudeSessionId,
        workingDir,
        name,
        skipPermissions: false,
        authHeader: this.authClient?.getAuthHeader(),
      });
      this.dispatchEvent(
        new CustomEvent('session-created', { detail: result, bubbles: true, composed: true })
      );
    } catch (error) {
      this.dispatchEvent(
        new CustomEvent('error', {
          detail: `${t('newChat.failed')}: ${error instanceof Error ? error.message : error}`,
          bubbles: true,
        })
      );
    } finally {
      this.resuming = false;
    }
  }

  /**
   * A finished Claude conversation that can be continued (the server says so only with agent
   * chat on) gets a one-tap Resume right on its row, besides the one in the long-press sheet.
   */
  private renderResume() {
    const { status, claudeSessionId, claudeResumable } = this.session;
    if (status !== 'exited' || !claudeSessionId || !claudeResumable) return nothing;
    // Its conversation still runs in that tmux session: resuming it would write it twice.
    if (isTmuxAttachment(this.session)) return nothing;
    return html`<button
      class="psr-resume"
      data-testid="psr-resume"
      ?disabled=${this.resuming}
      style="margin-top: 6px; display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px;
        border-radius: 999px; border: 1px solid color-mix(in srgb, var(--color-primary) 45%, transparent);
        color: var(--color-primary-text); font-size: 13px; font-weight: 600;${this.resuming ? ' opacity: 0.55;' : ''}"
      @pointerdown=${(e: Event) => e.stopPropagation()}
      @click=${(e: Event) => {
        e.stopPropagation();
        void this.resumeClaude();
      }}
    >
      <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
        <path d="M7 4.5v15l12.5-7.5z" />
      </svg>
      ${t('phoneList.resume')}
    </button>`;
  }

  private renderPreview(state: RowState) {
    const claude = this.session.claudeStatus;
    if (state === 'waiting') {
      // Tapping the chip opens the answer sheet (app.ts) instead of the session. It acts on
      // pointerup like the sheets; the click that follows is swallowed so the row underneath
      // doesn't open the session too. A mouse uses the click.
      let touchedAt = 0;
      const open = () =>
        window.dispatchEvent(
          new CustomEvent('vt-open-answer-sheet', { detail: { sessionId: this.session.id } })
        );
      return html`<span
        class="psr-needs psr-needs-btn"
        data-testid="psr-needs-chip"
        @pointerdown=${(e: Event) => e.stopPropagation()}
        @pointerup=${(e: PointerEvent) => {
          e.stopPropagation();
          if (e.pointerType === 'mouse') return;
          if (endsADrag(e)) return;
          touchedAt = Date.now();
          swallowNextClick();
          open();
        }}
        @click=${(e: Event) => {
          e.stopPropagation();
          if (Date.now() - touchedAt < 700) return;
          open();
        }}
        >${t('sessions.row.needsYou')}${claude?.waitingFor ? html` · ${claudeWaitingLabel(claude.waitingFor)}` : nothing}</span
      >`;
    }
    const preview = claude?.preview;
    const text = preview
      ? html`${preview.role === 'user' ? html`<span class="psr-you">${t('sessions.row.you')}</span>` : nothing}${preview.text}`
      : html`<span class="psr-path" dir="ltr">${formatPathForDisplay(this.session.workingDir)}</span>`;
    if (state === 'working') {
      // What Claude is doing right now ("Editing app.ts · 1m 20s"), else just "Working...".
      const activity = sessionActivity(this.session);
      const status = activity
        ? html`<span class="psr-working" data-testid="row-activity"><bdi>${formatActivity(activity)}</bdi></span>${
            activity.since
              ? html` · <claude-activity-elapsed class="psr-elapsed" since=${activity.since}></claude-activity-elapsed>`
              : nothing
          }`
        : html`<span class="psr-working">${t('sessions.row.working')}<span class="psr-dots"></span></span>`;
      return html`${status} ${preview ? html`· ${text}` : nothing}`;
    }
    if (isBackgroundWait(claude) && this.session.status === 'running') {
      // The reply is in; background agents still run. Calm, no dots: nothing to wait for here.
      return html`<span class="psr-background" data-testid="row-background">${t('activity.backgroundWait')}</span> ${preview ? html`· ${text}` : nothing}`;
    }
    return text;
  }

  /** Last output line of a shell session (the server sends it to the compact list). */
  private lastLine(): string | undefined {
    const { lastLine, claudeStatus } = this.session;
    return lastLine && !claudeStatus?.preview && this.session.status === 'running'
      ? lastLine
      : undefined;
  }

  /** Phones rename through a prompt: an inline editor is too small to hit. */
  private async promptRename() {
    const current = this.displayTitle();
    const input = window.prompt(t('sessions.row.renamePrompt'), current);
    const name = input?.trim();
    if (!name || name === current) return;
    const result = await renameSession(this.session.id, name, this.authClient);
    this.dispatchEvent(
      result.success
        ? new CustomEvent('session-renamed', {
            detail: { sessionId: this.session.id, newName: name },
            bubbles: true,
            composed: true,
          })
        : new CustomEvent('session-rename-error', {
            detail: { sessionId: this.session.id, error: result.error },
            bubbles: true,
            composed: true,
          })
    );
  }

  private async kill() {
    if (this.killing) return;
    this.killing = true;
    const result = await sessionActionService.deleteSession(this.session, {
      authClient: this.authClient,
      callbacks: {
        onError: (error) =>
          this.dispatchEvent(
            new CustomEvent('session-kill-error', {
              detail: { sessionId: this.session.id, error },
              bubbles: true,
              composed: true,
            })
          ),
        onSuccess: () =>
          this.dispatchEvent(
            new CustomEvent('session-killed', {
              detail: { sessionId: this.session.id, session: this.session },
              bubbles: true,
              composed: true,
            })
          ),
      },
    });
    if (!result.success) this.killing = false;
    // Its row under "On this computer" no longer says "In VibeTunnel".
    else if (isTmuxAttachment(this.session)) announceMacSessionsChanged();
  }

  /**
   * What a screen reader reads for the row, like a chat list: "zsh, build, 2 min, pinned,
   * ~/Projects/app". The row's visible parts are many small spans; read as one.
   */
  private accessibleName(tool: string, title: string, time: string): string {
    const claude = this.session.claudeStatus;
    const state = rowState(this.session);
    const status =
      state === 'waiting'
        ? [t('sessions.row.needsYou'), claudeWaitingLabel(claude?.waitingFor)]
            .filter(Boolean)
            .join(' · ')
        : state === 'working'
          ? (() => {
              const activity = sessionActivity(this.session);
              return activity ? formatActivity(activity) : t('sessions.row.working');
            })()
          : state === 'exited'
            ? t('a11y.row.exited')
            : isBackgroundWait(claude)
              ? t('activity.backgroundWait')
              : '';
    const preview =
      state === 'waiting'
        ? ''
        : claude?.preview
          ? `${claude.preview.role === 'user' ? t('sessions.row.you') : ''}${claude.preview.text}`
          : formatPathForDisplay(this.session.workingDir);
    return [
      tool,
      title,
      status,
      time,
      this.pinned ? t('organize.pinned') : '',
      preview,
      state === 'waiting' ? '' : this.lastLine(),
    ]
      .map((part) => part?.trim())
      .filter((part, index, parts) => part && parts.indexOf(part) === index)
      .join(', ');
  }

  render() {
    const session = this.session;
    const tool = sessionTool(session);
    const title = this.displayTitle();
    const timeIso = session.lastModified || session.startedAt;
    const time = formatRowTime(timeIso);
    const exited = session.status === 'exited';
    const revealed = this.swipeX !== 0;
    // Touch runs the action on pointerup: on iOS the first tap on a freshly revealed button
    // is often taken as a hover and produces no click at all. The click that may still follow
    // is ignored; mouse and keyboard use the click.
    const swipeAction = (fn: () => void) => ({
      handleEvent: (e: Event) => {
        e.stopPropagation();
        if (e.type === 'pointerup') {
          if ((e as PointerEvent).pointerType === 'mouse') return;
          if (endsADrag(e as PointerEvent)) return;
          this.swipeActionAt = Date.now();
          swallowNextClick();
        } else if (Date.now() - this.swipeActionAt < 700) {
          return;
        }
        this.closeSwipe();
        fn();
      },
    });
    return html`
      <div style="position: relative; overflow: hidden">
      <div
        class="psr-swipe-actions"
        aria-hidden=${revealed ? 'false' : 'true'}
        style="position: absolute; inset: 0 0 0 auto; display: flex; width: ${this.swipeWidth()}px; ${
          revealed || this.swiping ? '' : 'visibility: hidden'
        }"
      >
        ${
          exited
            ? nothing
            : html`<button
                tabindex="-1"
                style="flex: 1; color: var(--color-text); background: var(--color-bg-tertiary); font-size: 15px"
                @pointerup=${swipeAction(() => void this.promptRename())}
                @click=${swipeAction(() => void this.promptRename())}
              >
                ${t('sessions.row.rename')}
              </button>`
        }
        <button
          tabindex="-1"
          data-testid="psr-swipe-kill"
          style="flex: 1; color: white; background: var(--color-status-error); font-size: 15px; font-weight: 600"
          @pointerup=${swipeAction(() => (exited ? void this.kill() : this.openSheet(true)))}
          @click=${swipeAction(() => (exited ? void this.kill() : this.openSheet(true)))}
        >
          ${t(exited ? 'phoneList.swipeClear' : isTmuxAttachment(session) ? 'sessions.row.disconnect' : 'phoneList.swipeKill')}
        </button>
      </div>
      <div
        class="psr ${this.killing ? 'psr-killing' : ''} ${this.selected ? 'psr-selected' : ''}"
        data-testid="phone-session-row"
        data-state=${rowState(session)}
        style="position: relative; touch-action: pan-y; ${
          this.swipeX || this.swiping
            ? `transform: translateX(${this.swipeX}px);${this.swiping ? ' transition: none;' : ''}${
                // The selected tint is translucent; keep it but don't let the actions show through.
                this.selected
                  ? ' background: linear-gradient(var(--color-primary-muted), var(--color-primary-muted)), var(--color-bg);'
                  : ''
              }`
            : ''
        }"
        @pointerdown=${this.handlePointerDown}
        @pointermove=${this.handlePointerMove}
        @pointerup=${this.handlePointerEnd}
        @pointercancel=${this.handlePointerEnd}
        @pointerleave=${() => this.cancelPress()}
        @contextmenu=${(e: Event) => e.preventDefault()}
        @click=${this.handleClick}
      >
        ${renderToolAvatar(session)}
        <div class="psr-body">
          <div
            class="psr-main"
            role="button"
            tabindex="0"
            aria-label=${this.accessibleName(tool, title, time)}
            aria-current=${this.selected ? 'true' : 'false'}
            @keydown=${(e: KeyboardEvent) => {
              if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
              e.preventDefault();
              this.handleClick();
            }}
          >
            <div class="psr-top">
              <span class="psr-title"><bdi>${title}</bdi></span>
              ${
                this.pinned
                  ? html`<span class="psr-flag" role="img" aria-label=${t('organize.pinned')}>📌</span>`
                  : nothing
              }
              <span class="psr-time"><vt-row-time at=${timeIso ?? ''}></vt-row-time></span>
            </div>
            <div class="psr-preview">${this.renderPreview(rowState(session))}</div>
            ${
              rowState(session) !== 'waiting' && this.lastLine()
                ? html`<div class="psr-last-line" data-testid="row-last-line"><bdi>${this.lastLine()}</bdi></div>`
                : nothing
            }
          </div>
          ${this.renderChoices()}
          ${this.renderResume()}
        </div>
        <button
          class="psr-menu"
          aria-label=${t('a11y.row.actions', { name: title })}
          aria-haspopup="dialog"
          @pointerdown=${(e: Event) => e.stopPropagation()}
          @click=${this.handleMenuClick}
        >
          ⋯
        </button>
      </div>
      </div>
    `;
  }
}
