import type { Server } from 'http';
import type { WebSocket } from 'ws';

/** Longest a shutdown waits for requests in flight before every connection is cut. */
const SHUTDOWN_MAX_DRAIN_MS = 4000;
/** How often it looks whether they ended; the first look also lets the close frames go out. */
const SHUTDOWN_POLL_MS = 50;

/**
 * Ends what keeps `server.close()` from finishing: idle keep-alive sockets at once, WebSockets
 * with "going away" (1001; phones reconnect to the next server by themselves), and whatever
 * is still open, event streams included, as soon as `inFlight()` (inflight-requests.ts) is
 * down to zero, at the latest after SHUTDOWN_MAX_DRAIN_MS (inside the 5 s forced exit, so the
 * server still closes and logs cleanly). Without it every restart waited for the 5 s timeout
 * and was killed before logging its close; a fixed short cut instead would break uploads,
 * input being sent to a session and git pushes still in flight.
 */
export function closeConnectionsForShutdown(
  server: Pick<Server, 'closeIdleConnections' | 'closeAllConnections'>,
  wss: { clients: Iterable<Pick<WebSocket, 'close' | 'terminate'>> },
  inFlight: () => number
): void {
  server.closeIdleConnections();
  for (const client of wss.clients) client.close(1001, 'Server restarting');
  const cutAll = () => {
    clearInterval(poll);
    clearTimeout(deadline);
    server.closeAllConnections();
    for (const client of wss.clients) client.terminate();
  };
  const poll = setInterval(() => {
    if (inFlight() === 0) cutAll();
  }, SHUTDOWN_POLL_MS);
  const deadline = setTimeout(cutAll, SHUTDOWN_MAX_DRAIN_MS);
  poll.unref();
  deadline.unref();
}
