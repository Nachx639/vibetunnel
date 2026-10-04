import { html, LitElement, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LocaleController, t } from '../i18n/index.js';
import { Z_INDEX } from '../utils/constants.js';
import {
  controlCharacterFor,
  DIRECT_KEYBOARD_INPUT_ATTRIBUTE,
  getQuickKeyAriaLabel,
  getQuickKeyDefinition,
  getQuickKeyDisplayLabel,
  loadQuickKeysLayout,
  type QuickKeyDefinition,
  type QuickKeysLayout,
  SYMBOL_QUICK_KEYS,
  subscribeToQuickKeysLayout,
} from '../utils/quick-keys-layout.js';

// Common Ctrl key combinations
const CTRL_SHORTCUTS = [
  { key: 'Ctrl+D', label: '^D', combo: true, description: 'EOF/logout' },
  { key: 'Ctrl+L', label: '^L', combo: true, description: 'Clear screen' },
  { key: 'Ctrl+R', label: '^R', combo: true, description: 'Reverse search' },
  { key: 'Ctrl+W', label: '^W', combo: true, description: 'Delete word' },
  { key: 'Ctrl+U', label: '^U', combo: true, description: 'Clear line' },
  { key: 'Ctrl+A', label: '^A', combo: true, description: 'Start of line' },
  { key: 'Ctrl+E', label: '^E', combo: true, description: 'End of line' },
  { key: 'Ctrl+K', label: '^K', combo: true, description: 'Kill to EOL' },
  { key: 'CtrlFull', label: 'Ctrl…', special: true, description: 'Full Ctrl UI' },
];

// Function keys F1-F12
const FUNCTION_KEYS = Array.from({ length: 12 }, (_, i) => ({
  key: `F${i + 1}`,
  label: `F${i + 1}`,
  func: true,
}));

/** Press-and-hold auto-repeat timing, close to the iOS keyboard's own backspace repeat. */
export const KEY_REPEAT_INITIAL_DELAY_MS = 400;
export const KEY_REPEAT_INTERVAL_MS = 60;
/** Horizontal finger travel on the quick-keys bar per cursor step. */
export const SWIPE_STEP_PX = 16;
/** Mouse events iOS synthesizes after a touch must not press the key a second time. */
const SYNTHETIC_MOUSE_WINDOW_MS = 800;

/** Keys that repeat while held: cursor movement and forward delete. */
function isRepeatableKey(key: string): boolean {
  return key.startsWith('Arrow') || key === 'Delete';
}

/** Two taps on Ctrl or ⌥ within this window lock the modifier instead of releasing it. */
export const MODIFIER_LOCK_WINDOW_MS = 350;
const STICKY_MODIFIERS = ['Control', 'Option'] as const;
type StickyModifier = (typeof STICKY_MODIFIERS)[number];

function isStickyModifier(key: string): key is StickyModifier {
  return (STICKY_MODIFIERS as readonly string[]).includes(key);
}

// Done button - always visible (label is translated at render time)
const DONE_BUTTON = { key: 'Done', special: true };

/** Word labels (Paste, Home, End) are translated; key caps (Esc, Tab, Ctrl...) stay as is. */
const displayLabel = getQuickKeyDisplayLabel;

@customElement('terminal-quick-keys')
export class TerminalQuickKeys extends LitElement {
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  @property({ type: Function }) onKeyPress?: (
    key: string,
    isModifier?: boolean,
    isSpecial?: boolean,
    isToggle?: boolean,
    pasteText?: string
  ) => void;
  @property({ type: Boolean }) visible = false;
  /**
   * Compact phone layout: Ctrl and ⌥ are sticky (one tap arms, a double tap locks) and
   * combine with soft-keyboard letters, and a sideways swipe along the bar moves the cursor.
   * Off: ⌥ is a one-shot prefix for the arrows and Ctrl goes to the session as before.
   */
  @property({ type: Boolean }) compact = false;

  @state() private showFunctionKeys = false;
  @state() private showCtrlKeys = false;
  @state() private showSymbolKeys = false;
  @state() private isLandscape = false;
  @state() private quickKeysLayout: QuickKeysLayout = loadQuickKeysLayout();

