/**
 * Copy mode (phones): the terminal is a <canvas>, so iOS cannot select its text. This sheet
 * shows the screen plus recent scrollback as plain text in a native <pre>, where touch and
 * hold brings up the system selection handles and the Copy menu. URLs are tappable links.
 *
 * Rendered into <body>: position:fixed inside a transformed ancestor (the session view) would
 * be fixed to that ancestor instead of the screen.
 */

import { html, nothing, render } from 'lit';
import { t } from '../../i18n/index.js';
import { Z_INDEX } from '../../utils/constants.js';
import { copyToClipboard } from '../../utils/path-utils.js';

/** Lines of scrollback (including the visible screen) shown in the sheet. */
export const COPY_MODE_LINES = 500;

/** The click that finishes the gesture that opened the sheet must not hit its buttons. */
const OPEN_GUARD_MS = 500;
const TAP_SLOP_PX = 10;

// CSI, OSC (BEL or ST terminated), and two-byte escapes; then any other C0 control but tab
// and newline, and DEL.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: see above
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Plain text only: no escapes or controls, no trailing spaces, no trailing blank lines. */
export function cleanTerminalText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(ANSI_RE, '')
    .replace(CONTROL_RE, '')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

export type TextPart = { text: string; url?: string };

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/g;

/** Splits text into plain runs and http(s) URLs (trailing punctuation stays outside). */
export function linkifyText(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    let url = match[0];
    // "see https://x.dev/a." or "(https://x.dev/a)": the closing mark is not part of the URL.
    while (/[.,;:!?'"\]}>]$/.test(url) || (url.endsWith(')') && !url.includes('('))) {
      url = url.slice(0, -1);
    }
    const start = match.index ?? 0;
    if (url.length <= 'https://'.length) continue;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ text: url, url });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

let openHost: HTMLElement | null = null;
let releaseFocus: (() => void) | null = null;

/**
 * iOS follows a tap's pointerup with a click a moment later. When the pointerup closed the
 * sheet, that click would land on whatever is under the finger now (the terminal, which
 * raises the keyboard): it is dropped, as is any click in the next `ms`.
 */
function swallowNextClick(ms = 700): void {
  const until = Date.now() + ms;
  const swallow = (e: Event) => {
    document.removeEventListener('click', swallow, true);
    if (Date.now() > until) return;
    e.preventDefault();
    e.stopPropagation();
  };
  document.addEventListener('click', swallow, true);
  setTimeout(() => document.removeEventListener('click', swallow, true), ms);
}

/**
 * Focus moves into the sheet so a screen reader starts at its title, Escape closes it, and
 * focus goes back to where it was when it closes. Returns the release function.
 */
function holdSheetFocus(sheet: HTMLElement | null, onEscape: () => void): () => void {
  if (!sheet) return () => {};
  const opener = document.activeElement;
  sheet.setAttribute('tabindex', '-1');
  sheet.focus({ preventScroll: true });
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !sheet.isConnected) return;
    e.preventDefault();
    e.stopPropagation();
    onEscape();
  };
  document.addEventListener('keydown', onKeyDown, true);
  return () => {
    document.removeEventListener('keydown', onKeyDown, true);
    if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) {
      opener.focus({ preventScroll: true });
    }
  };
}

export function closeCopyMode(): void {
  if (!openHost) return;
  render(nothing, openHost);
  openHost.remove();
  openHost = null;
  releaseFocus?.();
  releaseFocus = null;
}

export function isCopyModeOpen(): boolean {
  return openHost !== null;
}

