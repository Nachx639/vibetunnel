/**
 * Mission control (phone, /agents): every running Claude / Codex / Gemini session as a card —
 * what it is doing, for how long, and whether it needs you — plus a broadcast bar to send one
 * instruction to several agents. Cards and sorting come from utils/agent-mission.ts; the data
 * is the session list the app already polls.
 *
 * @fires session-select - A card was tapped outside select mode (detail: Session)
 */
import { html, LitElement, nothing, render, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import type { Session } from '../../shared/types.js';
import { LocaleController, t } from '../i18n/index.js';
import type { AuthClient } from '../services/auth-client.js';
import {
  type AgentCard,
  type BroadcastIo,
  type BroadcastResult,
  broadcast,
  httpBroadcastIo,
  missionCards,
  showAgentsTab,
} from '../utils/agent-mission.js';
import { formatActivity, isBackgroundWait, sessionActivity } from '../utils/claude-activity.js';
import { claudeWaitingLabel } from '../utils/claude-waiting-label.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { formatPathForDisplay } from '../utils/path-utils.js';
import { endsADrag } from '../utils/pointer-drag.js';
import { holdSheetFocus } from '../utils/sheet-a11y.js';

const LONG_PRESS_MS = 550;
const TAP_SLOP_PX = 10;
/** Clicks this soon after a sheet opens are the tap that opened it, not a choice. */
const SHEET_GUARD_MS = 500;

/**
 * Touch acts on pointerup (iOS can take the first tap on a fresh button as a hover) and the
 * click that follows is swallowed; mouse and keyboard act on click.
 */
/**
 * With every session an agent, "Sessions" and "Agents" list the same ones: a line at the top
 * of Agents says what the tab adds, until dismissed (per device; a cleared storage shows it
 * again, which is harmless).
 */
export const AGENTS_INTRO_DISMISSED_KEY = 'vt-agents-intro-dismissed';

function isAgentsIntroDismissed(): boolean {
  try {
    return localStorage.getItem(AGENTS_INTRO_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberAgentsIntroDismissed(): void {
  try {
    localStorage.setItem(AGENTS_INTRO_DISMISSED_KEY, '1');
  } catch {
    // Storage blocked: the line comes back next visit.
  }
}

function tap(fn: (e: Event) => void, guardSince?: () => number) {
  let touchActedAt = 0;
  return {
    handleEvent(e: Event) {
      if (guardSince && Date.now() - guardSince() < SHEET_GUARD_MS) return;
      if (e.type === 'pointerup') {
        const p = e as PointerEvent;
        if (p.pointerType === 'mouse') return;
        // A scroll that started on the button ends here too. Not told by this handler's own
        // pointerdown: a render mid-scroll makes new handlers, and the tabs make one per event.
        if (endsADrag(p)) return;
        touchActedAt = Date.now();
        swallowNextClick();
      } else if (Date.now() - touchActedAt < 700) {
        return;
      }
      fn(e);
    },
  };
}

const CLAUDE_MARK = html`<svg viewBox="0 0 24 24" width="22" height="22" fill="none"
  stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
  <path d="M12 3.5v6M12 14.5v6M3.5 12h6M14.5 12h6M6 6l4.2 4.2M13.8 13.8L18 18M18 6l-4.2 4.2M10.2 13.8L6 18" />
</svg>`;
const CODEX_MARK = html`<svg viewBox="0 0 24 24" width="22" height="22" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
  <path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z" /><path d="M9 10l-2 2 2 2M15 10l2 2-2 2" />
</svg>`;
const GEMINI_MARK = html`<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
  <path d="M12 2c.6 5.4 4.6 9.4 10 10-5.4.6-9.4 4.6-10 10-.6-5.4-4.6-9.4-10-10 5.4-.6 9.4-4.6 10-10z" />
</svg>`;
const MARKS = { claude: CLAUDE_MARK, codex: CODEX_MARK, gemini: GEMINI_MARK };
const KIND_NAMES = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };

export function cardTitle(session: Session): string {
  return (
    session.claudeStatus?.title ||
    session.claudeTitle ||
    session.codexTitle ||
    session.geminiTitle ||
    session.name ||
    session.command?.join(' ') ||
    session.id
  );
}

/** What the agent is doing now, one line. */
function doingText(card: AgentCard): string {
  const { session, state } = card;
  if (state === 'waiting') {
    const waitingFor = session.claudeStatus?.waitingFor;
    return waitingFor
      ? `${t('sessions.row.needsYou')} · ${claudeWaitingLabel(waitingFor)}`
      : t('sessions.row.needsYou');
  }
  if (state === 'working') {
    const activity = sessionActivity(session);
    return activity ? formatActivity(activity) : t('sessions.row.working');
  }
  if (session.status === 'running' && isBackgroundWait(session.claudeStatus)) {
    return t('activity.backgroundWait');
  }
  return t('mission.state.idle');
}

/** Last message (Claude) or last line on screen (Codex / Gemini). */
function previewText(session: Session): string {
  const preview = session.claudeStatus?.preview;
  if (preview) return `${preview.role === 'user' ? t('sessions.row.you') : ''}${preview.text}`;
  return session.lastLine ?? '';
}

/** The "Sessions | Agents" switch above the phone list. */
export function renderAgentsTabs(agentsActive: boolean, sessions: Session[]): TemplateResult {
  const waiting = missionCards(sessions).filter((card) => card.state === 'waiting').length;
  const pick = (agents: boolean) =>
    tap(() => {
      if (agents !== agentsActive) showAgentsTab(agents);
    });
  // The tab styles live with mission control, which isn't mounted on the Sessions tab.
  return html`${agentsActive ? nothing : STYLES}
    <div class="vtm-tabs" role="tablist" data-testid="agents-tabs">
      <button role="tab" aria-selected=${agentsActive ? 'false' : 'true'} data-testid="tab-sessions"
        @pointerup=${pick(false)} @click=${pick(false)}>
        ${t('mission.tab.sessions')}
      </button>
      <button role="tab" aria-selected=${agentsActive ? 'true' : 'false'} data-testid="tab-agents"
        @pointerup=${pick(true)} @click=${pick(true)}>
        ${t('mission.tab.agents')}${
          waiting
            ? html`<span class="vtm-tab-badge" aria-label=${t('mission.waitingCount', { n: waiting })}>${waiting}</span>`
            : nothing
        }
      </button>
    </div>
  `;
}

const STYLES = html`<style>
  .vtm-tabs {
    display: flex;
    gap: 4px;
    padding: 3px;
    margin: 0 0 12px;
    border-radius: 10px;
    background: var(--color-bg-tertiary);
  }
  .vtm-tabs button {
    flex: 1;
    min-height: 34px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    color: var(--color-text-muted);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  .vtm-tabs button[aria-selected='true'] {
    background: var(--color-bg-elevated);
    color: var(--color-text);
    box-shadow: 0 1px 3px color-mix(in srgb, var(--color-text) 15%, transparent);
  }
  .vtm-tab-badge {
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 9px;
    font-size: 11px;
    line-height: 18px;
    background: var(--color-status-warning);
    color: var(--color-bg);
  }
  .vtm-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 10px;
    font-size: 13px;
    color: var(--color-text-muted);
  }
  /* Each count stays whole and keeps its separator: a narrow phone breaks the line between
     counts, never inside one or before a "·". */
  .vtm-count {
    white-space: nowrap;
  }
  .vtm-toolbar button {
    color: var(--color-primary);
    font-size: 15px;
    padding: 6px 4px;
  }
  .vtm-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-bottom: 12px;
  }
  .vtm-card {
    display: flex;
    gap: 12px;
    padding: 12px;
    border-radius: 14px;
    border: 1px solid var(--color-border);
    background: var(--color-bg-secondary);
    color: var(--color-text);
    text-align: start;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .vtm-card.waiting {
    border-color: var(--color-status-warning);
    background: color-mix(in srgb, var(--color-status-warning) 12%, var(--color-bg-secondary));
  }
  .vtm-card.selected {
    border-color: var(--color-primary);
    box-shadow: 0 0 0 1px var(--color-primary);
  }
  .vtm-check {
    width: 22px;
    height: 22px;
    flex-shrink: 0;
    align-self: center;
    border-radius: 50%;
    border: 2px solid var(--color-border);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    font-weight: 700;
    color: var(--color-bg);
  }
  .vtm-card.selected .vtm-check {
    border-color: var(--color-primary);
    background: var(--color-primary);
  }
  .vtm-icon {
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-bg-tertiary);
    color: var(--color-primary);
  }
  .vtm-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .vtm-top {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .vtm-name {
    flex: 1;
    min-width: 0;
    font-weight: 600;
    font-size: 15px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .vtm-elapsed {
    flex-shrink: 0;
    font-size: 12px;
    color: var(--color-text-dim);
    font-variant-numeric: tabular-nums;
  }
  .vtm-folder,
  .vtm-preview {
    font-size: 12px;
    color: var(--color-text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .vtm-doing {
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text-muted);
  }
  .vtm-card.working .vtm-doing {
    color: var(--color-primary);
  }
  .vtm-card.waiting .vtm-doing {
    color: var(--color-status-warning-text, var(--color-status-warning));
    font-weight: 700;
  }
  .vtm-needs {
    cursor: pointer;
    touch-action: manipulation;
    text-decoration: underline dotted;
    text-underline-offset: 3px;
  }
  .vtm-intro {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin-bottom: 12px;
    padding: 10px 12px;
    border-radius: 12px;
    border: 1px solid var(--color-border);
    background: var(--color-bg-secondary);
    color: var(--color-text-muted);
    font-size: 13px;
    line-height: 1.4;
  }
  .vtm-intro p {
    flex: 1;
    margin: 0;
  }
  .vtm-intro button {
    flex: none;
    min-height: 32px;
    padding: 4px 6px;
    color: var(--color-primary);
    font-size: 14px;
    font-weight: 600;
  }
  .vtm-empty {
    padding: 32px 12px;
    text-align: center;
    color: var(--color-text-muted);
    font-size: 14px;
  }
  .vtm-bar {
    position: sticky;
    bottom: 0;
    margin: 0 -4px;
    padding: 10px 4px calc(10px + env(safe-area-inset-bottom, 0px));
    background: var(--color-bg);
    border-top: 1px solid var(--color-border-light);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .vtm-chips {
    display: flex;
    gap: 8px;
    overflow-x: auto;
  }
  .vtm-chips button {
    flex-shrink: 0;
    padding: 6px 12px;
    border-radius: 16px;
    font-size: 14px;
    border: 1px solid var(--color-border);
    color: var(--color-text);
    background: var(--color-bg-secondary);
  }
  .vtm-send-row {
    display: flex;
    gap: 8px;
  }
  .vtm-send-row input {
    flex: 1;
    min-width: 0;
    font-size: 16px;
    padding: 9px 12px;
    border-radius: 10px;
    border: 1px solid var(--color-border);
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }
  .vtm-send-row button {
    flex-shrink: 0;
    padding: 0 14px;
    border-radius: 10px;
    font-weight: 600;
    background: var(--color-primary);
    color: var(--color-bg);
  }
  .vtm-send-row button:disabled {
    opacity: 0.45;
  }
  .vtm-sheet-list {
    max-height: 45vh;
    overflow-y: auto;
  }
  .vtm-sheet-row {
    display: flex;
    gap: 8px;
    align-items: baseline;
    padding: 10px 16px;
    font-size: 15px;
    color: var(--color-text);
    border-top: 1px solid var(--color-border-light);
  }
  .vtm-sheet-row .vtm-name {
    font-weight: 500;
  }
  .vtm-sheet-row .vtm-note {
    flex-shrink: 0;
    font-size: 13px;
    color: var(--color-text-muted);
  }
  .vtm-sheet-row .vtm-note.sent {
    color: var(--color-status-success);
  }
  .vtm-sheet-row .vtm-note.blocked,
  .vtm-sheet-row .vtm-note.exited {
    color: var(--color-status-warning);
  }
  .vtm-sheet-row .vtm-note.failed {
    color: var(--color-status-error);
  }
  .psr-sheet-group button.vtm-confirm {
    font-weight: 600;
  }
</style>`;

@customElement('agent-mission')
export class AgentMission extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ type: Array }) sessions: Session[] = [];
  @property({ type: Object }) authClient?: AuthClient;
  /** Tests replace the HTTP calls. */
  @property({ attribute: false }) io?: BroadcastIo;
  /** See missionStamp(): sessions change in place between polls. */
  @property({ type: String }) stamp = '';
  /** The line saying what this tab is for: shown until dismissed, once per device. */
  @state() private introDismissed = isAgentsIntroDismissed();
  @state() private selecting = false;
  @state() private selected = new Set<string>();
  @state() private draft = '';
  protected readonly i18n = new LocaleController(this);

  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private pressStart: { x: number; y: number } | null = null;
  private longPressed = false;
  private touchActedAt = 0;
  private sheetHost: HTMLElement | null = null;
  private releaseSheetFocus: (() => void) | null = null;

  disconnectedCallback() {
    super.disconnectedCallback();
    this.closeSheet();
    this.cancelPress();
  }

  private toggle(sessionId: string) {
    const next = new Set(this.selected);
    if (!next.delete(sessionId)) next.add(sessionId);
    this.selected = next;
  }

  private setSelecting(on: boolean) {
    this.selecting = on;
    if (!on) this.selected = new Set();
  }

  private openSession(session: Session) {
    this.dispatchEvent(
      new CustomEvent('session-select', { detail: session, bubbles: true, composed: true })
    );
  }

  private activate(card: AgentCard) {
    if (this.selecting) this.toggle(card.session.id);
    else this.openSession(card.session);
  }

  private cancelPress() {
    if (this.pressTimer) clearTimeout(this.pressTimer);
    this.pressTimer = null;
  }

  private cardEvents(card: AgentCard) {
    return {
      handleEvent: (e: Event) => {
        const p = e as PointerEvent;
        switch (e.type) {
          case 'pointerdown':
            this.longPressed = false;
            this.pressStart = { x: p.clientX, y: p.clientY };
            this.cancelPress();
            if (p.pointerType !== 'mouse') {
              this.pressTimer = setTimeout(() => {
                this.pressTimer = null;
                this.longPressed = true;
                this.selecting = true;
                if (!this.selected.has(card.session.id)) this.toggle(card.session.id);
                navigator.vibrate?.(10);
              }, LONG_PRESS_MS);
            }
            return;
          case 'pointermove':
            if (
              this.pressStart &&
              Math.hypot(p.clientX - this.pressStart.x, p.clientY - this.pressStart.y) > TAP_SLOP_PX
            ) {
              this.cancelPress();
              this.pressStart = null;
            }
            return;
          case 'pointercancel':
            this.cancelPress();
            this.pressStart = null;
            return;
          case 'pointerup': {
            this.cancelPress();
            if (p.pointerType === 'mouse') return;
            const wasTap = this.pressStart !== null;
            this.pressStart = null;
            if (this.longPressed) {
              this.longPressed = false;
              this.touchActedAt = Date.now();
              swallowNextClick();
              return;
            }
            if (!wasTap) return;
            this.touchActedAt = Date.now();
            swallowNextClick();
            this.activate(card);
            return;
          }
          case 'click':
            if (Date.now() - this.touchActedAt < 700) return;
            this.activate(card);
            return;
          case 'keydown': {
            const key = (e as KeyboardEvent).key;
            if (key === 'Enter' || key === ' ') {
              e.preventDefault();
              this.activate(card);
            }
            return;
          }
          case 'contextmenu':
            e.preventDefault();
            return;
        }
      },
    };
  }

  private renderCard(card: AgentCard) {
    const { session, kind, state } = card;
    const selected = this.selected.has(session.id);
    const events = this.cardEvents(card);
    const title = cardTitle(session);
    const doing = doingText(card);
    const preview = previewText(session);
    const label = [KIND_NAMES[kind], title, doing].join(', ');
    return html`
      <div
        class="vtm-card ${state} ${selected ? 'selected' : ''}"
        data-testid="agent-card"
        data-session-id=${session.id}
        data-state=${state}
        data-kind=${kind}
        role=${this.selecting ? 'checkbox' : 'button'}
        aria-checked=${this.selecting ? (selected ? 'true' : 'false') : nothing}
        aria-label=${label}
        tabindex="0"
        @pointerdown=${events}
        @pointermove=${events}
        @pointerup=${events}
        @pointercancel=${events}
        @click=${events}
        @keydown=${events}
        @contextmenu=${events}
      >
        ${this.selecting ? html`<span class="vtm-check" aria-hidden="true">${selected ? '✓' : ''}</span>` : nothing}
        <span class="vtm-icon" title=${KIND_NAMES[kind]}>${MARKS[kind]}</span>
        <div class="vtm-body">
          <div class="vtm-top">
            <span class="vtm-name"><bdi>${title}</bdi></span>
            ${
              card.since
                ? html`<claude-activity-elapsed class="vtm-elapsed" since=${card.since}></claude-activity-elapsed>`
                : nothing
            }
          </div>
          <div class="vtm-folder" dir="ltr">${formatPathForDisplay(session.workingDir)}</div>
          ${
            state === 'waiting' && !this.selecting
              ? this.renderNeeds(session, doing)
              : html`<div class="vtm-doing" data-testid="agent-doing"><bdi>${doing}</bdi></div>`
          }
          ${preview ? html`<div class="vtm-preview" data-testid="agent-preview"><bdi>${preview}</bdi></div>` : nothing}
        </div>
      </div>
    `;
  }

  /**
   * "Needs you · Permission request" opens the answer sheet (app.ts), as in the Sessions list;
   * the rest of the card opens the session. It acts on pointerup like the card, and the click
   * that follows is swallowed so the card doesn't open the session too; a mouse uses the click.
   */
  private renderNeeds(session: Session, doing: string) {
    let touchedAt = 0;
    const open = () =>
      window.dispatchEvent(
        new CustomEvent('vt-open-answer-sheet', { detail: { sessionId: session.id } })
      );
    return html`<div
      class="vtm-doing vtm-needs"
      data-testid="agent-doing"
      @pointerdown=${(e: Event) => e.stopPropagation()}
      @pointerup=${(e: PointerEvent) => {
        e.stopPropagation();
        if (e.pointerType === 'mouse') return;
        // A scroll of the list that started on it ends here too: not a tap.
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
    ><bdi>${doing}</bdi></div>`;
  }

  private targets(cards: AgentCard[]): AgentCard[] {
    return cards.filter((card) => this.selected.has(card.session.id));
  }

  private renderBar(cards: AgentCard[]) {
    const count = this.targets(cards).length;
    if (!this.selecting) return nothing;
    const quick = [t('mission.quick.continue'), t('mission.quick.tests')];
    const ask = (text: string) => tap(() => this.confirmBroadcast(text));
    const send = ask(this.draft);
    return html`
      <div class="vtm-bar" data-testid="broadcast-bar">
        <div class="vtm-chips">
          ${quick.map((text) => {
            const handler = ask(text);
            return html`<button
              data-testid="broadcast-chip"
              ?disabled=${!count}
              @pointerup=${handler}
              @click=${handler}
            >${text}</button>`;
          })}
        </div>
        <div class="vtm-send-row">
          <input
            type="text"
            enterkeyhint="send"
            data-testid="broadcast-input"
            placeholder=${t('mission.placeholder')}
            aria-label=${t('mission.placeholder')}
            .value=${this.draft}
            @input=${(e: Event) => {
              this.draft = (e.target as HTMLInputElement).value;
            }}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault();
                this.confirmBroadcast(this.draft);
              }
            }}
          />
          <button
            data-testid="broadcast-send"
            ?disabled=${!count || !this.draft.trim()}
            @pointerup=${send}
            @click=${send}
          >
            ${t('mission.send', { n: count })}
          </button>
        </div>
      </div>
    `;
  }

  render() {
    const cards = missionCards(this.sessions);
    const counts = { waiting: 0, working: 0, idle: 0 };
    for (const card of cards) counts[card.state]++;
    const toggleSelect = tap(() => this.setSelecting(!this.selecting));
    const selectAll = tap(() => {
      this.selected = new Set(cards.map((card) => card.session.id));
    });
    const dismissIntro = tap(() => {
      rememberAgentsIntroDismissed();
      this.introDismissed = true;
    });
    return html`
      ${STYLES}
      <div data-testid="agent-mission">
        ${
          this.introDismissed
            ? nothing
            : html`<div class="vtm-intro" data-testid="agents-intro">
                <p>${t('mission.intro')}</p>
                <button data-testid="agents-intro-dismiss" @pointerup=${dismissIntro}
                  @click=${dismissIntro}>${t('mission.introDismiss')}</button>
              </div>`
        }
        ${
          cards.length
            ? html`
              <div class="vtm-toolbar">
                <span data-testid="mission-counts">${
                  this.selecting
                    ? t('mission.selected', { n: this.targets(cards).length })
                    : html`<span class="vtm-count">${t('mission.waitingCount', { n: counts.waiting })} ·</span>
                        <span class="vtm-count">${t('mission.workingCount', { n: counts.working })} ·</span>
                        <span class="vtm-count">${t('mission.idleCount', { n: counts.idle })}</span>`
                }</span>
                <span>
                  ${
                    this.selecting
                      ? html`<button data-testid="mission-select-all" @pointerup=${selectAll}
                          @click=${selectAll}>${t('mission.selectAll')}</button>`
                      : nothing
                  }
                  <button data-testid="mission-select" @pointerup=${toggleSelect}
                    @click=${toggleSelect}>
                    ${this.selecting ? t('mission.done') : t('mission.select')}
                  </button>
                </span>
              </div>
              <div class="vtm-list" data-testid="agent-cards">
                ${repeat(
                  cards,
                  (card) => card.session.id,
                  (card) => this.renderCard(card)
                )}
              </div>
              ${this.renderBar(cards)}
            `
            : html`<div class="vtm-empty" data-testid="mission-empty">${t('mission.empty')}</div>`
        }
      </div>
    `;
  }

  // --- Confirmation / results sheet (rendered in <body>, like the other phone sheets) ------

  private closeSheet = () => {
    if (!this.sheetHost) return;
    render(nothing, this.sheetHost);
    this.sheetHost.remove();
    this.sheetHost = null;
    this.releaseSheetFocus?.();
    this.releaseSheetFocus = null;
  };

  private confirmBroadcast(rawText: string) {
    const text = rawText.trim();
    const targets = this.targets(missionCards(this.sessions));
    if (!text || !targets.length || this.sheetHost) return;
    const host = document.createElement('div');
    host.dataset.testid = 'broadcast-sheet';
    document.body.appendChild(host);
    this.sheetHost = host;
    const openedAt = Date.now();
    let results: BroadcastResult[] | null = null;
    let sending = false;
    const since = () => openedAt;

    const run = async () => {
      if (sending || results) return;
      sending = true;
      draw();
      const io =
        this.io ?? httpBroadcastIo(() => (this.authClient ? this.authClient.getAuthHeader() : {}));
      try {
        results = await broadcast(targets, text, io);
      } finally {
        sending = false;
      }
      if (results.some((result) => result.outcome === 'sent')) this.draft = '';
      draw();
    };

    const note = (card: AgentCard) => {
      const result = results?.find((r) => r.sessionId === card.session.id);
      if (result) {
        const words = {
          sent: t('mission.result.sent'),
          blocked: t('mission.result.blocked'),
          exited: t('mission.result.exited'),
          failed: t('mission.result.failed', { error: result.error ?? '' }),
          watchOnly: t('mission.result.watchOnly'),
        };
        return html`<span class="vtm-note ${result.outcome}" data-testid="broadcast-result"
          data-outcome=${result.outcome}>${words[result.outcome]}</span>`;
      }
      return card.session.claudeStatus?.choices
        ? html`<span class="vtm-note blocked">${t('mission.result.blocked')}</span>`
        : nothing;
    };

    const draw = () => {
      if (this.sheetHost !== host) return;
      const sent = results?.filter((r) => r.outcome === 'sent').length ?? 0;
      const confirm = tap(() => void run(), since);
      const close = tap(() => this.closeSheet(), since);
      render(
        html`
          <div class="psr-sheet-backdrop" @click=${() => {
            if (!sending && Date.now() - openedAt > SHEET_GUARD_MS) this.closeSheet();
          }}></div>
          <div class="psr-sheet" role="dialog" aria-modal="true" aria-label=${t('mission.confirmTitle', { text, n: targets.length })}>
            <div class="psr-sheet-group">
              <div class="psr-sheet-title question" data-testid="broadcast-title">${
                results
                  ? t('mission.resultsTitle', { sent, n: targets.length })
                  : t('mission.confirmTitle', { text, n: targets.length })
              }</div>
              <div class="vtm-sheet-list">
                ${targets.map(
                  (card) => html`<div class="vtm-sheet-row" data-testid="broadcast-target"
                    data-session-id=${card.session.id}>
                    <span class="vtm-name"><bdi>${cardTitle(card.session)}</bdi></span>
                    ${note(card)}
                  </div>`
                )}
              </div>
              ${
                results
                  ? nothing
                  : html`<button class="vtm-confirm" data-testid="broadcast-confirm" ?disabled=${sending}
                      @pointerup=${confirm} @click=${confirm}>
                      ${sending ? t('mission.sending') : t('mission.confirm')}
                    </button>`
              }
            </div>
            <button class="psr-sheet-cancel" data-testid="broadcast-close" ?disabled=${sending}
              @pointerup=${close} @click=${close}>
              ${results ? t('common.close') : t('common.cancel')}
            </button>
          </div>
          ${STYLES}
        `,
        host
      );
    };

    draw();
    this.releaseSheetFocus = holdSheetFocus(host.querySelector<HTMLElement>('.psr-sheet'), () => {
      if (!sending) this.closeSheet();
    });
    requestAnimationFrame(() => host.querySelector('.psr-sheet')?.classList.add('open'));
  }
}
