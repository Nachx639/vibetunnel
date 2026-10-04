import { html, LitElement, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { DEFAULT_REPOSITORY_BASE_PATH } from '../../shared/constants.js';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../../types/config.js';
import { LocaleController, t } from '../i18n/index.js';
import type { AuthClient } from '../services/auth-client.js';
import {
  type NotificationPreferences,
  type PushSubscription,
  pushNotificationService,
} from '../services/push-notification-service.js';
import { RepositoryService } from '../services/repository-service.js';
import { ServerConfigService } from '../services/server-config-service.js';
import { ACCENT_THEMES, accentName, applyAccent, getAccent } from '../utils/accent-themes.js';
import { createLogger } from '../utils/logger.js';
import { getPhoneUi, type PhoneUi, setPhoneUi } from '../utils/phone-ui.js';
import { applyThemeMode, getThemeMode, type ThemeMode } from '../utils/theme-mode.js';
import { VERSION } from '../version.js';
import { isQuickSwitcherEnabled, setQuickSwitcherEnabled } from './session-quick-switcher.js';
import './language-picker.js';
import './quick-keys-editor.js';

const logger = createLogger('settings');

@customElement('vt-settings')
export class Settings extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  @property({ type: Boolean }) visible = false;
  @property({ type: Object }) authClient?: AuthClient;

  // Notification settings state
  @state() private notificationPreferences: NotificationPreferences =
    DEFAULT_NOTIFICATION_PREFERENCES;
  @state() private permission: NotificationPermission = 'default';
  @state() private subscription: PushSubscription | null = null;
  @state() private isLoading = false;
  @state() private testingNotification = false;

  // App settings state
  @state() private repositoryBasePath = DEFAULT_REPOSITORY_BASE_PATH;
  @state() private repositoryCount = 0;
  @state() private isDiscoveringRepositories = false;
  @state() private showQuickKeysEditor = false;

  // Appearance state (shared with the header toggle and the session compact menu)
  @state() private themeMode: ThemeMode = getThemeMode();
  @state() private phoneUi: PhoneUi = getPhoneUi();
  @state() private quickSwitcher = isQuickSwitcherEnabled();
  @state() private accent = getAccent();

  private permissionChangeUnsubscribe?: () => void;
  private subscriptionChangeUnsubscribe?: () => void;
  private repositoryService?: RepositoryService;
  private serverConfigService?: ServerConfigService;
  protected readonly i18n = new LocaleController(this);

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('theme-changed', this.syncAppearance);
    window.addEventListener('vibetunnel-accent-changed', this.syncAppearance);
    this.syncAppearance();
    this.initializeNotifications();
    this.loadSettings();

    // Initialize services
    this.serverConfigService = new ServerConfigService(this.authClient);

    // Initialize repository service if authClient is available
    if (this.authClient) {
      this.repositoryService = new RepositoryService(this.authClient, this.serverConfigService);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('theme-changed', this.syncAppearance);
    window.removeEventListener('vibetunnel-accent-changed', this.syncAppearance);
    if (this.permissionChangeUnsubscribe) {
      this.permissionChangeUnsubscribe();
    }
    if (this.subscriptionChangeUnsubscribe) {
      this.subscriptionChangeUnsubscribe();
    }
    // Clean up keyboard listener
    document.removeEventListener('keydown', this.handleKeyDown);
  }

  protected willUpdate(changedProperties: PropertyValues) {
    if (changedProperties.has('visible')) {
      if (this.visible) {
        document.addEventListener('keydown', this.handleKeyDown);
        // Removed view transition for instant display
        this.requestUpdate();
        // Discover repositories when settings are opened
        this.discoverRepositories();
        // Refresh notification state when dialog opens
        this.refreshNotificationState();
      } else {
        document.removeEventListener('keydown', this.handleKeyDown);
        this.showQuickKeysEditor = false;
      }
    }

    // Initialize repository service when authClient becomes available
    if (changedProperties.has('authClient') && this.authClient) {
      if (!this.repositoryService && this.serverConfigService) {
        this.repositoryService = new RepositoryService(this.authClient, this.serverConfigService);
      }
      // Update server config service's authClient
      if (this.serverConfigService) {
        this.serverConfigService.setAuthClient(this.authClient);
      }
      // Discover repositories if settings are already visible
      if (this.visible) {
        this.discoverRepositories();
      }
    }
  }

  private async initializeNotifications(): Promise<void> {
    await pushNotificationService.waitForInitialization();

    this.permission = pushNotificationService.getPermission();
    this.subscription = pushNotificationService.getSubscription();
    this.notificationPreferences = await pushNotificationService.loadPreferences();

    // Get detailed subscription status for debugging
    const status = pushNotificationService.getSubscriptionStatus();
    logger.debug('Notification initialization status:', status);

    // If notifications are enabled but no subscription, try to force refresh
    if (this.notificationPreferences.enabled && !this.subscription && status.hasPermission) {
      logger.log('Notifications enabled but no subscription found, attempting to refresh...');
      await pushNotificationService.forceRefreshSubscription();

      // Update state after refresh
      this.subscription = pushNotificationService.getSubscription();
    }

    // Listen for changes
    this.permissionChangeUnsubscribe = pushNotificationService.onPermissionChange((permission) => {
      this.permission = permission;
      this.requestUpdate();
    });

    this.subscriptionChangeUnsubscribe = pushNotificationService.onSubscriptionChange(
      (subscription) => {
        this.subscription = subscription;
        this.requestUpdate();
      }
    );
  }

  private async refreshNotificationState(): Promise<void> {
    // Refresh current state from the push notification service
    this.permission = pushNotificationService.getPermission();
    this.subscription = pushNotificationService.getSubscription();
    this.notificationPreferences = await pushNotificationService.loadPreferences();

    logger.debug('Refreshed notification state:', {
      permission: this.permission,
      hasSubscription: !!this.subscription,
      preferencesEnabled: this.notificationPreferences.enabled,
    });
  }

  updated(changedProperties: PropertyValues) {
    super.updated(changedProperties);

    // When dialog becomes visible, refresh the config to ensure sync
    if (changedProperties.has('visible') && this.visible) {
      this.loadSettings();
    }
  }

  private async loadSettings() {
    try {
      // Fetch server configuration - force refresh when dialog opens
      if (this.serverConfigService) {
        try {
          const serverConfig = await this.serverConfigService.loadConfig(this.visible);
          // Always use server's repository base path
          this.repositoryBasePath = serverConfig.repositoryBasePath || DEFAULT_REPOSITORY_BASE_PATH;
          logger.debug('Loaded repository base path:', this.repositoryBasePath);
          // Force update to ensure UI reflects the loaded value
          this.requestUpdate();
        } catch (error) {
          logger.warn('Failed to fetch server config', error);
        }
      }

      // Discover repositories after preferences are loaded if visible
      if (this.visible && this.repositoryService) {
        this.discoverRepositories();
      }
    } catch (error) {
      logger.error('Failed to load settings', error);
    }
  }

  private async discoverRepositories() {
    if (!this.repositoryService || this.isDiscoveringRepositories) {
      return;
    }

    this.isDiscoveringRepositories = true;
    try {
      // Add a small delay to ensure preferences are loaded
      await new Promise((resolve) => setTimeout(resolve, 100));

      const repositories = await this.repositoryService.discoverRepositories();
      this.repositoryCount = repositories.length;
      logger.log(`Discovered ${this.repositoryCount} repositories in ${this.repositoryBasePath}`);
    } catch (error) {
      logger.error('Failed to discover repositories', error);
      this.repositoryCount = 0;
    } finally {
      this.isDiscoveringRepositories = false;
    }
  }

  /** Picks up theme/color changes made from the header or the session menu. */
  private syncAppearance = () => {
    this.themeMode = getThemeMode();
    this.accent = getAccent();
  };

  private selectThemeMode(mode: ThemeMode) {
    this.themeMode = mode;
    applyThemeMode(mode);
    this.dispatchEvent(
      new CustomEvent('theme-changed', { detail: { theme: mode }, bubbles: true, composed: true })
    );
  }

  private selectAccent(id: string) {
    this.accent = id;
    applyAccent(id);
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.visible) {
      this.handleClose();
    }
  };

  private handleClose() {
    this.dispatchEvent(new CustomEvent('close'));
  }

  private handleBackdropClick(e: Event) {
    if (e.target === e.currentTarget) {
      this.handleClose();
    }
  }

  private async handleToggleNotifications() {
    if (this.isLoading) return;

    this.isLoading = true;
    try {
      if (this.notificationPreferences.enabled) {
        // Disable notifications
        await pushNotificationService.unsubscribe();
        this.notificationPreferences = { ...this.notificationPreferences, enabled: false };
        await pushNotificationService.savePreferences(this.notificationPreferences);
        this.dispatchEvent(new CustomEvent('notifications-disabled'));
      } else {
        // Enable notifications
        const permission = await pushNotificationService.requestPermission();
        if (permission === 'granted') {
          // Check if this is the first time enabling notifications
          const currentPrefs = await pushNotificationService.loadPreferences();
          if (!currentPrefs.enabled) {
            // First time enabling - use recommended defaults
            this.notificationPreferences = pushNotificationService.getRecommendedPreferences();
            logger.log('Using recommended notification preferences for first-time enable');
          } else {
            // Already enabled before - just toggle the enabled state
            this.notificationPreferences = { ...this.notificationPreferences, enabled: true };
          }

          const subscription = await pushNotificationService.subscribe();
          if (subscription) {
            await pushNotificationService.savePreferences(this.notificationPreferences);

            // Show welcome notification
            await this.showWelcomeNotification();

            this.dispatchEvent(new CustomEvent('notifications-enabled'));
          } else {
            this.dispatchEvent(
              new CustomEvent('error', {
                detail: t('settings.error.subscribe'),
              })
            );
          }
        } else {
          this.dispatchEvent(
            new CustomEvent('error', {
              detail: t('settings.error.permissionDenied'),
            })
          );
        }
      }
    } catch (error) {
      logger.error('Failed to toggle notifications:', error);
      this.dispatchEvent(
        new CustomEvent('error', {
          detail: t('settings.error.toggle'),
        })
      );
    } finally {
      this.isLoading = false;
    }
  }

  private async handleForceRefresh() {
    try {
      await pushNotificationService.forceRefreshSubscription();

      // Update state after refresh
      this.subscription = pushNotificationService.getSubscription();
      this.notificationPreferences = await pushNotificationService.loadPreferences();

      logger.log('Force refresh completed');
    } catch (error) {
      logger.error('Force refresh failed:', error);
    }
  }

  private async handleTestNotification() {
    if (this.testingNotification) return;

    this.testingNotification = true;
    try {
      logger.log('🧪 Starting test notification...');

      // Step 1: Check service worker
      logger.debug('Step 1: Checking service worker registration');
      if (!pushNotificationService.isSupported()) {
        throw new Error('Push notifications not supported in this browser');
      }

      // Step 2: Check permissions
      logger.debug('Step 2: Checking notification permissions');
      const permission = pushNotificationService.getPermission();
      if (permission !== 'granted') {
        throw new Error(`Notification permission is ${permission}, not granted`);
      }

      // Step 3: Check subscription
      logger.debug('Step 3: Checking push subscription');
      const subscription = pushNotificationService.getSubscription();
      if (!subscription) {
        throw new Error('No active push subscription found');
      }

      // Step 4: Check server status
      logger.debug('Step 4: Checking server push notification status');
      const serverStatus = await pushNotificationService.getServerStatus();
      if (!serverStatus.enabled) {
        throw new Error('Push notifications disabled on server');
      }

      if (!serverStatus.configured) {
        throw new Error('VAPID keys not configured on server');
      }

      // Step 5: Send test notification
      logger.debug('Step 5: Sending test notification');
      await pushNotificationService.sendTestNotification(t('settings.testNotification.body'));

      logger.log('✅ Test notification sent successfully');
      this.dispatchEvent(
        new CustomEvent('success', {
          detail: t('settings.testNotification.sent'),
        })
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('❌ Test notification failed:', errorMessage);

      // Provide specific guidance based on error
      let guidance = '';
      if (errorMessage.includes('permission')) {
        guidance = t('settings.guidance.permission');
      } else if (errorMessage.includes('subscription')) {
        guidance = t('settings.guidance.subscription');
      } else if (errorMessage.includes('server')) {
        guidance = t('settings.guidance.server');
      } else if (errorMessage.includes('VAPID')) {
        guidance = t('settings.guidance.vapid');
      } else {
        guidance = t('settings.guidance.console');
      }

      this.dispatchEvent(
        new CustomEvent('error', {
          detail: t('settings.testNotification.failed', { error: errorMessage, guidance }),
        })
      );
    } finally {
      this.testingNotification = false;
    }
  }

  private async handleNotificationPreferenceChange(
    key: keyof NotificationPreferences,
    value: boolean
  ) {
    this.notificationPreferences = { ...this.notificationPreferences, [key]: value };
    await pushNotificationService.savePreferences(this.notificationPreferences);
  }

  private async showWelcomeNotification(): Promise<void> {
    // Check if we have a service worker registration
    const registration = await navigator.serviceWorker.ready;
    if (!registration) {
      return;
    }

    try {
      // Show notification directly
      await registration.showNotification(t('settings.welcomeNotification.title'), {
        body: t('settings.welcomeNotification.body'),
        icon: '/apple-touch-icon.png',
        badge: '/favicon-32.png',
        tag: 'vibetunnel-settings-welcome',
        requireInteraction: false,
        silent: false,
      });
      logger.log('Settings welcome notification displayed');
    } catch (error) {
      logger.error('Failed to show settings welcome notification:', error);
    }
  }

  private async handleRepositoryBasePathChange(value: string) {
    if (this.serverConfigService) {
      try {
        // Update server config
        await this.serverConfigService.updateConfig({ repositoryBasePath: value });
        // Update local state
        this.repositoryBasePath = value;
        // Rediscover repositories
        this.discoverRepositories();
      } catch (error) {
        logger.error('Failed to update repository base path:', error);
        // Revert the change on error
        this.requestUpdate();
      }
    }
  }

  private get isNotificationsSupported(): boolean {
    return pushNotificationService.isSupported();
  }

  private get isNotificationsEnabled(): boolean {
    // Show as enabled if the preference is set, regardless of subscription state
    // This allows the toggle to properly reflect user intent
    return this.notificationPreferences.enabled;
  }

  private renderSubscriptionStatus() {
    const hasSubscription = this.subscription || pushNotificationService.isSubscribed();

    if (hasSubscription) {
      return html`
        <div class="flex items-center space-x-2">
          <span class="text-status-success font-mono">✓</span>
          <span class="text-sm text-primary">${t('settings.status.active')}</span>
        </div>
      `;
    } else if (this.permission === 'granted') {
      return html`
        <div class="flex items-center space-x-2">
          <span class="text-status-warning font-mono">!</span>
          <span class="text-sm text-primary">${t('settings.status.notSubscribed')}</span>
        </div>
      `;
    } else {
      return html`
        <div class="flex items-center space-x-2">
          <span class="text-status-error font-mono">✗</span>
          <span class="text-sm text-primary">${t('settings.status.disabled')}</span>
        </div>
      `;
    }
  }

  private isIOSSafari(): boolean {
    const userAgent = navigator.userAgent.toLowerCase();
    const isIOS = /iphone|ipad|ipod/.test(userAgent);
    return isIOS;
  }

  private isStandalone(): boolean {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      ('standalone' in window.navigator &&
        (window.navigator as Navigator & { standalone?: boolean }).standalone === true)
    );
  }

  render() {
    if (!this.visible) return html``;

    return html`
      <div class="modal-backdrop flex items-center justify-center" @click=${this.handleBackdropClick}>
        <div
          class="modal-content font-mono text-sm w-full max-w-[calc(100vw-1rem)] sm:max-w-md lg:max-w-2xl mx-2 sm:mx-4 max-h-[calc(100vh-2rem)] overflow-hidden flex flex-col"
        >
          <!-- Header -->
          <div class="p-4 pb-4 border-b border-border/50 relative flex-shrink-0">
            <h2 class="text-primary text-lg font-bold">${t('common.settings')}</h2>
            <button
              class="absolute top-4 right-4 text-text-muted hover:text-primary transition-colors p-1"
              @click=${this.handleClose}
              title=${t('common.close')}
              aria-label=${t('settings.close')}
            >
              <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <!-- Content -->
          <div class="flex-1 overflow-y-auto p-4 space-y-6">
            ${this.renderNotificationSettings()}
            ${this.renderAppSettings()}
          </div>

          <!-- Footer -->
          <div class="p-4 pt-3 border-t border-border/50 flex-shrink-0">
            <div class="flex items-center justify-between text-xs font-mono">
              <span class="text-muted">v${VERSION}</span>
              <a href="/logs" class="text-primary hover:text-primary-hover transition-colors" target="_blank">
                ${t('settings.viewLogs')}
              </a>
            </div>
          </div>
        </div>
      </div>
      <quick-keys-editor
        .visible=${this.showQuickKeysEditor}
        @close=${() => {
          this.showQuickKeysEditor = false;
        }}
      ></quick-keys-editor>
    `;
  }

  private renderNotificationSettings() {
    const isIOSSafari = this.isIOSSafari();
    const isStandalone = this.isStandalone();
    const canTest = this.permission === 'granted' && this.subscription;

    return html`
      <div class="space-y-4">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-md font-bold text-primary">${t('settings.notifications')}</h3>
          ${this.renderSubscriptionStatus()}
        </div>
        
        ${
          !this.isNotificationsSupported
            ? html`
              <div class="p-4 bg-status-warning/10 border border-status-warning rounded-lg">
                ${
                  isIOSSafari && !isStandalone
                    ? html`
                      <p class="text-sm text-status-warning mb-2">
                        ${t('settings.ios.installRequired')}
                      </p>
                      <p class="text-xs text-status-warning opacity-80">
                        ${t('settings.ios.installHint')}
                      </p>
                    `
                    : !window.isSecureContext
                      ? html`
                      <p class="text-sm text-status-warning mb-2">
                        ⚠️ ${t('settings.secure.required')}
                      </p>
                      <p class="text-xs text-status-warning opacity-80 mb-2">
                        ${t('settings.secure.accessingVia', { origin: `${window.location.protocol}//${window.location.hostname}` })}
                      </p>
                      <p class="text-xs text-status-info opacity-90">
                        ${t('settings.secure.useInstead')}
                        <br>• https://${window.location.hostname}${window.location.port ? `:${window.location.port}` : ''}
                        <br>• http://localhost:${window.location.port || '4020'}
                        <br>• http://127.0.0.1:${window.location.port || '4020'}
                      </p>
                    `
                      : html`
                      <p class="text-sm text-status-warning">
                        ${t('settings.unsupported')}
                      </p>
                    `
                }
              </div>
            `
            : html`
              <!-- Main toggle -->
              <div class="flex items-center justify-between p-4 bg-bg-tertiary rounded-lg border border-border/50">
                <div class="flex-1">
                  <label class="text-primary font-medium">${t('settings.enableNotifications')}</label>
                  <p class="text-muted text-xs mt-1">
                    ${t('settings.enableNotifications.description')}
                  </p>
                </div>
                <button
                  role="switch"
                  aria-checked="${this.notificationPreferences.enabled}"
                  @click=${this.handleToggleNotifications}
                  ?disabled=${this.isLoading}
                  class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-base ${
                    this.notificationPreferences.enabled ? 'bg-primary' : 'bg-border'
                  }"
                >
                  <span
                    class="inline-block h-5 w-5 transform rounded-full bg-bg-elevated transition-transform ${
                      this.notificationPreferences.enabled ? 'translate-x-5' : 'translate-x-0.5'
                    }"
                  ></span>
                </button>
              </div>

              ${
                this.isNotificationsEnabled
                  ? html`
                    <!-- Notification types -->
                    <div class="mt-4 space-y-4">
                      <div>
                        <h4 class="text-sm font-medium text-text-muted mb-3">${t('settings.notificationTypes')}</h4>
                        <div class="space-y-2 bg-bg rounded-lg p-3">
                          ${this.renderNotificationToggle('sessionExit', t('settings.notify.sessionExit'), t('settings.notify.sessionExit.description'))}
                          ${this.renderNotificationToggle('sessionStart', t('settings.notify.sessionStart'), t('settings.notify.sessionStart.description'))}
                          ${this.renderNotificationToggle('commandError', t('settings.notify.commandError'), t('settings.notify.commandError.description'))}
                          ${this.renderNotificationToggle('commandCompletion', t('settings.notify.commandCompletion'), t('settings.notify.commandCompletion.description'))}
                          ${this.renderNotificationToggle('bell', t('settings.notify.bell'), t('settings.notify.bell.description'))}
                        </div>
                      </div>

                      <!-- Sound and vibration -->
                      <div>
                        <h4 class="text-sm font-medium text-text-muted mb-3">${t('settings.notificationBehavior')}</h4>
                        <div class="space-y-2 bg-bg rounded-lg p-3">
                          ${this.renderNotificationToggle('soundEnabled', t('settings.notify.sound'), t('settings.notify.sound.description'))}
                          ${this.renderNotificationToggle('vibrationEnabled', t('settings.notify.vibration'), t('settings.notify.vibration.description'))}
                        </div>
                      </div>
                    </div>

                    <!-- Test button -->
                    <div class="flex items-center justify-between pt-3 mt-3 border-t border-border/50">
                      <p class="text-xs text-muted">${t('settings.testNotification.hint')}</p>
                      <button
                        class="btn-secondary text-xs px-3 py-1.5"
                        @click=${this.handleTestNotification}
                        ?disabled=${this.testingNotification || !canTest}
                      >
                        ${this.testingNotification ? t('settings.testNotification.testing') : t('settings.testNotification.button')}
                      </button>
                    </div>

                    <!-- Debug section (only in development) -->
                    ${
                      typeof process !== 'undefined' && process.env?.NODE_ENV === 'development'
                        ? html`
                      <div class="mt-3 pt-3 border-t border-border/50">
                        <p class="text-xs text-muted mb-2">Debug Information</p>
                        <div class="text-xs space-y-1">
                          <div>Permission: ${this.permission}</div>
                          <div>Subscription: ${this.subscription ? 'Active' : 'None'}</div>
                          <div>Preferences: ${this.notificationPreferences.enabled ? 'Enabled' : 'Disabled'}</div>
                          <button
                            class="btn-secondary text-xs px-2 py-1 mt-2"
                            @click=${() => this.handleForceRefresh()}
                          >
                            Force Refresh
                          </button>
                        </div>
                      </div>
                    `
                        : ''
                    }
                  `
                  : ''
              }
            `
        }
      </div>
    `;
  }

  private renderNotificationToggle(
    key: keyof NotificationPreferences,
    label: string,
    description: string
  ) {
    return html`
      <div class="flex items-center justify-between py-2">
        <div class="flex-1 pr-4">
          <label class="text-primary text-sm font-medium">${label}</label>
          <p class="text-muted text-xs">${description}</p>
        </div>
        <button
          role="switch"
          aria-checked="${this.notificationPreferences[key]}"
          @click=${() => this.handleNotificationPreferenceChange(key, !this.notificationPreferences[key])}
          class="relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-base ${
            this.notificationPreferences[key] ? 'bg-primary' : 'bg-border'
          }"
        >
          <span
            class="inline-block h-4 w-4 transform rounded-full bg-bg-elevated transition-transform ${
              this.notificationPreferences[key] ? 'translate-x-4' : 'translate-x-0.5'
            }"
          ></span>
        </button>
      </div>
    `;
  }

  private renderAppearance() {
    const modes: Array<[ThemeMode, string]> = [
      ['light', t('theme.light')],
      ['dark', t('theme.dark')],
      ['system', t('theme.system')],
    ];
    return html`
      <div class="p-4 bg-bg-tertiary rounded-lg border border-border/50" data-testid="settings-appearance">
        <label class="text-primary font-medium">${t('appearance.title')}</label>
        <div class="appearance-modes mt-3" role="group" aria-label=${t('appearance.title')}>
          ${modes.map(
            ([mode, label]) => html`
              <button
                type="button"
                class="appearance-mode min-h-[44px] ${this.themeMode === mode ? 'active' : ''}"
                aria-pressed=${this.themeMode === mode ? 'true' : 'false'}
                data-testid="settings-theme-${mode}"
                @click=${() => this.selectThemeMode(mode)}
              >
                ${label}
              </button>
            `
          )}
        </div>
        <div class="appearance-label">${t('appearance.color')}</div>
        <div class="appearance-swatches" role="group" aria-label=${t('appearance.color')}>
          ${ACCENT_THEMES.map(
            (accent) => html`
              <button
                type="button"
                class="appearance-swatch ${this.accent === accent.id ? 'active' : ''}"
                style="--swatch: ${accent.color}; width: 44px; height: 44px"
                title=${accentName(accent)}
                aria-label=${accentName(accent)}
                aria-pressed=${this.accent === accent.id ? 'true' : 'false'}
                data-testid="settings-accent-${accent.id}"
                @click=${() => this.selectAccent(accent.id)}
              ></button>
            `
          )}
        </div>
      </div>
    `;
  }

  private selectPhoneUi(value: PhoneUi) {
    this.phoneUi = value;
    setPhoneUi(value);
  }

  /** Phone layout: Classic (the cards, as on wider screens) or Compact (chat-style rows). */
  private renderPhoneLayout() {
    const options: Array<[PhoneUi, string]> = [
      ['classic', t('settings.phoneLayout.classic')],
      ['compact', t('settings.phoneLayout.compact')],
    ];
    return html`
      <div class="p-4 bg-bg-tertiary rounded-lg border border-border/50" data-testid="settings-phone-layout">
        <label class="text-primary font-medium">${t('settings.phoneLayout')}</label>
        <p class="text-muted text-xs mt-1">${t('settings.phoneLayout.description')}</p>
        <div class="appearance-modes mt-3" role="group" aria-label=${t('settings.phoneLayout')}>
          ${options.map(
            ([value, label]) => html`
              <button
                type="button"
                class="appearance-mode min-h-[44px] ${this.phoneUi === value ? 'active' : ''}"
                aria-pressed=${this.phoneUi === value ? 'true' : 'false'}
                data-testid="settings-phone-layout-${value}"
                @click=${() => this.selectPhoneUi(value)}
              >
                ${label}
              </button>
            `
          )}
        </div>
      </div>
    `;
  }

  private renderAppSettings() {
    return html`
      <div class="space-y-4">
        <h3 class="text-md font-bold text-primary mb-3">${t('settings.application')}</h3>

        ${this.renderAppearance()}

        ${this.renderPhoneLayout()}

        <!-- Language -->
        <div class="p-4 bg-bg-tertiary rounded-lg border border-border/50">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <label class="text-primary font-medium" for="language-picker">${t('language.label')}</label>
              <p class="text-muted text-xs mt-1">${t('language.description')}</p>
            </div>
            <language-picker></language-picker>
          </div>
        </div>

        <!-- Repository Base Path -->
        <div class="p-4 bg-bg-tertiary rounded-lg border border-border/50">
          <div class="mb-3">
            <div class="flex items-center justify-between">
              <label class="text-primary font-medium">${t('settings.repoBasePath')}</label>
              <div class="flex items-center gap-2">
                ${
                  this.isDiscoveringRepositories
                    ? html`<span id="repository-status" class="text-muted text-xs">${t('settings.repoScanning')}</span>`
                    : html`<span id="repository-status" class="text-muted text-xs">${t('settings.repoCount', { count: this.repositoryCount })}</span>`
                }
                <button
                  @click=${() => this.discoverRepositories()}
                  ?disabled=${this.isDiscoveringRepositories}
                  class="text-primary hover:text-primary-hover text-xs transition-colors duration-200"
                  title=${t('settings.repoRefresh')}
                >
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
                          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </button>
              </div>
            </div>
            <p class="text-muted text-xs mt-1">
              ${t('settings.repoBasePath.description')}
            </p>
          </div>
          <div class="flex gap-2">
            <input
              type="text"
              .value=${this.repositoryBasePath}
              @input=${(e: Event) => {
                const input = e.target as HTMLInputElement;
                this.handleRepositoryBasePathChange(input.value);
              }}
              placeholder="~/"
              class="input-field py-2 text-sm flex-1"
            />
          </div>
        </div>

        <div class="p-4 bg-bg-tertiary rounded-lg border border-border/50">
          <div class="flex items-center justify-between gap-4">
            <div>
              <label class="text-primary font-medium" id="quick-switcher-label">${t('settings.quickSwitcher')}</label>
              <p class="text-muted text-xs mt-1">${t('settings.quickSwitcher.description')}</p>
            </div>
            <button
              role="switch"
              aria-checked=${this.quickSwitcher ? 'true' : 'false'}
              aria-labelledby="quick-switcher-label"
              data-testid="settings-quick-switcher"
              class="relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-bg ${
                this.quickSwitcher ? 'bg-primary' : 'bg-border'
              }"
              @click=${() => {
                this.quickSwitcher = !this.quickSwitcher;
                setQuickSwitcherEnabled(this.quickSwitcher);
              }}
            >
              <span
                class="inline-block h-5 w-5 transform rounded-full bg-bg-elevated transition-transform ${
                  this.quickSwitcher ? 'translate-x-5' : 'translate-x-0.5'
                }"
              ></span>
            </button>
          </div>
        </div>

        <div class="p-4 bg-bg-tertiary rounded-lg border border-border/50">
          <div class="flex items-center justify-between gap-4">
            <div>
              <label class="text-primary font-medium">${t('settings.quickKeys')}</label>
              <p class="text-muted text-xs mt-1">
                ${t('settings.quickKeys.description')}
              </p>
            </div>
            <button
              type="button"
              class="btn-secondary text-xs px-3 py-2 flex-shrink-0"
              @click=${() => {
                this.showQuickKeysEditor = true;
              }}
            >
              ${t('settings.quickKeys.customize')}
            </button>
          </div>
        </div>
      </div>
    `;
  }
}
