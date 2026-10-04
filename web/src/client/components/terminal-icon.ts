import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('terminal-icon')
export class TerminalIcon extends LitElement {
  @property({ type: Number }) size = 24;

  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    svg {
      display: block;
      width: var(--icon-size, 24px);
      height: var(--icon-size, 24px);
    }

    .terminal-icon {
      border-radius: 20%;
      box-shadow:
        0 2px 8px color-mix(in srgb, var(--color-bg-base) 30%, transparent),
        0 1px 3px color-mix(in srgb, var(--color-bg-base) 20%, transparent);
      background: color-mix(in srgb, var(--color-text-bright) 5%, transparent);
      padding: 2px;
    }
  `;

  render() {
    return html`
      <img
        src="/apple-touch-icon.png"
        alt="VibeTunnel"
        style="width: ${this.size}px; height: ${this.size}px"
        class="terminal-icon"
      />
    `;
  }
}
