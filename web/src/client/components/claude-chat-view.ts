/**
 * Claude Chat View
 *
 * Phone chat mode for Claude Code sessions: renders the conversation from Claude Code's
 * own transcript (served by /api/sessions/:id/claude-chat) as messaging-app bubbles. The
 * terminal only holds Claude Code's visible screen, so it cannot be the source.
 * Sets the `unavailable` attribute (and hides) when the session is not running Claude Code.
 */
import { css, html, LitElement, nothing, type PropertyValues } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import {
  parseScreenChoices,
  type ScreenChoices,
  type ScreenLayout,
  sameShownMenu,
} from '../../shared/claude-screen.js';
import { LocaleController, type MessageKey, t } from '../i18n/index.js';
import { authClient } from '../services/auth-client.js';
import { announce } from '../utils/announce.js';
import { type ClaudeActivity, formatActivity } from '../utils/claude-activity.js';
import { claudeWaitingLabel } from '../utils/claude-waiting-label.js';
import { isSwallowingGhostClick, swallowNextClick } from '../utils/ghost-click.js';
import { createLogger } from '../utils/logger.js';
import { endsADrag } from '../utils/pointer-drag.js';
import { closeClaudeModePicker, modeLabel, openClaudeModePicker } from './claude-mode-picker.js';
import { openImageLightbox } from './image-lightbox.js';

const logger = createLogger('claude-chat-view');

const POLL_INTERVAL_MS = 1500;
/** While Claude is idle and nothing changed for this many polls (~30 s), poll less often. */
const IDLE_POLLS_BEFORE_SLOWING = 20;
const IDLE_POLL_INTERVAL_MS = 3000;
/** Not a Claude session (a shell in chat mode): only check now and then whether one started. */
const UNAVAILABLE_POLL_INTERVAL_MS = 5000;
/** Right after a send: a poll at once, then these long after it, then the usual pace. */
const SENT_POLL_OFFSETS_MS = [300, 800];

/** Notes the server words in English ("[Request interrupted by user]"), in the page's language. */
const NOTE_KEYS: Record<string, MessageKey> = { Interrupted: 'chat.interrupted' };

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'note';
  text: string;
  timestamp?: string;
  tool?: string;
  question?: { text: string; options: string[] };
  detail?: string;
  result?: string;
  isError?: boolean;
  /** Edit/MultiEdit/Write: signed lines ('-', '+', ' '), or "…" for lines left out. */
  diff?: string[];
  diffMore?: number;
}

interface ChatResponse {
  available: boolean;
  status?: string;
  waitingFor?: string;
  title?: string;
  activity?: ClaudeActivity;
  /** Busy only because background agents or tasks run: the reply is over. */
  waitingForBackground?: boolean;
  messages: ChatMessage[];
  /** Fingerprint of `messages`, sent back as `?have=`. */
  messagesVersion?: string;
  /** The list matches `?have=` and was left out: keep the one shown. */
  messagesUnchanged?: boolean;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Code, bold, italics and strikethrough, in text already escaped (no links). */
function renderEmphasis(escaped: string): string {
  return escaped
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
}

const anchor = (url: string, label: string) =>
  `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;

/**
 * Links, inline code, bold, italics and strikethrough, in text already escaped. Links are
 * found in ONE scan and parked behind placeholders until the other rules have run: a second
 * URL rule going over the markup of the first nested an <a> inside an href, and the rest of
 * the URL became attributes, onclick included (an XSS). Only
 * http(s) links; the placeholder characters are removed from the input first.
 */
function renderInline(escaped: string): string {
  const links: string[] = [];
  const park = (html: string) => `${links.push(html) - 1}`;
  const parked = escaped
    .replace(/[]/g, '')
    .replace(
      /\[([^[\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,!?;:'"])/g,
      (_m, label?: string, url?: string, before?: string, bare?: string) =>
        label !== undefined && url !== undefined
          ? park(anchor(url, renderEmphasis(label)))
          : `${before ?? ''}${park(anchor(bare ?? '', bare ?? ''))}`
    );
  return renderEmphasis(parked).replace(
    /(\d+)/g,
    (_m, index: string) => links[Number(index)] ?? ''
  );
}

/** A heading or a --- / *** / ___ rule: block elements with their own spacing. */
const BLOCK_LINE = /^(?:#{1,6} |(?:-{3,}|\*{3,}|_{3,})[ \t]*$)/;

/**
 * Blank lines right before or after a heading or a rule only add empty lines to its own
 * spacing. Line by line: the regex version backtracked quadratically over long runs of
 * blank lines (40 000 took 1.6 s).
 */
function dropBlankLinesAroundBlocks(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      kept.push(lines[i]);
      continue;
    }
    let end = i;
    while (end < lines.length && lines[end].trim() === '') end++;
    const before = kept[kept.length - 1];
    const after = lines[end];
    const nextToBlock =
      (before !== undefined && BLOCK_LINE.test(before)) ||
      (after !== undefined && BLOCK_LINE.test(after));
    if (!nextToBlock) kept.push(...lines.slice(i, end));
    i = end - 1;
  }
  return kept.join('\n');
}

/** Prose: inline formatting, headings, lists and line breaks. */
function renderProse(text: string): string {
  // A heading or a rule has its own spacing: blank lines around it only add empty lines.
  const compact = dropBlankLinesAroundBlocks(text);
  return (
    renderInline(escapeHtml(compact))
      // Headings: a bit larger and set apart, so a long answer can be skimmed.
      .replace(
        /^(#{1,6}) (.+)$/gm,
        (_m, hashes: string, title: string) =>
          `<span class="h h${Math.min(hashes.length, 3)}">${title}</span>`
      )
      // A line of ---, *** or ___ separates sections; "> " lines are a quote.
      .replace(/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '<span class="hr"></span>')
      .replace(/^&gt; ?(.*)$/gm, '<span class="quote">$1</span>')
      // List items as blocks with a hanging indent, so a wrapped item lines up under its
      // text instead of under the bullet.
      .replace(
        /^( *)[-*] (.*)$/gm,
        (_m, indent: string, item: string) =>
          `<span class="li" style="margin-inline-start:${indent.length * 0.5}em">• ${item}</span>`
      )
      .replace(
        /^( *)(\d{1,3})[.)] (.*)$/gm,
        (_m, indent: string, n: string, item: string) =>
          `<span class="li" style="margin-inline-start:${indent.length * 0.5}em">${n}. ${item}</span>`
      )
      .replace(/<\/span>\n/g, '</span>')
      .replace(/\n(?=<span class="(?:li|quote|hr|h)\b)/g, '')
      .replace(/\n/g, '<br>')
  );
}

/** The cells of a table row; `\|` is a pipe inside a cell. */
function tableCells(line: string): string[] {
  let row = line.trim().replace(/\\\|/g, '\uE000');
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  return row.split('|').map((cell) => cell.trim().split('\uE000').join('|'));
}

const TABLE_DELIMITER_CELL = /^:?-{3,}:?$/;

/** A header line and the delimiter row under it (one `---` per header cell) start a table. */
function startsTable(lines: string[], i: number): boolean {
  if (!lines[i].includes('|') || i + 1 >= lines.length || !lines[i + 1].includes('-')) return false;
  const delimiter = tableCells(lines[i + 1]);
  return (
    delimiter.length === tableCells(lines[i]).length &&
    delimiter.every((cell) => TABLE_DELIMITER_CELL.test(cell))
  );
}

/** A markdown table; wider than the bubble, it scrolls sideways. */
function renderTable(lines: string[]): string {
  const header = tableCells(lines[0]);
  const aligns = tableCells(lines[1]).map((cell) =>
    cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : ''
  );
  const cell = (tag: 'th' | 'td', text: string, column: number) =>
    `<${tag}${aligns[column] ? ` style="text-align:${aligns[column]}"` : ''}>${renderInline(escapeHtml(text))}</${tag}>`;
  const rows = lines.slice(2).map((line) => {
    const cells = tableCells(line);
    return `<tr>${header.map((_, column) => cell('td', cells[column] ?? '', column)).join('')}</tr>`;
  });
  return `<div class="table-wrap"><table><thead><tr>${header
    .map((text, column) => cell('th', text, column))
    .join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

/** Text outside code blocks: tables (not raw pipes) and prose. */
function renderText(part: string): string {
  const lines = part.split('\n');
  const out: string[] = [];
  let prose: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!startsTable(lines, i)) {
      prose.push(lines[i]);
      continue;
    }
    // The table is a block: blank lines around it would add empty lines too.
    while (prose.length > 0 && prose[prose.length - 1].trim() === '') prose.pop();
    if (prose.length > 0) out.push(renderProse(prose.join('\n')));
    prose = [];
    let end = i + 2;
    while (end < lines.length && lines[end].includes('|') && lines[end].trim() !== '') end++;
    out.push(renderTable(lines.slice(i, end)));
    i = end - 1;
    if (lines[end]?.trim() === '') i++;
  }
  if (prose.length > 0) out.push(renderProse(prose.join('\n')));
  return out.join('');
}

/**
 * Small, safe markdown subset: fenced code, inline code, bold, italics, headings, lists,
 * tables. With `copyLabel`, code blocks get a copy button (handled by delegation in the view).
 */
