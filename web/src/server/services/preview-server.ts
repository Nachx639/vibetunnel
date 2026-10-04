/**
 * The preview listener: a second HTTP server in the VibeTunnel process, on its own port, so
 * previewed apps run on an origin of their own (see preview-proxy.ts). It serves the ticket
 * login, `/preview/<port>/…` and its HMR sockets, and nothing else: no /api, no VibeTunnel
 * UI, no main-origin auth. It only exists when previews are turned on (`--preview-port`).
 */

import * as http from 'node:http';
import type { Duplex } from 'node:stream';
import express from 'express';
import {
  PREVIEW_LOGIN_PATH,
  type PreviewProxy,
  VIBETUNNEL_SERVER_HEADER,
} from './preview-proxy.js';

/**
 * Preview port from `--preview-port` / VIBETUNNEL_PREVIEW_PORT. Previews are off unless one
 * of them names a port; "off", "false", "0" or nothing keep them off.
 */
export function resolvePreviewPort(
  flag: string | null | undefined,
  env: string | undefined,
  mainPort: number
): { port: number | null; error?: string } {
  const raw = (flag ?? env ?? '').trim();
  if (!raw || raw === 'off' || raw === 'false' || raw === '0') return { port: null };
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { port: null, error: `invalid preview port: ${raw}` };
  }
  if (port === mainPort)
    return { port: null, error: 'preview port must differ from the main port' };
  return { port };
}

/**
 * True when a request to the MAIN origin comes from the preview origin (a previewed app
 * calling VibeTunnel's API with ambient credentials such as Tailscale identity headers).
 */
export function isFromPreviewOrigin(
  origin: string | undefined,
  previewPort: number | null,
  previewOrigin?: string | null
): boolean {
  if (!origin || origin === 'null') return false;
  try {
    const url = new URL(origin);
    if (previewOrigin && url.origin === previewOrigin) return true;
    if (!previewPort) return false;
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return port === previewPort;
  } catch {
    return false;
  }
}

/**
 * Why a browser request to the MAIN origin's API must be refused, or null. VibeTunnel's own
 * UI only calls its API same-origin; a previewed app (same site, other port) must not reach
 * it with ambient credentials (Tailscale identity headers, local bypass). WebKit sends
 * `Origin: null` for a no-cors POST from the preview page, so the Origin port alone isn't
 * enough: opaque origins and same-site/cross-site fetches are refused too. Non-browser
 * clients (vt, the Mac app, HQ) send neither header and are unaffected. Installed only while
 * previews are on.
 */
export function foreignApiRequestReason(
  headers: http.IncomingHttpHeaders,
  previewPort: number | null,
  previewOrigin?: string | null
): string | null {
  const origin = typeof headers.origin === 'string' ? headers.origin : undefined;
  if (isFromPreviewOrigin(origin, previewPort, previewOrigin)) return 'preview origin';
  if (origin === 'null') return 'opaque origin';
  const site = headers['sec-fetch-site'];
  if ((site === 'same-site' || site === 'cross-site') && headers['sec-fetch-mode'] !== 'navigate') {
    return `${site} request`;
  }
  return null;
}

/**
 * Main-origin middleware, installed only while previews are on: refuses foreign browser
 * requests to /api (see above) and anything coming from the preview origin.
 */
export function mainOriginPreviewGuard(
  getPreviewPort: () => number | null,
  previewOrigin?: string | null
): express.RequestHandler {
  return (req, res, next) => {
    const isApi = req.path === '/api' || req.path.startsWith('/api/');
    const reason = isApi
      ? foreignApiRequestReason(req.headers, getPreviewPort(), previewOrigin)
      : isFromPreviewOrigin(req.headers.origin, getPreviewPort(), previewOrigin)
        ? 'preview origin'
        : null;
    if (reason) {
      res.status(403).type('text/plain').send(`Forbidden (${reason})`);
      return;
    }
    next();
  };
}

export function createPreviewApp(proxy: PreviewProxy): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Another VibeTunnel's proxy must recognize this origin and never preview it.
    res.setHeader(VIBETUNNEL_SERVER_HEADER, '1');
    next();
  });
  app.get(PREVIEW_LOGIN_PATH, (req, res) => proxy.handleLogin(req, res));
  app.use(proxy.redirectStrayLoad);
  app.use((req, res, next) => {
    void proxy.handleRequest(req, res, next);
  });
  app.use((_req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });
  return app;
}

export function createPreviewServer(proxy: PreviewProxy): http.Server {
  const server = http.createServer(createPreviewApp(proxy));
  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    void proxy.handleUpgrade(req, socket, head);
  });
  return server;
}
