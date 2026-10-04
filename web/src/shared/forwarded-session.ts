/**
 * A session started with `vt <command>` in a terminal window: the forwarder (vibetunnel-fwd)
 * runs the program there, in that window, and names the session `fwd_<time>_<pid>`. VibeTunnel
 * shows and controls it, but the program belongs to the window.
 */
export function isForwardedSession(session: { id: string }): boolean {
  return session.id.startsWith('fwd_');
}
