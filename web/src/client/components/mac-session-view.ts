/**
 * The conversation of an agent running outside VibeTunnel ("On this computer"), alone in a terminal
 * window or in a pane of a tmux session: followed live from its transcript, read-only. Nothing
 * typed here reaches it; a tmux pane can be opened instead, to type into it.
 *
 * Rendered into <body> as a full-screen sheet, like the Claude history, so it stays fixed to
 * the screen and not to a sliding sidebar. Its styles live here.
 */
import { html, LitElement, nothing, render } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  MAC_TMUX_OPEN_EVENT,
  type MacSessionViewDetail,
  type MacTmuxOpenDetail,
} from '../../shared/mac-sessions.js';
import { LocaleController, t, tAround } from '../i18n/index.js';
import { Z_INDEX } from '../utils/constants.js';
import { tapHandler } from '../utils/ghost-click.js';
import { MAC_AGENT_NAMES, macAppName } from '../utils/mac-sessions.js';
import { formatPathForDisplay } from '../utils/path-utils.js';
import { holdSheetFocus } from '../utils/sheet-a11y.js';
import './claude-chat-view.js';

/** live: the conversation shows; ended: the agent is gone (404); off: Mac sessions off (503). */
type SheetState = 'live' | 'unavailable' | 'ended' | 'off';

function basename(path: string | undefined): string {
  return (
    path
      ?.replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() ?? ''
  );
}

