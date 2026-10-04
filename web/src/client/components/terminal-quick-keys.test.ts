// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';
import { setLocale } from '../i18n/index.js';
import {
  QUICK_KEY_GAP_PX,
  QUICK_KEY_ROW_INSET_PX,
  quickKeyMinWidth,
  quickKeyRowSizing,
} from '../utils/quick-key-sizing.js';
import {
  COMPACT_QUICK_KEYS_LAYOUT,
  DEFAULT_QUICK_KEYS_LAYOUT,
  DIRECT_KEYBOARD_INPUT_ATTRIBUTE,
  PHONE_QUICK_KEYS_LAYOUT,
  SYMBOL_QUICK_KEYS,
  saveQuickKeysLayout,
} from '../utils/quick-keys-layout.js';
import { TerminalQuickKeys } from './terminal-quick-keys.js';

type OnKeyPress = NonNullable<TerminalQuickKeys['onKeyPress']>;

// Define interface for private methods we need to test
interface TerminalQuickKeysPrivate extends TerminalQuickKeys {
  handleKeyPress(
    key: string,
    isModifier?: boolean,
    isSpecial?: boolean,
    isToggle?: boolean,
    event?: Event
  ): void;
  activeModifiers: Set<string>;
  isLandscape: boolean;
}

describe('TerminalQuickKeys', () => {
  let component: TerminalQuickKeysPrivate;
  let mockOnKeyPress: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setupLocalStorageMock();
    component = new TerminalQuickKeys() as TerminalQuickKeysPrivate;
    mockOnKeyPress = vi.fn();
    component.onKeyPress = mockOnKeyPress;
    component.visible = true;
  });

  afterEach(() => {
    component.remove();
    restoreLocalStorage();
  });

  describe('Option key chord system', () => {
    it('should toggle Option modifier state when pressed', () => {
      // Press Option key
      component.handleKeyPress('Option', true, false, false);

      // Option should be in active modifiers
      expect(component.activeModifiers.has('Option')).toBe(true);

      // Should not send Option key immediately
      expect(mockOnKeyPress).not.toHaveBeenCalled();
    });

    it('should clear Option modifier when pressed twice', () => {
      // Press Option key twice
      component.handleKeyPress('Option', true, false, false);
      component.handleKeyPress('Option', true, false, false);

      // Option should not be in active modifiers
      expect(component.activeModifiers.has('Option')).toBe(false);

      // Should not send any keys
      expect(mockOnKeyPress).not.toHaveBeenCalled();
    });

    it('should send Option+Arrow combination when arrow pressed after Option', () => {
      // Press Option first
      component.handleKeyPress('Option', true, false, false);

      // Then press ArrowLeft
      component.handleKeyPress('ArrowLeft', false, false, false);

      // Should have sent Option (ESC) first, then ArrowLeft
      expect(mockOnKeyPress).toHaveBeenCalledTimes(2);
      expect(mockOnKeyPress).toHaveBeenNthCalledWith(1, 'Option', true, false);
      expect(mockOnKeyPress).toHaveBeenNthCalledWith(2, 'ArrowLeft', false, false);

      // Option modifier should be cleared
      expect(component.activeModifiers.has('Option')).toBe(false);
    });

    it('should work with all arrow keys', () => {
      const arrowKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

      arrowKeys.forEach((arrow) => {
        mockOnKeyPress.mockClear();

        // Press Option first
        component.handleKeyPress('Option', true, false, false);

        // Then press arrow key
        component.handleKeyPress(arrow, false, false, false);

        // Should have sent Option+Arrow combination
        expect(mockOnKeyPress).toHaveBeenCalledTimes(2);
        expect(mockOnKeyPress).toHaveBeenNthCalledWith(1, 'Option', true, false);
        expect(mockOnKeyPress).toHaveBeenNthCalledWith(2, arrow, false, false);
      });
    });

    it('should clear Option modifier when non-arrow key is pressed', () => {
      // Press Option first
      component.handleKeyPress('Option', true, false, false);

      // Then press a non-arrow key
      component.handleKeyPress('a', false, false, false);

      // Should have cleared Option modifier
      expect(component.activeModifiers.has('Option')).toBe(false);

      // Should have sent only the 'a' key
      expect(mockOnKeyPress).toHaveBeenCalledOnce();
      expect(mockOnKeyPress).toHaveBeenCalledWith('a', false, false, false);
    });

    it('should handle multiple Option+Arrow sequences', () => {
      // First sequence: Option+ArrowLeft
      component.handleKeyPress('Option', true, false, false);
      component.handleKeyPress('ArrowLeft', false, false, false);

      expect(mockOnKeyPress).toHaveBeenCalledTimes(2);

      mockOnKeyPress.mockClear();

      // Second sequence: Option+ArrowRight
      component.handleKeyPress('Option', true, false, false);
      component.handleKeyPress('ArrowRight', false, false, false);

      expect(mockOnKeyPress).toHaveBeenCalledTimes(2);
      expect(mockOnKeyPress).toHaveBeenNthCalledWith(1, 'Option', true, false);
      expect(mockOnKeyPress).toHaveBeenNthCalledWith(2, 'ArrowRight', false, false);
    });
  });

  describe('Visual state updates', () => {
    it('should request update when Option modifier changes', () => {
      const requestUpdateSpy = vi.spyOn(component, 'requestUpdate');

      // Press Option
      component.handleKeyPress('Option', true, false, false);
      expect(requestUpdateSpy).toHaveBeenCalled();

      requestUpdateSpy.mockClear();

      // Press Option again to toggle off
      component.handleKeyPress('Option', true, false, false);
      expect(requestUpdateSpy).toHaveBeenCalled();
    });

    it('should request update when chord is completed', () => {
      const requestUpdateSpy = vi.spyOn(component, 'requestUpdate');

      // Press Option
      component.handleKeyPress('Option', true, false, false);
      requestUpdateSpy.mockClear();

      // Press ArrowLeft
      component.handleKeyPress('ArrowLeft', false, false, false);
      expect(requestUpdateSpy).toHaveBeenCalled();
    });

    it('notifies the parent when expanded quick-key rows change', async () => {
      const layoutChangeSpy = vi.fn();
      component.addEventListener('quick-keys-layout-change', layoutChangeSpy);
      document.body.append(component);
      await component.updateComplete;
      layoutChangeSpy.mockClear();

      component.handleKeyPress('CtrlExpand', false, false, true);
      await component.updateComplete;

      expect(layoutChangeSpy).toHaveBeenCalledOnce();
      component.remove();
    });
  });

  describe('Touch target sizing', () => {
    const realWidth = window.innerWidth;
    const setViewportWidth = (value: number) => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value });
      window.dispatchEvent(new Event('resize'));
    };

    afterEach(async () => {
      setViewportWidth(realWidth);
      await setLocale('en');
    });

    const renderedRows = () =>
      Array.from(component.querySelectorAll<HTMLElement>('.quick-keys-bar > div')).map((row) =>
        Array.from(row.querySelectorAll<HTMLButtonElement>('button'))
      );

    it('keeps the roomy portrait padding on a short row and the tighter one in landscape', async () => {
      saveQuickKeysLayout([
        ['Escape', 'Control', 'Tab', 'ArrowUp', 'ArrowDown'],
        ['Home', 'End'],
      ]);
      document.body.append(component);
      component.isLandscape = false;
      await component.updateComplete;
      const arrowKey = () => component.querySelector<HTMLButtonElement>('[data-key="ArrowUp"]');
      expect(arrowKey()?.className).toContain('px-1.5 py-2.5');

      component.isLandscape = true;
      await component.updateComplete;
      expect(arrowKey()?.className).toContain('px-1 py-2');
    });

    // A 375 pt phone gave the translated 12-key second row 29 px keys with 6 px padding a
    // side, so the longer labels spilled out of their keys.
    it.each([
      320, 375, 440,
    ])('gives every key of the 12-key Spanish phone row at least its label width at %i pt', async (width) => {
      await setLocale('es');
      setViewportWidth(width);
      saveQuickKeysLayout(PHONE_QUICK_KEYS_LAYOUT);
      document.body.append(component);
      await component.updateComplete;

      const secondRow = renderedRows()[1];
      expect(secondRow.map((button) => button.textContent?.trim())).toEqual([
        'Pegar',
        '/',
        '@',
        '!',
        '-',
        '|',
        '~',
        'Inicio',
        'Fin',
        'Del',
        '↵',
        'Listo',
      ]);
      for (const button of secondRow) {
        expect(button.classList.contains('px-0.5')).toBe(true);
      }
      const labels = secondRow.map((button) => button.textContent?.trim() ?? '');
      // The labels' minimum widths, at the padding and font picked, add up to no more than the row.
      const { paddingPx, fontStep } = quickKeyRowSizing(labels, width);
      const needed = labels.reduce(
        (sum, label) => sum + quickKeyMinWidth(label, paddingPx, fontStep),
        0
      );
      expect(needed).toBeLessThanOrEqual(
        width - QUICK_KEY_ROW_INSET_PX - QUICK_KEY_GAP_PX * (labels.length - 1)
      );
    });

    it('sizes the expanded rows, Done included, to fit a 320 pt screen', async () => {
      setViewportWidth(320);
      saveQuickKeysLayout(DEFAULT_QUICK_KEYS_LAYOUT);
      document.body.append(component);
      await component.updateComplete;

      component.handleKeyPress('F', false, false, true);
      await component.updateComplete;
      const functionRow = renderedRows()[1];
      expect(functionRow).toHaveLength(13);
      // 13 keys at 22 px: only 1 px of padding a side leaves room for "F10" and "Done".
      for (const button of functionRow) {
        expect(button.classList.contains('px-px')).toBe(true);
      }
    });
  });

  describe('custom layouts', () => {
    it('keeps the existing three-row layout as the default', async () => {
      document.body.append(component);
      await component.updateComplete;

      const renderedKeys = Array.from(component.querySelectorAll<HTMLElement>('[data-key]')).map(
        (element) => element.dataset.key
      );

      expect(renderedKeys).toEqual([
        ...DEFAULT_QUICK_KEYS_LAYOUT[0],
        ...DEFAULT_QUICK_KEYS_LAYOUT[1],
        'Done',
        ...DEFAULT_QUICK_KEYS_LAYOUT[2],
      ]);
      component.remove();
    });

    it('updates an open keyboard when a valid layout is saved', async () => {
      document.body.append(component);
      await component.updateComplete;

      expect(saveQuickKeysLayout(COMPACT_QUICK_KEYS_LAYOUT)).toBe(true);
      await component.updateComplete;

      const renderedKeys = Array.from(component.querySelectorAll<HTMLElement>('[data-key]')).map(
        (element) => element.dataset.key
      );

      expect(renderedKeys).toEqual([
        ...COMPACT_QUICK_KEYS_LAYOUT[0],
        ...COMPACT_QUICK_KEYS_LAYOUT[1],
        'Done',
      ]);
      expect(component.querySelectorAll('[data-key="Done"]')).toHaveLength(1);
      expect(component.querySelector('[data-key="ArrowUp"]')?.classList.contains('arrow-key')).toBe(
        true
      );
      component.remove();
    });

    it.each([
      ['CtrlExpand', 'Ctrl+D'],
      ['F', 'F1'],
    ] as const)('keeps the %s toggle reachable when row 2 is expanded', async (toggle, expandedKey) => {
      expect(
        saveQuickKeysLayout([
          ['Escape', 'Control', 'Tab'],
          [toggle, 'Home', 'Paste'],
        ])
      ).toBe(true);
      document.body.append(component);
      await component.updateComplete;

      component.handleKeyPress(toggle, false, false, true);
      await component.updateComplete;

      const collapseButton = component.querySelector<HTMLButtonElement>(`[data-key="${toggle}"]`);
      expect(collapseButton).not.toBeNull();
      expect(component.querySelector(`[data-key="${expandedKey}"]`)).not.toBeNull();

      collapseButton?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, composed: true, detail: 1 })
      );
      await component.updateComplete;

      expect(component.querySelector(`[data-key="${expandedKey}"]`)).toBeNull();
      expect(component.querySelector('[data-key="Home"]')).not.toBeNull();
      component.remove();
    });
  });
});

