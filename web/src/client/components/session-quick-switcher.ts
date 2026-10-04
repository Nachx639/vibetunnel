/**
 * Session Quick Switcher
 *
 * A keyboard-driven, fuzzy-filterable session switcher (Cmd+K on Mac/iPad Magic
 * Keyboard). Lets you jump to any session by name/working-dir/command from the session
 * list or the session header. Arrow keys to move, Enter to switch, Escape to close.
 *
 * Opt-in (Settings > Application): Cmd+K also means "clear" in many terminals, so the
 * shortcut is only taken when the user turned it on, and never while a terminal has the
 * keyboard (keyboard capture on, or focus in the terminal): there Cmd+K stays the terminal's.
 *
 * @fires select-session - detail: { sessionId } when a session is chosen
 * @fires close - when dismissed
 */
import { html, LitElement, type PropertyValues } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import type { Session } from '../../shared/types.js';
import { LocaleController, t } from '../i18n/index.js';
import { createLogger } from '../utils/logger.js';
import './modal-wrapper.js';

const logger = createLogger('session-quick-switcher');

const PREFERENCES_KEY = 'vibetunnel_app_preferences';

/** Whether Cmd+K opens this switcher (app preference `quickSwitcher`, off by default). */
export function isQuickSwitcherEnabled(): boolean {
  try {
    const stored = localStorage.getItem(PREFERENCES_KEY);
    return Boolean(stored && JSON.parse(stored).quickSwitcher === true);
  } catch {
    return false;
  }
}

export function setQuickSwitcherEnabled(enabled: boolean): void {
  try {
    const stored = localStorage.getItem(PREFERENCES_KEY);
    const preferences = stored ? JSON.parse(stored) : {};
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ ...preferences, quickSwitcher: enabled })
    );
  } catch {
    // Blocked storage: the choice is not kept.
  }
}

@customElement('session-quick-switcher')
export class SessionQuickSwitcher extends LitElement {
  // Light DOM so Tailwind classes apply (matches the rest of the app)
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  @property({ type: Boolean }) visible = false;
  @property({ type: Array }) sessions: Session[] = [];

  @state() private filterText = '';
  @state() private selectedIndex = 0;

  @query('#quick-switcher-input') private inputEl?: HTMLInputElement;

  updated(changed: PropertyValues) {
    if (changed.has('visible') && this.visible) {
      // Reset and focus the input each time it opens
      this.filterText = '';
      this.selectedIndex = 0;
      requestAnimationFrame(() => this.inputEl?.focus());
    }
  }

  private get filteredSessions(): Session[] {
    // Running sessions first, then the rest; stable within each group.
    const sorted = [...this.sessions].sort((a, b) => {
      const ar = a.status === 'running' ? 0 : 1;
      const br = b.status === 'running' ? 0 : 1;
      return ar - br;
    });

    const q = this.filterText.trim().toLowerCase();
    if (!q) return sorted;

    // Simple subsequence fuzzy match over name + command + working dir.
    return sorted.filter((s) => this.isFuzzyMatch(this.haystack(s), q));
  }

  private haystack(s: Session): string {
    const cmd = Array.isArray(s.command) ? s.command.join(' ') : '';
    return `${s.name ?? ''} ${cmd} ${s.workingDir ?? ''}`.toLowerCase();
  }

  private isFuzzyMatch(haystack: string, needle: string): boolean {
    // Plain substring first (fast path), then ordered-subsequence fallback.
    if (haystack.includes(needle)) return true;
    let i = 0;
    for (const ch of haystack) {
      if (ch === needle[i]) i++;
      if (i === needle.length) return true;
    }
    return needle.length === 0;
  }

  private handleInput(e: Event) {
    this.filterText = (e.target as HTMLInputElement).value;
    this.selectedIndex = 0;
  }

  private handleKeydown(e: KeyboardEvent) {
    const list = this.filteredSessions;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.selectedIndex = list.length ? (this.selectedIndex + 1) % list.length : 0;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.selectedIndex = list.length ? (this.selectedIndex - 1 + list.length) % list.length : 0;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const sel = list[this.selectedIndex];
      if (sel) this.selectSession(sel.id);
    }
    // Escape is handled by <modal-wrapper>.
  }

  private selectSession(sessionId: string) {
    logger.log(`Quick switch to session ${sessionId}`);
    this.dispatchEvent(
      new CustomEvent('select-session', {
        detail: { sessionId },
        bubbles: true,
        composed: true,
      })
    );
    this.handleClose();
  }

  private handleClose = () => {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  };

  render() {
    if (!this.visible) return html``;
    const list = this.filteredSessions;

    return html`
      <modal-wrapper
        .visible=${this.visible}
        .ariaLabel=${t('switcher.quickLabel')}
        contentClass="w-full max-w-lg mx-auto bg-bg border border-border rounded-xl shadow-lg overflow-hidden"
        @close=${this.handleClose}
      >
        <div class="flex flex-col max-h-[70vh]">
          <input
            id="quick-switcher-input"
            type="text"
            placeholder=${t('switcher.quickPlaceholder')}
            .value=${this.filterText}
            @input=${this.handleInput}
            @keydown=${this.handleKeydown}
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
            class="w-full px-4 py-3 bg-transparent text-text text-base border-b border-border outline-none"
          />
          <div class="overflow-y-auto">
            ${
              list.length === 0
                ? html`<div class="px-4 py-6 text-text-muted text-sm text-center">${t('switcher.noMatches')}</div>`
                : list.map((s, i) => this.renderItem(s, i))
            }
          </div>
        </div>
      </modal-wrapper>
    `;
  }

  private renderItem(s: Session, i: number) {
    const active = i === this.selectedIndex;
    const cmd = Array.isArray(s.command) ? s.command.join(' ') : '';
    const subtitle = [s.workingDir, cmd].filter(Boolean).join(' — ');
    return html`
      <button
        id="quick-switcher-item-${i}"
        class="w-full text-left px-4 py-3 flex flex-col gap-0.5 min-h-[44px] ${active ? 'bg-surface-hover' : 'hover:bg-surface-hover'}"
        @click=${() => this.selectSession(s.id)}
        @mouseenter=${() => {
          this.selectedIndex = i;
        }}
      >
        <div class="flex items-center gap-2">
          <span
            class="w-2 h-2 rounded-full flex-shrink-0 ${s.status === 'running' ? 'bg-status-success' : 'bg-text-dim'}"
          ></span>
          <span class="text-text text-sm font-medium truncate">${s.name || cmd || s.id}</span>
        </div>
        ${subtitle ? html`<span class="text-text-muted text-xs truncate pl-4">${subtitle}</span>` : ''}
      </button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'session-quick-switcher': SessionQuickSwitcher;
  }
}
