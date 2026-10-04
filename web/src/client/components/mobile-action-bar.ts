/**
 * Mobile Action Bar Component
 *
 * A comprehensive mobile-first action bar that provides quick access to:
 * - Command palette (Ctrl+Shift+P)
 * - Clipboard manager with paste functionality
 * - Slash commands for Claude Code
 * - Session management actions
 * - File operations
 * - Terminal settings
 *
 * Features:
 * - Touch-friendly 44px minimum targets
 * - Swipe gestures support
 * - Long-press actions
 * - Haptic feedback
 * - Adaptive layout based on screen size
 */
import { html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { Session } from '../../shared/types.js';
import { LocaleController, type MessageKey, t } from '../i18n/index.js';
import { createLogger } from '../utils/logger.js';
import { detectMobile } from '../utils/mobile-utils.js';
import { endsADrag, touchEndsADrag } from '../utils/pointer-drag.js';
import type { ClipboardManagerCallbacks } from './clipboard-manager.js';
import type { CommandPaletteCallbacks } from './command-palette.js';
import type { SlashCommandsCallbacks } from './slash-commands.js';

// Import the new components
import './command-palette.js';
import './clipboard-manager.js';
import './slash-commands.js';

const logger = createLogger('mobile-action-bar');

export interface MobileActionBarCallbacks
  extends CommandPaletteCallbacks,
    ClipboardManagerCallbacks,
    SlashCommandsCallbacks {
  // Additional mobile-specific callbacks
  onShowKeyboard?: () => void;
  onHideKeyboard?: () => void;
  onToggleActionBar?: () => void;
  onTriggerHaptic?: (type: 'light' | 'medium' | 'heavy') => void;
}

interface ActionButton {
  id: string;
  /** Message key of the button's name; translated when rendered. */
  title: MessageKey;
  icon: string;
  action:
    | keyof MobileActionBarCallbacks
    | 'showCommandPalette'
    | 'showClipboardManager'
    | 'showSlashCommands';
  shortcut?: string;
  longPressAction?: ActionButton['action'];
  highlight?: boolean;
  badge?: string | number;
  category: 'primary' | 'secondary' | 'utility';
}

@customElement('mobile-action-bar')
export class MobileActionBar extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  @property({ type: Boolean }) visible = true;
  @property({ type: Object }) session: Session | null = null;
  @property({ type: Object }) callbacks: MobileActionBarCallbacks | null = null;
  @property({ type: Boolean }) keyboardVisible = false;
  @property({ type: String }) currentMode: 'normal' | 'plan' | 'auto-accept' = 'normal';
  @property({ type: Number }) keyboardHeight = 0;
  /**
   * Compact phone layout: a bar docked under the terminal (it takes layout space instead of
   * floating over the last rows), Keyboard first, and Paste pastes on tap (long press opens
   * the clipboard manager).
   */
  @property({ type: Boolean }) docked = false;

  @state() private showCommandPalette = false;
  @state() private showClipboardManager = false;
  @state() private showSlashCommands = false;
  @state() private isExpanded = false;
  @state() private longPressTimer: number | null = null;
  @state() private isMobile = detectMobile();
  protected readonly i18n = new LocaleController(this);

  private readonly primaryActions: ActionButton[] = [
    // Temporarily disabled - no functionality yet
    // {
    //   id: 'command-palette',
    //   title: 'Command Palette',
    //   icon: '⚡',
    //   action: 'showCommandPalette', // Internal action to show modal
    //   shortcut: 'Ctrl+Shift+P',
    //   highlight: true,
    //   category: 'primary',
    // },
    {
      id: 'clipboard',
      title: 'actionBar.clipboard',
      icon: '📋',
      action: 'showClipboardManager', // Internal action to show modal
      longPressAction: 'onPasteFromClipboard',
      category: 'primary',
    },
    // Temporarily disabled - no functionality yet
    // {
    //   id: 'slash-commands',
    //   title: 'Slash Commands',
    //   icon: '/',
    //   action: 'showSlashCommands', // Internal action to show modal
    //   highlight: true,
    //   category: 'primary',
    // },
    {
      id: 'keyboard',
      title: 'actionBar.keyboard',
      icon: '⌨️',
      action: 'onShowKeyboard',
      category: 'primary',
    },
  ];

  private readonly dockedPrimaryActions: ActionButton[] = [
    {
      id: 'keyboard',
      title: 'actionBar.keyboard',
      icon: '⌨️',
      action: 'onShowKeyboard',
      category: 'primary',
    },
    {
      id: 'clipboard',
      title: 'quickKeys.paste',
      icon: '📋',
      action: 'onPasteFromClipboard',
      longPressAction: 'showClipboardManager',
      category: 'primary',
    },
  ];

  private readonly secondaryActions: ActionButton[] = [
    {
      id: 'new-session',
      title: 'actionBar.newSession',
      icon: '➕',
      action: 'onCreateSession',
      shortcut: 'Ctrl+N',
      category: 'secondary',
    },
    {
      id: 'files',
      title: 'actionBar.files',
      icon: '📁',
      action: 'onOpenFileBrowser',
      longPressAction: 'onUploadFile',
      category: 'secondary',
    },
    {
      id: 'settings',
      title: 'common.settings',
      icon: '⚙️',
      action: 'onOpenTerminalSettings',
      category: 'secondary',
    },
    {
      id: 'theme',
      title: 'actionBar.theme',
      icon: '🌓',
      action: 'onToggleTheme',
      category: 'secondary',
    },
  ];

  connectedCallback() {
    super.connectedCallback();

    // Ensure all modals start closed
    this.closeAllModals();

    // Listen for orientation changes
    window.addEventListener('orientationchange', this.handleOrientationChange);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.outsideClickTimer) clearTimeout(this.outsideClickTimer);
    this.outsideClickTimer = null;
    document.removeEventListener('click', this.handleOutsideClick);

    window.removeEventListener('orientationchange', this.handleOrientationChange);

    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
    }
  }

  private handleOrientationChange = () => {
    // Small delay to let the orientation change complete
    setTimeout(() => {
      this.requestUpdate();
    }, 100);
  };

  private async triggerHaptic(type: 'light' | 'medium' | 'heavy' = 'light') {
    if (this.callbacks?.onTriggerHaptic) {
      this.callbacks.onTriggerHaptic(type);
    }

    // Fallback to native haptic feedback on supported devices
    if ('vibrate' in navigator) {
      const patterns = {
        light: [10],
        medium: [20],
        heavy: [50],
      };
      navigator.vibrate(patterns[type]);
    }
  }

  private handleButtonPress(button: ActionButton, event: PointerEvent) {
    event.preventDefault();
    event.stopPropagation();

    logger.debug(`Button pressed: ${button.id}`);
    this.triggerHaptic('light');

    // Set timer for all buttons - we'll check for long press action in the timeout
    this.longPressTimer = window.setTimeout(() => {
      // This timeout means it's a long press
      if (button.longPressAction) {
        logger.debug(`Long press action: ${button.longPressAction}`);
        this.triggerHaptic('medium');
        this.executeAction(button.longPressAction);
      }
      this.longPressTimer = null;
    }, 500); // 500ms long press
  }

  private handleButtonRelease(button: ActionButton, event: PointerEvent) {
    event.preventDefault();
    event.stopPropagation();

    // If long press timer is still active, it's a regular tap
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
      // Unless the finger moved: iOS ends a scroll that started on the button here too.
      if (endsADrag(event)) return;
      logger.debug(`Button tap: ${button.id} -> ${button.action}`);
      if (this.docked && button.category === 'secondary') this.isExpanded = false;
      this.executeAction(button.action);
    } else {
      logger.debug(`Button release but no timer: ${button.id}`);
    }
  }

  private executeAction(
    action:
      | keyof MobileActionBarCallbacks
      | 'showCommandPalette'
      | 'showClipboardManager'
      | 'showSlashCommands'
  ) {
    logger.debug(`Executing mobile action: ${action}`);

    // Handle internal actions
    switch (action) {
      case 'showCommandPalette':
        logger.debug('Toggling command palette - current state:', this.showCommandPalette);
        if (this.showCommandPalette) {
          this.showCommandPalette = false;
        } else {
          this.closeAllModals();
          this.showCommandPalette = true;
        }
        return;
      case 'showClipboardManager':
        logger.debug('Toggling clipboard manager - current state:', this.showClipboardManager);
        if (this.showClipboardManager) {
          this.showClipboardManager = false;
        } else {
          this.closeAllModals();
          this.showClipboardManager = true;
        }
        return;
      case 'showSlashCommands':
        logger.debug('Toggling slash commands - current state:', this.showSlashCommands);
        if (this.showSlashCommands) {
          // If already open, close it
          this.showSlashCommands = false;
          logger.debug('Closed slash commands');
        } else {
          // If closed, open it (and close others)
          this.closeAllModals();
          this.showSlashCommands = true;
          logger.debug('Opened slash commands');
        }
        return;
      case 'onToggleActionBar':
        this.isExpanded = !this.isExpanded;
        return;
    }

    // Execute callback if available (only for actual callback actions)
    if (typeof action === 'string' && action.startsWith('on')) {
      const callback = this.callbacks?.[action as keyof MobileActionBarCallbacks];

      if (callback && typeof callback === 'function') {
        // Handle callbacks that require parameters
        if (action === 'onTriggerHaptic') {
          (callback as (type: 'light' | 'medium' | 'heavy') => void)('light');
        } else {
          (callback as () => void)();
        }
      }
    }
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has('isExpanded')) {
      if (this.outsideClickTimer) clearTimeout(this.outsideClickTimer);
      this.outsideClickTimer = null;
      if (this.isExpanded) {
        // Defer so the click that opened the popover does not immediately close it.
        this.outsideClickTimer = setTimeout(() => {
          this.outsideClickTimer = null;
          document.addEventListener('click', this.handleOutsideClick);
        }, 0);
      } else {
        document.removeEventListener('click', this.handleOutsideClick);
      }
    }
  }

  private outsideClickTimer: ReturnType<typeof setTimeout> | null = null;

  /** The More popover closes on a click anywhere else, like other menus. */
  private handleOutsideClick = (e: MouseEvent) => {
    if (!e.composedPath().includes(this)) this.isExpanded = false;
  };

  private lastKeyboardTouchEnd = 0;

  /**
   * A real (transparent) textarea covers the Keyboard button. On iPhone, once the page has
   * lost keyboard focus (after Done, or right after loading), iOS ignores a scripted focus():
   * activeElement changes but no focus event fires and the keyboard never appears, leaving
   * only the quick keys. A finger landing on a real field always brings the keyboard up;
   * focus then moves to the hidden terminal input with the keyboard already open.
   */
  private handleKeyboardProxyFocus = () => {
    // The tap's click comes after focus, when the quick keys may already sit under the
    // finger (this bar hides): swallow it so it neither sends a key nor steals focus.
    const swallow = (e: Event) => this.swallowClick(e);
    document.addEventListener('click', swallow, true);
    setTimeout(() => document.removeEventListener('click', swallow, true), 700);
    this.cancelLongPress();
    this.lastKeyboardTouchEnd = Date.now();
    this.executeAction('onShowKeyboard');
  };

  /**
   * The keyboard button focuses the hidden input from touchend, like a terminal tap: in
   * Chrome on iOS (WKWebView) a focus() from pointerup sometimes left only the quick keys
   * up without the soft keyboard.
   */
  private handleKeyboardTouchEnd(button: ActionButton, e: TouchEvent) {
    if (button.action !== 'onShowKeyboard') return;
    // A scroll that started on the button ends here too: not a tap.
    if (touchEndsADrag(e)) return;
    e.preventDefault();
    this.cancelLongPress();
    this.lastKeyboardTouchEnd = Date.now();
    this.executeAction(button.action);
  }

  private handleButtonClick(button: ActionButton, e: MouseEvent) {
    this.swallowClick(e);
    // Mouse or keyboard activation of the keyboard button (touch already ran on touchend).
    if (button.action === 'onShowKeyboard' && Date.now() - this.lastKeyboardTouchEnd > 700) {
      this.cancelLongPress();
      this.executeAction(button.action);
    }
  }

  private cancelLongPress() {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  // The click after a tap must not bubble to session-view: its click handler focuses the
  // session view and steals focus from the hidden input, closing the keyboard just opened.
  private swallowClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };

  /** The transparent field over the Keyboard button (see handleKeyboardProxyFocus). */
  private renderKeyboardProxy() {
    return html`<textarea
      class="keyboard-proxy"
      rows="1"
      tabindex="-1"
      aria-hidden="true"
      autocomplete="off"
      autocapitalize="none"
      autocorrect="off"
      spellcheck="false"
      @focus=${this.handleKeyboardProxyFocus}
      style="position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0;border:0;outline:none;resize:none;opacity:0.01;font-size:16px;color:transparent;background:transparent;caret-color:transparent;"
    ></textarea>`;
  }

  private closeAllModals(): void {
    this.showCommandPalette = false;
    this.showClipboardManager = false;
    this.showSlashCommands = false;
  }

  private renderFloating() {
    const dynamicStyle =
      this.keyboardVisible && this.keyboardHeight > 0
        ? `bottom: ${this.keyboardHeight + 16}px; left: 50%; transform: translateX(-50%);`
        : `bottom: calc(env(safe-area-inset-bottom, 16px) + 16px); left: 50%; transform: translateX(-50%);`;

    return html`
      <!-- Mobile Action Bar -->
      <div 
        class="fixed transition-all duration-300 ${this.isExpanded ? 'scale-105' : 'scale-100'}"
        style="${dynamicStyle} z-index: 1100; position: fixed !important;"
      >
        <!-- Primary Actions (Always Visible) -->
        <div class="bg-bg/90 backdrop-blur-lg border border-border/50 rounded-2xl shadow-2xl p-2 max-w-sm mx-auto">
          <div class="flex items-center gap-2">
            ${this.primaryActions.map(
              (button) => html`
              <span class="relative inline-flex" @click=${this.swallowClick}>
              <button
                class="relative flex flex-col items-center justify-center w-14 h-14 rounded-xl transition-all duration-200 ${
                  button.highlight
                    ? 'bg-primary/20 border border-primary/30 text-primary'
                    : 'bg-bg-secondary/80 hover:bg-surface-hover text-text hover:text-primary'
                } active:scale-95 touch-manipulation"
                @pointerdown=${(e: PointerEvent) => this.handleButtonPress(button, e)}
                @pointerup=${(e: PointerEvent) => {
                  if (button.action !== 'onShowKeyboard') this.handleButtonRelease(button, e);
                }}
                @pointercancel=${() => this.cancelLongPress()}
                @touchend=${(e: TouchEvent) => this.handleKeyboardTouchEnd(button, e)}
                @click=${(e: MouseEvent) => this.handleButtonClick(button, e)}
                title=${button.longPressAction ? t('actionBar.longPressHint', { action: t(button.title) }) : t(button.title)}
                aria-label=${t(button.title)}
              >
                <span class="text-xl mb-0.5">${button.icon}</span>
                <span class="text-xs font-medium leading-none">${t(button.title).split(' ')[0]}</span>
                
                ${
                  button.badge
                    ? html`
                  <div class="absolute -top-1 -right-1 bg-status-error text-white text-xs rounded-full w-5 h-5 flex items-center justify-center font-bold">
                    ${button.badge}
                  </div>
                `
                    : ''
                }
                
                ${
                  button.longPressAction
                    ? html`
                  <div class="absolute bottom-0 right-0 w-2 h-2 bg-primary/60 rounded-full"></div>
                `
                    : ''
                }
              </button>
              ${button.action === 'onShowKeyboard' ? this.renderKeyboardProxy() : ''}
              </span>
            `
            )}
            
            <!-- Expand/Collapse Toggle -->
            <button
              class="flex items-center justify-center w-8 h-14 text-text-muted hover:text-text transition-colors ml-1"
              @click=${() => {
                this.isExpanded = !this.isExpanded;
                this.triggerHaptic('light');
              }}
              title=${this.isExpanded ? t('actionBar.collapse') : t('actionBar.moreActions')}
              aria-label=${this.isExpanded ? t('actionBar.collapseMenu') : t('actionBar.showMoreActions')}
            >
              <svg 
                width="16" 
                height="16" 
                viewBox="0 0 20 20" 
                fill="currentColor"
                class="transition-transform duration-200 ${this.isExpanded ? 'rotate-180' : ''}"
              >
                <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/>
              </svg>
            </button>
          </div>
          
          <!-- Secondary Actions (Expandable) -->
          ${
            this.isExpanded
              ? html`
            <div class="mt-2 pt-2 border-t border-border/30">
              <div class="flex items-center gap-2 justify-center">
                ${this.secondaryActions.map(
                  (button) => html`
                  <button
                    class="relative flex flex-col items-center justify-center w-12 h-12 rounded-lg transition-all duration-200 bg-bg-tertiary/80 hover:bg-surface-hover text-text-muted hover:text-text active:scale-95 touch-manipulation"
                    @pointerdown=${(e: PointerEvent) => this.handleButtonPress(button, e)}
                    @pointerup=${(e: PointerEvent) => this.handleButtonRelease(button, e)}
                    @pointercancel=${() => {
                      if (this.longPressTimer) {
                        clearTimeout(this.longPressTimer);
                        this.longPressTimer = null;
                      }
                    }}
                    title=${button.longPressAction ? t('actionBar.longPressHint', { action: t(button.title) }) : t(button.title)}
                    aria-label=${t(button.title)}
                  >
                    <span class="text-lg mb-0.5">${button.icon}</span>
                    <span class="text-xs font-medium leading-none">${t(button.title).split(' ')[0]}</span>
                    
                    ${
                      button.longPressAction
                        ? html`
                      <div class="absolute bottom-0 right-0 w-1.5 h-1.5 bg-primary/60 rounded-full"></div>
                    `
                        : ''
                    }
                  </button>
                `
                )}
              </div>
            </div>
          `
              : ''
          }
        </div>
        
        <!-- Mode Indicator -->
        ${
          this.currentMode !== 'normal'
            ? html`
          <div class="mt-2 text-center">
            <div class="inline-flex items-center gap-2 bg-primary/20 border border-primary/30 rounded-full px-3 py-1">
              <div class="w-2 h-2 rounded-full bg-primary animate-pulse"></div>
              <span class="text-xs font-medium text-primary uppercase">
                ${this.currentMode === 'plan' ? t('palette.planMode.title') : t('palette.autoAccept.title')}
              </span>
            </div>
          </div>
        `
            : ''
        }
      </div>
    `;
  }

  /** Compact phone layout: docked in the session view's flex column (see `docked`). */
  private renderDocked() {
    const renderButton = (button: ActionButton, extraClass = '') => html`
      <button
        class="relative flex items-center gap-1.5 h-10 px-3 rounded-lg text-sm font-medium bg-bg-tertiary/80 text-text active:scale-95 active:bg-surface-hover transition-transform duration-100 touch-manipulation ${extraClass}"
        @pointerdown=${(e: PointerEvent) => this.handleButtonPress(button, e)}
        @pointerup=${(e: PointerEvent) => {
          if (button.action !== 'onShowKeyboard') this.handleButtonRelease(button, e);
        }}
        @pointercancel=${() => this.cancelLongPress()}
        @touchend=${(e: TouchEvent) => this.handleKeyboardTouchEnd(button, e)}
        @click=${(e: MouseEvent) => this.handleButtonClick(button, e)}
        title=${button.longPressAction ? t('actionBar.longPressHint', { action: t(button.title) }) : t(button.title)}
        aria-label=${t(button.title)}
      >
        <span class="text-base leading-none" aria-hidden="true">${button.icon}</span>
        <span class="leading-none">${t(button.title)}</span>
      </button>
    `;

    return html`
      <div
        class="mobile-action-bar relative flex items-center gap-2 px-2 pt-1.5 bg-bg-secondary border-t border-border/50 select-none"
        style="padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 6px); -webkit-user-select: none; -webkit-touch-callout: none;"
      >
        ${this.dockedPrimaryActions.map((button) =>
          button.action === 'onShowKeyboard'
            ? html`<span class="relative inline-flex" @click=${this.swallowClick}>
                ${renderButton(button)} ${this.renderKeyboardProxy()}
              </span>`
            : renderButton(button)
        )}
        <div class="flex-1"></div>
        ${
          this.currentMode !== 'normal'
            ? html`
          <span class="inline-flex items-center gap-1.5 text-xs font-medium text-primary uppercase">
            <span class="w-2 h-2 rounded-full bg-primary animate-pulse"></span>
            ${this.currentMode === 'plan' ? t('palette.planMode.title') : t('palette.autoAccept.title')}
          </span>
        `
            : ''
        }
        <button
          class="flex items-center justify-center w-10 h-10 rounded-lg text-text-muted active:bg-surface-hover touch-manipulation"
          @click=${(e: Event) => {
            this.swallowClick(e);
            this.isExpanded = !this.isExpanded;
            this.triggerHaptic('light');
          }}
          title=${this.isExpanded ? t('actionBar.collapse') : t('actionBar.moreActions')}
          aria-label=${this.isExpanded ? t('actionBar.collapseMenu') : t('actionBar.showMoreActions')}
          aria-haspopup="menu"
          aria-expanded="${this.isExpanded}"
        >
          <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" class="transition-transform duration-200 ${this.isExpanded ? 'rotate-180' : ''}">
            <path fill-rule="evenodd" d="M14.707 12.707a1 1 0 01-1.414 0L10 9.414l-3.293 3.293a1 1 0 01-1.414-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 010 1.414z" clip-rule="evenodd"/>
          </svg>
        </button>

        ${
          this.isExpanded
            ? html`
          <div
            class="absolute right-2 bottom-full mb-2 p-2 grid grid-cols-2 gap-2 bg-bg-secondary border border-border/50 rounded-xl shadow-2xl"
            style="z-index: 30;"
          >
            ${this.secondaryActions.map((button) => renderButton(button, 'justify-start'))}
          </div>
        `
            : ''
        }
      </div>
    `;
  }

  render() {
    if (!this.visible || !this.isMobile) {
      logger.debug('Mobile action bar not rendering:', {
        visible: this.visible,
        isMobile: this.isMobile,
      });
      return html``;
    }

    // Debug logging
    logger.debug('Mobile action bar rendering:', {
      visible: this.visible,
      isMobile: this.isMobile,
      showCommandPalette: this.showCommandPalette,
      showClipboardManager: this.showClipboardManager,
      showSlashCommands: this.showSlashCommands,
    });

    return html`
      ${this.docked ? this.renderDocked() : this.renderFloating()}

      <!-- Command Palette Modal -->
      <command-palette
        .visible=${this.showCommandPalette}
        .session=${this.session}
        .callbacks=${this.callbacks}
        .currentMode=${this.currentMode}
        .planModeActive=${this.currentMode === 'plan'}
        .autoAcceptActive=${this.currentMode === 'auto-accept'}
        @close=${() => {
          this.showCommandPalette = false;
        }}
      ></command-palette>

      <!-- Clipboard Manager Modal -->
      <clipboard-manager
        .visible=${this.showClipboardManager}
        .callbacks=${this.callbacks}
        @close=${() => {
          this.showClipboardManager = false;
        }}
      ></clipboard-manager>

      <!-- Slash Commands Modal -->
      <slash-commands
        .visible=${this.showSlashCommands}
        .session=${this.session}
        .callbacks=${this.callbacks}
        @close=${() => {
          this.showSlashCommands = false;
        }}
      ></slash-commands>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mobile-action-bar': MobileActionBar;
  }
}