describe('TerminalQuickKeys press-and-hold repeat', () => {
  let component: TerminalQuickKeys;
  let onKeyPress: Mock<OnKeyPress>;

  const touch = (target: Element, type: string, x = 10, y = 10) => {
    const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
    Object.defineProperty(event, 'touches', { value: [{ clientX: x, clientY: y }] });
    target.dispatchEvent(event);
  };

  const pressesOf = (key: string) => onKeyPress.mock.calls.filter(([k]) => k === key).length;

  beforeEach(async () => {
    vi.useFakeTimers();
    setupLocalStorageMock();
    component = new TerminalQuickKeys();
    onKeyPress = vi.fn();
    component.onKeyPress = onKeyPress;
    component.visible = true;
    document.body.append(component);
    await component.updateComplete;
  });

  afterEach(() => {
    component.remove();
    restoreLocalStorage();
    vi.useRealTimers();
  });

  it.each(['ArrowLeft', 'Delete'])('repeats %s while held with the mouse', (key) => {
    const button = component.querySelector(`[data-key="${key}"]`) as HTMLElement;
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    expect(pressesOf(key)).toBe(1);

    vi.advanceTimersByTime(399);
    expect(pressesOf(key)).toBe(1);
    vi.advanceTimersByTime(1);
    expect(pressesOf(key)).toBe(2);
    vi.advanceTimersByTime(120);
    expect(pressesOf(key)).toBe(4);

    button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    vi.advanceTimersByTime(1000);
    expect(pressesOf(key)).toBe(4);
  });

  it('repeats Del while a finger holds it and stops on touchend', () => {
    const button = component.querySelector('[data-key="Delete"]') as HTMLElement;
    touch(button, 'touchstart');
    vi.advanceTimersByTime(400);
    expect(pressesOf('Delete')).toBe(1);

    vi.advanceTimersByTime(60);
    expect(pressesOf('Delete')).toBe(2);

    touch(button, 'touchend');
    // The mouse events iOS synthesizes after the touch must not press it again.
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    vi.advanceTimersByTime(1000);
    expect(pressesOf('Delete')).toBe(2);
  });

  it('presses an arrow once on a quick tap', () => {
    const button = component.querySelector('[data-key="ArrowUp"]') as HTMLElement;
    touch(button, 'touchstart');
    vi.advanceTimersByTime(100);
    touch(button, 'touchend');
    vi.advanceTimersByTime(1000);
    expect(pressesOf('ArrowUp')).toBe(1);
  });

  it('applies an armed Option to the first press and every repeat', () => {
    const option = component.querySelector('[data-key="Option"]') as HTMLElement;
    option.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    const arrow = component.querySelector('[data-key="ArrowLeft"]') as HTMLElement;
    touch(arrow, 'touchstart');
    vi.advanceTimersByTime(460);
    touch(arrow, 'touchend');

    expect(onKeyPress.mock.calls.map(([k]) => k)).toEqual([
      'Option',
      'ArrowLeft',
      'Option',
      'ArrowLeft',
    ]);
  });
});

