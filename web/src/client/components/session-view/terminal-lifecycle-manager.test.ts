/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../shared/types.js';
import { terminalSocketClient } from '../../services/terminal-socket-client.js';
import { TerminalLifecycleManager } from './terminal-lifecycle-manager.js';

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

  it('does not resend an unchanged size', async () => {
    await manager.handleTerminalResize(resizeEvent(48, 46, false));
    await vi.runAllTimersAsync();
    resize.mockClear();

    await manager.handleTerminalResize(resizeEvent(48, 46, true));
    await vi.runAllTimersAsync();

    expect(resize).not.toHaveBeenCalled();
  });
});
