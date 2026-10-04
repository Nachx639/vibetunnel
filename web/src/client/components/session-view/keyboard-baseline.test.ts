/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { estimateKeyboardHeight, LifecycleEventManager } from './lifecycle-event-manager.js';

describe('estimateKeyboardHeight', () => {
  it('reads Safari (innerHeight kept) and Chrome on iOS (innerHeight shrinks too)', () => {
    expect(estimateKeyboardHeight(874, 500, 874)).toBe(374);
    expect(estimateKeyboardHeight(500, 500, 874)).toBe(374);
    // Under 150 px: the browser's own bars collapsing, not a keyboard.
    expect(estimateKeyboardHeight(780, 780, 874)).toBe(0);
  });
});

describe('soft keyboard detection', () => {
  afterEach(() => vi.restoreAllMocks());

  const setup = () => {
    const viewport = Object.assign(new EventTarget(), { height: 894, width: 440, offsetTop: 0 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    let inner = 894;
    vi.spyOn(window, 'innerHeight', 'get').mockImplementation(() => inner);
    const calls: Record<string, ReturnType<typeof vi.fn>> = {};
    const callbacks = new Proxy(calls, {
      get: (target, name: string) => {
        target[name] ??= vi.fn();
        return target[name];
      },
    });
    const manager = new LifecycleEventManager();
    manager.setCallbacks(callbacks as never);
    (manager as unknown as { setupMobileFeatures(mobile: boolean): void }).setupMobileFeatures(
      true
    );
    const resize = (innerHeight: number, viewportHeight: number) => {
      inner = innerHeight;
      viewport.height = viewportHeight;
      viewport.dispatchEvent(new Event('resize'));
    };
    return { calls, resize };
  };

  it('sees the keyboard from the first viewport change after the session opens', () => {
    const { calls, resize } = setup();
    // The keyboard opens: innerHeight and the visual viewport shrink together (Chrome on iOS).
    resize(560, 560);
    expect(calls.setKeyboardHeight).toHaveBeenLastCalledWith(334);
  });

  it('leaves keyboard mode when the keyboard closes, not only the quick keys', () => {
    const { calls, resize } = setup();
    const keyboard = {
      getShowQuickKeys: () => true,
      isRecentlyEnteredKeyboardMode: () => false,
      exitKeyboardMode: vi.fn(),
    };
    calls.getDirectKeyboardManager = vi.fn(() => keyboard);

    resize(894, 500);
    resize(894, 894);

    expect(keyboard.exitKeyboardMode).toHaveBeenCalledOnce();
  });
});