describe('TerminalQuickKeys swipe trackpad (compact layout)', () => {
  let component: TerminalQuickKeys;
  let onKeyPress: Mock<OnKeyPress>;

  const touch = (target: Element, type: string, x: number, y = 10) => {
    const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
    Object.defineProperty(event, 'touches', {
      value: type === 'touchend' ? [] : [{ clientX: x, clientY: y }],
    });
    target.dispatchEvent(event);
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    setupLocalStorageMock();
    component = new TerminalQuickKeys();
    onKeyPress = vi.fn();
    component.onKeyPress = onKeyPress;
    component.visible = true;
    component.compact = true;
    document.body.append(component);
    await component.updateComplete;
  });

  afterEach(() => {
    component.remove();
    restoreLocalStorage();
    vi.useRealTimers();
  });

  it('moves the cursor one step per 16px of horizontal swipe, both ways', () => {
    const home = component.querySelector('[data-key="Home"]') as HTMLElement;
    touch(home, 'touchstart', 100);
    touch(home, 'touchmove', 150, 14);
    expect(onKeyPress.mock.calls.map(([k]) => k)).toEqual([
      'ArrowRight',
      'ArrowRight',
      'ArrowRight',
    ]);

    onKeyPress.mockClear();
    touch(home, 'touchmove', 60, 14);
    touch(home, 'touchend', 60);
    expect(onKeyPress.mock.calls.map(([k]) => k)).toEqual([
      'ArrowLeft',
      'ArrowLeft',
      'ArrowLeft',
      'ArrowLeft',
      'ArrowLeft',
    ]);
  });

  it('does not press Del when a swipe starts on it', () => {
    const del = component.querySelector('[data-key="Delete"]') as HTMLElement;
    touch(del, 'touchstart', 100);
    touch(del, 'touchmove', 80);
    vi.advanceTimersByTime(1000);
    touch(del, 'touchend', 80);
    expect(onKeyPress.mock.calls.map(([k]) => k)).toEqual(['ArrowLeft']);
  });

  it('highlights the key under the finger until it lifts or starts a swipe', () => {
    const home = component.querySelector('[data-key="Home"]') as HTMLElement;
    touch(home, 'touchstart', 100);
    expect(home.classList.contains('pressed')).toBe(true);
    touch(home, 'touchend', 100);
    expect(home.classList.contains('pressed')).toBe(false);
    expect(onKeyPress).toHaveBeenCalledWith('Home', false, false, false);

    touch(home, 'touchstart', 100);
    touch(home, 'touchmove', 130);
    expect(home.classList.contains('pressed')).toBe(false);
  });

  it('ignores mostly vertical moves', () => {
    const home = component.querySelector('[data-key="Home"]') as HTMLElement;
    touch(home, 'touchstart', 100, 10);
    touch(home, 'touchmove', 120, 60);
    expect(onKeyPress).not.toHaveBeenCalled();
  });
});

