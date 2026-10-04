/**
 * "Take the terminal size back" (app preference `reclaimPtySize`, off by default).
 *
 * A session's PTY has one size, the last one a client asked for. With it on, the client in use
 * sends its size again after another client resized the PTY (see
 * TerminalLifecycleManager.reclaimPtySize). Off, a client only sends its size when its own
 * terminal changes, as before.
 */
const PREFERENCES_KEY = 'vibetunnel_app_preferences';

export function isPtySizeReclaimEnabled(): boolean {
  try {
    const stored = localStorage.getItem(PREFERENCES_KEY);
    return Boolean(stored && JSON.parse(stored).reclaimPtySize === true);
  } catch {
    return false;
  }
}

export function setPtySizeReclaimEnabled(enabled: boolean): void {
  try {
    const stored = localStorage.getItem(PREFERENCES_KEY);
    const preferences = stored ? JSON.parse(stored) : {};
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ ...preferences, reclaimPtySize: enabled })
    );
  } catch {
    // Blocked storage: the choice is not kept.
  }
}