  private keyRepeatInterval: number | null = null;
  private keyRepeatTimeout: number | null = null;
  private lastTouchAt = 0;
  /** Whether the held key has already been pressed (by the mouse or the hold timer). */
  private repeatPressed = false;
  private swipeActive = false;
  private pressedButton: HTMLElement | undefined;
  private swipeSteps = 0;
  private orientationHandler: (() => void) | null = null;
  private quickKeysLayoutUnsubscribe?: () => void;

  // Chord system state: armed modifiers, and which of them are locked by a double tap
  private activeModifiers = new Set<string>();
  private lockedModifiers = new Set<string>();
  private modifierTappedAt = new Map<string, number>();
  private intercepting = false;

  // Touch tracking for scroll detection
  private touchStartY = 0;
  private touchStartX = 0;
  private isTouchMoving = false;

  connectedCallback() {
    super.connectedCallback();
    // Check orientation on mount
    this.checkOrientation();

    // Set up orientation change listener
    this.orientationHandler = () => {
      this.checkOrientation();
    };

    window.addEventListener('resize', this.orientationHandler);
    window.addEventListener('orientationchange', this.orientationHandler);

    // Add passive touch listeners for smooth scrolling
    // We attach to the component host itself since it captures events from shadow DOM
    this.addEventListener('touchstart', this.handleDelegatedTouchStart, { passive: true });
    this.addEventListener('touchmove', this.handleDelegatedTouchMove, { passive: true });
    // Capture: the buttons stop touchend propagation
    this.addEventListener('touchend', this.releasePressedButton, { capture: true, passive: true });
    this.addEventListener('touchcancel', this.releasePressedButton, {
      capture: true,
      passive: true,
    });

    this.quickKeysLayout = loadQuickKeysLayout();
    this.quickKeysLayoutUnsubscribe = subscribeToQuickKeysLayout(() => {
      this.quickKeysLayout = loadQuickKeysLayout();
    });
  }

  private checkOrientation() {
    // Consider landscape if width is greater than height
    // and width is more than 600px (typical phone landscape width)
    this.isLandscape = window.innerWidth > window.innerHeight && window.innerWidth > 600;
  }

  private getButtonSizeClass(_label: string): string {
    // Increase touch area while preserving space for all three rows.
    return this.isLandscape ? 'px-1 py-2' : 'px-1.5 py-2.5';
  }

  private getButtonFontClass(label: string): string {
    if (label.length >= 4) {
      return 'quick-key-btn-xs'; // 8px
    } else if (label.length === 3) {
      return 'quick-key-btn-small'; // 10px
    } else {
      return 'quick-key-btn-medium'; // 13px
    }
  }

  // Delegated touch start handler (passive)
  private handleDelegatedTouchStart = (e: TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    this.touchStartY = touch.clientY;
    this.touchStartX = touch.clientX;
    this.isTouchMoving = false;
    this.lastTouchAt = Date.now();
    this.swipeActive = false;
    this.swipeSteps = 0;

    const target = e
      .composedPath()
      .find((el) => el instanceof HTMLElement && el.classList.contains('quick-key-btn')) as
      | HTMLElement
      | undefined;
    this.setPressedButton(
      e
        .composedPath()
        .find(
          (el) =>
            el instanceof HTMLElement &&
            (el.classList.contains('quick-key-btn') ||
              el.classList.contains('ctrl-shortcut-btn') ||
              el.classList.contains('func-key-btn'))
        ) as HTMLElement | undefined
    );

    // Arrows and Del repeat while held. A finger presses on release (see touchend) so a
    // swipe that starts on them doesn't press them.
    const key = target?.getAttribute('data-key');
    if (key && isRepeatableKey(key)) {
      this.startKeyRepeat(key, false);
    }
  };