describe('TerminalQuickKeys sticky Ctrl and Option (compact layout)', () => {
  let component: TerminalQuickKeys;
  let onKeyPress: Mock<OnKeyPress>;
  let hiddenInput: HTMLTextAreaElement;

  const tap = (key: string) =>
    (component.querySelector(`[data-key="${key}"]`) as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, detail: 1 })
    );

  /** Simulates the iOS keyboard typing one character into the hidden input. */
  const type = (data: string) => {
    const event = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data,
    });
    hiddenInput.dispatchEvent(event);
    return event;
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    setupLocalStorageMock();
    component = new TerminalQuickKeys();
    onKeyPress = vi.fn();
    component.onKeyPress = onKeyPress;
    component.visible = true;
    component.compact = true;
    document.body.append(component);
    hiddenInput = document.createElement('textarea');
    hiddenInput.setAttribute(DIRECT_KEYBOARD_INPUT_ATTRIBUTE, '');
    document.body.append(hiddenInput);
    await component.updateComplete;
  });

  afterEach(() => {
    component.remove();
    hiddenInput.remove();
    restoreLocalStorage();
    vi.useRealTimers();
  });

  it('turns the next letter typed on the soft keyboard into a Ctrl chord', async () => {
    tap('Control');
    await component.updateComplete;
    expect(onKeyPress).not.toHaveBeenCalled();
    const ctrl = component.querySelector('[data-key="Control"]') as HTMLElement;
    expect(ctrl.classList.contains('active')).toBe(true);
    expect(ctrl.getAttribute('aria-pressed')).toBe('true');

    const event = type('c');
    expect(event.defaultPrevented).toBe(true);
    expect(onKeyPress).toHaveBeenCalledWith('Ctrl+C', true, false, false);

    // One-shot: the following letter is typed normally.
    await component.updateComplete;
    expect(ctrl.classList.contains('active')).toBe(false);
    expect(type('c').defaultPrevented).toBe(false);
    expect(onKeyPress).toHaveBeenCalledOnce();
  });

  it('locks Ctrl on a double tap until it is tapped again', async () => {
    tap('Control');
    vi.advanceTimersByTime(200);
    tap('Control');
    await component.updateComplete;
    const ctrl = component.querySelector('[data-key="Control"]') as HTMLElement;
    expect(ctrl.classList.contains('locked')).toBe(true);

    type('a');
    type('e');
    expect(onKeyPress.mock.calls.map(([k]) => k)).toEqual(['Ctrl+A', 'Ctrl+E']);

    vi.advanceTimersByTime(1000);
    tap('Control');
    await component.updateComplete;
    expect(ctrl.classList.contains('active')).toBe(false);
    expect(type('a').defaultPrevented).toBe(false);
  });

  it('sends Option with a typed letter as the ESC prefix', () => {
    tap('Option');
    type('b');
    expect(onKeyPress.mock.calls.map(([k]) => k)).toEqual(['Option', 'b']);
  });

  it('never sends the bare Ctrl key to the terminal', () => {
    tap('Control');
    vi.advanceTimersByTime(1000);
    tap('Control');
    expect(onKeyPress).not.toHaveBeenCalled();
  });
});

