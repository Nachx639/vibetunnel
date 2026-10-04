/**
 * Whether the server has agent chat on (GET /api/config `agentChat`, set by config.json
 * `agentChat` or VIBETUNNEL_AGENT_CHAT). Off while unknown or on any error: the session view
 * then keeps the classic chat mode. Asked again at most once a minute.
 */
import { authClient } from '../services/auth-client.js';

const RECHECK_MS = 60_000;
let cached: { at: number; enabled: boolean } | null = null;
let inFlight: Promise<boolean> | null = null;

export function agentChatEnabled(): Promise<boolean> {
  if (cached && Date.now() - cached.at < RECHECK_MS) return Promise.resolve(cached.enabled);
  inFlight ??= Promise.resolve()
    .then(() => fetch('/api/config', { headers: authClient.getAuthHeader() }))
    .then(async (response) => {
      const enabled = response.ok && (await response.json())?.agentChat === true;
      cached = { at: Date.now(), enabled };
      return enabled;
    })
    .catch(() => false)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** For tests: forget the cached answer. */
export function resetAgentChatCache(): void {
  cached = null;
  inFlight = null;
}