  // Delegated touch move handler (passive)
  private handleDelegatedTouchMove = (e: TouchEvent) => {
    const touch = e.touches[0];
    const deltaY = Math.abs(touch.clientY - this.touchStartY);
    const deltaX = Math.abs(touch.clientX - this.touchStartX);

    // Reduced threshold from 10px to 5px for better scroll detection
    if (deltaY > 5 || deltaX > 5) {
      this.isTouchMoving = true;
      this.setPressedButton(undefined);
    }

    // A held key tolerates some finger drift before the repeat is cancelled.
    if (deltaY > 12 || deltaX > 12) {
      this.stopKeyRepeat();
    }

    // Swiping sideways along the bar moves the cursor like a trackpad: one arrow key per
    // SWIPE_STEP_PX, back and forth. The rows never scroll horizontally, so nothing fights it.
    if (this.compact && !this.swipeActive && deltaX >= SWIPE_STEP_PX && deltaX > deltaY * 1.5) {
      this.swipeActive = true;
      this.stopKeyRepeat();
    }
    if (this.swipeActive) {
      const steps = Math.trunc((touch.clientX - this.touchStartX) / SWIPE_STEP_PX);
      while (this.swipeSteps < steps) {
        this.swipeSteps++;
        this.onKeyPress?.('ArrowRight', false, false, false);
      }
      while (this.swipeSteps > steps) {
        this.swipeSteps--;
        this.onKeyPress?.('ArrowLeft', false, false, false);
      }
    }
  };

  private releasePressedButton = () => {
    this.setPressedButton(undefined);
  };

  /** Highlights the key under the finger until it lifts or starts a swipe. */
  private setPressedButton(button: HTMLElement | undefined) {
    if (this.pressedButton === button) return;
    this.pressedButton?.classList.remove('pressed');
    this.pressedButton = button;
    button?.classList.add('pressed');
  }

  // Keep handleTouchEnd for non-passive usage in @touchend
  private handleTouchEnd(e: TouchEvent, callback: () => void) {
    if (!this.isTouchMoving) {
      // Only preventDefault for actual taps
      if (e.cancelable) {
        e.preventDefault();
      }
      e.stopPropagation();
      callback();
    }
    // Don't preventDefault if user was scrolling - let iOS handle it naturally
    this.isTouchMoving = false;
  }

  updated(changedProperties: PropertyValues) {
    super.updated(changedProperties);
    if (changedProperties.has('visible') && !this.visible) {
      this.stopKeyRepeat();
      this.clearStickyModifiers();
    }
    if (
      changedProperties.has('visible') ||
      changedProperties.has('showFunctionKeys') ||
      changedProperties.has('showCtrlKeys') ||
      changedProperties.has('showSymbolKeys') ||
      changedProperties.has('isLandscape') ||
      changedProperties.has('quickKeysLayout')
    ) {
      this.dispatchEvent(
        new CustomEvent('quick-keys-layout-change', {
          bubbles: true,
          composed: true,
        })
      );
    }
  }

  private handleKeyPress(
    key: string,
    isModifier = false,
    isSpecial = false,
    isToggle = false,
    event?: Event
  ) {
    // Prevent default to avoid any focus loss
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    if (isToggle && key === 'F') {
      // Toggle function keys display
      this.showFunctionKeys = !this.showFunctionKeys;
      this.showCtrlKeys = false; // Hide Ctrl keys if showing
      this.showSymbolKeys = false;
      return;
    }

    if (isToggle && key === 'CtrlExpand') {
      // Toggle Ctrl shortcuts display
      this.showCtrlKeys = !this.showCtrlKeys;
      this.showFunctionKeys = false; // Hide function keys if showing
      this.showSymbolKeys = false;
      return;
    }

    if (isToggle && key === 'Symbols') {
      // Shell symbols row; stays open while typing things like 2>&1 until toggled off
      this.showSymbolKeys = !this.showSymbolKeys;
      this.showFunctionKeys = false;
      this.showCtrlKeys = false;
      return;
    }

    // If we're showing function keys and a function key is pressed, hide them
    if (this.showFunctionKeys && key.startsWith('F') && key !== 'F') {
      this.showFunctionKeys = false;
    }

    // If we're showing Ctrl keys and a Ctrl shortcut is pressed (not CtrlFull), hide them
    if (this.showCtrlKeys && key.startsWith('Ctrl+')) {
      this.showCtrlKeys = false;
    }

    // Ctrl and ⌥ are sticky: one tap arms them for the next key, a quick double tap locks
    // them until tapped again. Nothing is sent to the terminal for the modifier itself.
    if (!this.compact) {
      this.sendWithOneShotOption(key, isModifier, isSpecial, isToggle);
      return;
    }
    if (isStickyModifier(key)) {
      this.toggleStickyModifier(key);
      return;
    }

    this.sendWithModifiers(key, isModifier, isSpecial, isToggle);
  }

