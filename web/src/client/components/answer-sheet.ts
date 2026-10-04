/**
 * Answer sheet (phones): Claude's waiting prompt with one button per option and a reply box,
 * opened straight from a "Claude needs you" push (/session/<id>?answer=1) or from the
 * "needs you" chip of a session list row.
 *
 * What it shows first may be stale (the push can be minutes old), so it asks the server for
 * the live prompt when it opens and again right before sending: if Claude stopped waiting or
 * shows a different question, nothing is typed and the sheet says so. The server checks once
 * more (409) and picks the keys (the digit, or y/n). Nothing is ever answered without a tap.
 *
 * Rendered into <body> like the other phone sheets.
 */

import { html, nothing, render } from 'lit';
import { t } from '../i18n/index.js';
import { claudeWaitingLabel } from '../utils/claude-waiting-label.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { holdSheetFocus } from '../utils/sheet-a11y.js';

export interface PromptChoices {
  question: string;
  options: string[];
  /** What the menu is about ("Bash command", the command), shown above its question. */
  detail?: string[];
  /** What the server checks the menu by (ScreenChoices.key). */
  key?: string;
  /** A push's fingerprint of that key, which it has no room for (see menuKeyHash). */
  keyHash?: string;
}

export interface AnswerSheetOptions {
  sessionId: string;
  /** Session or conversation name, for the subtitle. */
  where?: string;
  /** What Claude waits for (Claude Code's waitingFor), shown until the live read arrives. */
  detail?: string;
  /** Choices known when opening (push data, session list): replaced by the live ones. */
  choices?: PromptChoices | null;
  authHeader?: () => Record<string, string>;
  onOpenSession?: () => void;
  /** Called after an answer was sent, with the toast text. */
  onSent?: (message: string) => void;
}

interface LivePrompt {
  waiting: boolean;
  waitingFor?: string;
  choices: PromptChoices | null;
}

type Phase = 'loading' | 'ready' | 'sending' | 'gone';

/** The click that finishes the gesture that opened the sheet must not hit its buttons. */
export const ANSWER_OPEN_GUARD_MS = 500;
const TAP_SLOP_PX = 10;

let openHost: HTMLElement | null = null;
let releaseFocus: (() => void) | null = null;

export function isAnswerSheetOpen(): boolean {
  return openHost !== null;
}

export function closeAnswerSheet(): void {
  const host = openHost;
  if (!host) return;
  openHost = null;
  render(nothing, host);
  host.remove();
  releaseFocus?.();
  releaseFocus = null;
}

/**
 * The same prompt, as far as the sheet can tell before answering: its question and options,
 * cut like a push cuts them (a longer option said "no longer waiting" of a prompt still
 * there). Which one exactly is the server's to check, by the key
 * of what the sheet shows: never by a key read at the tap, which would compare the screen
 * with itself.
 */
const sameChoices = (a: PromptChoices | null, b: PromptChoices | null) => {
  const shape = (c: PromptChoices | null) =>
    c && [c.question.slice(0, 160), c.options.slice(0, 9).map((option) => option.slice(0, 80))];
  return JSON.stringify(shape(a)) === JSON.stringify(shape(b));
};

