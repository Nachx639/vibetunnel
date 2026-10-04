/**
 * Whether the server has agent chat on (GET /api/config `agentChat`, set by config.json
 * `agentChat` or VIBETUNNEL_AGENT_CHAT), and Claude history (`claudeHistory`). Off while unknown
 * or on any error: the session view then keeps the classic chat mode, and History stays out of
 * the menu. Asked again at most once a minute.
 */
import { authClient } from '../services/auth-client.js';

const RECHECK_MS = 60_000;
interface ServerSwitches {
  agentChat: boolean;
  claudeHistory: boolean;
}

const OFF: ServerSwitches = { agentChat: false, claudeHistory: false };
let cached: { at: number; switches: ServerSwitches } | null = null;
let inFlight: Promise<ServerSwitches> | null = null;

function serverSwitches(): Promise<ServerSwitches> {
  if (cached && Date.now() - cached.at < RECHECK_MS) return Promise.resolve(cached.switches);
  inFlight ??= Promise.resolve()
    .then(() => fetch('/api/config', { headers: authClient.getAuthHeader() }))
    .then(async (response) => {
      const body = response.ok ? await response.json() : null;
      const switches = {
        agentChat: body?.agentChat === true,
        claudeHistory: body?.claudeHistory === true,
      };
      cached = { at: Date.now(), switches };
      return switches;
    })
    .catch(() => OFF)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function agentChatEnabled(): Promise<boolean> {
  return serverSwitches().then((switches) => switches.agentChat);
}

/** Claude history (GET /api/config `claudeHistory`): never true on a server without a login. */
export function claudeHistoryEnabled(): Promise<boolean> {
  return serverSwitches().then((switches) => switches.claudeHistory);
}

/** For tests: forget the cached answer. */
export function resetAgentChatCache(): void {
  cached = null;
  inFlight = null;
}