export function renderChatMarkdown(text: string, copyLabel?: string): string {
  const parts = text.split(/```[^\n]*\n?/);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) {
        const block = `<pre><code>${escapeHtml(part.replace(/\n$/, ''))}</code></pre>`;
        return copyLabel
          ? `<div class="code-block"><button type="button" class="copy-code" data-copy-code>${escapeHtml(copyLabel)}</button>${block}</div>`
          : block;
      }
      // A code block has its own margins: the line breaks around its fences are not empty
      // lines (they left a gap between "Here is the code:" and the block).
      let prose = part;
      if (index > 0) prose = prose.replace(/^\n+/, '');
      if (index < parts.length - 1) prose = prose.replace(/\n+$/, '');
      return renderText(prose);
    })
    .join('');
}

const MODE_KEY_PREFIX = 'vt-claude-mode-';

/** Claude's permission mode last read on this session's screen, for this tab. */
function rememberedMode(sessionId: string): string | null {
  try {
    return sessionStorage.getItem(MODE_KEY_PREFIX + sessionId);
  } catch {
    return null;
  }
}

function rememberMode(sessionId: string, mode: string | null): void {
  try {
    if (mode) sessionStorage.setItem(MODE_KEY_PREFIX + sessionId, mode);
    else sessionStorage.removeItem(MODE_KEY_PREFIX + sessionId);
  } catch {
    // Storage blocked: the chip just waits for the screen, as before.
  }
}

/** Tap a sent image to see it full screen (pointerup: iOS can eat a first tap's click). */
function openOnTap(url: string) {
  return (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'pointerup') {
      // A scroll of the conversation that started on the image ends here too: not a tap.
      if (endsADrag(e as PointerEvent)) return;
      swallowNextClick();
    }
    openImageLightbox(url, t('chat.attachedImage'));
  };
}

/** A file path Claude can read as an image. */
const READ_IMAGE = /\.(?:png|jpe?g|gif|webp)$/i;

function isReadImage(message: { tool?: string; detail?: string }): boolean {
  return message.tool === 'Read' && READ_IMAGE.test(message.detail ?? '');
}

const UPLOADED_IMAGE = /\S*\/uploads\/([A-Za-z0-9._-]+\.(?:png|jpe?g|gif|webp|heic|heif))/gi;

/** Split images uploaded through VibeTunnel out of a message: their paths become thumbnails. */
export function extractUploadedImages(text: string): { text: string; images: string[] } {
  const images: string[] = [];
  const rest = text
    .replace(UPLOADED_IMAGE, (_path, name: string) => {
      images.push(name);
      return '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return { text: rest, images };
}

/**
 * Whether pressing Shift+Tab now could answer something instead of changing the mode: no
 * mode line on the live screen, or a numbered permission dialog showing (Claude can keep the
 * mode line visible under it; Shift+Tab there means "allow all edits this session").
 */
export function modeSwitchBlocked(screen: string): boolean {
  return !parseClaudeMode(screen) || parseScreenChoices(screen) !== null;
}

/** Claude Code's permission mode, read from its status line at the bottom of the screen. */
export function parseClaudeMode(screenText: string): string | null {
  // e.g. "⏵⏵ bypass permissions on", "⏸ plan mode on", "⏸ manual mode on"
  const match = screenText.match(/(?:⏵⏵|⏵|⏸)\s*([a-z][a-z -]*?) on\b/i);
  if (match) {
    const name = match[1].trim();
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  return screenText.includes('? for shortcuts') ? 'Default mode' : null;
}

function formatTime(timestamp?: string): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** "Today", "Yesterday" or a short date, for the separators between days of a long chat. */
function formatDay(date: Date, now = new Date()): string {
  if (localDayKey(date) === localDayKey(now)) return t('chat.today');
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (localDayKey(date) === localDayKey(yesterday)) return t('chat.yesterday');
  return date.toLocaleDateString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

function canShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

const SHARE_ICON = html`<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12" /><path d="M8 7l4-4 4 4" /><path d="M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7" /></svg>`;

const COPY_ICON = html`<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1" /></svg>`;

/** How long a menu just answered stays hidden while the screen still shows it. */
const ANSWERED_MENU_HIDE_MS = 4000;

/** A message the phone composer just sent (see ClaudeChatView.addSentMessage). */
export interface SentChatMessage {
  sessionId: string;
  /** The composer's id for it: a retry sends it again under the same id. */
  id: string;
  /** What was sent: uploaded images' paths, then the text. */
  text: string;
  /** Date.now() at the send. */
  at: number;
  /** performance.now() when the composer's send began, for the timing line. */
  startedAt: number;
}

/** Which sent message a failure or a retry is about. */
export interface SentChatMessageRef {
  sessionId: string;
  id: string;
}

type SendState = 'sending' | 'failed' | 'unconfirmed';

/** A sent message shown as the user's bubble until the transcript has it. */
interface PendingSent {
  id: string;
  text: string;
  words: string;
  images: string[];
  at: number;
  state: SendState;
  /** Order of sending: the messages of later sends came after it. */
  seq: number;
  /** User messages shown when it was sent (ids without an images suffix): none of them is it. */
  shownBefore: Set<string>;
  /**
   * The message of a later send, once the transcript has it: this one never came (or not yet)
   * and stays just before it, instead of below everything said since.
   */
  before?: string;
}

/** No word from the transcript or the composer this long after a send: say so, offer nothing. */
const SENT_CONFIRM_MS = 30_000;
/** How far the transcript's clock (the server's) may be behind the phone's. */
const SENT_CLOCK_SKEW_MS = 10_000;

/** A message's text as compared with what the phone sent: whitespace collapsed, images apart. */
function sentWords(text: string): { words: string; images: string[] } {
  const { text: rest, images } = extractUploadedImages(text.normalize('NFC'));
  return { words: rest.replace(/\s+/g, ' ').trim(), images: [...new Set(images)].sort() };
}

/**
 * The server marks a message with images logged after its text by a new id, `<id>+<images>`.
 * A message without an id still renders, as it always did.
 */
const baseMessageId = (id: string | undefined) => (id ?? '').split('+')[0];

/**
 * The transcript's messages that are the sent ones, by sent id. In send order: the first sent
 * takes the first match, so identical texts sent twice match one each. A message counts only if
 * it was not shown at the send, is not older than it (give or take the clocks) and does not
 * already stand for another one (`claimed`).
 */
function matchSent(
  sent: readonly PendingSent[],
  messages: readonly ChatMessage[],
  claimed: ReadonlySet<string>
) {
  const matches = new Map<string, string>();
  const taken = new Set(claimed);
  const users = messages.filter((m) => m.role === 'user');
  for (const pending of sent) {
    const match = users.find((m) => {
      const id = baseMessageId(m.id);
      if (taken.has(id) || pending.shownBefore.has(id)) return false;
      // A message without a time (NaN) is not ruled out by it.
      if (Date.parse(m.timestamp ?? '') < pending.at - SENT_CLOCK_SKEW_MS) return false;
      const shown = sentWords(m.text);
      if (shown.words !== pending.words) return false;
      // Claude Code logs a message's images just after its text: the text alone is it too.
      return shown.images.length === 0
        ? pending.words !== ''
        : shown.images.join('\n') === pending.images.join('\n');
    });
    if (match) {
      matches.set(pending.id, match.id);
      taken.add(baseMessageId(match.id));
    }
  }
  return matches;
}

/** A sent bubble as the transcript shows the message, so the two look the same. */
const sentAsMessage = (sent: PendingSent): ChatMessage => ({
  id: sent.id,
  role: 'user',
  text: sent.text,
  timestamp: new Date(sent.at).toISOString(),
});

const CLOCK_ICON = html`<svg class="sending-icon" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>`;
const ALERT_ICON = html`<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5" /><path d="M12 16.5v.01" /></svg>`;

@customElement('claude-chat-view')
export class ClaudeChatView extends LitElement {
  static styles = css`
    :host {
      /* Palette from the app theme (light/dark and color themes). */
      --chat-bg: var(--color-bg, #0b141a);
      --chat-panel: var(--color-bg-secondary, #111b21);
      --chat-border: var(--color-border-light, #1f2c33);
      --chat-border-strong: var(--color-border, #2a3942);
      --chat-text: var(--color-text, #e9edef);
      --chat-muted: var(--color-text-dim, #8696a0);
      --chat-bubble-in: var(--color-bg-elevated, #202c33);
      --chat-bubble-out: color-mix(in srgb, var(--color-primary, #10b981) 30%, var(--color-bg-elevated, #202c33));
      --chat-chip: var(--color-bg-tertiary, #182229);
      --chat-chip-hover: var(--color-surface-hover, #233138);
      --chat-link: var(--color-primary-light, #53bdeb);
      --chat-danger: var(--color-status-error, #f15c6d);
      --chat-warn: var(--color-status-warning, #f5d78e);
      --chat-warn-bg: color-mix(in srgb, var(--color-status-warning, #f5d78e) 18%, var(--color-bg, #0b141a));
      display: block;
      height: 100%;
      background: var(--chat-bg);
      color: var(--chat-text);
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
    }
    :host([unavailable]) {
      display: none;
    }
    :host {
      display: flex !important;
      flex-direction: column;
    }
    :host([unavailable]) {
      display: none !important;
    }
    .top {
      flex-shrink: 0;
      position: relative;
      z-index: 1;
      display: flex;
      align-items: center;
      background: var(--chat-panel);
      border-bottom: 1px solid var(--chat-border);
    }
    .title {
      flex: 1 1 auto;
      min-width: 0;
      /* Same inset on both sides so the title stays centred next to the search icon. */
      padding: 6px 36px;
      text-align: center;
      font-size: 12px;
      color: var(--chat-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .search-proxy {
      position: absolute;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      width: 44px;
      height: 44px;
      margin: 0;
      opacity: 0.01;
      font-size: 16px;
      border: 0;
      padding: 0;
      background: transparent;
      color: transparent;
      caret-color: transparent;
    }
    .search-toggle {
      position: absolute;
      right: 6px;
      top: 50%;
      transform: translateY(-50%);
      display: flex;
      padding: 4px;
      border: none;
      background: none;
      color: var(--chat-muted);
    }
    .search-toggle::after {
      content: '';
      position: absolute;
      inset: -11px;
    }
    .search-bar {
      flex: 1 1 auto;
      /* Without it the bar could not shrink below the field's built-in width: on a 375 pt
         phone the close button was pushed off the right edge. */
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 0 2px 0 8px;
    }
    .search-bar input {
      flex: 1 1 0;
      width: 0;
      min-width: 0;
      height: 32px;
      padding: 0 10px;
      border: 1px solid var(--chat-border-strong);
      border-radius: 8px;
      background: var(--chat-bg);
      color: var(--chat-text);
      /* 16px keeps iOS from zooming into the field. */
      font-size: 16px;
    }
    .search-count {
      flex-shrink: 0;
      padding: 0 4px;
      font-size: 12px;
      color: var(--chat-muted);
      font-variant-numeric: tabular-nums;
    }
    .search-bar button {
      flex-shrink: 0;
      width: 44px;
      height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: none;
      background: none;
      color: var(--chat-text);
    }
    .search-bar button:disabled {
      color: var(--chat-muted);
      opacity: 0.5;
    }
    mark.hit {
      background: color-mix(in srgb, var(--chat-warn) 45%, transparent);
      color: inherit;
      border-radius: 2px;
    }
    mark.hit.current {
      background: var(--chat-warn);
      color: #1a1405;
    }
    .mode-row {
      flex-shrink: 0;
      display: flex;
      padding: 4px 10px 6px;
      background: var(--chat-bg);
    }
    .mode {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 1px solid var(--chat-border-strong);
      border-radius: 999px;
      padding: 4px 10px;
      background: var(--chat-panel);
      color: var(--chat-text);
      font-size: 12px;
    }
    .mode span {
      color: var(--chat-muted);
      font-size: 11px;
    }
    .scroll-area {
      position: relative;
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .jump {
      position: absolute;
      right: 12px;
      bottom: 12px;
      width: 44px;
      height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--chat-border-strong);
      border-radius: 50%;
      background: var(--chat-panel);
      color: var(--chat-text);
      box-shadow: 0 2px 8px color-mix(in srgb, var(--chat-bg) 60%, transparent);
    }
    .jump .badge {
      position: absolute;
      top: -6px;
      right: -4px;
      min-width: 20px;
      height: 20px;
      padding: 0 5px;
      box-sizing: border-box;
      border-radius: 10px;
      background: var(--color-primary, #10b981);
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      line-height: 20px;
      text-align: center;
    }
    .scroller {
      flex: 1 1 auto;
      min-height: 0;
      height: 100%;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain;
      padding: 12px 10px 16px;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    /* The column overflows (it scrolls); never let items shrink to fit — chips with
       overflow: hidden collapsed to a thin line. */
    .scroller > * {
      flex-shrink: 0;
    }
    .row {
      display: flex;
    }
    .row.user {
      justify-content: flex-end;
    }
    .bubble {
      position: relative;
      max-width: 85%;
      padding: 6px 9px 18px;
      border-radius: 10px;
      font-size: 15px;
      line-height: 1.38;
      overflow-wrap: anywhere;
      box-shadow: 0 1px 0.5px rgba(11, 20, 26, 0.13);
    }
    .row.user .bubble {
      background: var(--chat-bubble-out);
      border-top-right-radius: 3px;
    }
    .row.assistant .bubble {
      background: var(--chat-bubble-in);
      border-top-left-radius: 3px;
    }
    .row.first {
      margin-top: 8px;
    }
    /* Room for the action icons (left) and the time (right) under a one-word answer. */
    .row.assistant .bubble {
      min-width: 116px;
    }
    /* And for the time under a one-character message ("2"), which wrapped a character per
       line in a bubble narrower than it. */
    .row.user .bubble {
      min-width: 84px;
    }
    .row.assistant .bubble.actions-2 {
      min-width: 160px;
    }
    /* Icons 26px apart so their 44px hit areas meet without overlapping. */
    .msg-actions {
      position: absolute;
      left: 8px;
      bottom: 2px;
      display: flex;
      gap: 26px;
    }
    .msg-action {
      position: relative;
      display: flex;
      padding: 2px;
      border: none;
      background: none;
      color: var(--chat-muted);
      opacity: 0.8;
    }
    .msg-action.active {
      color: var(--chat-link);
      opacity: 1;
    }
    /* The small buttons keep their look but get a finger-sized (44px) hit area. */
    .msg-action::after,
    .copy-code::after,
    .stop::after,
    .mode::after,
    .waiting button::after {
      content: '';
      position: absolute;
    }
    .msg-action::after {
      inset: -8px -13px -14px;
    }
    .copy-code::after {
      inset: -11px -6px;
    }
    .stop::after,
    .mode::after,
    .waiting button::after {
      inset: -8px -4px;
    }
    .copy-code,
    .stop,
    .mode,
    .waiting button {
      position: relative;
    }
    .li {
      display: block;
      padding-inline-start: 1.1em;
      text-indent: -1.1em;
      margin-block: 3px;
    }
    .h {
      display: block;
      margin: 10px 0 2px;
      font-weight: 700;
      line-height: 1.3;
    }
    .h:first-child {
      margin-top: 0;
    }
    .h1 {
      font-size: 1.15em;
    }
    .h2 {
      font-size: 1.07em;
    }
    .quote {
      display: block;
      margin-block: 2px;
      padding-inline-start: 8px;
      border-inline-start: 3px solid var(--chat-border);
      opacity: 0.85;
    }
    .hr {
      display: block;
      margin: 8px 0;
      border-top: 1px solid var(--chat-border);
    }
    .table-wrap {
      max-width: 100%;
      overflow-x: auto;
      margin: 6px 0;
    }
    .table-wrap table {
      border-collapse: collapse;
      font-size: 0.88em;
      line-height: 1.35;
    }
    /* A table needs the room: its bubble may take the whole width of the chat. */
    .bubble:has(.table-wrap) {
      max-width: 100%;
    }
    .table-wrap th,
    .table-wrap td {
      border: 1px solid var(--chat-border);
      padding: 3px 6px;
      vertical-align: top;
      text-align: start;
      /* The bubble's "anywhere" counts every letter as a break point when sizing columns:
         short columns were squeezed to one letter per line. Whole words; a long token can
         still break, and a table too wide for the bubble scrolls. */
      overflow-wrap: break-word;
    }
    .table-wrap th {
      font-weight: 600;
      background: rgba(127, 127, 127, 0.12);
    }
    .copy-msg.copied,
    .copy-code.copied {
      color: var(--color-status-success, #10b981);
    }
    .code-block {
      display: flex;
      flex-direction: column;
      min-width: 160px;
    }
    .copy-code {
      align-self: flex-end;
      margin: 2px 0 -2px;
      padding: 2px 8px;
      border: 1px solid var(--chat-border-strong);
      border-radius: 6px;
      background: var(--chat-panel);
      color: var(--chat-muted);
      font-size: 11px;
    }
    .copy-code.copied::after {
      content: ' ✓';
    }
    .time {
      position: absolute;
      right: 8px;
      bottom: 3px;
      font-size: 11px;
      color: var(--chat-muted);
      white-space: nowrap;
    }
    /* A message just sent, until the transcript has it: a little faded, a clock by its time.
       Same size as the transcript's bubble that replaces it, so nothing moves. */
    .row.user .bubble {
      transition: opacity 0.2s ease;
    }
    .row[data-send='sending'] .bubble {
      opacity: 0.7;
    }
    .sending-icon {
      margin-inline-start: 3px;
      vertical-align: -1px;
    }
    .send-note {
      align-self: flex-end;
      display: flex;
      align-items: center;
      gap: 4px;
      margin-block: 2px 4px;
      padding-inline: 4px;
      font-size: 12px;
      color: var(--chat-muted);
    }
    .send-note.failed {
      color: var(--chat-danger);
    }
    .send-note button {
      position: relative;
      border: none;
      background: none;
      padding: 2px 4px;
      color: var(--chat-link);
      font: inherit;
      font-weight: 600;
    }
    .send-note button::after {
      content: '';
      position: absolute;
      inset: -12px -8px;
    }
    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    @media (prefers-reduced-motion: reduce) {
      .row.user .bubble {
        transition: none;
      }
    }
    .attachment {
      display: block;
      max-width: 100%;
      max-height: 260px;
      margin: 2px 0 6px;
      border-radius: 8px;
      object-fit: cover;
    }
    .tool-detail .read-image {
      margin: 6px 10px;
      max-width: calc(100% - 20px);
      object-fit: contain;
    }
    .attachment.placeholder {
      width: 200px;
      height: 140px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.25);
      font-size: 28px;
    }
    .bubble a {
      color: var(--chat-link);
      text-decoration: underline;
      overflow-wrap: anywhere;
    }
    .bubble code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 13px;
      /* A tint of the text colour: light grey on a light theme, lighter than a dark bubble
         on a dark one (a fixed 25 % black was a heavy mid-grey in light mode). */
      background: color-mix(in srgb, var(--chat-text) 10%, transparent);
      border-radius: 4px;
      padding: 1px 4px;
    }
    /* Code and command output stay left-to-right even in RTL languages. */
    .bubble pre,
    .bubble code,
    .tool-detail pre {
      direction: ltr;
      text-align: left;
      unicode-bidi: isolate;
    }
    .bubble pre {
      margin: 6px 0 2px;
      padding: 8px;
      background: color-mix(in srgb, var(--chat-text) 7%, transparent);
      border: 1px solid color-mix(in srgb, var(--chat-text) 12%, transparent);
      border-radius: 6px;
      overflow-x: auto;
      white-space: pre;
    }
    .bubble pre code {
      background: none;
      padding: 0;
      font-size: 12px;
    }
    .day {
      align-self: center;
      margin: 10px 0 2px;
      padding: 3px 10px;
      border-radius: 8px;
      background: var(--chat-chip);
      color: var(--chat-muted);
      font-size: 12px;
    }
    .tool {
      align-self: center;
      max-width: 90%;
      margin: 2px 0;
      padding: 3px 10px;
      border-radius: 8px;
      background: var(--chat-chip);
      color: var(--chat-muted);
      font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tool.note {
      font-family: inherit;
      color: var(--chat-text);
      background: var(--chat-chip);
    }
    button.tool {
      border: none;
      cursor: pointer;
      padding-top: 6px;
      padding-bottom: 6px;
    }
    button.tool:disabled {
      cursor: default;
    }
    .tool.open {
      background: var(--chat-chip-hover);
    }
    .tool.error strong {
      color: var(--chat-danger);
    }
    .tool-detail {
      align-self: stretch;
      margin: 0 6px 4px;
      border-radius: 8px;
      background: var(--chat-panel);
      overflow: hidden;
    }
    .tool-detail pre {
      margin: 0;
      padding: 8px 10px;
      font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: var(--chat-text);
      max-height: 16rem;
      overflow-y: auto;
    }
    .tool-detail pre.cmd {
      color: var(--chat-link);
      border-bottom: 1px solid var(--chat-border);
    }
    .tool-detail pre.err {
      color: var(--chat-danger);
    }
    .tool-detail .diff {
      padding: 6px 0;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
      max-height: 20rem;
      overflow-y: auto;
      border-bottom: 1px solid var(--chat-border);
      /* Code stays left-to-right even in RTL languages. */
      direction: ltr;
      text-align: left;
      unicode-bidi: isolate;
    }
    .tool-detail .diff:last-child {
      border-bottom: none;
    }
    .diff .dl {
      /* Hanging indent: a wrapped line continues after the sign column. */
      padding: 0 10px 0 calc(4px + 1.3em);
      text-indent: -1.3em;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: var(--chat-text);
    }
    .diff .sign {
      display: inline-block;
      width: 1.3em;
      text-indent: 0;
      text-align: center;
      opacity: 0.7;
      user-select: none;
    }
    .diff .del {
      background: rgba(248, 81, 73, 0.16);
    }
    .diff .add {
      background: rgba(46, 160, 67, 0.18);
    }
    .diff .ctx {
      opacity: 0.7;
    }
    .diff .gap {
      text-align: center;
      text-indent: 0;
      padding-left: 10px;
      opacity: 0.6;
    }
    .tool strong {
      color: var(--chat-link);
      font-weight: 600;
    }
    .busy-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
    }
    .busy-row .typing {
      margin-top: 0;
    }
    .busy-row .activity {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      color: var(--chat-muted);
      font-variant-numeric: tabular-nums;
    }
    /* Claude replied; background agents still run: a quiet line, not the typing dots. */
    .background-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
      font-size: 13px;
      color: var(--chat-muted);
    }
    .background-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      border: 1.5px solid var(--chat-muted);
      flex: none;
    }
    .stop {
      border: 1px solid var(--chat-border-strong);
      border-radius: 999px;
      padding: 8px 14px;
      background: var(--chat-panel);
      color: var(--chat-text);
      font-size: 13px;
    }
    .stop:active {
      background: var(--chat-border-strong);
    }
    .typing {
      display: inline-flex;
      gap: 4px;
      padding: 10px 12px;
      background: var(--chat-bubble-in);
      border-radius: 10px;
      border-top-left-radius: 3px;
      margin-top: 8px;
      align-self: flex-start;
    }
    .typing span {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--chat-muted);
      animation: blink 1.2s infinite ease-in-out;
    }
    .typing span:nth-child(2) {
      animation-delay: 0.2s;
    }
    .typing span:nth-child(3) {
      animation-delay: 0.4s;
    }
    @keyframes blink {
      0%,
      80%,
      100% {
        opacity: 0.3;
        transform: translateY(0);
      }
      40% {
        opacity: 1;
        transform: translateY(-3px);
      }
    }
    /* Reduced motion: the typing dots only fade, slowly; they still say Claude is working. */
    @media (prefers-reduced-motion: reduce) {
      .typing span {
        animation-duration: 2.4s;
      }
      @keyframes blink {
        0%,
        80%,
        100% {
          opacity: 0.3;
        }
        40% {
          opacity: 1;
        }
      }
    }
    .question {
      align-self: flex-start;
      max-width: 85%;
      margin-top: 8px;
      padding: 8px;
      border-radius: 10px;
      border-top-left-radius: 3px;
      background: var(--chat-bubble-in);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .question-text {
      padding: 2px 4px 4px;
      font-size: 15px;
    }
    .question-detail {
      padding: 6px 8px;
      border-radius: 6px;
      background: var(--chat-panel);
      color: var(--chat-muted);
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      font-size: 12px;
      line-height: 1.4;
      overflow-wrap: anywhere;
    }
    .question button {
      border: 1px solid var(--chat-border-strong);
      border-radius: 8px;
      padding: 9px 12px;
      background: var(--chat-panel);
      color: var(--chat-link);
      font-size: 15px;
      text-align: center;
      /* A path in an option has no spaces to wrap at: it would run past the edge. */
      overflow-wrap: anywhere;
    }
    .question button.link {
      border: none;
      background: none;
      color: var(--chat-muted);
      font-size: 13px;
      padding: 4px;
      min-height: 44px;
    }
    .question button:active {
      background: var(--chat-border-strong);
    }
    .question button:disabled {
      opacity: 0.55;
    }
    .question-note {
      padding: 2px 4px;
      font-size: 13px;
      color: var(--color-status-warning-text, #b45309);
    }
    .waiting {
      align-self: center;
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 10px;
      padding: 8px 10px 8px 12px;
      border-radius: 10px;
      background: var(--chat-warn-bg);
      color: var(--chat-text);
      font-size: 13px;
    }
    .waiting button {
      border: none;
      border-radius: 8px;
      padding: 6px 10px;
      background: var(--chat-warn);
      color: #1a1405;
      font-weight: 600;
      font-size: 13px;
    }
    .offline {
      flex-shrink: 0;
      padding: 6px 12px;
      text-align: center;
      font-size: 12px;
      color: var(--chat-text);
      background: var(--chat-warn-bg);
      border-bottom: 1px solid var(--chat-border);
    }
    .empty {
      margin: auto;
      text-align: center;
      color: var(--chat-muted);
      font-size: 14px;
      padding: 24px;
    }
  `;

  @property({ type: String }) sessionId = '';
  @property({ type: Boolean, reflect: true }) unavailable = false;
  /** Last lines of the terminal screen, where Claude Code shows its mode. */
  @property({ attribute: false }) getScreenTail?: () => string;
  /**
   * The screen's last lines for reading a menu, as the composer and the server read them:
   * enough to reach its dialog's top (getScreenTail's 30 may not; its key then lacked the
   * command). With their layout.
   */
  @property({ attribute: false }) getMenuScreen?: () => string;
  @property({ attribute: false }) getScreenLayout?: () => ScreenLayout | undefined;

  @state() private messages: ChatMessage[] = [];
  /** Messages sent from the phone that the transcript does not have yet, in send order. */
  @state() private pendingSent: PendingSent[] = [];
  private sentTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private sentSeq = 0;
  /** Transcript messages (base ids) that took a sent bubble's place: each stands for one. */
  private claimedIds = new Set<string>();
  @state() private busy = false;
  /**
   * Claude Code says "busy" while background agents run, even after its reply: then it
   * waits for the user, and the view says so instead of showing the typing dots.
   */
  @state() private backgroundWait = false;
  /** What Claude is doing while busy ("Editing app.ts"), shown next to the typing dots. */
  @state() private activity: ClaudeActivity | null = null;
  @state() private waitingFor: string | null = null;
  @state() private loaded = false;
  /** The last poll could not reach the server: what is shown may be out of date. */
  @state() private offline = false;
  protected readonly i18n = new LocaleController(this);
  @state() private expandedTools = new Set<string>();
  @state() private conversationTitle = '';
  @state() private imageUrls = new Map<string, string>();
  private loadingImages = new Set<string>();
  @state() private mode: string | null = null;
  @state() private screenChoices: ScreenChoices | null = null;
  /** An option of the question card on its way through the server. */
  @state() private answering = false;
  /** Why the last tap on the card did nothing (the menu changed, the request failed). */
  @state() private answerNote = '';
  /**
   * The menu just answered: its card stays hidden while the screen still shows it (Claude
   * redraws after the Enter), for a few seconds at most.
   */
  private answeredMenu: { menu: ScreenChoices; at: number } | null = null;
  /**
   * Whether a question with its options shows here, as last told to the phone composer;
   * unset until told once, so a view mounted again says where it stands.
   */
  private askingShown: boolean | undefined;
  private signature = '';
  /** The server's fingerprint of the messages shown (null: none yet, or an older server). */
  private messagesVersion: string | null = null;
  /** Shown while the user reads further up; counts replies that arrived meanwhile. */
  @state() private showJump = false;
  @state() private unread = 0;

  @state() private searchOpen = false;
  @state() private searchQuery = '';
  @state() private searchIndex = 0;
  @state() private searchCount = 0;
  /**
   * Another text field has the focus (the composer, with its keyboard up). The search proxy is
   * a real field so a tap on the search icon raises the keyboard, but while the composer is
   * focused iOS counts it as the next field and offers its ↑ ↓ arrows, which could move the
   * keyboard to this invisible input. It is left out then: a tap lands on the search button below it, and moving the focus from the
   * composer to the search field by script keeps the keyboard that is already up.
   */
  @state() private fieldFocusedElsewhere = false;
  private searchMarks: HTMLElement[] = [];
  private scrollToMatchPending = false;

  @query('.scroller') private scroller?: HTMLElement;

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the polls right after a send fall due (Date.now()), soonest first. */
  private sentPolls: number[] = [];
  /** The last send, until its timing line is logged (see logSentTiming). */
  private sentTiming: {
    id: string;
    startedAt: number;
    /** Claude was working already: its "thinking" showed before the send. */
    busy: boolean;
    bubbleMs?: number;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private stickToBottom = true;
  private resizeObserver: ResizeObserver | null = null;

  /** Polls in a row that brought nothing new while Claude was idle. */
  private unchangedPolls = 0;

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    // Typing or tapping (sending a message, answering) brings a slowed poll back at once.
    document.addEventListener('keydown', this.handleUserActivity, true);
    document.addEventListener('pointerdown', this.handleUserActivity, true);
    document.addEventListener('focusin', this.trackFieldFocus, true);
    document.addEventListener('focusout', this.trackFieldFocus, true);
    this.trackFieldFocus();
    this.poll();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    closeClaudeModePicker();
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    document.removeEventListener('keydown', this.handleUserActivity, true);
    document.removeEventListener('pointerdown', this.handleUserActivity, true);
    document.removeEventListener('focusin', this.trackFieldFocus, true);
    document.removeEventListener('focusout', this.trackFieldFocus, true);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.forgetSent();
    for (const url of this.imageUrls.values()) URL.revokeObjectURL(url);
  }

  /**
   * Fetch an uploaded image (or, keyed "fs:<path>", an image file Claude read) with the auth
   * header: an <img src> could not send it.
   */
  private async loadImage(name: string) {
    if (this.loadingImages.has(name)) return;
    this.loadingImages.add(name);
    try {
      const source = name.startsWith('fs:')
        ? `/api/fs/raw?path=${encodeURIComponent(name.slice(3))}`
        : `/api/files/${encodeURIComponent(name)}`;
      const response = await fetch(source, { headers: authClient.getAuthHeader() });
      if (!response.ok) return;
      const url = URL.createObjectURL(await response.blob());
      this.imageUrls = new Map(this.imageUrls).set(name, url);
    } catch (error) {
      logger.debug('failed to load uploaded image', error);
    }
  }

  firstUpdated() {
    // The keyboard shrinks the view; keep the latest message in sight. Synchronously: a
    // resize observer runs after layout and before paint, while scrollToBottom() waits a
    // frame, so each keyboard or composer-row change would paint the conversation shifted
    // for one frame and then snap back.
    this.resizeObserver = new ResizeObserver(() => {
      if (this.stickToBottom && this.scroller) this.scroller.scrollTop = this.scroller.scrollHeight;
    });
    this.resizeObserver.observe(this);
  }

  updated(changed: PropertyValues) {
    if (changed.has('sessionId') && changed.get('sessionId') !== undefined) {
      // A different conversation: forget everything shown for the previous one.
      this.messages = [];
      this.signature = '';
      this.messagesVersion = null;
      this.loaded = false;
      this.offline = false;
      this.busy = false;
      this.backgroundWait = false;
      this.waitingFor = null;
      this.screenChoices = null;
      // The question card's state was the last session's.
      this.answering = false;
      this.answerNote = '';
      this.answeredMenu = null;
      this.mode = null;
      closeClaudeModePicker();
      this.conversationTitle = '';
      this.closeSearch();
      this.expandedTools = new Set();
      this.stickToBottom = true;
      this.showJump = false;
      this.unread = 0;
      this.spokenStatus = null;
      // Sent messages belong to the session they were sent to.
      this.forgetSent();
      this.poll();
    }
    if (
      changed.has('busy') ||
      changed.has('backgroundWait') ||
      changed.has('waitingFor') ||
      changed.has('loaded')
    ) {
      this.announceStatus();
    }
    const timing = this.sentTiming;
    if (timing) {
      // Rendered: the sent bubble first, then (a poll later) Claude's typing dots.
      const ms = Math.round(performance.now() - timing.startedAt);
      if (timing.bubbleMs === undefined && changed.has('pendingSent')) timing.bubbleMs = ms;
      if (timing.bubbleMs !== undefined && this.busy) {
        this.logSentTiming(timing.busy ? 'already showing' : `${ms} ms`);
      }
    }
    const grew = [
      'messages',
      'pendingSent',
      'busy',
      'backgroundWait',
      'waitingFor',
      'screenChoices',
      'imageUrls',
      'mode',
    ].some((key) => changed.has(key));
    if (grew && this.stickToBottom) this.scrollToBottom();
    if (
      ['messages', 'pendingSent', 'searchQuery', 'searchOpen', 'expandedTools'].some((key) =>
        changed.has(key)
      )
    ) {
      this.highlightMatches();
    }
    // The phone composer shows a menu's options as buttons too; while this view asks, it
    // leaves them here (otherwise the same buttons showed twice, one set over the other).
    const asking =
      !this.unavailable && Boolean(this.pendingQuestion || (this.waitingFor && this.screenChoices));
    if (asking !== this.askingShown) {
      this.askingShown = asking;
      this.dispatchEvent(
        new CustomEvent<boolean>('claude-chat-asking', {
          detail: asking,
          bubbles: true,
          composed: true,
        })
      );
    }
  }

  /** Claude's state as last told to a screen reader; null until the first poll lands. */
  private spokenStatus: string | null = null;

  /**
   * Say "working", "waiting for you" or "finished" when it changes, politely, not on every
   * poll and not for the state a session already had when it opened.
   */
  private announceStatus() {
    if (!this.loaded) return;
    const status = this.waitingFor
      ? `waiting:${this.waitingFor}`
      : this.busy
        ? 'busy'
        : this.backgroundWait
          ? 'background'
          : 'idle';
    const before = this.spokenStatus;
    this.spokenStatus = status;
    if (before === null || before === status) return;
    if (this.waitingFor) announce(t('chat.waiting', { reason: this.waitingFor }));
    else if (this.busy) announce(t('chat.working'));
    else if (this.backgroundWait) announce(t('a11y.chat.replied'));
    else if (before === 'busy' || before === 'background') announce(t('a11y.chat.finished'));
  }

  private pollGeneration = 0;

  /** Hidden: stop polling (the phone kept waking every 1.5 s). Shown: fetch at once. */
  private readonly handleVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      if (this.pollTimer) clearTimeout(this.pollTimer);
      this.pollTimer = null;
      this.sentPolls = [];
    } else {
      this.unchangedPolls = 0;
      this.poll();
    }
  };

  private readonly handleUserActivity = () => {
    if (this.unchangedPolls < IDLE_POLLS_BEFORE_SLOWING) return;
    this.unchangedPolls = 0;
    this.poll();
  };

  private async poll() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (!this.isConnected || !this.sessionId) return;
    // A restarted poll (session switch) supersedes any request still in flight, so an old
    // session's answer never lands in the new view (its question buttons would type there).
    const generation = ++this.pollGeneration;
    const sessionId = this.sessionId;

    // Hidden: no request and no timer; the visibilitychange handler polls on return.
    if (document.visibilityState === 'hidden') return;

    // The messages already shown: the server leaves them out of its answer if still current
    // (a long conversation was ~50 KB compressed every 1.5 s while the agent worked).
    const have = this.messagesVersion;
    const url = `/api/sessions/${sessionId}/claude-chat`;
    const query = have ? `?have=${encodeURIComponent(have)}` : '';
    try {
      const response = await fetch(`${url}${query}`, {
        headers: authClient.getAuthHeader(),
      });
      // An error answer (remote HQ session, expired auth, server error) must not leave an
      // opaque panel over the live terminal: treat it as "not a Claude session".
      const chat: ChatResponse = response.ok
        ? ((await response.json()) as ChatResponse)
        : { available: false, messages: [] };
      if (generation === this.pollGeneration && sessionId === this.sessionId) {
        // Whoever shows this view tells the error answers apart (404: the agent is gone).
        if (!response.ok) {
          this.dispatchEvent(
            new CustomEvent<number>('claude-chat-error', {
              detail: response.status,
              bubbles: true,
              composed: true,
            })
          );
        }
        this.offline = false;
        if (!Array.isArray(chat.messages)) {
          chat.messages = this.messages;
          chat.messagesVersion = this.messagesVersion ?? undefined;
        }
        const changed = this.apply(chat);
        // No status means no Claude here: that's not activity, so don't keep polling fast.
        // Background agents can keep Claude "busy" for an hour after its reply: poll like idle.
        const active = chat.available && chat.status !== 'idle' && !this.backgroundWait;
        this.unchangedPolls = changed || active ? 0 : this.unchangedPolls + 1;
      }
    } catch (error) {
      logger.debug('failed to load claude chat', error);
      if (generation === this.pollGeneration) this.offline = true;
    }

    if (
      this.isConnected &&
      generation === this.pollGeneration &&
      // Re-read after the await: the page may have been hidden meanwhile.
      (document.visibilityState as DocumentVisibilityState) !== 'hidden'
    ) {
      const delay = this.unavailable
        ? UNAVAILABLE_POLL_INTERVAL_MS
        : this.unchangedPolls >= IDLE_POLLS_BEFORE_SLOWING
          ? IDLE_POLL_INTERVAL_MS
          : POLL_INTERVAL_MS;
      this.pollTimer = setTimeout(() => this.poll(), this.nextSentPoll() ?? delay);
    }
  }

  /** The wait for the next of the polls right after a send, while one is left. */
  private nextSentPoll(): number | undefined {
    const now = Date.now();
    // Those that fell due while a request was out: one poll at once stands for them all.
    while (this.sentPolls.length > 1 && this.sentPolls[1] <= now) this.sentPolls.shift();
    const at = this.sentPolls.shift();
    return at === undefined ? undefined : Math.max(0, at - now);
  }

  /** Shows a poll's answer; returns whether anything on screen changed. */
  private apply(chat: ChatResponse): boolean {
    const before = `${this.unavailable}|${this.busy}|${this.backgroundWait}|${this.waitingFor}|${this.conversationTitle}|${this.signature}|${this.mode}|${JSON.stringify(this.screenChoices)}|${JSON.stringify(this.activity)}`;
    this.unavailable = !chat.available;
    this.dispatchEvent(
      new CustomEvent('claude-chat-availability', { detail: chat.available, bubbles: true })
    );
    this.backgroundWait = chat.status === 'busy' && chat.waitingForBackground === true;
    this.busy = chat.status === 'busy' && !this.backgroundWait;
    this.activity = this.busy ? (chat.activity ?? null) : null;
    this.conversationTitle = chat.title ?? '';
    const screen = this.getScreenTail?.() ?? '';
    // Claude Code's permission mode. Until the terminal's screen has loaded (a moment after
    // opening) the mode last read for this session stands in: the chip turning up late would
    // push the conversation up.
    if (screen.trim()) {
      this.mode = parseClaudeMode(screen);
      rememberMode(this.sessionId, this.mode);
    } else {
      this.mode = rememberedMode(this.sessionId);
    }
    const screenChoices =
      chat.status === 'waiting'
        ? parseScreenChoices(this.getMenuScreen?.() ?? screen, this.getScreenLayout?.())
        : null;
    // A fresh object every poll re-rendered (and re-scrolled) the view each 1.5 s while
    // Claude waited on a question; keep the old one when the choices are the same.
    if (JSON.stringify(screenChoices) !== JSON.stringify(this.screenChoices)) {
      this.screenChoices = screenChoices;
      this.answerNote = '';
      if (!sameShownMenu(this.answeredMenu?.menu, screenChoices)) this.answeredMenu = null;
    }
    this.waitingFor =
      chat.status === 'waiting'
        ? (claudeWaitingLabel(chat.waitingFor) ?? t('chat.yourInput'))
        : null;
    // Tool results attach to existing messages, so compare more than the last id.
    const signature = `${chat.messages.length}:${chat.messages[chat.messages.length - 1]?.id}:${
      chat.messages.filter((m) => m.result !== undefined).length
    }`;
    // With the server's fingerprint any change counts (an edited message too); an older
    // server sends none, and the signature decides.
    const messagesChanged =
      chat.messagesVersion !== undefined
        ? chat.messagesVersion !== this.messagesVersion
        : signature !== this.signature;
    if (messagesChanged) {
      this.signature = signature;
      this.messagesVersion = chat.messagesVersion ?? null;
      if (!this.stickToBottom) {
        // Count what came after the last message already shown, by id: the server sends at
        // most the latest 400, so past that the list length stops growing.
        const lastSeen = this.messages[this.messages.length - 1]?.id;
        const from = lastSeen ? chat.messages.findIndex((m) => m.id === lastSeen) + 1 : 0;
        this.unread += chat.messages
          .slice(from > 0 ? from : this.messages.length)
          .filter((m) => m.role === 'assistant').length;
      }
      this.messages = chat.messages;
      // In the same render, so a sent bubble gives way to the transcript's without a flicker.
      this.settleSent();
    }
    const wasLoaded = this.loaded;
    this.loaded = true;
    const after = `${this.unavailable}|${this.busy}|${this.backgroundWait}|${this.waitingFor}|${this.conversationTitle}|${this.signature}|${this.mode}|${JSON.stringify(this.screenChoices)}|${JSON.stringify(this.activity)}`;
    return !wasLoaded || after !== before;
  }

  /** A single-choice AskUserQuestion Claude is currently waiting on, if any. */
  private get pendingQuestion() {
    if (!this.waitingFor) return null;
    const last = this.messages[this.messages.length - 1];
    return last?.role === 'tool' && last.tool === 'AskUserQuestion'
      ? (last.question ?? null)
      : null;
  }

  /**
   * The menu on screen is the one just answered, a few seconds ago at most: same options and
   * key. By its options alone, the next command's prompt stayed hidden for 4 s, with no buttons
   * anywhere.
   */
  private justAnswered(): boolean {
    return (
      this.answeredMenu !== null &&
      sameShownMenu(this.answeredMenu.menu, this.screenChoices) &&
      Date.now() - this.answeredMenu.at < ANSWERED_MENU_HIDE_MS
    );
  }

  /**
   * Answer what Claude asks. A question read from the conversation (no menu on screen to
   * check) takes its option number; a menu on screen is answered by the server, which checks
   * it is still the same menu before pressing any key.
   */
  private async answer(optionIndex: number) {
    if (this.answering) return;
    const choices = this.pendingQuestion ? null : this.screenChoices;
    if (!choices) {
      this.waitingFor = null;
      this.dispatchEvent(
        new CustomEvent('claude-chat-input', {
          detail: String(optionIndex + 1),
          bubbles: true,
          composed: true,
        })
      );
      this.pollSoon();
      return;
    }
    const sessionId = this.sessionId;
    // The card keeps showing the menu (buttons off) until the server answers, so the composer
    // does not show it again under it, and a failed answer says so instead of the buttons just
    // coming back.
    this.answering = true;
    this.answerNote = '';
    let response: Response | null = null;
    try {
      response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authClient.getAuthHeader() },
        body: JSON.stringify({
          option: optionIndex + 1,
          question: choices.question,
          options: choices.options,
          key: choices.key,
        }),
      });
    } catch {
      response = null;
    } finally {
      if (this.sessionId === sessionId) this.answering = false;
    }
    // Another session opened meanwhile: this answer is not about what it shows.
    if (this.sessionId !== sessionId) return;
    if (response?.ok) {
      this.answeredMenu = { menu: choices, at: Date.now() };
      // Shown again if the screen still has it then (the answer did not take).
      setTimeout(() => this.requestUpdate(), ANSWERED_MENU_HIDE_MS + 50);
      this.pollSoon();
      return;
    }
    const error =
      response?.status === 409
        ? ((await response.json().catch(() => ({}))) as { error?: string }).error
        : undefined;
    this.answerNote = t(
      error === 'busy'
        ? 'screenMenu.sending'
        : response?.status === 409
          ? 'screenMenu.changed'
          : 'screenMenu.failed'
    );
  }

  private toggleTool(id: string) {
    const next = new Set(this.expandedTools);
    const opening = !next.delete(id);
    if (opening) next.add(id);
    this.expandedTools = next;
    if (!opening) return;
    // Reading what was opened: following new messages (or the image loading) pushed it out of
    // sight. Bring it into view; the view only stays pinned if that is still the bottom.
    this.markUserScroll();
    this.stickToBottom = false;
    void this.updateComplete.then(() => {
      this.revealToolDetail(id);
      this.handleScroll();
    });
  }

  private revealToolDetail(id: string) {
    for (const detail of this.shadowRoot?.querySelectorAll<HTMLElement>('.tool-detail') ?? []) {
      if (detail.dataset.toolId === id) detail.scrollIntoView?.({ block: 'nearest' });
    }
  }

  /** Pick Claude Code's permission mode from a sheet; it presses Shift+Tab until it shows. */
  private openModePicker = () => {
    const sessionId = this.sessionId;
    openClaudeModePicker({
      sessionId,
      readMode: () => (this.getScreenTail ? parseClaudeMode(this.getScreenTail()) : null),
      sendShiftTab: () =>
        this.dispatchEvent(
          new CustomEvent('claude-chat-input', { detail: '\x1b[Z', bubbles: true, composed: true })
        ),
      // Shift+Tab inside a permission dialog would move its selection, not the mode (on the
      // edit dialog it means "allow all edits"). Read the live screen, not the last poll's
      // state, which can be 1.5-3 s old.
      isBlocked: () =>
        sessionId !== this.sessionId ||
        !this.isConnected ||
        Boolean(this.waitingFor || this.screenChoices) ||
        modeSwitchBlocked(this.getScreenTail?.() ?? ''),
      onModeChange: (mode) => {
        if (sessionId === this.sessionId && mode) this.mode = mode;
      },
    });
  };

  /** Interrupt Claude Code (Esc), like the stop button of a chat app. */
  private stop = () => {
    this.dispatchEvent(
      new CustomEvent('claude-chat-input', { detail: '\x1b', bubbles: true, composed: true })
    );
  };

  private scrollToBottom() {
    requestAnimationFrame(() => {
      if (this.scroller) this.scroller.scrollTop = this.scroller.scrollHeight;
    });
  }

  private lastUserScrollIntent = 0;

  private markUserScroll = () => {
    this.lastUserScrollIntent = Date.now();
  };

  private handleScroll = () => {
    const el = this.scroller;
    if (!el) return;
    // Only a scroll the user made can unpin the view: layout changes (the composer growing,
    // the keyboard opening) also move scrollTop and must not stop following new messages.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom || Date.now() - this.lastUserScrollIntent < 1000) this.stickToBottom = atBottom;
    this.showJump = !this.stickToBottom;
    if (this.stickToBottom) this.unread = 0;
  };

  /**
   * The composer was focused: show the end of the conversation, like a messaging app.
   * Instant (the keyboard is animating); the resize observer keeps it there as it lands.
   */
  followLatest() {
    this.stickToBottom = true;
    this.showJump = false;
    this.unread = 0;
    this.scrollToBottom();
  }

  /**
   * A message the phone composer just sent: the user's bubble at once, "sending…", until the
   * transcript has it. Otherwise it would show only once Claude Code had written it and the
   * next poll (every 1.5 s) brought it. Sent again (Retry), its bubble goes back to sending.
   */
  addSentMessage(sent: SentChatMessage) {
    if (sent.sessionId !== this.sessionId || this.unavailable) return;
    const shownBefore = this.messages
      .filter((message) => message.role === 'user')
      .map((message) => baseMessageId(message.id));
    // Sent again, it is the latest send: at the end, compared with what is shown now.
    this.pendingSent = [
      ...this.pendingSent.filter((pending) => pending.id !== sent.id),
      {
        id: sent.id,
        text: sent.text,
        ...sentWords(sent.text),
        at: sent.at,
        state: 'sending',
        seq: ++this.sentSeq,
        shownBefore: new Set(shownBefore),
      },
    ];
    this.watchSent(sent.id);
    // Like a messaging app: what was just sent is in sight, even from further up.
    this.followLatest();
    this.logSentTiming('not seen before the next send');
    this.sentTiming = {
      id: sent.id,
      startedAt: sent.startedAt,
      busy: this.busy,
      timer: setTimeout(() => this.logSentTiming('not seen in 30 s'), SENT_CONFIRM_MS),
    };
    this.pollSoon();
  }

  /**
   * Claude's "thinking" shows with the first poll after it starts: polls a few hundred ms
   * apart catch it, where the usual pace left it for 1.5 s later. After a message, and after
   * an answer to its question card.
   */
  private pollSoon() {
    const now = Date.now();
    this.sentPolls = SENT_POLL_OFFSETS_MS.map((offset) => now + offset);
    this.unchangedPolls = 0;
    this.poll();
  }

  /** The composer could not send it (refused, or not delivered): "Couldn't send · Retry". */
  markSendFailed(ref: SentChatMessageRef) {
    if (ref.sessionId !== this.sessionId || !this.setSendState(ref.id, 'failed')) return;
    announce(t('chat.sendFailed'));
    if (this.sentTiming?.id === ref.id) this.logSentTiming('not seen, not sent');
  }

  /**
   * One log line per send: how long its bubble and Claude's "thinking" took to show, from
   * the composer's send. At log level: the client logger drops debug lines unless debug mode is
   * on, which nothing in the app turns on, so they would never reach the server's log.
   */
  private logSentTiming(thinking: string) {
    const timing = this.sentTiming;
    if (!timing) return;
    clearTimeout(timing.timer);
    this.sentTiming = null;
    logger.log(`chat timing: bubble ${timing.bubbleMs ?? '?'} ms, thinking ${thinking}`);
  }

  /**
   * No sign of it in the transcript and no error after SENT_CONFIRM_MS: it may have gone (Claude
   * Code queues a message sent while it works) or not, so neither "sending" nor a Retry that
   * could send it twice.
   */
  private watchSent(id: string) {
    clearTimeout(this.sentTimers.get(id));
    this.sentTimers.set(
      id,
      setTimeout(() => {
        this.sentTimers.delete(id);
        if (this.pendingSent.find((pending) => pending.id === id)?.state === 'sending') {
          this.setSendState(id, 'unconfirmed');
        }
      }, SENT_CONFIRM_MS)
    );
  }

  /** Moves a sent bubble to another state; false if it is gone or already in it. */
  private setSendState(id: string, state: SendState): boolean {
    const pending = this.pendingSent.find((sent) => sent.id === id);
    if (!pending || pending.state === state) return false;
    if (state !== 'sending') {
      clearTimeout(this.sentTimers.get(id));
      this.sentTimers.delete(id);
    }
    this.pendingSent = this.pendingSent.map((sent) => (sent.id === id ? { ...sent, state } : sent));
    return true;
  }

  /**
   * Sent bubbles the transcript now has give way to its messages (a failed one too: it went).
   * One sent before a message that came stays just before that message: it is not coming
   * (Claude Code takes queued messages in order) or not logged, and must not trail below
   * everything said since. Without a clock: the server's and the phone's may differ.
   */
  private settleSent() {
    if (this.pendingSent.length === 0) return;
    const matches = matchSent(this.pendingSent, this.messages, this.claimedIds);
    const came = this.pendingSent.flatMap((pending) => {
      const id = matches.get(pending.id);
      return id === undefined ? [] : [{ seq: pending.seq, id: baseMessageId(id) }];
    });
    for (const { id } of came) this.claimedIds.add(id);
    const shown = new Set(this.messages.map((message) => baseMessageId(message.id)));
    let changed = matches.size > 0;
    const next: PendingSent[] = [];
    for (const pending of this.pendingSent) {
      // Its message came; or the one it stood before is gone (past the latest 400, or /clear).
      if (matches.has(pending.id) || (pending.before && !shown.has(pending.before))) {
        clearTimeout(this.sentTimers.get(pending.id));
        this.sentTimers.delete(pending.id);
        changed = true;
        continue;
      }
      const later = pending.before ? undefined : came.find(({ seq }) => seq > pending.seq);
      if (later) changed = true;
      next.push(later ? { ...pending, before: later.id } : pending);
    }
    if (changed) this.pendingSent = next;
  }

  private forgetSent() {
    for (const timer of this.sentTimers.values()) clearTimeout(timer);
    this.sentTimers.clear();
    this.claimedIds.clear();
    this.pendingSent = [];
    this.sentPolls = [];
    if (this.sentTiming) clearTimeout(this.sentTiming.timer);
    this.sentTiming = null;
  }

  /** "Retry": the composer sends it again the way it went (TerminalChatView.resendMessage). */
  private retrySent(id: string) {
    this.dispatchEvent(
      new CustomEvent<SentChatMessageRef>('chat-message-retry', {
        detail: { sessionId: this.sessionId, id },
        bubbles: true,
        composed: true,
      })
    );
  }

  /** Retry acts on a tap's pointerup (iOS can eat a first tap's click), and on a keyboard click. */
  private retryTap(id: string) {
    return (e: Event) => {
      if (e.type === 'pointerup') {
        // A scroll of the conversation that started on the button ends here too: not a tap.
        if ((e as PointerEvent).button > 0 || endsADrag(e as PointerEvent)) return;
        // The click that follows the tap would send it twice.
        swallowNextClick();
      }
      this.retrySent(id);
    };
  }

  private jumpToLatest = () => {
    this.stickToBottom = true;
    this.showJump = false;
    this.unread = 0;
    const el = this.scroller;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el?.scrollTo({ top: el.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
  };

  /** Code block copy buttons come from markdown HTML, so they are handled by delegation. */
  private handleBubbleClick = (e: Event) => {
    const button = (e.target as HTMLElement).closest?.('[data-copy-code]') as HTMLElement | null;
    const code = button?.parentElement?.querySelector('pre')?.textContent;
    if (button && code != null) this.copy(code, button);
  };

  private async copy(text: string, button: HTMLElement) {
    try {
      await navigator.clipboard.writeText(text);
      button.classList.add('copied');
      setTimeout(() => button.classList.remove('copied'), 1500);
    } catch {
      // Clipboard denied (insecure context): the text is still selectable.
    }
  }

  /**
   * Wrap search matches inside the rendered bubbles in <mark>. Only text nodes are split
   * (built with DOM APIs, never HTML strings), so nothing in a message can inject markup.
   */
  private highlightMatches() {
    const root = this.shadowRoot;
    if (!root) return;
    for (const mark of root.querySelectorAll('mark.hit')) {
      const parent = mark.parentNode;
      mark.replaceWith(...mark.childNodes);
      parent?.normalize();
    }
    const query = this.searchOpen ? this.searchQuery.trim() : '';
    const marks: HTMLElement[] = [];
    if (query) {
      const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
      for (const container of root.querySelectorAll('.md')) {
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        const nodes: Text[] = [];
        while (walker.nextNode()) {
          const node = walker.currentNode as Text;
          if (!node.parentElement?.closest('button')) nodes.push(node);
        }
        for (const node of nodes) {
          const text = node.data;
          const fragment = document.createDocumentFragment();
          let last = 0;
          for (const match of text.matchAll(pattern)) {
            const start = match.index ?? 0;
            fragment.append(text.slice(last, start));
            const mark = document.createElement('mark');
            mark.className = 'hit';
            mark.textContent = match[0];
            fragment.append(mark);
            marks.push(mark);
            last = start + match[0].length;
          }
          if (last > 0) {
            fragment.append(text.slice(last));
            node.replaceWith(fragment);
          }
        }
      }
    }
    this.searchMarks = marks;
    this.searchCount = marks.length;
    if (this.scrollToMatchPending) {
      // A new query starts from the most recent match, like chat apps.
      this.scrollToMatchPending = false;
      this.searchIndex = marks.length - 1;
      this.showMatch();
    } else {
      this.searchIndex = Math.min(Math.max(this.searchIndex, 0), Math.max(marks.length - 1, 0));
      marks[this.searchIndex]?.classList.add('current');
    }
  }

  private showMatch() {
    for (const mark of this.searchMarks) mark.classList.remove('current');
    const mark = this.searchMarks[this.searchIndex];
    if (!mark) return;
    mark.classList.add('current');
    // Reading an older match: stop following new messages until the user jumps back.
    this.markUserScroll();
    this.stickToBottom = false;
    this.showJump = true;
    mark.scrollIntoView?.({ block: 'center' });
  }

  /** Step through matches: -1 goes up to older ones, +1 down to newer ones (wrapping). */
  private stepMatch(delta: number) {
    const count = this.searchMarks.length;
    if (!count) return;
    this.searchIndex = (this.searchIndex + delta + count) % count;
    this.showMatch();
  }

  /** Where the focus settled once a focus change is done (focusout comes before focusin). */
  private trackFieldFocus = () => {
    queueMicrotask(() => {
      let focused = document.activeElement;
      while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
      const field =
        focused instanceof HTMLInputElement ||
        focused instanceof HTMLTextAreaElement ||
        focused instanceof HTMLSelectElement ||
        (focused as HTMLElement | null)?.isContentEditable === true;
      this.fieldFocusedElsewhere = field && !focused?.classList.contains('search-proxy');
    });
  };

  /** The field under the finger: focused by the end of a tap meant for something above it. */
  private onSearchProxyFocus = (e: FocusEvent) => {
    if (isSwallowingGhostClick()) {
      (e.target as HTMLElement).blur();
      return;
    }
    void this.openSearch();
  };

  private openSearch = async () => {
    this.searchOpen = true;
    await this.updateComplete;
    this.shadowRoot?.querySelector<HTMLInputElement>('.search-bar input')?.focus();
  };

  private closeSearch = () => {
    this.searchOpen = false;
    this.searchQuery = '';
    this.searchIndex = 0;
    this.searchCount = 0;
    // Removing the focused search field may fire no focusout: look again once it is gone.
    void this.updateComplete.then(this.trackFieldFocus);
  };

  private handleSearchInput = (e: Event) => {
    this.searchQuery = (e.target as HTMLInputElement).value;
    this.scrollToMatchPending = true;
  };

  private handleSearchKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.closeSearch();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.stepMatch(e.shiftKey ? 1 : -1);
    }
  };

  private renderTop() {
    if (this.searchOpen) {
      const query = this.searchQuery.trim();
      return html`<div class="top">
        <div class="search-bar" role="search">
          <input
            type="search"
            enterkeyhint="search"
            autocapitalize="none"
            autocorrect="off"
            autocomplete="off"
            .value=${this.searchQuery}
            placeholder=${t('chat.searchPlaceholder')}
            aria-label=${t('chat.search')}
            @input=${this.handleSearchInput}
            @keydown=${this.handleSearchKey}
          />
          ${
            query
              ? html`<span class="search-count" role="status">${
                  this.searchCount
                    ? `${this.searchIndex + 1}/${this.searchCount}`
                    : t('chat.searchNoResults')
                }</span>`
              : nothing
          }
          <button
            class="search-prev"
            ?disabled=${!this.searchCount}
            aria-label=${t('chat.searchPrevious')}
            @click=${() => this.stepMatch(-1)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6" /></svg>
          </button>
          <button
            class="search-next"
            ?disabled=${!this.searchCount}
            aria-label=${t('chat.searchNext')}
            @click=${() => this.stepMatch(1)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6" /></svg>
          </button>
          <button class="search-close" aria-label=${t('chat.searchClose')} @click=${this.closeSearch}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
      </div>`;
    }
    const title = this.conversationTitle;
    if (!title && !this.messages.length) return nothing;
    return html`<div class="top">
      <div class="title" title=${title}>${title}</div>
      ${
        this.messages.length
          ? html`<button
              class="search-toggle"
              aria-label=${t('chat.search')}
              title=${t('chat.search')}
              @click=${this.openSearch}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            </button>
            <!-- A real field under the finger: iOS raises the keyboard only for a native tap,
                 not for the scripted focus() of the search field rendered after it. Not while
                 another field has the keyboard (fieldFocusedElsewhere). -->
            ${
              this.fieldFocusedElsewhere
                ? nothing
                : html`<input
                    class="search-proxy"
                    tabindex="-1"
                    aria-hidden="true"
                    autocomplete="off"
                    @focus=${this.onSearchProxyFocus}
                  />`
            }`
          : nothing
      }
    </div>`;
  }

  private renderActions(text: string) {
    return html`<div class="msg-actions">
      <button
        class="msg-action copy-msg"
        aria-label=${t('chat.copyMessage')}
        title=${t('chat.copyMessage')}
        @click=${(e: Event) => this.copy(text, e.currentTarget as HTMLElement)}
      >
        ${COPY_ICON}
      </button>
      ${
        canShare()
          ? html`<button
              class="msg-action share-msg"
              aria-label=${t('chat.share')}
              title=${t('chat.share')}
              @click=${() => this.share(text)}
            >
              ${SHARE_ICON}
            </button>`
          : nothing
      }
    </div>`;
  }

  private async share(text: string) {
    try {
      await navigator.share({ text });
    } catch {
      // Cancelled by the user, or not allowed here: nothing to do.
    }
  }

  /**
   * An image file Claude read (a screenshot it took, say), shown when its chip is opened:
   * the chip alone says only "Read · shot.png". Fetched on opening, not before.
   */
  private renderReadImage(message: ChatMessage) {
    const path = message.detail;
    if (!path || !isReadImage(message)) return nothing;
    const key = `fs:${path}`;
    const url = this.imageUrls.get(key);
    if (!url) this.loadImage(key);
    return url
      ? html`<img
          class="attachment read-image"
          src=${url}
          alt=${path}
          @load=${() => this.revealToolDetail(message.id)}
          @pointerup=${openOnTap(url)}
          @click=${openOnTap(url)}
        />`
      : html`<div class="attachment placeholder read-image">🖼️</div>`;
  }

  /** What an Edit/MultiEdit/Write changed: removed lines red, added green. */
  private renderDiff(message: ChatMessage) {
    if (!message.diff?.length) return nothing;
    return html`<div class="diff" role="group" aria-label=${t('chat.diffLabel')}>
      ${message.diff.map((line) =>
        line === '…'
          ? html`<div class="dl gap">⋯</div>`
          : html`<div class="dl ${line[0] === '-' ? 'del' : line[0] === '+' ? 'add' : 'ctx'}"><span class="sign">${line[0]}</span>${line.slice(1)}</div>`
      )}
      ${message.diffMore ? html`<div class="dl gap">${t('chat.diffMore', { n: message.diffMore })}</div>` : nothing}
    </div>`;
  }

  private renderMessage(message: ChatMessage, previous?: ChatMessage, sendState?: SendState) {
    if (message.role === 'note') {
      const key = NOTE_KEYS[message.text];
      return html`<div class="tool note">${key ? t(key) : message.text}</div>`;
    }
    if (message.role === 'tool') {
      const expandable = !!message.detail || message.result !== undefined || !!message.diff;
      const expanded = this.expandedTools.has(message.id);
      return html`
        <button
          class="tool ${expanded ? 'open' : ''} ${message.isError ? 'error' : ''}"
          ?disabled=${!expandable}
          aria-expanded=${expandable ? String(expanded) : nothing}
          @click=${() => this.toggleTool(message.id)}
        >
          <strong>${message.tool}</strong>${message.text ? html` · ${message.text}` : nothing}
        </button>
        ${
          expanded
            ? html`<div class="tool-detail" data-tool-id=${message.id}>
                ${message.detail ? html`<pre class="cmd">${message.detail}</pre>` : nothing}
                ${this.renderReadImage(message)}
                ${this.renderDiff(message)}
                ${
                  // With the change on screen the stock "file has been updated" adds nothing,
                  // nor "(no output)" under an image Claude read; an error always shows.
                  message.result !== undefined &&
                  !message.isError &&
                  !message.diff &&
                  !(message.result === '' && isReadImage(message))
                    ? html`<pre class="out">${message.result || t('chat.noOutput')}</pre>`
                    : message.result !== undefined && message.isError
                      ? html`<pre class="out err">${message.result || t('chat.noOutput')}</pre>`
                      : nothing
                }
              </div>`
            : nothing
        }
      `;
    }
    const first = previous?.role !== message.role;
    const { text, images } =
      message.role === 'user'
        ? extractUploadedImages(message.text)
        : { text: message.text, images: [] };
    return html`
      <div class="row ${message.role} ${first ? 'first' : ''}" data-send=${sendState ?? nothing}>
        <div
          class="bubble ${
            message.role === 'assistant' && text ? `actions-${1 + Number(canShare())}` : ''
          }"
          @click=${this.handleBubbleClick}
        >
          ${images.map((name) => {
            const url = this.imageUrls.get(name);
            if (!url) this.loadImage(name);
            return url
              ? html`<img
                  class="attachment"
                  src=${url}
                  alt=${t('chat.attachedImage')}
                  @load=${() => this.stickToBottom && this.scrollToBottom()}
                  @pointerup=${openOnTap(url)}
                  @click=${openOnTap(url)}
                />`
              : html`<div class="attachment placeholder">📷</div>`;
          })}
          ${text ? html`<div class="md">${unsafeHTML(renderChatMarkdown(text, t('chat.copy')))}</div>` : nothing}
          ${message.role === 'assistant' && text ? this.renderActions(text) : nothing}
          <span class="time">${formatTime(message.timestamp)}${sendState === 'sending' ? CLOCK_ICON : nothing}</span>
          ${
            sendState === 'sending'
              ? html`<span class="visually-hidden">${t('chat.sending')}</span>`
              : nothing
          }
        </div>
      </div>
    `;
  }

  private openTerminal = () => {
    this.dispatchEvent(
      new CustomEvent('claude-chat-open-terminal', {
        bubbles: true,
        composed: true,
      })
    );
  };

  /** A question read from the conversation, with its options, or what Claude waits for. */
  private renderAsking() {
    if (this.pendingQuestion) {
      return html`<div class="question">
        <div class="question-text">${this.pendingQuestion.text}</div>
        ${this.pendingQuestion.options.map(
          (option, index) => html`<button @click=${() => this.answer(index)}>${option}</button>`
        )}
      </div>`;
    }
    if (this.waitingFor && this.screenChoices && !this.justAnswered()) {
      return html`<div class="question">
        ${
          // What an answer approves ("Bash command", the command): the same question
          // comes for every permission.
          this.screenChoices.detail?.length
            ? html`<div class="question-detail" dir="ltr" data-testid="question-detail">
                ${this.screenChoices.detail.map((line) => html`<div>${line}</div>`)}
              </div>`
            : nothing
        }
        <div class="question-text">${this.screenChoices.question}</div>
        ${
          this.answerNote
            ? html`<div class="question-note" role="alert">${this.answerNote}</div>`
            : nothing
        }
        ${this.screenChoices.options.map(
          (option, index) =>
            html`<button ?disabled=${this.answering} @click=${() => this.answer(index)}>
              ${option}
            </button>`
        )}
        <button class="link" @click=${this.openTerminal}>${t('chat.openTerminal')}</button>
      </div>`;
    }
    if (this.waitingFor) {
      return html`<div class="waiting" role="status">
        <span>${t('chat.waiting', { reason: this.waitingFor })}</span>
        <button @click=${this.openTerminal}>${t('chat.openTerminal')}</button>
      </div>`;
    }
    return nothing;
  }

  /**
   * Messages sent from the phone that the transcript does not have yet, after the conversation
   * and the question it may end with (a reply answers it), shaped like the transcript's own so
   * that its message takes their place without anything moving.
   */
  private renderSent() {
    // The conversation's last day, as its separators go.
    let lastDay = '';
    for (let i = this.messages.length - 1; i >= 0 && !lastDay; i--) {
      const date = new Date(this.messages[i].timestamp ?? '');
      if (!Number.isNaN(date.getTime())) lastDay = localDayKey(date);
    }
    const rows = this.pendingSent
      .filter((sent) => !sent.before)
      .map((sent) => ({ message: sentAsMessage(sent), sent }));
    return this.renderRows(rows, this.messages[this.messages.length - 1], lastDay);
  }

  private renderSendNote(pending: PendingSent) {
    if (pending.state === 'failed') {
      const tap = this.retryTap(pending.id);
      return html`<div class="send-note failed" data-testid="send-note">
        ${ALERT_ICON}<span>${t('chat.sendFailed')}</span><span aria-hidden="true">·</span>
        <button type="button" data-testid="send-retry" @pointerup=${tap} @click=${tap}>
          ${t('attach.retry')}
        </button>
      </div>`;
    }
    if (pending.state === 'unconfirmed') {
      return html`<div class="send-note" data-testid="send-note">${t('chat.notConfirmed')}</div>`;
    }
    return nothing;
  }

  /** The conversation, with the sent bubbles it went past just before the message after each. */
  private renderMessages() {
    const placed = new Map<string, PendingSent[]>();
    for (const sent of this.pendingSent) {
      if (sent.before) placed.set(sent.before, [...(placed.get(sent.before) ?? []), sent]);
    }
    const rows = this.messages.flatMap((message) => {
      const id = baseMessageId(message.id);
      const before = placed.get(id) ?? [];
      placed.delete(id);
      return [...before.map((sent) => ({ message: sentAsMessage(sent), sent })), { message }];
    });
    return this.renderRows(rows, undefined, '');
  }

  /** Rows with a day separator wherever the local date changes (after `lastDay`). */
  private renderRows(
    rows: Array<{ message: ChatMessage; sent?: PendingSent }>,
    previous: ChatMessage | undefined,
    lastDay: string
  ) {
    return rows.map(({ message, sent }) => {
      const date = message.timestamp ? new Date(message.timestamp) : null;
      const day = date && !Number.isNaN(date.getTime()) ? localDayKey(date) : '';
      const separator =
        date && day && day !== lastDay
          ? html`<div class="day" role="separator">${formatDay(date)}</div>`
          : nothing;
      if (day) lastDay = day;
      const row = this.renderMessage(message, previous, sent?.state);
      previous = message;
      return html`${separator}${row}${sent ? this.renderSendNote(sent) : nothing}`;
    });
  }

  render() {
    return html`
      ${this.renderTop()}
      ${this.offline ? html`<div class="offline" role="status">${t('chat.offline')}</div>` : nothing}
      <div class="scroll-area">
      <div
        class="scroller"
        @scroll=${this.handleScroll}
        @touchmove=${this.markUserScroll}
        @wheel=${this.markUserScroll}
      >
        ${
          !this.loaded
            ? html`<div class="empty" role="status">${t('chat.loading')}</div>`
            : this.messages.length === 0
              ? this.pendingSent.length
                ? nothing
                : html`<div class="empty">${t('chat.empty')}</div>`
              : this.renderMessages()
        }
        ${this.renderAsking()}
        ${this.renderSent()}
        ${
          this.busy
            ? html`<div class="busy-row">
                <div class="typing" role="img" aria-label=${t('chat.working')}><span></span><span></span><span></span></div>
                ${
                  this.activity
                    ? html`<span class="activity" data-testid="chat-activity"
                        >Claude · <bdi>${formatActivity(this.activity)}</bdi>${
                          this.activity.since
                            ? html` · <claude-activity-elapsed since=${this.activity.since}></claude-activity-elapsed>`
                            : nothing
                        }</span
                      >`
                    : nothing
                }
                <button class="stop" @click=${this.stop} aria-label=${t('chat.stopClaude')}>■ ${t('chat.stop')}</button>
              </div>`
            : this.backgroundWait
              ? html`<div class="background-row" role="status" data-testid="chat-background">
                  <span class="background-dot" aria-hidden="true"></span>${t('activity.backgroundWait')}
                </div>`
              : nothing
        }
      </div>
      ${
        this.showJump
          ? html`<button
              class="jump"
              @click=${this.jumpToLatest}
              aria-label=${this.unread ? t('chat.newMessages', { n: this.unread }) : t('chat.jumpToLatest')}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6" /></svg>
              ${this.unread ? html`<span class="badge">${this.unread > 99 ? '99+' : this.unread}</span>` : nothing}
            </button>`
          : nothing
      }
      </div>
      ${
        this.mode
          ? html`<div class="mode-row">
              <button
                class="mode"
                data-testid="mode-chip"
                aria-haspopup="dialog"
                @click=${this.openModePicker}
                aria-label=${t('chat.changeMode')}
              >
                ${modeLabel(this.mode)}<span aria-hidden="true">▾</span>
              </button>
            </div>`
          : nothing
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'claude-chat-view': ClaudeChatView;
  }
}