@customElement('mac-session-view')
export class MacSessionView extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) detail!: MacSessionViewDetail;
  @state() private sheetState: SheetState = 'live';
  protected readonly i18n = new LocaleController(this);

  /** The click that finishes the tap that opened the sheet must not hit a button in it. */
  private readonly openedAt = Date.now();

  close = () => {
    this.dispatchEvent(new CustomEvent('close'));
  };

  private readonly closeTap = tapHandler(() => this.close(), this.openedAt);

  /** Open the pane's tmux session in VibeTunnel, ready to type. */
  private readonly openTap = tapHandler(() => {
    const id = this.detail.tmuxId;
    if (!id) return;
    this.close();
    window.dispatchEvent(
      new CustomEvent<MacTmuxOpenDetail>(MAC_TMUX_OPEN_EVENT, { detail: { id, mode: 'control' } })
    );
  }, this.openedAt);

  private handleAvailability = (e: CustomEvent<boolean>) => {
    if (this.sheetState === 'ended' || this.sheetState === 'off') return;
    this.sheetState = e.detail ? 'live' : 'unavailable';
  };

  /** A 404 is final: the agent exited, or its pane or tmux server is gone. */
  private handleError = (e: CustomEvent<number>) => {
    if (e.detail === 404) this.sheetState = 'ended';
    else if (e.detail === 503) this.sheetState = 'off';
  };

  private get pane(): boolean {
    return (
      this.detail.kind === 'pane' &&
      this.detail.tmuxName !== undefined &&
      this.detail.windowIndex !== undefined
    );
  }

  private renderWhere() {
    const { cwd, tmuxName, windowIndex } = this.detail;
    if (this.pane) {
      // Only the session's name is the user's: the phrase around it follows the page.
      const [before, name, after] = tAround(
        'macSessions.view.inTmuxWindow',
        { name: tmuxName ?? '', index: windowIndex ?? 0 },
        'name'
      );
      return html`${before}<bdi>${name}</bdi>${after}`;
    }
    const folder = cwd ? formatPathForDisplay(cwd) : '';
    return html`<bdi>${this.agentApp() ?? t('macSessions.where.otherTerminal')}</bdi>${
      folder ? html` · <span dir="ltr">${folder}</span>` : nothing
    }`;
  }

  /** Where an agent runs, as its row says it: "tmux" under a server that can't be listed. */
  private agentApp(): string | null {
    const { app, inTmux } = this.detail;
    if (inTmux) return 'tmux';
    return app ? macAppName(app) : null;
  }

  private renderBody() {
    if (this.sheetState === 'ended' || this.sheetState === 'off') {
      return html`<div class="vt-mac-view-gone" role="status" data-testid="mac-view-ended">
        <p>${this.sheetState === 'ended' ? t('macSessions.view.ended') : t('macSessions.error.disabled')}</p>
        <button
          class="vt-mac-view-primary"
          data-testid="mac-view-ended-close"
          @pointerdown=${this.closeTap}
          @pointerup=${this.closeTap}
          @click=${this.closeTap}
        >
          ${t('common.close')}
        </button>
      </div>`;
    }
    const { chatId } = this.detail;
    return html`
      ${
        this.sheetState === 'unavailable'
          ? html`<div class="vt-mac-view-note" role="status" data-testid="mac-view-unavailable">
              ${t('macSessions.view.unavailable')}
            </div>`
          : nothing
      }
      <claude-chat-view
        class="vt-mac-view-chat"
        .readOnly=${true}
        .sessionId=${`mac:${chatId}`}
        .chatUrl=${`/api/mac-sessions/${encodeURIComponent(chatId)}/chat`}
        @claude-chat-availability=${this.handleAvailability}
        @claude-chat-error=${this.handleError}
      ></claude-chat-view>
    `;
  }

  private renderFooter() {
    if (this.sheetState === 'ended' || this.sheetState === 'off') return nothing;
    const { tmuxId, tmuxName, windowIndex } = this.detail;
    if (this.pane) {
      const [before, name, after] = tAround(
        'macSessions.view.runningInTmux',
        { name: tmuxName ?? '', index: windowIndex ?? 0 },
        'name'
      );
      return html`<div class="vt-mac-view-foot">
        <p class="vt-mac-view-running">${before}<bdi>${name}</bdi>${after}</p>
        ${
          tmuxId
            ? html`<button
                class="vt-mac-view-primary"
                data-testid="mac-view-open"
                @pointerdown=${this.openTap}
                @pointerup=${this.openTap}
                @click=${this.openTap}
              >
                ${t('macSessions.action.open')}
              </button>`
            : nothing
        }
      </div>`;
    }
    // Only the app it runs in can type into it: nothing here can, so say why. In tmux, it is
    // that its server can't be reached (no tmux session to open), not where it was started.
    const where = this.agentApp();
    return html`<div class="vt-mac-view-foot">
      <p class="vt-mac-view-running">
        ${
          where
            ? t('macSessions.view.runningIn', { app: where })
            : t('macSessions.view.runningElsewhere')
        }
      </p>
      <details class="vt-mac-view-why" data-testid="mac-view-why">
        <summary>${t('macSessions.view.whyTitle')}</summary>
        <p>${this.detail.inTmux ? t('macSessions.cannotOpen.unreachable') : t('macSessions.view.whyBody')}</p>
      </details>
    </div>`;
  }

  render() {
    if (!this.detail) return nothing;
    const { title, cwd, agent } = this.detail;
    const heading = title || basename(cwd) || MAC_AGENT_NAMES[agent] || agent;
    return html`
      <style>
        .vt-mac-view {
          position: fixed;
          inset: 0;
          display: flex;
          flex-direction: column;
          background: var(--color-bg);
          color: var(--color-text);
          padding: env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);
        }
        .vt-mac-view-bar {
          display: flex;
          align-items: center;
          gap: 8px;
          padding-block: 6px;
          padding-inline: 16px 4px;
          background: var(--color-bg-secondary);
          border-bottom: 1px solid var(--color-border);
        }
        .vt-mac-view-heading {
          flex: 1;
          min-width: 0;
        }
        .vt-mac-view-title {
          font-weight: 600;
          font-size: 16px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .vt-mac-view-where {
          font-size: 12px;
          color: var(--color-text-muted);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .vt-mac-view-badge {
          flex-shrink: 0;
          font-size: 11px;
          font-weight: 600;
          padding: 2px 8px;
          border-radius: 999px;
          color: var(--color-text-muted);
          border: 1px solid var(--color-border);
        }
        .vt-mac-view-close {
          flex-shrink: 0;
          width: 44px;
          height: 44px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 8px;
          color: var(--color-text-muted);
          touch-action: manipulation;
        }
        .vt-mac-view-body {
          position: relative;
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
        }
        .vt-mac-view-chat {
          flex: 1;
          min-height: 0;
        }
        .vt-mac-view-note,
        .vt-mac-view-gone {
          padding: 32px 16px;
          text-align: center;
          color: var(--color-text-dim);
        }
        .vt-mac-view-gone p {
          margin: 0 0 16px;
        }
        .vt-mac-view-foot {
          flex-shrink: 0;
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding-block: 10px calc(10px + env(safe-area-inset-bottom));
          padding-inline: 16px;
          background: var(--color-bg-secondary);
          border-top: 1px solid var(--color-border);
          font-size: 13px;
        }
        .vt-mac-view-running {
          margin: 0;
          color: var(--color-text-muted);
        }
        .vt-mac-view-why summary {
          min-height: 44px;
          display: flex;
          align-items: center;
          color: var(--color-primary);
          cursor: pointer;
        }
        .vt-mac-view-why p {
          margin: 0 0 4px;
          color: var(--color-text-dim);
        }
        .vt-mac-view-primary {
          align-self: stretch;
          min-height: 44px;
          padding: 0 18px;
          border-radius: 10px;
          background: var(--color-primary);
          color: var(--color-bg);
          font-weight: 600;
          font-size: 15px;
          touch-action: manipulation;
        }
        .vt-mac-view-gone .vt-mac-view-primary {
          min-width: 160px;
        }
      </style>
      <div
        class="vt-mac-view"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vt-mac-view-title"
        data-testid="mac-session-view"
        style="z-index: ${Z_INDEX.MODAL};"
      >
        <div class="vt-mac-view-bar">
          <div class="vt-mac-view-heading">
            <div id="vt-mac-view-title" class="vt-mac-view-title"><bdi>${heading}</bdi></div>
            <div class="vt-mac-view-where" data-testid="mac-view-where">${this.renderWhere()}</div>
          </div>
          <span class="vt-mac-view-badge" data-testid="mac-view-read-only"
            >${t('macSessions.view.readOnly')}</span
          >
          <button
            class="vt-mac-view-close"
            aria-label=${t('common.close')}
            title=${t('common.close')}
            data-testid="mac-view-close"
            @pointerdown=${this.closeTap}
            @pointerup=${this.closeTap}
            @click=${this.closeTap}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div class="vt-mac-view-body">${this.renderBody()}</div>
        ${this.renderFooter()}
      </div>
    `;
  }
}

let openSheet: { host: HTMLElement; release: () => void } | null = null;

export function closeMacSessionView(): void {
  if (!openSheet) return;
  const { host, release } = openSheet;
  openSheet = null;
  render(nothing, host);
  host.remove();
  release();
}

/** Open the read-only conversation of a Mac agent or tmux pane (MAC_SESSION_VIEW_EVENT). */
export function openMacSessionView(detail: MacSessionViewDetail): void {
  closeMacSessionView();
  const opener = document.activeElement;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const sheet: { host: HTMLElement; release: () => void } = { host, release: () => {} };
  openSheet = sheet;
  render(
    html`<mac-session-view .detail=${detail} @close=${closeMacSessionView}></mac-session-view>`,
    host
  );
  // The view renders on its next update; hold focus once its dialog exists.
  void host.querySelector<MacSessionView>('mac-session-view')?.updateComplete.then(() => {
    if (openSheet !== sheet) return;
    sheet.release = holdSheetFocus(
      host.querySelector<HTMLElement>('.vt-mac-view'),
      closeMacSessionView,
      opener
    );
  });
}

declare global {
  interface HTMLElementTagNameMap {
    'mac-session-view': MacSessionView;
  }
}
