/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../shared/types.js';
import { terminalSocketClient } from '../../services/terminal-socket-client.js';
import { setPtySizeReclaimEnabled } from '../../utils/pty-size-reclaim.js';
import { TerminalLifecycleManager, takesBackPtySize } from './terminal-lifecycle-manager.js';

const resizeEvent = (cols: number, rows: number) =>
  new CustomEvent('terminal-resize', {
    detail: { cols, rows, isMobile: true, isHeightOnlyChange: false, source: 'test' },
  });

/** localStorage is a mock in the client tests: back it with a map for the preference. */
function useStorage() {
  const store = new Map<string, string>();
  vi.mocked(localStorage.getItem).mockImplementation((key: string) => store.get(key) ?? null);
  vi.mocked(localStorage.setItem).mockImplementation((key: string, value: string) => {
    store.set(key, String(value));
  });
}

async function managerAt45x33(session: Partial<Session> = { id: 's1', status: 'running' }) {
  const manager = new TerminalLifecycleManager();
  manager.setSession(session as Session);
  await manager.handleTerminalResize(resizeEvent(45, 33));
  await vi.runAllTimersAsync();
  manager.handlePtySize({ cols: 45, rows: 33 });
  return manager;
}

describe('TerminalLifecycleManager taking the PTY back from another client', () => {
  let resize: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    useStorage();
    resize = vi.spyOn(terminalSocketClient, 'resize').mockReturnValue(true);
  });

  afterEach(() => {
    resize.mockRestore();
    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.setItem).mockReset();
    vi.useRealTimers();
  });

  it('never sends its size again with the preference off (the default)', async () => {
    const manager = await managerAt45x33();
    resize.mockClear();
    manager.noteUserActivity();
    // Another client set 53x56 under this client's 45 columns.
    manager.handlePtySize({ cols: 53, rows: 56 });
    manager.noteUserActivity();
    await vi.runAllTimersAsync();
    expect(resize).not.toHaveBeenCalled();
  });

  describe('with "Take the terminal size back" on', () => {
    beforeEach(() => setPtySizeReclaimEnabled(true));

    it('sends its size again when another client resized the PTY while this one is in use', async () => {
      const manager = await managerAt45x33();
      resize.mockClear();
      manager.noteUserActivity();
      manager.handlePtySize({ cols: 53, rows: 56 });
      await vi.runAllTimersAsync();
      expect(resize.mock.calls).toEqual([['s1', 45, 33]]);

      // Its echo settles it; touches afterwards send nothing.
      manager.handlePtySize({ cols: 45, rows: 33 });
      manager.noteUserActivity();
      await vi.runAllTimersAsync();
      expect(resize.mock.calls).toEqual([['s1', 45, 33]]);
    });

    it('leaves the PTY to the other client until this one is used again', async () => {
      const manager = await managerAt45x33();
      resize.mockClear();
      manager.handlePtySize({ cols: 53, rows: 56 });
      await vi.runAllTimersAsync();
      expect(resize).not.toHaveBeenCalled();

      manager.noteUserActivity();
      await vi.runAllTimersAsync();
      expect(resize.mock.calls).toEqual([['s1', 45, 33]]);
    });

    it('does not ask again on every touch when the PTY keeps the other size', async () => {
      const manager = await managerAt45x33();
      resize.mockClear();
      manager.noteUserActivity();
      manager.handlePtySize({ cols: 53, rows: 56 });
      await vi.runAllTimersAsync();
      manager.noteUserActivity();
      await vi.runAllTimersAsync();
      manager.noteUserActivity();
      await vi.runAllTimersAsync();
      expect(resize).toHaveBeenCalledTimes(1);
    });

    it("never resizes a forwarded session's window back, however much it is used", async () => {
      const manager = await managerAt45x33({ id: 'fwd_1791029966_4242', status: 'running' });
      resize.mockClear();
      // The window was made wider; this client is touched right after.
      manager.handlePtySize({ cols: 53, rows: 56 });
      manager.noteUserActivity();
      await vi.runAllTimersAsync();
      expect(resize).not.toHaveBeenCalled();
    });
  });

  it('leaves the size of a forwarded session to its terminal window', () => {
    expect(takesBackPtySize({ id: 'ff005102-6d2f-43b2-99e2-925ee7e3c611' })).toBe(true);
    expect(takesBackPtySize({ id: 'fwd_1791029966_4242' })).toBe(false);
    expect(takesBackPtySize(null)).toBe(false);
  });
});
