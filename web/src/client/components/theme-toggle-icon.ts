import { html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LocaleController, t } from '../i18n/index.js';
import {
  ACCENT_THEMES,
  accentName,
  applyAccent,
  getAccent,
  syncThemeColorMeta,
} from '../utils/accent-themes.js';

export type Theme = 'light' | 'dark' | 'system';

/**
 * Appearance button: opens a small panel with light/dark/auto and the color themes.
 */
@customElement('theme-toggle-icon')
export class ThemeToggleIcon extends LitElement {
  @property({ type: String })
  theme: Theme = 'system';

  @state() private open = false;
  protected readonly i18n = new LocaleController(this);
  @state() private accent = getAccent();

  private readonly STORAGE_KEY = 'vibetunnel-theme';
  private mediaQuery?: MediaQueryList;

  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();

    // Load saved theme preference
    const saved = localStorage.getItem(this.STORAGE_KEY) as Theme | null;
    this.theme = saved || 'system';

    // Set up system preference listener
    this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    this.mediaQuery.addEventListener('change', this.handleSystemThemeChange);

    // Apply initial theme
    this.applyTheme();
    window.addEventListener('theme-changed', this.handleThemeChanged);
    document.documentElement.setAttribute('data-accent', this.accent);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.mediaQuery?.removeEventListener('change', this.handleSystemThemeChange);
    window.removeEventListener('theme-changed', this.handleThemeChanged);
    document.removeEventListener('click', this.handleOutsideClick, true);
  }

  /** Theme picked elsewhere (settings, session menu): keep the icon and panel in sync. */
  private handleThemeChanged = (e: Event) => {
    const theme = (e as CustomEvent<{ theme?: Theme }>).detail?.theme;
    if (theme && theme !== this.theme) this.theme = theme;
  };

  private handleOutsideClick = (e: Event) => {
    if (!e.composedPath().includes(this)) this.setOpen(false);
  };

  @state() private panelPosition = '';

  private setOpen(open: boolean) {
    if (open) {
      // Fixed position from the button: headers clip overflow, and the button can sit
      // anywhere from the left edge (phone) to the right (desktop).
      const rect = this.querySelector('button')?.getBoundingClientRect();
      if (rect) {
        const width = 232;
        const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
        this.panelPosition = `top: ${rect.bottom + 8}px; left: ${left}px;`;
      }
    }
    this.open = open;
    document.removeEventListener('click', this.handleOutsideClick, true);
    if (open) document.addEventListener('click', this.handleOutsideClick, true);
  }

  private selectTheme(theme: Theme) {
    this.theme = theme;
    localStorage.setItem(this.STORAGE_KEY, this.theme);
    this.applyTheme();
    this.dispatchEvent(
      new CustomEvent('theme-changed', { detail: { theme }, bubbles: true, composed: true })
    );
  }

  private selectAccent(id: string) {
    this.accent = id;
    applyAccent(id);
  }

  private handleSystemThemeChange = () => {
    if (this.theme === 'system') {
      this.applyTheme();
    }
  };

  private applyTheme() {
    const root = document.documentElement;
    let effectiveTheme: 'light' | 'dark';

    if (this.theme === 'system') {
      effectiveTheme = this.mediaQuery?.matches ? 'dark' : 'light';
    } else {
      effectiveTheme = this.theme;
    }

    // Set data-theme attribute
    root.setAttribute('data-theme', effectiveTheme);

    // Update meta theme-color for mobile browsers
    syncThemeColorMeta();
  }

  private getIcon() {
    switch (this.theme) {
      case 'light':
        return html`
          <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clip-rule="evenodd"/>
          </svg>
        `;
      case 'dark':
        return html`
          <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
            <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z"/>
          </svg>
        `;
      case 'system':
        return html`
          <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
            <path d="M10 2C5.858 2 2.5 5.358 2.5 9.5S5.858 17 10 17s7.5-3.358 7.5-7.5S14.142 2 10 2zM10 15.5V4.5c3.314 0 6 2.686 6 6s-2.686 6-6 6z"/>
          </svg>
        `;
    }
  }

  render() {
    const modes: Array<[Theme, string]> = [
      ['light', t('appearance.light')],
      ['dark', t('appearance.dark')],
      ['system', t('appearance.auto')],
    ];
    return html`
      <div class="relative">
        <button
          @click=${() => this.setOpen(!this.open)}
          class="bg-bg-tertiary border border-border rounded-lg p-2 font-mono text-muted transition-all duration-200 hover:text-primary hover:bg-surface-hover hover:border-primary hover:shadow-sm flex-shrink-0"
          title=${t('appearance.title')}
          aria-label=${t('appearance.title')}
          aria-haspopup="dialog"
          aria-expanded=${this.open ? 'true' : 'false'}
        >
          ${this.getIcon()}
        </button>
        ${
          this.open
            ? html`
              <div
                class="appearance-panel"
                role="dialog"
                aria-label=${t('appearance.title')}
                style=${this.panelPosition}
              >
                <div class="appearance-modes">
                  ${modes.map(
                    ([mode, label]) => html`
                      <button
                        class="appearance-mode ${this.theme === mode ? 'active' : ''}"
                        aria-pressed=${this.theme === mode ? 'true' : 'false'}
                        @click=${() => this.selectTheme(mode)}
                      >
                        ${label}
                      </button>
                    `
                  )}
                </div>
                <div class="appearance-label">${t('appearance.color')}</div>
                <div class="appearance-swatches">
                  ${ACCENT_THEMES.map(
                    (accent) => html`
                      <button
                        class="appearance-swatch ${this.accent === accent.id ? 'active' : ''}"
                        style="--swatch: ${accent.color}"
                        title=${accentName(accent)}
                        aria-label=${accentName(accent)}
                        aria-pressed=${this.accent === accent.id ? 'true' : 'false'}
                        @click=${() => this.selectAccent(accent.id)}
                      ></button>
                    `
                  )}
                </div>
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
    'theme-toggle-icon': ThemeToggleIcon;
  }
}
