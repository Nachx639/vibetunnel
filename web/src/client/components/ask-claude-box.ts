/**
 * "Ask Claude…" / "Ask Codex…" on the phone home screen: pick the agent, type a question,
 * pick the folder, send. The session list starts the agent there and the server types the
 * question once the agent is ready.
 *
 * Events: `ask-claude` ({ text, agent }) on send, `ask-pick-folder` when the folder chip is
 * tapped.
 */

import { html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { t } from '../i18n/index.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { formatPathForDisplay } from '../utils/path-utils.js';
import { endsADrag } from '../utils/pointer-drag.js';
import { composerHeightFor } from './terminal-chat-view.js';

export const ASK_DRAFT_KEY = 'vt-ask-claude-draft';
export const ASK_AGENT_KEY = 'vt-ask-agent';

export type AskAgent = 'claude' | 'codex';

/** The agent picked last in the ask box (Claude unless Codex was picked). */
export function readAskAgent(): AskAgent {
  try {
    return localStorage.getItem(ASK_AGENT_KEY) === 'codex' ? 'codex' : 'claude';
  } catch {
    return 'claude';
  }
}

function writeAskAgent(agent: AskAgent) {
  try {
    localStorage.setItem(ASK_AGENT_KEY, agent);
  } catch {
    // Blocked storage: the choice lasts until reload.
  }
}

function readDraft(): string {
  try {
    return localStorage.getItem(ASK_DRAFT_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(text: string) {
  try {
    if (text) localStorage.setItem(ASK_DRAFT_KEY, text);
    else localStorage.removeItem(ASK_DRAFT_KEY);
  } catch {
    // Blocked storage: the draft just isn't kept.
  }
}

/**
 * What the folder chip shows: the folder's own name, "~" or "/". The whole path, cut at the
 * end to fit, would hide the one part that tells folders apart.
 */
export function folderName(displayPath: string): string {
  const trimmed = displayPath.replace(/\/+$/, '');
  if (!trimmed) return displayPath ? '/' : '~';
  if (trimmed === '~') return '~';
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

@customElement('ask-claude-box')
export class AskClaudeBox extends LitElement {
  createRenderRoot() {
    return this;
  }

  /** Folder Claude starts in (shown on the chip). */
  @property({ type: String }) folder = '~';
  /** True while the session is being created: blocks a double send. */
  @property({ type: Boolean }) busy = false;

  @state() private text = readDraft();
  @state() private agent: AskAgent = readAskAgent();

  /** iOS: a touch acts on pointerup (a first tap can be eaten as hover); skip its click. */
  private ignoreClickUntil = 0;

  private onTap(action: () => void) {
    return {
      pointerup: (e: PointerEvent) => {
        if (e.pointerType !== 'touch') return;
        // A scroll of the list that started on a button ends here too: not a tap.
        if (endsADrag(e)) return;
        e.preventDefault();
        this.ignoreClickUntil = Date.now() + 700;
        swallowNextClick();
        action();
      },
      click: () => {
        if (Date.now() < this.ignoreClickUntil) return;
        action();
      },
    };
  }

  private sendTap = this.onTap(() => this.send());
  private claudeTap = this.onTap(() => this.pickAgent('claude'));
  private codexTap = this.onTap(() => this.pickAgent('codex'));

  private pickAgent(agent: AskAgent) {
    if (agent === this.agent) return;
    this.agent = agent;
    writeAskAgent(agent);
  }
  private folderTap = this.onTap(() =>
    this.dispatchEvent(new CustomEvent('ask-pick-folder', { bubbles: true }))
  );

  send() {
    const text = this.text.trim();
    if (!text || this.busy) return;
    this.dispatchEvent(
      new CustomEvent('ask-claude', { detail: { text, agent: this.agent }, bubbles: true })
    );
    this.text = '';
    writeDraft('');
    const input = this.querySelector('textarea');
    if (input) {
      input.value = '';
      this.autoSize(input);
    }
  }

  /** Put text back (the session could not be started) unless something new was typed. */
  restore(text: string) {
    if (this.text.trim()) return;
    this.text = text;
    writeDraft(text);
  }

  private autoSize(input: HTMLTextAreaElement) {
    input.style.height = 'auto';
    // scrollHeight includes the padding: setting it as a content-box height counted the
    // padding twice and showed an extra blank line (the chat composer does the same).
    input.style.height = `${Math.min(composerHeightFor(input.scrollHeight, getComputedStyle(input)), 140)}px`;
  }

  private onInput = (e: Event) => {
    const input = e.target as HTMLTextAreaElement;
    this.text = input.value;
    writeDraft(input.value);
    this.autoSize(input);
  };

  private onKeyDown = (e: KeyboardEvent) => {
    // Desktop keyboards: Enter sends, Shift+Enter is a new line. Touch keyboards keep Enter
    // for new lines and send with the button.
    const touch = window.matchMedia?.('(pointer: coarse)').matches;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touch) {
      e.preventDefault();
      this.send();
    }
  };

  render() {
    const folder = formatPathForDisplay(this.folder);
    const name = folderName(folder);
    const codex = this.agent === 'codex';
    const placeholder = t(codex ? 'ask.placeholderCodex' : 'ask.placeholder');
    const sendLabel = t(codex ? 'ask.sendCodex' : 'ask.send');
    const agentButton = (
      agent: AskAgent,
      label: string,
      tap: { pointerup: (e: PointerEvent) => void; click: () => void }
    ) =>
      html`<button
        type="button"
        role="radio"
        aria-checked=${this.agent === agent ? 'true' : 'false'}
        class=${this.agent === agent ? 'selected' : ''}
        data-testid=${`ask-agent-${agent}`}
        @pointerup=${tap.pointerup}
        @click=${tap.click}
      >${label}</button>`;
    return html`
      <div class="ask-claude" data-testid="ask-claude">
        <textarea
          rows="1"
          dir="auto"
          enterkeyhint="enter"
          placeholder=${placeholder}
          aria-label=${placeholder}
          .value=${this.text}
          @input=${this.onInput}
          @keydown=${this.onKeyDown}
        ></textarea>
        <div class="ask-claude-bar">
          <span class="ask-claude-start">
          <span class="ask-claude-agent" role="radiogroup" aria-label=${t('ask.agent')}>
            ${agentButton('claude', 'Claude', this.claudeTap)}${agentButton('codex', 'Codex', this.codexTap)}
          </span>
          <button
            class="ask-claude-folder"
            data-testid="ask-claude-folder"
            aria-label=${t('ask.folder', { folder })}
            title=${folder}
            @pointerup=${this.folderTap.pointerup}
            @click=${this.folderTap.click}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
            <bdi>${name}</bdi>
          </button>
          </span>
          <span class="ask-claude-actions">
          <button
            class="ask-claude-send"
            data-testid="ask-claude-send"
            aria-label=${sendLabel}
            title=${sendLabel}
            ?disabled=${!this.text.trim() || this.busy}
            @pointerup=${this.sendTap.pointerup}
            @click=${this.sendTap.click}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
              stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
          </button>
          </span>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ask-claude-box': AskClaudeBox;
  }
}
