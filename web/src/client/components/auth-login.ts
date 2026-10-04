import { html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LocaleController, t } from '../i18n/index.js';
import type { AuthClient } from '../services/auth-client.js';
import { responsiveObserver } from '../utils/responsive-utils.js';
import './language-picker.js';
import './terminal-icon.js';

@customElement('auth-login')
export class AuthLogin extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  @property({ type: Object }) authClient!: AuthClient;
  @state() private loading = false;
  @state() private error = '';
  @state() private success = '';
  @state() private currentUserId = '';
  @state() private loginPassword = '';
  @state() private userAvatar = '';
  @state() private authConfig = {
    enableSSHKeys: false,
    disallowUserPassword: false,
    noAuth: false,
    passwordAuthMode: 'system' as 'system' | 'configured',
  };
  @state() private isMobile = false;
  private unsubscribeResponsive?: () => void;
  protected readonly i18n = new LocaleController(this);

  async connectedCallback() {
    super.connectedCallback();
    console.log('🔌 Auth login component connected');

    // Subscribe to responsive changes
    this.unsubscribeResponsive = responsiveObserver.subscribe((state) => {
      this.isMobile = state.isMobile;
    });

    await this.loadUserInfo();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.unsubscribeResponsive) {
      this.unsubscribeResponsive();
    }
  }

  private async loadUserInfo() {
    try {
      // Load auth configuration first
      try {
        const configResponse = await fetch('/api/auth/config');
        if (configResponse.ok) {
          this.authConfig = await configResponse.json();
          console.log('⚙️ Auth config loaded:', this.authConfig);
        } else {
          console.warn('⚠️ Failed to load auth config, using defaults:', configResponse.status);
        }
      } catch (error) {
        console.error('❌ Error loading auth config:', error);
      }

      this.currentUserId = await this.authClient.getCurrentSystemUser();
      console.log('👤 Current user:', this.currentUserId);

      // Load user avatar only if auth is enabled
      if (!this.authConfig.noAuth) {
        this.userAvatar = await this.authClient.getUserAvatar(this.currentUserId);
        console.log('🖼️ User avatar loaded');
      }

      // If no auth required, auto-login
      if (this.authConfig.noAuth) {
        console.log('🔓 No auth required, auto-logging in');
        this.dispatchEvent(
          new CustomEvent('auth-success', {
            detail: {
              success: true,
              userId: this.currentUserId,
              authMethod: 'no-auth',
            },
          })
        );
      }
    } catch (_error) {
      this.error = t('login.error.loadUser');
    }
  }

  private async handlePasswordLogin(e: Event) {
    e.preventDefault();
    if (this.loading) return;

    console.log('🔐 Attempting password authentication...');
    this.loading = true;
    this.error = '';

    try {
      const result = await this.authClient.authenticateWithPassword(
        this.currentUserId,
        this.loginPassword
      );
      console.log('🎫 Password auth result:', result);

      if (result.success) {
        this.loginPassword = '';
        this.dispatchEvent(new CustomEvent('auth-success', { detail: result }));
      } else {
        this.error = result.error || t('login.error.password');
      }
    } catch (_error) {
      this.error = t('login.error.password');
    } finally {
      this.loading = false;
    }
  }

  private async handleSSHKeyAuth() {
    if (this.loading) return;

    console.log('🔐 Attempting SSH key authentication...');
    this.loading = true;
    this.error = '';

    try {
      const authResult = await this.authClient.authenticate(this.currentUserId);
      console.log('🎯 SSH auth result:', authResult);

      if (authResult.success) {
        this.dispatchEvent(new CustomEvent('auth-success', { detail: authResult }));
      } else {
        this.error = authResult.error || t('login.error.sshTryPassword');
      }
    } catch (error) {
      console.error('SSH key authentication error:', error);
      this.error = t('login.error.ssh');
    } finally {
      this.loading = false;
    }
  }

  private handleShowSSHKeyManager() {
    this.dispatchEvent(new CustomEvent('show-ssh-key-manager'));
  }

  private handleOpenSettings = () => {
    // Don't bubble - let parent handle via direct event listener
    this.dispatchEvent(new CustomEvent('open-settings'));
  };

  private get usesConfiguredPassword(): boolean {
    return this.authConfig.passwordAuthMode === 'configured';
  }

  render() {
    console.log(
      '🔍 Rendering auth login',
      'enableSSHKeys:',
      this.authConfig.enableSSHKeys,
      'noAuth:',
      this.authConfig.noAuth
    );

    return html`
      <div class="auth-container">
        <!-- Language picker in top left corner -->
        <div class="absolute top-4 left-4">
          <language-picker compact></language-picker>
        </div>

        <!-- Settings button in top right corner -->
        <button
          class="absolute top-4 right-4 p-2 text-text-muted hover:text-primary transition-colors"
          @click=${this.handleOpenSettings}
          title=${t('common.settings')}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/>
          </svg>
        </button>
        
        <div class="w-full max-w-sm">
          <div class="auth-header">
            <div class="flex flex-col items-center gap-2 sm:gap-3 mb-4 sm:mb-8">
              <terminal-icon
                size="${this.isMobile ? '48' : '56'}"
                style="filter: drop-shadow(0 0 15px color-mix(in srgb, var(--color-primary) 40%, transparent));"
              ></terminal-icon>
              <h2 class="auth-title text-2xl sm:text-3xl mt-1 sm:mt-2">VibeTunnel</h2>
              <p class="auth-subtitle text-xs sm:text-sm">${t('login.subtitle')}</p>
            </div>
          </div>

          ${
            this.error
              ? html`
                <div
                  class="bg-status-error text-white px-3 py-1.5 rounded mb-3 font-mono text-xs sm:text-sm"
                  data-testid="error-message"
                >
                  ${this.error}
                  <button
                    @click=${() => {
                      this.error = '';
                    }}
                    class="ml-2 text-bg hover:text-primary"
                    aria-label=${t('common.close')}
                    data-testid="error-close"
                  >
                    ✕
                  </button>
                </div>
              `
              : ''
          }
          ${
            this.success
              ? html`
                <div
                  class="bg-status-success text-on-fill px-3 py-1.5 rounded mb-3 font-mono text-xs sm:text-sm"
                >
                  ${this.success}
                  <button
                    @click=${() => {
                      this.success = '';
                    }}
                    class="ml-2 text-bg hover:text-primary"
                    aria-label=${t('common.close')}
                  >
                    ✕
                  </button>
                </div>
              `
              : ''
          }

          <div class="auth-form">
            ${
              !this.authConfig.disallowUserPassword
                ? html`
                  <!-- Password Login Section (Primary) -->
                  <div class="p-5 sm:p-8">
                    <div class="flex flex-col items-center mb-4 sm:mb-6">
                      <div
                        class="w-24 h-24 sm:w-28 sm:h-28 rounded-full mb-3 sm:mb-4 overflow-hidden"
                        style="box-shadow: 0 0 25px color-mix(in srgb, var(--color-primary) 30%, transparent);"
                      >
                        ${
                          this.userAvatar
                            ? html`
                              <img
                                src="${this.userAvatar}"
                                alt=${t('login.avatarAlt')}
                                class="w-full h-full object-cover"
                                width="80"
                                height="80"
                              />
                            `
                            : html`
                              <div
                                class="w-full h-full bg-bg-secondary flex items-center justify-center"
                              >
                                <svg
                                  class="w-12 h-12 sm:w-14 sm:h-14 text-text-muted"
                                  fill="currentColor"
                                  viewBox="0 0 20 20"
                                >
                                  <path d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" />
                                </svg>
                              </div>
                            `
                        }
                      </div>
                      <p class="text-primary text-base sm:text-lg font-medium">
                        ${t('login.welcomeBack', { user: this.currentUserId || '...' })}
                      </p>
                    </div>
                    <form @submit=${this.handlePasswordLogin} class="space-y-3">
                      <div>
                        <label
                          for="system-password"
                          class="block text-xs font-medium text-text mb-1.5"
                        >
                          ${
                            this.usesConfiguredPassword
                              ? t('login.configuredPassword')
                              : t('login.computerPassword')
                          }
                        </label>
                        <input
                          id="system-password"
                          type="password"
                          class="input-field"
                          data-testid="password-input"
                          placeholder=${
                            this.usesConfiguredPassword
                              ? t('login.placeholder.configured')
                              : t('login.placeholder.computer')
                          }
                          autocomplete="current-password"
                          aria-describedby="password-help"
                          .value=${this.loginPassword}
                          @input=${(e: Event) => {
                            this.loginPassword = (e.target as HTMLInputElement).value;
                          }}
                          ?disabled=${this.loading}
                          required
                        />
                        <p
                          id="password-help"
                          class="mt-2 text-xs leading-relaxed text-text-muted"
                        >
                          ${
                            this.usesConfiguredPassword
                              ? t('login.passwordHelp.sentConfigured')
                              : t('login.passwordHelp.sentComputer')
                          }
                        </p>
                      </div>
                      <button
                        type="submit"
                        class="btn-primary w-full py-3 sm:py-4 mt-2"
                        data-testid="password-submit"
                        ?disabled=${this.loading || !this.loginPassword}
                      >
                        ${
                          this.loading
                            ? t('login.authenticating')
                            : this.usesConfiguredPassword
                              ? t('login.logInConfigured')
                              : t('login.logInComputer')
                        }
                      </button>
                    </form>
                  </div>
                `
                : ''
            }
            ${
              this.authConfig.disallowUserPassword
                ? html`
                  <!-- Avatar for SSH-only mode -->
                  <div class="ssh-key-item p-6 sm:p-8">
                    <div class="flex flex-col items-center mb-4 sm:mb-6">
                      <div
                        class="w-16 h-16 sm:w-20 sm:h-20 rounded-full mb-2 sm:mb-3 overflow-hidden border-2 border-border"
                      >
                        ${
                          this.userAvatar
                            ? html`
                              <img
                                src="${this.userAvatar}"
                                alt=${t('login.avatarAlt')}
                                class="w-full h-full object-cover"
                                width="80"
                                height="80"
                              />
                            `
                            : html`
                              <div
                                class="w-full h-full bg-bg-secondary flex items-center justify-center"
                              >
                                <svg
                                  class="w-8 h-8 sm:w-10 sm:h-10 text-text-muted"
                                  fill="currentColor"
                                  viewBox="0 0 20 20"
                                >
                                  <path d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" />
                                </svg>
                              </div>
                            `
                        }
                      </div>
                      <p class="text-primary text-xs sm:text-sm">
                        ${
                          this.currentUserId
                            ? t('login.welcomeBack', { user: this.currentUserId })
                            : t('login.subtitle')
                        }
                      </p>
                      <p class="text-text-muted text-xs mt-1 sm:mt-2">
                        ${t('login.sshRequired')}
                      </p>
                    </div>
                  </div>
                `
                : ''
            }
            ${
              this.authConfig.enableSSHKeys === true
                ? html`
                  <!-- Divider (only show if password auth is also available) -->
                  ${
                    !this.authConfig.disallowUserPassword
                      ? html`
                        <div class="auth-divider py-2 sm:py-3">
                          <span>${t('login.or')}</span>
                        </div>
                      `
                      : ''
                  }

                  <!-- SSH Key Management Section -->
                  <div class="ssh-key-item p-6 sm:p-8">
                    <div class="flex items-center justify-between mb-3 sm:mb-4">
                      <div class="flex items-center gap-2">
                        <div class="w-2 h-2 rounded-full bg-primary"></div>
                        <span class="font-mono text-xs sm:text-sm">${t('login.sshKeyManagement')}</span>
                      </div>
                      <button
                        class="btn-ghost text-xs"
                        data-testid="manage-keys"
                        @click=${this.handleShowSSHKeyManager}
                      >
                        ${t('login.manageKeys')}
                      </button>
                    </div>

                    <div class="space-y-3">
                      <div class="bg-bg border border-border rounded p-3">
                        <p class="text-text-muted text-xs mb-2">
                          ${t('login.sshGenerateHint')}
                        </p>
                        <p class="text-text-muted text-xs">
                          💡 ${t('login.sshBothHint')}
                        </p>
                      </div>

                      <button
                        class="btn-secondary w-full py-2.5 sm:py-3 text-sm sm:text-base"
                        data-testid="ssh-login"
                        @click=${this.handleSSHKeyAuth}
                        ?disabled=${this.loading}
                      >
                        ${this.loading ? t('login.authenticating') : t('login.sshLogin')}
                      </button>
                    </div>
                  </div>
                `
                : ''
            }
          </div>
        </div>
      </div>
    `;
  }
}