  /** Default layout: ⌥ arms once for the next arrow; every other key goes to the session. */
  private sendWithOneShotOption(
    key: string,
    isModifier: boolean,
    isSpecial: boolean,
    isToggle: boolean
  ) {
    if (isModifier && key === 'Option') {
      if (this.activeModifiers.has('Option')) {
        this.activeModifiers.delete('Option');
      } else {
        this.activeModifiers.add('Option');
      }
      this.requestUpdate();
      return; // Don't send Option key immediately
    }

    if (this.activeModifiers.has('Option') && key.startsWith('Arrow')) {
      this.activeModifiers.delete('Option');
      this.requestUpdate();
      // Option (ESC) first, then the arrow
      this.onKeyPress?.('Option', true, false);
      this.onKeyPress?.(key, false, false);
      return;
    }

    // Any other key releases Option
    if (this.activeModifiers.has('Option')) {
      this.activeModifiers.clear();
      this.requestUpdate();
    }

    this.onKeyPress?.(key, isModifier, isSpecial, isToggle);
  }

  private toggleStickyModifier(key: StickyModifier) {
    const now = Date.now();
    if (this.lockedModifiers.has(key)) {
      this.lockedModifiers.delete(key);
      this.activeModifiers.delete(key);
    } else if (this.activeModifiers.has(key)) {
      if (now - (this.modifierTappedAt.get(key) ?? 0) <= MODIFIER_LOCK_WINDOW_MS) {
        this.lockedModifiers.add(key);
      } else {
        this.activeModifiers.delete(key);
      }
    } else {
      this.activeModifiers.add(key);
    }
    this.modifierTappedAt.set(key, now);
    this.syncTypedInputInterception();
    this.requestUpdate();
  }

  /** Send a key with the armed modifiers applied, then release the one-shot ones. */
  private sendWithModifiers(key: string, isModifier = false, isSpecial = false, isToggle = false) {
    const ctrl = this.activeModifiers.has('Control');
    const option = this.activeModifiers.has('Option');
    const applies = key.startsWith('Arrow') || key.length === 1;

    if ((ctrl || option) && !isToggle && key !== 'Command') {
      for (const modifier of STICKY_MODIFIERS) {
        if (!this.lockedModifiers.has(modifier)) this.activeModifiers.delete(modifier);
      }
      this.syncTypedInputInterception();
      this.requestUpdate();
    }

    if (!this.onKeyPress) return;

    if (option && applies) {
      // ⌥ is the ESC prefix (Meta): ⌥← / ⌥→ jump words, ⌥b / ⌥f / ⌥d edit by word.
      this.onKeyPress('Option', true, false);
    }
    if (ctrl && key.length === 1 && controlCharacterFor(key) !== null) {
      this.onKeyPress(`Ctrl+${key.toUpperCase()}`, true, false, false);
      return;
    }
    if (option && applies) {
      this.onKeyPress(key, false, false);
      return;
    }
    this.onKeyPress(key, isModifier, isSpecial, isToggle);
  }

  /**
   * While a modifier is armed, letters typed on the soft keyboard take it too (Ctrl, then
   * "c" on the iOS keyboard sends ^C). The typed character is caught before the hidden
   * input sees it; focus never moves, so the keyboard stays up.
   */
  private syncTypedInputInterception() {
    const armed = this.compact && this.isConnected && this.visible && this.activeModifiers.size > 0;
    if (armed && !this.intercepting) {
      document.addEventListener('beforeinput', this.handleTypedInput, true);
      this.intercepting = true;
    } else if (!armed && this.intercepting) {
      document.removeEventListener('beforeinput', this.handleTypedInput, true);
      this.intercepting = false;
    }
  }

  private handleTypedInput = (event: Event) => {
    const input = event as InputEvent;
    const target = input.target as HTMLElement | null;
    if (
      !target?.hasAttribute?.(DIRECT_KEYBOARD_INPUT_ATTRIBUTE) ||
      input.inputType !== 'insertText' ||
      !input.data ||
      [...input.data].length !== 1 ||
      this.activeModifiers.size === 0
    ) {
      return;
    }
    input.preventDefault();
    input.stopImmediatePropagation();
    this.sendWithModifiers(input.data);
  };

