import { html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LocaleController, t } from '../i18n/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('keyboard-capture-indicator');

/** "Double-tap {key} to toggle" cut around {key}, so the key can be rendered in its own element. */
function toggleHintParts(): [before: string, after: string] {
  const marker = '\u0000';
  const [before, after = ''] = t('keyboardCapture.toggleHint', { key: marker }).split(marker);
  return [before, after];
}

@customElement('keyboard-capture-indicator')
export class KeyboardCaptureIndicator extends LitElement {
  // Disable shadow DOM to use Tailwind classes
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  @property({ type: Boolean }) active = true;
  @property({ type: Boolean }) isMobile = false;
  @state() private animating = false;
  @state() private lastCapturedShortcut = '';
  @state() private showDynamicTooltip = false;
  @state() private isHovered = false;

  private animationTimeout?: number;
  private tooltipTimeout?: number;
  private isMacOS = navigator.platform.toLowerCase().includes('mac');

  connectedCallback() {
    super.connectedCallback();
    // Listen for captured shortcuts
    window.addEventListener('shortcut-captured', this.handleShortcutCaptured as EventListener);
  }

  willUpdate(changedProperties: Map<string, unknown>) {
    if (changedProperties.has('active')) {
      logger.log(`Keyboard capture indicator updated: ${this.active ? 'ON' : 'OFF'}`);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('shortcut-captured', this.handleShortcutCaptured as EventListener);
    if (this.animationTimeout) clearTimeout(this.animationTimeout);
    if (this.tooltipTimeout) clearTimeout(this.tooltipTimeout);
  }

  private handleShortcutCaptured = (event: CustomEvent) => {
    const { shortcut, browserAction, terminalAction } = event.detail;
    this.lastCapturedShortcut = this.formatShortcutInfo(shortcut, browserAction, terminalAction);
    this.animating = true;
    this.showDynamicTooltip = true;

    // Clear existing timeouts
    if (this.animationTimeout) clearTimeout(this.animationTimeout);
    if (this.tooltipTimeout) clearTimeout(this.tooltipTimeout);

    // Remove animation class after animation completes
    this.animationTimeout = window.setTimeout(() => {
      this.animating = false;
    }, 400);

    // Hide dynamic tooltip after 3 seconds
    this.tooltipTimeout = window.setTimeout(() => {
      this.showDynamicTooltip = false;
    }, 3000);
  };

  private formatShortcutInfo(
    shortcut: string,
    browserAction: string,
    terminalAction: string
  ): string {
    return `"${shortcut}" → Terminal: ${terminalAction} (not Browser: ${browserAction})`;
  }

  private handleClick() {
    // Don't toggle local state - let parent control it
    const newActive = !this.active;
    this.dispatchEvent(
      new CustomEvent('capture-toggled', {
        detail: { active: newActive },
        bubbles: true,
        composed: true,
      })
    );
    logger.log(`Keyboard capture toggle requested: ${newActive ? 'enable' : 'disable'}`);
  }

  private getOSSpecificShortcuts() {
    if (this.isMacOS) {
      return [
        { key: 'Cmd+1...9', desc: t('keyboardCapture.switchSessions') },
        { key: 'Cmd+0', desc: t('keyboardCapture.switchSession10') },
        { key: 'Cmd+A', desc: t('keyboardCapture.lineStart') },
        { key: 'Cmd+E', desc: t('keyboardCapture.lineEnd') },
        { key: 'Cmd+R', desc: t('keyboardCapture.historySearch') },
        { key: 'Cmd+L', desc: t('keyboardCapture.clearScreen') },
        { key: 'Cmd+D', desc: t('keyboardCapture.eof') },
        { key: 'Cmd+F', desc: t('keyboardCapture.forwardChar') },
        { key: 'Cmd+P', desc: t('keyboardCapture.previousCommand') },
        { key: 'Cmd+U', desc: t('keyboardCapture.deleteToStart') },
        { key: 'Cmd+K', desc: t('keyboardCapture.deleteToEnd') },
        { key: 'Option+D', desc: t('keyboardCapture.deleteWordForward') },
      ];
    } else {
      return [
        { key: 'Ctrl+1...9', desc: t('keyboardCapture.switchSessions') },
        { key: 'Ctrl+0', desc: t('keyboardCapture.switchSession10') },
        { key: 'Ctrl+A', desc: t('keyboardCapture.lineStart') },
        { key: 'Ctrl+E', desc: t('keyboardCapture.lineEnd') },
        { key: 'Ctrl+R', desc: t('keyboardCapture.historySearch') },
        { key: 'Ctrl+L', desc: t('keyboardCapture.clearScreen') },
        { key: 'Ctrl+D', desc: t('keyboardCapture.eof') },
        { key: 'Ctrl+F', desc: t('keyboardCapture.forwardChar') },
        { key: 'Ctrl+P', desc: t('keyboardCapture.previousCommand') },
        { key: 'Ctrl+U', desc: t('keyboardCapture.deleteToStart') },
        { key: 'Ctrl+K', desc: t('keyboardCapture.deleteToEnd') },
        { key: 'Alt+D', desc: t('keyboardCapture.deleteWordForward') },
      ];
    }
  }

  private renderKeyboardIcon() {
    return html`
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="2" y="6" width="20" height="12" rx="2"/>
        <circle cx="7" cy="10" r="1"/>
        <circle cx="12" cy="10" r="1"/>
        <circle cx="17" cy="10" r="1"/>
        <circle cx="7" cy="14" r="1"/>
        <rect x="9" y="13" width="6" height="2" rx="1"/>
        <circle cx="17" cy="14" r="1"/>
      </svg>
    `;
  }

  render() {
    if (this.isMobile) return html``;

    // Use the same button styling as other header buttons
    const buttonClasses = `
      bg-bg-tertiary border border-border rounded-lg p-2 font-mono 
      transition-all duration-200 hover:text-primary hover:bg-surface-hover hover:border-primary 
      hover:shadow-sm flex-shrink-0
      ${this.active ? 'text-primary' : 'text-muted'}
      ${this.animating ? 'animating' : ''}
    `.trim();

    const toggleHint = toggleHintParts();
    const _tooltipContent =
      this.showDynamicTooltip && this.lastCapturedShortcut
        ? html`<div class="tooltip dynamic">${this.lastCapturedShortcut}</div>`
        : html`
          <div class="tooltip">
            <div>
              <strong>${this.active ? t('keyboardCapture.on') : t('keyboardCapture.off')}</strong>
            </div>
            <div style="margin-top: 0.5em;">
              ${this.active ? t('keyboardCapture.activeHint') : t('keyboardCapture.inactiveHint')}
            </div>
            <div style="margin-top: 0.5em;">
              ${toggleHint[0]}<span class="shortcut-key">Escape</span>${toggleHint[1]}
            </div>
            ${
              this.active
                ? html`
              <div class="shortcut-list">
                <div style="margin-bottom: 0.5em; font-weight: bold;">${t('keyboardCapture.captured')}</div>
                ${this.getOSSpecificShortcuts().map(
                  ({ key, desc }) => html`
                  <div class="shortcut-item">
                    <span class="shortcut-key">${key}</span>
                    <span class="shortcut-desc">${desc}</span>
                  </div>
                `
                )}
              </div>
            `
                : ''
            }
          </div>
        `;

    return html`
      <div 
        class="relative flex-shrink-0"
        @mouseenter=${() => {
          this.isHovered = true;
        }}
        @mouseleave=${() => {
          this.isHovered = false;
        }}
      >
        <button 
          class="${buttonClasses}"
          @click=${this.handleClick}
        >
          ${this.renderKeyboardIcon()}
        </button>
        ${
          this.isHovered
            ? html`
          <div 
            style="
              position: absolute;
              top: 100%;
              left: 50%;
              transform: translateX(-50%);
              margin-top: 0.5em;
              padding: 0.75em 1em;
              background: #1a1a1a;
              color: #e0e0e0;
              border: 1px solid #333;
              border-radius: 0.25em;
              font-size: 0.875em;
              white-space: normal;
              z-index: 1000;
              max-width: 300px;
              width: 300px;
              box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
            "
          >
            <div>
              <strong>${this.active ? t('keyboardCapture.on') : t('keyboardCapture.off')}</strong>
            </div>
            <div style="margin-top: 0.5em;">
              ${this.active ? t('keyboardCapture.activeHint') : t('keyboardCapture.inactiveHint')}
            </div>
            <div style="margin-top: 0.5em;">
              ${toggleHint[0]}<strong>Escape</strong>${toggleHint[1]}
            </div>
            ${
              this.active
                ? html`
              <div style="margin-top: 0.5em; padding-top: 0.5em; border-top: 1px solid #333;">
                <div style="margin-bottom: 0.5em; font-weight: bold;">${t('keyboardCapture.captured')}</div>
                ${this.getOSSpecificShortcuts().map(
                  ({ key, desc }) => html`
                  <div style="display: flex; justify-content: space-between; gap: 1em; margin: 0.25em 0; font-family: monospace;">
                    <span style="font-weight: bold;">${key}</span>
                    <span style="color: #999;">${desc}</span>
                  </div>
                `
                )}
              </div>
            `
                : ''
            }
          </div>
        `
            : ''
        }
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'keyboard-capture-indicator': KeyboardCaptureIndicator;
  }
}
