import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { LocaleController, t } from '../i18n/index.js';
import { reducedMotionStyles } from '../utils/reduced-motion.js';

@customElement('file-browser-fab')
export class FileBrowserFAB extends LitElement {
  static styles = [
    reducedMotionStyles,
    css`
    :host {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 100;
    }

    .fab {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: var(--color-primary);
      color: var(--color-text-bright);
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 8px color-mix(in srgb, var(--color-bg-base) 30%, transparent);
      transition: all 0.3s ease;
    }

    .fab:hover {
      background: var(--color-primary-hover);
      box-shadow: 0 6px 12px color-mix(in srgb, var(--color-bg-base) 40%, transparent);
      transform: translateY(-2px);
    }

    .fab:active {
      transform: translateY(0);
      box-shadow: 0 2px 4px color-mix(in srgb, var(--color-bg-base) 30%, transparent);
    }

    .icon {
      font-size: 24px;
    }

    .tooltip {
      position: absolute;
      bottom: 100%;
      right: 0;
      margin-bottom: 8px;
      background: var(--color-surface);
      color: var(--color-text);
      padding: 6px 12px;
      border-radius: 4px;
      font-size: 12px;
      white-space: nowrap;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.3s;
    }

    .fab:hover + .tooltip {
      opacity: 1;
    }

    @media (max-width: 768px) {
      :host {
        bottom: 16px;
        right: 16px;
      }

      .fab {
        width: 48px;
        height: 48px;
      }

      .icon {
        font-size: 20px;
      }
    }
  `,
  ];

  protected readonly i18n = new LocaleController(this);

  @property({ type: Boolean }) visible = true;

  private handleClick() {
    this.dispatchEvent(new CustomEvent('open-file-browser'));
  }

  render() {
    if (!this.visible) {
      return html``;
    }

    const label = `${t('menu.browseFiles')} (⌘O)`;
    return html`
      <button class="fab" @click=${this.handleClick} title=${label}>
        <svg
          class="icon"
          fill="currentColor"
          viewBox="0 0 20 20"
          style="width: 24px; height: 24px;"
        >
          <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
        </svg>
      </button>
      <div class="tooltip">${label}</div>
    `;
  }
}