  private clearStickyModifiers() {
    this.activeModifiers.clear();
    this.lockedModifiers.clear();
    this.syncTypedInputInterception();
  }

  private handlePasteImmediate(_e: Event) {
    console.log('[QuickKeys] Paste button touched - delegating to paste handler');

    // Always delegate to the main paste handler in direct-keyboard-manager
    // This preserves user gesture context while keeping all clipboard logic in one place
    if (this.onKeyPress) {
      this.onKeyPress('Paste', false, false);
    }
  }

  /**
   * Press the key now and keep pressing it while held: first repeat after
   * KEY_REPEAT_INITIAL_DELAY_MS, then every KEY_REPEAT_INTERVAL_MS. An armed ⌥ applies to
   * every repeat, so holding ⌥← keeps jumping words.
   */
  private startKeyRepeat(key: string, pressNow = true) {
    if (!isRepeatableKey(key)) return;

    this.stopKeyRepeat();
    this.repeatPressed = false;

    let withOption = false;
    const press = () => {
      withOption = this.activeModifiers.has('Option') && key.startsWith('Arrow');
      this.repeatPressed = true;
      this.handleKeyPress(key);
    };
    if (pressNow) press();

    const repeat = () => {
      if (!this.onKeyPress) return;
      if (withOption) {
        this.onKeyPress('Option', true, false);
        this.onKeyPress(key, false, false);
      } else {
        this.onKeyPress(key, false, false, false);
      }
    };

    this.keyRepeatTimeout = window.setTimeout(() => {
      this.keyRepeatTimeout = null;
      if (this.repeatPressed) repeat();
      else press();
      this.keyRepeatInterval = window.setInterval(repeat, KEY_REPEAT_INTERVAL_MS);
    }, KEY_REPEAT_INITIAL_DELAY_MS);
  }