export function openAnswerSheet(options: AnswerSheetOptions): void {
  closeAnswerSheet();
  const { sessionId } = options;
  const opener = document.activeElement;
  const host = document.createElement('div');
  document.body.appendChild(host);
  openHost = host;
  const openedAt = Date.now();
  const isOpen = () => openHost === host;

  let phase: Phase = 'loading';
  let choices: PromptChoices | null = options.choices ?? null;
  let detail = claudeWaitingLabel(options.detail) ?? '';
  let failed = false;
  let draft = '';

  const api = (path: string, init?: RequestInit) =>
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...options.authHeader?.() },
    });

  const readLive = async (): Promise<LivePrompt | null> => {
    const response = await api('/prompt');
    if (response.status === 404) return { waiting: false, choices: null };
    if (!response.ok) return null;
    return (await response.json()) as LivePrompt;
  };

  const done = () => {
    closeAnswerSheet();
    options.onSent?.(t('answerSheet.sent'));
  };

  /**
   * Re-reads the prompt: false (and the "no longer waiting" state) when it moved on, null when
   * unread. The answer then goes with the key of what is shown, or a push's fingerprint of it.
   */
  const stillTheSame = async (): Promise<boolean | null> => {
    const live = await readLive().catch(() => null);
    if (!live) return null;
    if (!live.waiting || !sameChoices(live.choices, choices)) {
      phase = 'gone';
      return false;
    }
    return true;
  };

  /** Posts what `body` builds once the prompt read again is still the one shown. */
  const send = async (path: string, body: () => unknown) => {
    if (phase !== 'ready') return;
    phase = 'sending';
    failed = false;
    paint();
    try {
      const same = await stillTheSame();
      if (same === false) return;
      if (same === null) {
        failed = true;
        return;
      }
      const response = await api(path, { method: 'POST', body: JSON.stringify(body()) });
      if (response.ok) return done();
      // "busy": another answer to this session is still on its way; this one can be retried.
      const error =
        response.status === 409
          ? ((await response.json().catch(() => ({}))) as { error?: string }).error
          : undefined;
      if (error !== 'busy' && (response.status === 409 || response.status === 404)) {
        phase = 'gone';
      } else failed = true;
    } catch {
      failed = true;
    } finally {
      if (isOpen()) {
        if (phase === 'sending') phase = 'ready';
        paint();
      }
    }
  };

  const answer = (option: number) =>
    choices &&
    send('/answer', () => ({
      option,
      question: choices?.question,
      options: choices?.options,
      key: choices?.key,
      keyHash: choices?.keyHash,
    }));

  const reply = () => {
    const text = draft.trim();
    if (!text) return;
    return send('/reply', () => ({
      text,
      question: choices?.question ?? null,
      options: choices?.options ?? null,
      key: choices?.key ?? null,
      keyHash: choices?.keyHash ?? null,
    }));
  };

  const openSession = () => {
    closeAnswerSheet();
    options.onOpenSession?.();
  };

  // Touch acts on pointerup: on iOS the first tap on freshly shown buttons is often taken
  // as a hover and produces no click. The click that may still follow is swallowed; mouse
  // and keyboard use the click. Nothing acts in the first moments after opening.
  let touchActedAt = 0;
  let down: { x: number; y: number } | null = null;
  const act = (fn: () => void) => ({
    handleEvent: (e: Event) => {
      if (e.type === 'pointerdown') {
        const p = e as PointerEvent;
        down = { x: p.clientX, y: p.clientY };
        return;
      }
      if (Date.now() - openedAt < ANSWER_OPEN_GUARD_MS) return;
      if (e.type === 'pointerup') {
        const p = e as PointerEvent;
        if (p.pointerType === 'mouse') return;
        const moved = down && Math.hypot(p.clientX - down.x, p.clientY - down.y) > TAP_SLOP_PX;
        down = null;
        if (moved) return;
        touchActedAt = Date.now();
        swallowNextClick();
      } else if (Date.now() - touchActedAt < 700) {
        return;
      }
      fn();
    },
  });
  const close = act(closeAnswerSheet);

  function paint() {
    if (!isOpen()) return;
    const busy = phase !== 'ready';
    const gone = phase === 'gone';
    render(
      html`
        <div class="ans-backdrop" @click=${close}></div>
        <div
          class="ans-sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ans-title"
          data-testid="answer-sheet"
        >
          <div class="ans-head">
            <div class="ans-head-text">
              <h2 id="ans-title" class="ans-title">
                ${gone ? t('answerSheet.notWaiting') : detail || t('answerSheet.title')}
              </h2>
              ${options.where ? html`<p class="ans-subtitle"><bdi>${options.where}</bdi></p>` : nothing}
            </div>
            <button
              class="ans-x"
              aria-label=${t('answerSheet.close')}
              @pointerdown=${close}
              @pointerup=${close}
              @click=${close}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          <div class="ans-body">
            ${
              gone
                ? html`<p class="ans-gone" data-testid="answer-gone">${t('answerSheet.notWaiting')}</p>`
                : html`
                    ${
                      phase === 'loading'
                        ? html`<p class="ans-note">${t('answerSheet.loading')}</p>`
                        : nothing
                    }
                    ${
                      // What an answer approves: "Bash command", the command (a push can be
                      // minutes old; the same question may now be about another command).
                      choices?.detail?.length
                        ? html`<div class="ans-detail" data-testid="answer-detail" dir="ltr">
                            ${choices.detail.map((line) => html`<div><bdi>${line}</bdi></div>`)}
                          </div>`
                        : nothing
                    }
                    ${choices ? html`<p class="ans-question"><bdi>${choices.question}</bdi></p>` : nothing}
                    ${
                      choices
                        ? html`<div class="ans-choices">
                            ${choices.options.map((label, index) => {
                              const pick = act(() => void answer(index + 1));
                              return html`<button
                                class="ans-choice"
                                data-testid="answer-choice"
                                ?disabled=${busy}
                                @pointerdown=${pick}
                                @pointerup=${pick}
                                @click=${pick}
                              >
                                <span class="ans-num">${index + 1}</span><bdi>${label}</bdi>
                              </button>`;
                            })}
                          </div>`
                        : nothing
                    }
                    ${
                      failed
                        ? html`<p class="ans-error" role="alert">
                            ${t('answerSheet.failed')}
                          </p>`
                        : nothing
                    }
                    <form
                      class="ans-reply"
                      @submit=${(e: Event) => {
                        e.preventDefault();
                        void reply();
                      }}
                    >
                      <input
                        class="ans-input"
                        data-testid="answer-reply"
                        type="text"
                        enterkeyhint="send"
                        autocomplete="off"
                        placeholder=${t('answerSheet.replyPlaceholder')}
                        aria-label=${t('answerSheet.replyPlaceholder')}
                        .value=${draft}
                        @input=${(e: Event) => {
                          draft = (e.target as HTMLInputElement).value;
                          paint();
                        }}
                      />
                      <button
                        class="ans-send"
                        data-testid="answer-send"
                        type="button"
                        ?disabled=${busy || !draft.trim()}
                        @pointerdown=${act(() => void reply())}
                        @pointerup=${act(() => void reply())}
                        @click=${act(() => void reply())}
                      >
                        ${t('answerSheet.send')}
                      </button>
                    </form>
                    ${choices ? html`<p class="ans-note">${t('answerSheet.replyHint')}</p>` : nothing}
                  `
            }
          </div>
          <div class="ans-foot">
            <button
              class="ans-open"
              data-testid="answer-open-session"
              @pointerdown=${act(openSession)}
              @pointerup=${act(openSession)}
              @click=${act(openSession)}
            >
              ${t('answerSheet.openSession')}
            </button>
          </div>
        </div>
      `,
      host
    );
  }

  paint();
  const sheet = host.querySelector<HTMLElement>('.ans-sheet');
  releaseFocus = holdSheetFocus(sheet, closeAnswerSheet, opener);
  requestAnimationFrame(() => sheet?.classList.add('open'));

  // Opened from a push the phone may still be waking up: a failed read is tried again.
  const readLiveRetrying = async (): Promise<LivePrompt | null> => {
    for (const pause of [0, 800, 2000]) {
      if (pause) await new Promise((resolve) => setTimeout(resolve, pause));
      if (!isOpen()) return null;
      const live = await readLive().catch(() => null);
      if (live) return live;
    }
    return null;
  };
  readLiveRetrying()
    .then((live) => {
      if (!isOpen()) return;
      if (live && !live.waiting) {
        phase = 'gone';
      } else {
        if (live) {
          choices = live.choices;
          detail = claudeWaitingLabel(live.waitingFor) || detail;
        }
        phase = 'ready';
      }
      paint();
    })
    .catch(() => {
      if (!isOpen()) return;
      phase = 'ready';
      paint();
    });
}