describe('TerminalQuickKeys symbols row', () => {
  let component: TerminalQuickKeys;
  let onKeyPress: Mock<OnKeyPress>;

  beforeEach(async () => {
    setupLocalStorageMock();
    saveQuickKeysLayout([
      ['Escape', 'Symbols', 'Ctrl+C', 'Tab'],
      ['Paste', 'Home', 'End', 'Delete'],
    ]);
    component = new TerminalQuickKeys();
    onKeyPress = vi.fn();
    component.onKeyPress = onKeyPress;
    component.visible = true;
    document.body.append(component);
    await component.updateComplete;
  });

  afterEach(() => {
    component.remove();
    restoreLocalStorage();
  });

  const click = (key: string) =>
    (component.querySelector(`[data-key="${key}"]`) as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, detail: 1 })
    );

  it('swaps shell symbols into the second row and keeps them open while typing', async () => {
    const toggle = component.querySelector('[data-key="Symbols"]') as HTMLElement;
    expect(toggle.getAttribute('aria-label')).toBe('Symbols');
    expect(component.querySelector('[data-key=">"]')).toBeNull();

    click('Symbols');
    await component.updateComplete;
    for (const symbol of SYMBOL_QUICK_KEYS) {
      expect(component.querySelector(`[data-key="${CSS.escape(symbol)}"]`)).not.toBeNull();
    }
    expect(component.querySelector('[data-key="Paste"]')).toBeNull();

    click('>');
    click('&');
    await component.updateComplete;
    expect(onKeyPress.mock.calls.map(([k]) => k)).toEqual(['>', '&']);
    expect(component.querySelector('[data-key=">"]')).not.toBeNull();

    click('Symbols');
    await component.updateComplete;
    expect(component.querySelector('[data-key=">"]')).toBeNull();
    expect(component.querySelector('[data-key="Paste"]')).not.toBeNull();
  });
  it('names glyph keys for VoiceOver and says whether a row toggle is open, without taking focus', async () => {
    const symbols = () => component.querySelector('[data-key="Symbols"]') as HTMLElement;
    expect(symbols().getAttribute('aria-expanded')).toBe('false');
    click('Symbols');
    await component.updateComplete;
    expect(symbols().getAttribute('aria-expanded')).toBe('true');
    expect(component.querySelector('[data-key="Ctrl+C"]')?.getAttribute('aria-label')).toBe(
      'Control C'
    );
    // Quick keys sit over the soft keyboard: none may ever become a focus target.
    for (const button of component.querySelectorAll('button')) {
      expect(button.getAttribute('tabindex')).toBe('-1');
    }
  });
});

describe('TerminalQuickKeys default layout keeps the classic modifiers', () => {
  let component: TerminalQuickKeys;
  let onKeyPress: Mock<OnKeyPress>;

  beforeEach(async () => {
    setupLocalStorageMock();
    component = new TerminalQuickKeys();
    onKeyPress = vi.fn();
    component.onKeyPress = onKeyPress;
    component.visible = true;
    document.body.append(component);
    await component.updateComplete;
  });

  afterEach(() => {
    component.remove();
    restoreLocalStorage();
  });

  it('sends Ctrl to the session instead of arming it', () => {
    (component.querySelector('[data-key="Control"]') as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, detail: 1 })
    );
    expect(onKeyPress).toHaveBeenCalledWith('Control', true, false, false);
  });

  it('does not turn a sideways swipe into cursor keys', () => {
    const home = component.querySelector('[data-key="Home"]') as HTMLElement;
    const touch = (type: string, x: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
      Object.defineProperty(event, 'touches', { value: [{ clientX: x, clientY: 10 }] });
      home.dispatchEvent(event);
    };
    touch('touchstart', 100);
    touch('touchmove', 160);
    expect(onKeyPress).not.toHaveBeenCalled();
  });
});
