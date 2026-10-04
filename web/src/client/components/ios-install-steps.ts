/**
 * "Add VibeTunnel to the Home Screen" steps for Settings, worded for the iOS browser in use,
 * plus the app address with a Copy button, so someone in a browser without "Add to Home
 * Screen" can paste it into Safari.
 */
import { html, LitElement, type SVGTemplateResult, svg } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LocaleController, t } from '../i18n/index.js';
import type { IOSBrowser } from '../utils/ios-install.js';
import { copyToClipboard } from '../utils/path-utils.js';

export const INSTALL_STEP_ICONS = {
  // Share glyph: square with an arrow pointing up.
  share: svg`<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v12m0-12L8 7m4-4l4 4M8 11H6a1 1 0 00-1 1v8a1 1 0 001 1h12a1 1 0 001-1v-8a1 1 0 00-1-1h-2" />`,
  // "Add to Home Screen" glyph: plus in a rounded square.
  add: svg`<rect x="4" y="4" width="16" height="16" rx="3" stroke-width="2" /><path stroke-linecap="round" stroke-width="2" d="M12 8v8m-4-4h8" />`,
  bell: svg`<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 00-4-5.7V5a2 2 0 10-4 0v.3A6 6 0 006 11v3.2a2 2 0 01-.6 1.4L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />`,
};

export interface InstallStep {
  icon: SVGTemplateResult;
  text: string;
}

/** The steps for this browser, ending with "turn notifications on here". */
export function iosInstallSteps(browser: IOSBrowser): InstallStep[] {
  const share =
    browser === 'chrome'
      ? t('settings.ios.step.shareChrome')
      : browser === 'other'
        ? t('settings.ios.step.shareOther')
        : t('settings.ios.step.shareSafari');
  const add = browser === 'safari' ? t('settings.ios.step.add') : t('settings.ios.step.addChrome');
  return [
    { icon: INSTALL_STEP_ICONS.share, text: share },
    { icon: INSTALL_STEP_ICONS.add, text: add },
    { icon: INSTALL_STEP_ICONS.bell, text: t('settings.ios.step.open') },
  ];
}

/**
 * The app address (where this page is served from) and a Copy button. Outside Safari it is
 * introduced as the way out when the browser has no "Add to Home Screen".
 */
@customElement('app-address-copy')
export class AppAddressCopy extends LitElement {
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  /** Browser in use; anything but Safari gets the "open it in Safari" hint. */
  @property({ attribute: false }) browser: IOSBrowser = 'safari';
  @state() private copied: 'ok' | 'failed' | null = null;

  private async copy() {
    this.copied = (await copyToClipboard(window.location.origin)) ? 'ok' : 'failed';
  }

  render() {
    return html`
      <div data-testid="app-address">
        <p class="text-xs text-muted mb-2">
          ${this.browser === 'safari' ? t('settings.ios.address.label') : t('settings.ios.safariHint')}
        </p>
        <div class="flex items-center gap-2">
          <code
            class="flex-1 min-w-0 truncate text-xs bg-bg-secondary border border-border/50 rounded px-2 py-2 select-all"
            data-testid="app-address-value"
            >${window.location.origin}</code
          >
          <button
            class="btn-secondary text-xs px-3 min-h-[44px] flex-shrink-0"
            data-testid="app-address-copy"
            @click=${() => this.copy()}
          >
            ${this.copied === 'ok' ? t('settings.ios.address.copied') : t('settings.ios.address.copy')}
          </button>
        </div>
        ${
          this.copied === 'failed'
            ? html`<p class="text-xs text-status-error mt-2" role="status">
                ${t('settings.ios.address.copyFailed')}
              </p>`
            : ''
        }
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'app-address-copy': AppAddressCopy;
  }
}