  private stopKeyRepeat() {
    if (this.keyRepeatTimeout) {
      clearTimeout(this.keyRepeatTimeout);
      this.keyRepeatTimeout = null;
    }
    if (this.keyRepeatInterval) {
      clearInterval(this.keyRepeatInterval);
      this.keyRepeatInterval = null;
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.stopKeyRepeat();
    this.clearStickyModifiers();

    // Clean up orientation listener
    if (this.orientationHandler) {
      window.removeEventListener('resize', this.orientationHandler);
      window.removeEventListener('orientationchange', this.orientationHandler);
      this.orientationHandler = null;
    }

    // Remove passive touch listeners
    this.removeEventListener('touchstart', this.handleDelegatedTouchStart);
    this.removeEventListener('touchmove', this.handleDelegatedTouchMove);
    this.removeEventListener('touchend', this.releasePressedButton, { capture: true });
    this.removeEventListener('touchcancel', this.releasePressedButton, { capture: true });
    this.setPressedButton(undefined);
    this.quickKeysLayoutUnsubscribe?.();
    this.quickKeysLayoutUnsubscribe = undefined;
  }

  private getQuickKeyRows(): QuickKeyDefinition[][] {
    return this.quickKeysLayout.map((row) => row.map((key) => getQuickKeyDefinition(key)));
  }

  private renderExpandedToggle(rows: QuickKeyDefinition[][], key: 'CtrlExpand' | 'F' | 'Symbols') {
    const remainsVisible = [rows[0], ...rows.slice(2)].some((row) =>
      row.some((definition) => definition.key === key)
    );

    return remainsVisible ? '' : this.renderQuickKey(getQuickKeyDefinition(key));
  }

  private renderQuickKey(definition: QuickKeyDefinition) {
    const { key, modifier, combo, arrow, toggle } = definition;
    const label = displayLabel(key, definition.label);
    const activeToggle =
      toggle &&
      ((key === 'CtrlExpand' && this.showCtrlKeys) ||
        (key === 'F' && this.showFunctionKeys) ||
        (key === 'Symbols' && this.showSymbolKeys));
    const activeModifier = modifier && isStickyModifier(key) && this.activeModifiers.has(key);
    const lockedModifier = activeModifier && this.lockedModifiers.has(key);
    const repeatable = isRepeatableKey(key);

    return html`
      <button
        type="button"
        tabindex="-1"
        class="quick-key-btn ${this.getButtonFontClass(label)} min-w-0 ${this.getButtonSizeClass(label)} bg-bg-tertiary text-primary font-mono rounded border border-border hover:bg-surface hover:border-primary transition-all whitespace-nowrap ${modifier ? 'modifier-key' : ''} ${combo ? 'combo-key' : ''} ${arrow ? 'arrow-key' : ''} ${toggle ? 'toggle-key' : ''} ${activeToggle || activeModifier ? 'active' : ''} ${lockedModifier ? 'locked' : ''}"
        aria-pressed=${
          modifier && (this.compact ? isStickyModifier(key) : key === 'Option')
            ? String(Boolean(activeModifier))
            : nothing
        }
        aria-expanded=${toggle ? String(Boolean(activeToggle)) : nothing}
        aria-label=${
          activeModifier
            ? t(lockedModifier ? 'quickKeys.modifier.locked' : 'quickKeys.modifier.once', {
                key: getQuickKeyAriaLabel(key) ?? label,
              })
            : (getQuickKeyAriaLabel(key) ?? nothing)
        }
        data-key=${key}
        ?data-modifier=${modifier}
        ?data-combo=${combo}
        ?data-arrow=${arrow}
        ?data-toggle=${toggle}
        @mousedown=${(event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          if (
            repeatable &&
            event.button === 0 &&
            Date.now() - this.lastTouchAt > SYNTHETIC_MOUSE_WINDOW_MS
          ) {
            this.startKeyRepeat(key);
          }
        }}
        @mouseup=${() => {
          if (repeatable) this.stopKeyRepeat();
        }}
        @mouseleave=${() => {
          if (repeatable) this.stopKeyRepeat();
        }}
        @touchend=${(event: TouchEvent) => {
          // A quick tap on a repeatable key presses it once on release; after a hold the
          // repeat already pressed it, so releasing only stops it.
          const heldDown = repeatable && this.repeatPressed;
          if (repeatable) {
            this.stopKeyRepeat();
          }
          this.handleTouchEnd(event, () => {
            if (repeatable) {
              if (!heldDown) this.handleKeyPress(key);
            } else if (key === 'Paste') {
              this.handlePasteImmediate(event);
            } else {
              this.handleKeyPress(key, Boolean(modifier || combo), false, Boolean(toggle), event);
            }
          });
        }}
        @touchcancel=${() => {
          if (repeatable) {
            this.stopKeyRepeat();
          }
        }}
        @click=${(event: MouseEvent) => {
          if (event.detail !== 0 && !repeatable) {
            this.handleKeyPress(key, Boolean(modifier || combo), false, Boolean(toggle), event);
          }
        }}
      >
        ${label}
      </button>
    `;
  }

  private renderAuxiliaryKey(definition: {
    key: string;
    label: string;
    combo?: boolean;
    special?: boolean;
    func?: boolean;
  }) {
    const { key, label, combo, special, func } = definition;

    return html`
      <button
        type="button"
        tabindex="-1"
        aria-label=${getQuickKeyAriaLabel(key) ?? nothing}
        class="${func ? 'func-key-btn' : 'ctrl-shortcut-btn'} ${this.getButtonFontClass(label)} min-w-0 ${this.getButtonSizeClass(label)} bg-bg-tertiary text-primary font-mono rounded border border-border hover:bg-surface hover:border-primary transition-all whitespace-nowrap ${combo ? 'combo-key' : ''} ${special ? 'special-key' : ''}"
        data-key=${key}
        ?data-combo=${combo}
        ?data-special=${special}
        @mousedown=${(event: Event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        @touchend=${(event: TouchEvent) => {
          this.handleTouchEnd(event, () => {
            this.handleKeyPress(key, false, Boolean(special), false, event);
          });
        }}
        @click=${(event: MouseEvent) => {
          if (event.detail !== 0) {
            this.handleKeyPress(key, false, Boolean(special), false, event);
          }
        }}
      >
        ${label}
      </button>
    `;
  }

  private renderDoneButton() {
    const doneLabel = t('quickKeys.done');
    return html`
      <button
        type="button"
        tabindex="-1"
        class="quick-key-btn ${this.getButtonFontClass(doneLabel)} min-w-0 ${this.getButtonSizeClass(doneLabel)} bg-bg-tertiary text-primary font-mono rounded border border-border hover:bg-surface hover:border-primary transition-all whitespace-nowrap special-key"
        data-key=${DONE_BUTTON.key}
        data-special
        @mousedown=${(event: Event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        @touchend=${(event: TouchEvent) => {
          this.handleTouchEnd(event, () => {
            this.handleKeyPress(DONE_BUTTON.key, false, true, false, event);
          });
        }}
        @click=${(event: MouseEvent) => {
          if (event.detail !== 0) {
            this.handleKeyPress(DONE_BUTTON.key, false, true, false, event);
          }
        }}
      >
        ${doneLabel}
      </button>
    `;
  }

  private renderStyles() {
    return html`
      <style>
        
        /* Quick keys container - fixed above keyboard */
        .terminal-quick-keys-container {
          /* position, bottom, left, right are set inline with !important */
          z-index: ${Z_INDEX.TERMINAL_QUICK_KEYS};
          background-color: color-mix(in srgb, var(--color-bg-secondary) 98%, transparent);
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          width: 100%;
          max-width: 100%;
          padding-left: 0;
          padding-right: 0;
          margin-left: 0;
          margin-right: 0;
          box-sizing: border-box;
          /* Prevent overscroll and bouncing */
          overscroll-behavior: none;
          -webkit-overflow-scrolling: auto;
          /* Allow touch events to pass through for scrolling terminal content */
          pointer-events: none;
          /* NO transform, will-change, or contain properties that break position:fixed */
        }
        
        /* The actual bar with buttons */
        .quick-keys-bar {
          background: transparent;
          border-top: 1px solid color-mix(in srgb, var(--color-border) 50%, transparent);
          padding: 0.25rem 0;
          width: 100%;
          box-sizing: border-box;
          overflow: hidden;
          /* Re-enable pointer events for the button bar */
          pointer-events: auto;
        }

        /* Compact layout: the bar is a cursor trackpad (horizontal swipe); this also stops
           double-tap zoom when double tapping Ctrl or ⌥ to lock them */
        .quick-keys-bar.compact {
          touch-action: none;
        }

        /* Button rows - ensure full width */
        .quick-keys-bar > div {
          width: 100%;
          padding-left: 0.125rem;
          padding-right: 0.125rem;
        }

        /* Quick key buttons */
        .quick-key-btn {
          outline: none !important;
          -webkit-tap-highlight-color: transparent;
          user-select: none;
          -webkit-user-select: none;
          flex: 1 1 0;
          min-width: 0;
          /* Ensure buttons are interactive */
          pointer-events: auto;
        }
        
        /* Modifier key styling */
        .modifier-key {
          background-color: var(--color-bg-tertiary);
          border-color: var(--color-border);
        }
        
        
        /* Active modifier styling */
        .modifier-key.active {
          background-color: var(--color-primary);
          border-color: var(--color-primary);
          color: var(--color-text-bright);
        }
        

        /* Locked modifier (double tap): stays on until tapped again */
        .modifier-key.active.locked {
          box-shadow: inset 0 -3px 0 var(--color-text-bright);
          text-decoration: underline;
          text-underline-offset: 3px;
        }
        
        /* Arrow key styling */
        .arrow-key {
          font-size: 1rem;
        }
        
        /* Medium font for short character buttons */
        .quick-key-btn-medium {
          font-size: 13px;
        }
        
        /* Small font for mobile keyboard buttons */
        .quick-key-btn-small {
          font-size: 10px;
        }
        
        /* Extra small font for long text buttons */
        .quick-key-btn-xs {
          font-size: 8px;
        }
        
        /* Combo key styling (like ^C, ^Z) */
        .combo-key {
          background-color: var(--color-bg-tertiary);
          border-color: var(--color-primary);
        }
        
        
        /* Special key styling (like ABC) */
        .special-key {
          background-color: var(--color-primary);
          border-color: var(--color-primary);
          color: var(--color-text-bright);
        }
        
        
        /* Function key styling */
        .func-key-btn {
          outline: none !important;
          -webkit-tap-highlight-color: transparent;
          user-select: none;
          -webkit-user-select: none;
          flex: 1 1 0;
          min-width: 0;
        }
        
        /* Scrollable row styling */
        .scrollable-row {
          overflow-x: auto;
          -webkit-overflow-scrolling: touch;
          scroll-behavior: smooth;
        }
        
        /* Hide scrollbar but keep functionality */
        .scrollable-row::-webkit-scrollbar {
          display: none;
        }
        
        .scrollable-row {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
        
        /* Toggle button styling */
        .toggle-key {
          background-color: var(--color-bg-secondary);
          border-color: var(--color-primary);
        }
        
        
        .toggle-key.active {
          background-color: var(--color-primary);
          border-color: var(--color-primary);
          color: var(--color-text-bright);
        }
        
        
        /* Ctrl shortcut button styling */
        .ctrl-shortcut-btn {
          outline: none !important;
          -webkit-tap-highlight-color: transparent;
          user-select: none;
          -webkit-user-select: none;
          flex: 1 1 0;
          min-width: 0;
        }

        /* Hover styles only where hover exists: on iOS a tapped key kept its hover look */
        @media (hover: hover) {
          .modifier-key:hover {
            background-color: var(--color-bg-secondary);
          }

          .modifier-key.active:hover {
            background-color: var(--color-primary-hover);
          }

          .combo-key:hover {
            background-color: var(--color-bg-secondary);
          }

          .special-key:hover {
            background-color: var(--color-primary-hover);
          }

          .toggle-key:hover {
            background-color: var(--color-bg-tertiary);
          }

          .toggle-key.active:hover {
            background-color: var(--color-primary-hover);
          }
        }

        /* Press feedback: iOS shows no :active state on these buttons */
        .quick-key-btn.pressed,
        .ctrl-shortcut-btn.pressed,
        .func-key-btn.pressed {
          transform: scale(0.92);
          filter: brightness(1.3);
          border-color: var(--color-primary);
          transition: none;
        }
      </style>
    `;
  }

  render() {
    if (!this.visible) return '';

    const rows = this.getQuickKeyRows();

    return html`
      <div
        class="terminal-quick-keys-container"
        dir="ltr"
        style="position: fixed !important; bottom: var(--keyboard-offset, 0px) !important; left: 0 !important; right: 0 !important;"
      >
        <div class="quick-keys-bar ${this.compact ? 'compact' : ''}">
          <div class="flex gap-0.5 mb-0.5">${rows[0].map((key) => this.renderQuickKey(key))}</div>

          ${
            this.showCtrlKeys
              ? html`
              <div class="flex gap-0.5 ${rows.length > 2 ? 'mb-0.5' : ''}">
                ${CTRL_SHORTCUTS.map((key) => this.renderAuxiliaryKey(key))}
                ${this.renderExpandedToggle(rows, 'CtrlExpand')}
                ${this.renderDoneButton()}
              </div>
            `
              : this.showSymbolKeys
                ? html`
              <div class="flex gap-0.5 ${rows.length > 2 ? 'mb-0.5' : ''}">
                ${SYMBOL_QUICK_KEYS.map((key) => this.renderQuickKey(getQuickKeyDefinition(key)))}
                ${this.renderExpandedToggle(rows, 'Symbols')}
                ${this.renderDoneButton()}
              </div>
            `
                : this.showFunctionKeys
                  ? html`
              <div class="flex gap-0.5 ${rows.length > 2 ? 'mb-0.5' : ''}">
                ${FUNCTION_KEYS.map((key) => this.renderAuxiliaryKey(key))}
                ${this.renderExpandedToggle(rows, 'F')}
                ${this.renderDoneButton()}
              </div>
            `
                  : html`
              <div class="flex gap-0.5 ${rows.length > 2 ? 'mb-0.5' : ''}">
                ${rows[1].map((key) => this.renderQuickKey(key))}
                ${this.renderDoneButton()}
              </div>
            `
          }

          ${rows.slice(2).map(
            (row) => html`
              <div class="flex gap-0.5">${row.map((key) => this.renderQuickKey(key))}</div>
            `
          )}
        </div>
      </div>
      ${this.renderStyles()}
    `;
  }
}
