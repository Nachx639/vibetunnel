import * as net from 'net';

/**
 * A second server started on the port of a running one used to set up its control dir and
 * unlink the running server's control socket before its own listen failed with EADDRINUSE:
 * the Mac app lost its control channel to the server that was still running. Startup now
 * checks the port before touching anything and, with --port-wait, can wait for it (a restart
 * then outlasts its predecessor's shutdown).
 */

/** A listener on this machine answers far sooner; past this, nothing is there. */
const CONNECT_TIMEOUT_MS = 300;

/**
 * True when `listen(port, host)` would succeed right now (found out by doing it) and nothing
 * accepts a connection on the port on loopback or on `host`. The bind alone misses a server
 * on another address: on macOS 0.0.0.0 binds while one listens on 127.0.0.1 or ::1, and a
 * second server started with the default bind would pass the check.
 */
export async function portIsFree(port: number, host: string): Promise<boolean> {
  if (!(await canListen(port, host))) return false;
  const accepted = await Promise.all(probeHosts(host).map((target) => accepts(port, target)));
  return !accepted.includes(true);
}

function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    // Other errors (EACCES, EADDRNOTAVAIL) are the real listen's to report.
    probe.once('error', (error: NodeJS.ErrnoException) => resolve(error.code !== 'EADDRINUSE'));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

/** Both loopbacks, plus `host` when it is a specific address other than them. */
function probeHosts(host: string): string[] {
  const wildcard = host === '' || host === '0.0.0.0' || host === '::';
  const loopback =
    host === 'localhost' || host === '::1' || (net.isIPv4(host) && host.startsWith('127.'));
  return wildcard || loopback ? ['127.0.0.1', '::1'] : ['127.0.0.1', '::1', host];
}

/**
 * True only when something accepts the connection. A refusal, an address family or route this
 * machine lacks (EADDRNOTAVAIL, ENETUNREACH, EAFNOSUPPORT: ::1 without IPv6) or the timeout
 * all mean nothing listens there.
 */
function accepts(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host, timeout: CONNECT_TIMEOUT_MS });
    const settle = (connected: boolean) => {
      socket.destroy();
      resolve(connected);
    };
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.on('error', () => settle(false));
  });
}

/**
 * Waits up to `waitMs` (default 0: one check, no wait) for the port to be free; `onWait` runs
 * once if it has to wait.
 */
export async function waitForFreePort(
  port: number,
  host: string,
  options: { waitMs?: number; pollMs?: number; onWait?: () => void } = {}
): Promise<boolean> {
  if (port === 0) return true;
  const { waitMs = 0, pollMs = 250, onWait } = options;
  const deadline = Date.now() + waitMs;
  if (await portIsFree(port, host)) return true;
  if (waitMs <= 0) return false;
  onWait?.();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    if (await portIsFree(port, host)) return true;
  }
  return false;
}