export function openCopyMode(rawText: string): void {
  closeCopyMode();
  // Reading, not typing: drop the soft keyboard so the text gets the whole screen.
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.matches('input, textarea, [contenteditable]')) {
    active.blur();
  }

  const text = cleanTerminalText(rawText);
  const host = document.createElement('div');
  host.dataset.testid = 'copy-mode';
  document.body.appendChild(host);
  openHost = host;
  const openedAt = Date.now();
  let status: 'idle' | 'copied' | 'failed' = 'idle';

  // Touch acts on pointerup: on iOS the first tap on freshly shown buttons is often taken
  // as a hover and produces no click. The click that may still follow is ignored; mouse and
  // keyboard use the click. Nothing acts in the first moments after opening.
  let touchActedAt = 0;
  let down: { x: number; y: number } | null = null;
  const act = (fn: () => void) => ({
    handleEvent: (e: Event) => {
      if (e.type === 'pointerdown') {
        const p = e as PointerEvent;
        down = { x: p.clientX, y: p.clientY };
        return;
      }
      if (Date.now() - openedAt < OPEN_GUARD_MS) return;
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

  const copyAll = act(async () => {
    const ok = await copyToClipboard(text);
    status = ok ? 'copied' : 'failed';
    draw();
  });
  const close = act(closeCopyMode);

  const lines = text.split('\n');
  const body = lines.map((line, i) => {
    const parts = linkifyText(line).map((part) =>
      part.url
        ? html`<a href=${part.url} target="_blank" rel="noopener noreferrer">${part.text}</a>`
        : part.text
    );
    return i < lines.length - 1 ? [parts, '\n'] : parts;
  });

  const draw = () => {
    if (openHost !== host) return;
    const copyLabel =
      status === 'copied'
        ? t('copyMode.copied')
        : status === 'failed'
          ? t('copyMode.copyFailed')
          : t('copyMode.copyAll');
    render(
      html`
        <style>
          .vt-copy-mode {
            position: fixed;
            inset: 0;
            display: flex;
            flex-direction: column;
            background: var(--color-bg);
            color: var(--color-text);
            padding: env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);
          }
          .vt-copy-bar {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 12px;
            border-bottom: 1px solid var(--color-border);
            background: var(--color-bg-secondary);
          }
          .vt-copy-title {
            flex: 1;
            min-width: 0;
            font-weight: 600;
            font-size: 15px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .vt-copy-bar button {
            min-height: 40px;
            padding: 0 14px;
            border-radius: 8px;
            font-size: 14px;
            border: 1px solid var(--color-border);
            color: var(--color-text);
            background: var(--color-bg-tertiary);
            touch-action: manipulation;
          }
          .vt-copy-bar button.vt-copy-primary {
            background: var(--color-primary);
            border-color: var(--color-primary);
            color: var(--color-bg);
          }
          .vt-copy-hint {
            padding: 6px 12px;
            font-size: 12px;
            color: var(--color-text-muted);
          }
          .vt-copy-text {
            flex: 1;
            margin: 0;
            padding: 8px 12px calc(16px + env(safe-area-inset-bottom));
            overflow: auto;
            overscroll-behavior: contain;
            -webkit-overflow-scrolling: touch;
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-size: 13px;
            line-height: 1.4;
            white-space: pre;
            user-select: text;
            -webkit-user-select: text;
            -webkit-touch-callout: default;
          }
          .vt-copy-text a {
            color: var(--color-primary);
            text-decoration: underline;
          }
          .vt-copy-empty {
            padding: 24px 16px;
            text-align: center;
            color: var(--color-text-dim);
          }
        </style>
        <div
          class="vt-copy-mode"
          role="dialog"
          aria-modal="true"
          aria-label=${t('copyMode.title')}
          style="z-index: ${Z_INDEX.MODAL};"
        >
          <div class="vt-copy-bar">
            <div class="vt-copy-title">${t('copyMode.title')}</div>
            <button
              class="vt-copy-primary"
              data-testid="copy-mode-copy-all"
              ?disabled=${!text}
              @pointerdown=${copyAll}
              @pointerup=${copyAll}
              @click=${copyAll}
            >
              ${copyLabel}
            </button>
            <button
              data-testid="copy-mode-close"
              @pointerdown=${close}
              @pointerup=${close}
              @click=${close}
            >
              ${t('copyMode.close')}
            </button>
          </div>
          ${
            text
              ? html`<div class="vt-copy-hint">${t('copyMode.hint')}</div>
                  <pre class="vt-copy-text" dir="ltr" data-testid="copy-mode-text">${body}</pre>`
              : html`<div class="vt-copy-empty">${t('copyMode.empty')}</div>`
          }
        </div>
      `,
      host
    );
  };

  draw();
  const pre = host.querySelector<HTMLElement>('.vt-copy-text');
  if (pre) pre.scrollTop = pre.scrollHeight;
  releaseFocus = holdSheetFocus(host.querySelector<HTMLElement>('.vt-copy-mode'), closeCopyMode);
}
