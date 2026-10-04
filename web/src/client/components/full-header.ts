/**
 * Full Header Component
 *
 * Full-width header for list view with horizontal layout
 */
import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { t } from '../i18n/index.js';
import { PHONE_UI_CHANGED_EVENT, usesCompactPhoneUi } from '../utils/phone-ui.js';
import { HeaderBase } from './header-base.js';
import './terminal-icon.js';
import './notification-status.js';
import './theme-toggle-icon.js';

const MENU_ICONS = {
  settings: html`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" /></svg>`,
  files: html`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></svg>`,
  tmux: html`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16M3 12h9" /></svg>`,
  logout: html`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 17l5-5-5-5M15 12H3" /></svg>`,
};

@customElement('full-header')
export class FullHeader extends HeaderBase {
  @state() private showMoreMenu = false;
  @state() private moreMenuStyle = '';

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener(PHONE_UI_CHANGED_EVENT, this.handlePhoneUiChanged);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener(PHONE_UI_CHANGED_EVENT, this.handlePhoneUiChanged);
    document.removeEventListener('click', this.closeMoreMenu, true);
  }

  private handlePhoneUiChanged = () => this.requestUpdate();

  /** The compact phone layout: three buttons (appearance, create, more) instead of six. */
  private isPhone(): boolean {
    return usesCompactPhoneUi();
  }

  private closeMoreMenu = (e: Event) => {
    if (!e.composedPath().some((el) => (el as HTMLElement).dataset?.moreMenu !== undefined)) {
      this.setMoreMenu(false);
    }
  };

  private setMoreMenu(open: boolean, anchor?: HTMLElement) {
    if (open && anchor) {
      // Fixed position: the header row clips its overflow.
      const rect = anchor.getBoundingClientRect();
      this.moreMenuStyle = `top: ${rect.bottom + 6}px; right: ${window.innerWidth - rect.right}px;`;
    }
    this.showMoreMenu = open;
    document.removeEventListener('click', this.closeMoreMenu, true);
    if (open) document.addEventListener('click', this.closeMoreMenu, true);
  }

  private menuItem(label: string, icon: ReturnType<typeof html>, action: () => void) {
    return html`
      <button
        class="phone-menu-item"
        role="menuitem"
        @click=${() => {
          this.setMoreMenu(false);
          action();
        }}
      >
        <span class="phone-menu-icon" aria-hidden="true">${icon}</span>${label}
      </button>
    `;
  }

  private renderPhoneActions() {
    return html`
      <div class="flex items-center gap-2 flex-shrink-0">
        <theme-toggle-icon
          .theme=${this.currentTheme}
          @theme-changed=${(e: CustomEvent) => {
            this.currentTheme = e.detail.theme;
          }}
        ></theme-toggle-icon>
        <button
          class="p-2 bg-primary text-text-bright hover:bg-primary-light rounded-lg transition-all duration-200 vt-create-button"
          @click=${this.handleCreateSession}
          title=${t('header.createSession')}
          aria-label=${t('header.createSession')}
          data-testid="create-session-button"
        >
          <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z"/>
          </svg>
        </button>
        <button
          class="p-2 bg-bg-tertiary text-muted border border-border rounded-lg"
          data-more-menu
          data-testid="header-more-button"
          aria-label=${t('header.more')}
          aria-haspopup="menu"
          aria-expanded=${this.showMoreMenu ? 'true' : 'false'}
          @click=${(e: Event) => this.setMoreMenu(!this.showMoreMenu, e.currentTarget as HTMLElement)}
        >
          <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M4 10a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zm7.5 0a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zM19 10a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z"/>
          </svg>
        </button>
        ${
          this.showMoreMenu
            ? html`
              <div class="phone-menu" role="menu" data-more-menu style=${this.moreMenuStyle}>
                ${this.menuItem(t('common.settings'), MENU_ICONS.settings, () =>
                  this.dispatchEvent(new CustomEvent('open-settings'))
                )}
                ${this.menuItem(t('menu.browseFiles'), MENU_ICONS.files, () =>
                  this.dispatchEvent(new CustomEvent('open-file-browser'))
                )}
                ${this.menuItem(t('header.tmuxSessionsButton'), MENU_ICONS.tmux, () =>
                  this.handleOpenTmuxSessions()
                )}
                ${
                  this.currentUser
                    ? html`
                      <div class="phone-menu-sep"></div>
                      <div class="phone-menu-user">${this.currentUser} · ${this.authMethodLabel}</div>
                      ${this.menuItem(t('header.logoutButton'), MENU_ICONS.logout, () => this.handleLogout())}
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

  private get authMethodLabel(): string {
    switch (this.authMethod) {
      case 'password':
        return t('header.auth.password');
      case 'ssh-key':
        return t('header.auth.sshKey');
      case 'tailscale':
        return 'Tailscale';
      default:
        return t('header.auth.authenticated');
    }
  }

  render() {
    const runningSessions = this.runningSessions;

    return html`
      <div
        class="app-header bg-bg-secondary border-b border-border p-3"
        style="padding-top: max(0.75rem, calc(0.75rem + env(safe-area-inset-top))); padding-right: max(0.75rem, calc(0.75rem + env(safe-area-inset-right))); padding-left: max(0.75rem, calc(0.75rem + env(safe-area-inset-left)));"
      >
        <div class="flex items-center justify-between gap-2 overflow-hidden">
          <button
            class="flex items-center gap-2 hover:opacity-80 transition-opacity cursor-pointer group min-w-0 flex-shrink"
            title=${t('header.goHome')}
            @click=${this.handleHomeClick}
          >
            <terminal-icon size="24" class="flex-shrink-0"></terminal-icon>
            <div class="flex items-baseline gap-2 min-w-0">
              <h1 class="text-sm sm:text-xl font-bold text-primary font-mono group-hover:underline truncate">
                <span class="${this.isPhone() ? '' : 'hidden sm:inline'}">VibeTunnel</span>
                <span class="${this.isPhone() ? 'hidden' : 'sm:hidden'}">VT</span>
              </h1>
              <p class="text-text-muted text-xs font-mono flex-shrink-0">
                (${runningSessions.length})
              </p>
            </div>
          </button>

          ${this.isPhone() ? this.renderPhoneActions() : this.renderActions()}
        </div>
      </div>
    `;
  }

  private renderActions() {
    return html`
          <div class="flex items-center gap-2 flex-shrink-0">
            <notification-status
              @open-settings=${() => this.dispatchEvent(new CustomEvent('open-settings'))}
            ></notification-status>
            <theme-toggle-icon
              .theme=${this.currentTheme}
              @theme-changed=${(e: CustomEvent) => {
                this.currentTheme = e.detail.theme;
              }}
            ></theme-toggle-icon>
            <button
              class="p-2 bg-bg-tertiary text-muted border border-border hover:border-primary hover:text-primary hover:bg-surface-hover rounded-lg transition-all duration-200"
              @click=${() => this.dispatchEvent(new CustomEvent('open-file-browser'))}
              title="${t('menu.browseFiles')} (⌘O)"
              data-testid="file-browser-button"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path
                  d="M1.75 1h5.5c.966 0 1.75.784 1.75 1.75v1h4c.966 0 1.75.784 1.75 1.75v7.75A1.75 1.75 0 0113 15H3a1.75 1.75 0 01-1.75-1.75V2.75C1.25 1.784 1.784 1 1.75 1zM2.75 2.5v10.75c0 .138.112.25.25.25h10a.25.25 0 00.25-.25V5.5a.25.25 0 00-.25-.25H8.75v-2.5a.25.25 0 00-.25-.25h-5.5a.25.25 0 00-.25.25z"
                />
              </svg>
            </button>
            <button
              class="p-2 bg-bg-tertiary text-muted border border-border hover:border-primary hover:text-primary hover:bg-surface-hover rounded-lg transition-all duration-200"
              @click=${this.handleOpenTmuxSessions}
              title=${t('header.tmuxSessionsButton')}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M2 2v12h12V2H2zM1 2a1 1 0 011-1h12a1 1 0 011 1v12a1 1 0 01-1 1H2a1 1 0 01-1-1V2zm7 3h5v2H8V5zm0 3h5v2H8V8zm0 3h5v2H8v-2zM3 5h4v2H3V5zm0 3h4v2H3V8zm0 3h4v2H3v-2z"/>
              </svg>
            </button>
            <button
              class="p-2 bg-primary text-text-bright hover:bg-primary-light rounded-lg transition-all duration-200 vt-create-button"
              @click=${this.handleCreateSession}
              title=${t('header.createSession')}
              data-testid="create-session-button"
            >
              <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
                <path d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z"/>
              </svg>
            </button>
            ${this.renderUserMenu()}
          </div>
    `;
  }

  private renderUserMenu() {
    // When no user, don't show anything (settings accessible via notification bell)
    if (!this.currentUser) {
      return html``;
    }

    return html`
      <div class="user-menu-container relative flex-shrink-0">
        <button
          class="font-mono text-sm px-3 py-2 text-text border border-border hover:bg-bg-tertiary hover:text-text rounded-lg transition-all duration-200 flex items-center gap-2"
          @click=${this.toggleUserMenu}
          title=${t('header.userMenu')}
        >
          <span class="hidden sm:inline">${this.currentUser}</span>
          <svg
            width="16"
            height="16"
            viewBox="0 0 20 20"
            fill="currentColor"
            class="sm:hidden"
          >
            <path d="M10 9a3 3 0 100-6 3 3 0 000 6zM3 18a7 7 0 1114 0H3z" />
          </svg>
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="currentColor"
            class="transition-transform ${this.showUserMenu ? 'rotate-180' : ''}"
          >
            <path d="M5 7L1 3h8z" />
          </svg>
        </button>
        ${
          this.showUserMenu
            ? html`
              <div
                class="absolute right-0 top-full mt-1 bg-surface border border-border rounded-lg shadow-lg py-1 z-50 min-w-36"
              >
                <div
                  class="px-3 py-2 text-sm text-text-muted border-b border-border"
                  data-testid="auth-method-label"
                >
                  ${this.authMethodLabel}
                </div>
                <button
                  class="w-full text-left px-3 py-2 text-sm font-mono text-status-warning hover:bg-bg-secondary hover:text-status-error"
                  @click=${this.handleLogout}
                >
                  ${t('header.logoutButton')}
                </button>
              </div>
            `
            : ''
        }
      </div>
    `;
  }
}
