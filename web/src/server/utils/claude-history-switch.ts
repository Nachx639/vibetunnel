/**
 * The Claude history switch. Off unless turned on: config.json `"claudeHistory": true`, or the
 * environment variable VIBETUNNEL_CLAUDE_HISTORY=1 (which also turns it off with 0, whatever
 * the file says). History lists every Claude Code conversation in `<Claude dir>/projects`, from
 * every project, so it is never available on a server started with --no-auth, where anyone who
 * reaches the port would read them.
 */
export function claudeHistoryEnabled(
  config: { claudeHistory?: boolean },
  env: Record<string, string | undefined> = process.env
): boolean {
  const value = env.VIBETUNNEL_CLAUDE_HISTORY?.trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'off') return false;
  return config.claudeHistory === true;
}

/** Why History is unavailable right now, or null when it is available. */
export function claudeHistoryBlock(
  config: { claudeHistory?: boolean },
  options: { noAuth: boolean },
  env: Record<string, string | undefined> = process.env
): 'disabled' | 'no-auth' | null {
  if (!claudeHistoryEnabled(config, env)) return 'disabled';
  if (options.noAuth) return 'no-auth';
  return null;
}
