/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../shared/types.js';
import { terminalSocketClient } from '../../services/terminal-socket-client.js';
import {
  KEYBOARD_RESIZE_DEBOUNCE_MS,
  TerminalLifecycleManager,
} from './terminal-lifecycle-manager.js';

const resizeEvent = (cols: number, rows: number, isHeightOnlyChange: boolean) =>
  new CustomEvent('terminal-resize', {
    detail: { cols, rows, isMobile: true, isHeightOnlyChange, source: 'test' },
  });

describe('TerminalLifecycleManager resize forwarding on mobile', () => {
  let manager: TerminalLifecycleManager;
  let resize: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    resize = vi.spyOn(terminalSocketClient, 'resize').mockReturnValue(true);
    manager = new TerminalLifecycleManager();
    manager.setSession({ id: 's1', status: 'running' } as Session);
  });

  afterEach(() => {
    resize.mockRestore();
    vi.useRealTimers();
  });

  it('forwards keyboard-driven height changes so the PTY matches the visible rows', async () => {
    await manager.handleTerminalResize(resizeEvent(48, 46, false));
    await vi.runAllTimersAsync();
    await manager.handleTerminalResize(resizeEvent(48, 16, true));
    await vi.runAllTimersAsync();

    expect(resize.mock.calls).toEqual([
      ['s1', 48, 46],
      ['s1', 48, 16],
    ]);
  });

  it('forces a repaint when the terminal shrinks and returns to the size the PTY already has', async () => {
    await manager.handleTerminalResize(resizeEvent(48, 46, false));
    await vi.runAllTimersAsync();
    resize.mockClear();

    // Keyboard shown and hidden within one debounce window.
    await manager.handleTerminalResize(resizeEvent(48, 16, true));
    await manager.handleTerminalResize(resizeEvent(48, 46, true));
    await vi.runAllTimersAsync();

    expect(resize.mock.calls).toEqual([
      ['s1', 48, 45],
      ['s1', 48, 46],
    ]);
  });

  it('sends a keyboard resize once, 150 ms after the last of its changes', async () => {
    await manager.handleTerminalResize(resizeEvent(48, 16, false));
    await vi.runAllTimersAsync();
    resize.mockClear();

    // The keyboard going down in steps: each new size restarts the wait.
    await manager.handleTerminalResize(resizeEvent(48, 30, true));
    await vi.advanceTimersByTimeAsync(KEYBOARD_RESIZE_DEBOUNCE_MS - 10);
    await manager.handleTerminalResize(resizeEvent(48, 46, true));
    await vi.advanceTimersByTimeAsync(KEYBOARD_RESIZE_DEBOUNCE_MS - 1);
    expect(resize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(KEYBOARD_RESIZE_DEBOUNCE_MS).toBe(150);
    expect(resize.mock.calls).toEqual([['s1', 48, 46]]);
  });

  it('waits for the visual viewport to stop moving before the app redraws', async () => {
    const viewport = new EventTarget();
    vi.stubGlobal('visualViewport', viewport);
    try {
      await manager.handleTerminalResize(resizeEvent(48, 16, false));
      await vi.runAllTimersAsync();
      resize.mockClear();

      // The rows changed with the keyboard's first viewport resize; it is still animating.
      await manager.handleTerminalResize(resizeEvent(48, 46, true));
      await vi.advanceTimersByTimeAsync(100);
      viewport.dispatchEvent(new Event('resize'));
      await vi.advanceTimersByTimeAsync(100);
      viewport.dispatchEvent(new Event('resize'));
      await vi.advanceTimersByTimeAsync(KEYBOARD_RESIZE_DEBOUNCE_MS - 1);
      expect(resize).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(resize.mock.calls).toEqual([['s1', 48, 46]]);

      // Once sent, a later viewport change sends nothing more.
      viewport.dispatchEvent(new Event('resize'));
      await vi.runAllTimersAsync();
      expect(resize).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not resend an unchanged size', async () => {
    await manager.handleTerminalResize(resizeEvent(48, 46, false));
    await vi.runAllTimersAsync();
    resize.mockClear();

    await manager.handleTerminalResize(resizeEvent(48, 46, true));
    await vi.runAllTimersAsync();

    expect(resize).not.toHaveBeenCalled();
  });
});
