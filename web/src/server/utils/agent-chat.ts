/**
 * The agent chat switch. Off unless turned on: config.json `"agentChat": true`, or the
 * environment variable VIBETUNNEL_AGENT_CHAT=1 (which also turns it off with 0, whatever the
 * file says). While off, the server never reads an agent's transcripts or process tree for the
 * chat view, and the web app keeps its classic chat mode.
 */
export function agentChatEnabled(
  config: { agentChat?: boolean },
  env: Record<string, string | undefined> = process.env
): boolean {
  const value = env.VIBETUNNEL_AGENT_CHAT?.trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'off') return false;
  return config.agentChat === true;
}
