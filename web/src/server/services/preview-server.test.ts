import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createPreviewRoutes } from '../routes/preview.js';
import {
  createPreviewProxy,
  PREVIEW_SW_HEADER,
  PreviewTickets,
  PreviewTokens,
  safeNextPath,
} from './preview-proxy.js';
import { PreviewRegistry } from './preview-registry.js';
import {
  createPreviewServer,
  foreignApiRequestReason,
  isFromPreviewOrigin,
  mainOriginPreviewGuard,
  previewUnreachableReason,
  resolvePreviewPort,
} from './preview-server.js';

describe('preview listener config', () => {
  it('is off unless a port is named, takes the flag before the env, refuses the main port', () => {
    // Off by default: never main port + 1 (that is often a dev server's port).
    expect(resolvePreviewPort(null, undefined, 7020)).toEqual({ port: null });
    expect(resolvePreviewPort('', '', 7020)).toEqual({ port: null });
    expect(resolvePreviewPort(null, '0', 7020)).toEqual({ port: null });
    expect(resolvePreviewPort('off', '4666', 7020)).toEqual({ port: null });
    expect(resolvePreviewPort('4555', '4666', 7020)).toEqual({ port: 4555 });
    expect(resolvePreviewPort(null, '4666', 7020)).toEqual({ port: 4666 });
    expect(resolvePreviewPort(null, 'off', 7020)).toEqual({ port: null });
    expect(resolvePreviewPort('7020', undefined, 7020).port).toBeNull();
    expect(resolvePreviewPort('7020', undefined, 7020).error).toMatch(/differ/);
    expect(resolvePreviewPort('abc', undefined, 7020).error).toMatch(/invalid/);
  });

  it('hides previews from pages that reach the server through a proxy, a tunnel or a mapping', () => {
    const lan = new Set(['192.168.1.20', 'fe80::1']);
    const opts = (bindAddress?: string) => ({
      mainPort: 7020,
      bindAddress,
      isLocalAddress: (address: string) => lan.has(address),
      machineName: 'studio',
    });
    const reason = (host: string, bind?: string, extra: Record<string, string> = {}) =>
      previewUnreachableReason({ host, ...extra }, opts(bind));
    // Direct: loopback, the bind address, an address or the name of this machine.
    expect(reason('localhost:7020')).toBeNull();
    expect(reason('127.0.0.1:7020')).toBeNull();
    expect(reason('[::1]:7020')).toBeNull();
    expect(reason('192.168.1.20:7020')).toBeNull();
    expect(reason('[fe80::1]:7020')).toBeNull();
    expect(reason('studio.local:7020')).toBeNull();
    expect(reason('Studio:7020')).toBeNull();
    expect(reason('10.0.0.5:7020', '10.0.0.5')).toBeNull();
    expect(reason('localhost:7020', '127.0.0.1')).toBeNull();
    // A reverse proxy or tunnel (Serve-style HTTPS front end, ngrok, nginx).
    expect(reason('localhost:7020', undefined, { 'x-forwarded-for': '203.0.113.5' })).toBe('proxy');
    expect(reason('localhost:7020', undefined, { forwarded: 'for=1.2.3.4' })).toBe('proxy');
    expect(reason('localhost:7020', undefined, { 'x-forwarded-host': 'vt.example' })).toBe('proxy');
    expect(reason('mac.example.net')).toBe('port');
    expect(reason('abc.ngrok.app:443')).toBe('port');
    // A port mapping (Docker -p 8080:7020) or a host that isn't this machine.
    expect(reason('localhost:8080')).toBe('port');
    expect(reason('vt.example.com:7020')).toBe('host');
    expect(reason('203.0.113.9:7020')).toBe('host');
    // Bound to one address: a different host can't be served by the preview listener.
    expect(reason('192.168.1.20:7020', '127.0.0.1')).toBe('host');
    expect(reason('localhost:7020', '10.0.0.5')).toBe('host');
    expect(reason('')).toBe('host');
  });

  it('recognizes requests coming from the preview origin', () => {
    expect(isFromPreviewOrigin('https://vt.example.com:7021', 7021)).toBe(true);
    expect(isFromPreviewOrigin('http://127.0.0.1:7021', 7021)).toBe(true);
    expect(isFromPreviewOrigin('https://vt.example.com:7020', 7021)).toBe(false);
    expect(isFromPreviewOrigin(undefined, 7021)).toBe(false);
    expect(isFromPreviewOrigin('https://p.example', null, 'https://p.example')).toBe(true);
  });

  it('refuses foreign browser requests to the main API, not VibeTunnel or its clients', () => {
    const reason = (headers: Record<string, string>) => foreignApiRequestReason(headers, 7021);
    // WebKit: no-cors POST from the (service-worker controlled) preview page.
    expect(reason({ origin: 'null', 'sec-fetch-site': 'same-site' })).toMatch(/opaque/);
    expect(reason({ 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors' })).toMatch(
      /same-site/
    );
    expect(reason({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' })).toMatch(
      /cross-site/
    );
    expect(reason({ origin: 'https://vt.example.com:7021' })).toMatch(/preview/);
    expect(
      reason({ origin: 'https://vt.example.com:7020', 'sec-fetch-site': 'same-origin' })
    ).toBeNull();
    expect(reason({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' })).toBeNull();
    expect(reason({ authorization: 'Bearer x' })).toBeNull(); // vt, the Mac app, HQ
  });
});

describe('tickets and sessions', () => {
  it('tickets are single-use and expire', async () => {
    const tickets = new PreviewTickets();
    const grant = { port: 5173, parentOrigin: 'https://vt' };
    const ticket = tickets.issue(grant);
    expect(tickets.redeem(ticket)).toEqual(grant);
    expect(tickets.redeem(ticket)).toBeNull();
    const short = new PreviewTickets(1);
    const old = short.issue(grant);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(short.redeem(old)).toBeNull();
    expect(tickets.redeem(undefined)).toBeNull();
  });

  it('a session only opens the port it was issued for', () => {
    const tokens = new PreviewTokens();
    const { token, maxAgeSeconds } = tokens.issue({ port: 5173, parentOrigin: 'https://vt' });
    expect(maxAgeSeconds).toBe(12 * 60 * 60);
    expect(tokens.verify(token, 5173)).not.toBeNull();
    expect(tokens.verify(token, 3000)).toBeNull();
  });

  it('login only redirects inside the ticket port', () => {
    expect(safeNextPath('/preview/5173/a?b=1', 5173)).toBe('/preview/5173/a?b=1');
    expect(safeNextPath('/preview/3000/', 5173)).toBe('/preview/5173/');
    expect(safeNextPath('//evil.com/preview/5173/', 5173)).toBe('/preview/5173/');
    expect(safeNextPath('https://evil.com/', 5173)).toBe('/preview/5173/');
    expect(safeNextPath(undefined, 5173)).toBe('/preview/5173/');
  });
});

describe('preview origin end to end', () => {
  let upstream: http.Server;
  let upstreamWss: WebSocketServer;
  let upstreamPort: number;
  let main: http.Server;
  let mainPort: number;
  let preview: http.Server;
  let previewPort: number;
  const parentOrigin = 'http://vt.test:7020';
  const seen: http.IncomingHttpHeaders[] = [];
  const registry = new PreviewRegistry();

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      seen.push(req.headers);
      if (req.url === '/') {
        res.writeHead(200, {
          'content-type': 'text/html',
          'x-frame-options': 'DENY',
          'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
          'set-cookie': 'sid=1; Path=/',
        });
        res.end('<html><head></head><body>app</body></html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(`// ${req.url}`);
    });
    upstreamWss = new WebSocketServer({ server: upstream });
    upstreamWss.on('connection', (ws, req) => {
      ws.send(JSON.stringify({ type: 'connected', url: req.url, host: req.headers.host }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as AddressInfo).port;

    const proxy = createPreviewProxy({ getOwnPorts: () => [mainPort, previewPort] });

    // A stand-in for the main server: bearer auth, the origin guard and the real routes.
    const app = express();
    app.use(mainOriginPreviewGuard(() => previewPort));
    app.use(express.json());
    app.use('/api', (req, res, next) => {
      if (req.headers.authorization === 'Bearer good') return next();
      res.status(401).json({ error: 'auth' });
    });
    app.use(
      '/api',
      createPreviewRoutes({
        previewProxy: proxy,
        previewRegistry: registry,
        getOwnPort: () => mainPort,
        getPreviewPort: () => previewPort,
        sessionExists: () => false,
      })
    );
    main = http.createServer(app);
    await new Promise<void>((resolve) => main.listen(0, '127.0.0.1', resolve));
    mainPort = (main.address() as AddressInfo).port;

    preview = createPreviewServer(proxy);
    await new Promise<void>((resolve) => preview.listen(0, '127.0.0.1', resolve));
    previewPort = (preview.address() as AddressInfo).port;
  });

  afterAll(async () => {
    upstreamWss.close();
    await new Promise((resolve) => upstream.close(resolve));
    for (const server of [main, preview]) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // node:http, not fetch: fetch drops Origin/Sec-Fetch-* request headers.
  const request = (
    port: number,
    path: string,
    options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
  ) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
      (resolve, reject) => {
        const body = options.body === undefined ? undefined : JSON.stringify(options.body);
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path,
            method: options.method ?? 'GET',
            headers: {
              ...(body ? { 'content-type': 'application/json' } : {}),
              ...options.headers,
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
              })
            );
          }
        );
        req.on('error', reject);
        req.end(body);
      }
    );

  const ticket = async (port = upstreamPort, path = '/') => {
    const res = await request(mainPort, '/api/preview/ticket', {
      method: 'POST',
      headers: { authorization: 'Bearer good', origin: parentOrigin },
      body: { port, path },
    });
    expect(res.status).toBe(200);
    return JSON.parse(res.body).loginPath as string;
  };

  const login = async (port = upstreamPort) => {
    const res = await request(previewPort, await ticket(port));
    expect(res.status).toBe(302);
    return { res, cookie: String(res.headers['set-cookie']?.[0] ?? '').split(';')[0] };
  };

  it('never shows another VibeTunnel server, and marks its own responses as VibeTunnel', async () => {
    // Stands in for a second VibeTunnel server: it says so in every response.
    const other = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/javascript', 'x-vibetunnel-server': '1' });
      res.end('// the other VibeTunnel');
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const otherPort = (other.address() as AddressInfo).port;
    try {
      const { cookie } = await login(otherPort);
      const asset = await request(previewPort, `/preview/${otherPort}/bundle.js`, {
        headers: { cookie, 'sec-fetch-mode': 'no-cors', accept: '*/*' },
      });
      expect(asset.status).toBe(403);
      expect(asset.body).toContain('another VibeTunnel server');
      expect(asset.body).not.toContain('the other VibeTunnel');
      // From then on it isn't even offered.
      const again = await request(mainPort, '/api/preview/ticket', {
        method: 'POST',
        headers: { authorization: 'Bearer good', origin: parentOrigin },
        body: { port: otherPort, path: '/' },
      });
      expect(again.status).toBe(403);
      // This preview origin says it is VibeTunnel too.
      expect(asset.headers['x-vibetunnel-server']).toBe('1');
    } finally {
      other.closeAllConnections?.();
      await new Promise((resolve) => other.close(resolve));
    }
  });

  it('the main API reports the preview port and needs its own auth for tickets', async () => {
    const config = await request(mainPort, '/api/preview/config', {
      headers: { authorization: 'Bearer good' },
    });
    expect(JSON.parse(config.body)).toEqual({
      enabled: true,
      port: previewPort,
      origin: null,
      reachable: true,
    });
    const proxied = await request(mainPort, '/api/preview/config', {
      headers: { authorization: 'Bearer good', 'x-forwarded-for': '203.0.113.5' },
    });
    expect(JSON.parse(proxied.body)).toEqual({
      enabled: true,
      port: previewPort,
      origin: null,
      reachable: false,
      unreachableReason: 'proxy',
    });
    const anon = await request(mainPort, '/api/preview/ticket', {
      method: 'POST',
      headers: { origin: parentOrigin },
      body: { port: upstreamPort },
    });
    expect(anon.status).toBe(401);
    const own = await request(mainPort, '/api/preview/ticket', {
      method: 'POST',
      headers: { authorization: 'Bearer good', origin: parentOrigin },
      body: { port: previewPort },
    });
    expect(own.status).toBe(403);
  });

  it('a ticket logs in once, sets a port-bound HttpOnly SameSite=Strict cookie', async () => {
    const loginPath = await ticket(upstreamPort, '/about?x=1');
    const first = await request(previewPort, loginPath);
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe(`/preview/${upstreamPort}/about?x=1`);
    const cookie = String(first.headers['set-cookie']?.[0]);
    expect(cookie).toMatch(new RegExp(`^vt_preview_${upstreamPort}=`));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(new RegExp(`Path=/preview/${upstreamPort}/`));
    expect(cookie).toMatch(/Max-Age=43200/);
    expect((await request(previewPort, loginPath)).status).toBe(401); // burnt
    expect((await request(previewPort, '/__vt_preview_login?ticket=forged')).status).toBe(401);
  });

  it('a saved preview opens with no session at all (ticket by preview id)', async () => {
    const { id } = registry.addManual(upstreamPort, '/about');
    const res = await request(mainPort, '/api/preview/ticket', {
      method: 'POST',
      headers: { authorization: 'Bearer good', origin: parentOrigin },
      body: { id, path: '/about' },
    });
    expect(res.status).toBe(200);
    const first = await request(previewPort, JSON.parse(res.body).loginPath);
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe(`/preview/${upstreamPort}/about`);
    const cookie = String(first.headers['set-cookie']?.[0] ?? '').split(';')[0];
    const page = await request(previewPort, `/preview/${upstreamPort}/main.js`, {
      headers: { cookie, [PREVIEW_SW_HEADER]: '1' },
    });
    expect(page.status).toBe(200);
    expect(page.body).toBe('// /main.js');

    const unknown = await request(mainPort, '/api/preview/ticket', {
      method: 'POST',
      headers: { authorization: 'Bearer good', origin: parentOrigin },
      body: { id: 'pnothere1' },
    });
    expect(unknown.status).toBe(404);
    const anon = await request(mainPort, '/api/preview/ticket', {
      method: 'POST',
      headers: { origin: parentOrigin },
      body: { id },
    });
    expect(anon.status).toBe(401);
  });

  it('serves only previews: no API, no UI, nothing without the preview cookie', async () => {
    for (const path of ['/', '/api/sessions', '/api/preview/config', '/index.html']) {
      const res = await request(previewPort, path, { headers: { authorization: 'Bearer good' } });
      expect(res.status).toBe(404);
    }
    // The main origin's credentials mean nothing here.
    const bearer = await request(previewPort, `/preview/${upstreamPort}/main.js`, {
      headers: { authorization: 'Bearer good', 'tailscale-user-login': 'me@example.com' },
    });
    expect(bearer.status).toBe(401);
  });

  it('proxies with the cookie, only for its port, never forwarding it', async () => {
    const { cookie } = await login();
    const res = await request(previewPort, `/preview/${upstreamPort}/main.js?x=1`, {
      headers: { cookie: `${cookie}; app=1`, [PREVIEW_SW_HEADER]: '1' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe('// /main.js?x=1');
    expect(seen[seen.length - 1].cookie).toBe('app=1');
    // The same session value under another port's name opens nothing.
    const value = cookie.split('=')[1];
    const other = await request(previewPort, '/preview/3999/main.js', {
      headers: { cookie: `vt_preview_3999=${value}` },
    });
    expect(other.status).toBe(401);
  });

  it('the preview cookie is not accepted by the main API, and the main origin has no previews', async () => {
    const { cookie } = await login();
    expect((await request(mainPort, '/api/preview/config', { headers: { cookie } })).status).toBe(
      401
    );
    const old = await request(mainPort, `/preview/${upstreamPort}/`, {
      headers: { cookie, authorization: 'Bearer good' },
    });
    expect(old.status).toBe(404);
  });

  it('the main origin refuses requests made from the preview origin', async () => {
    const res = await request(mainPort, '/api/preview/config', {
      headers: { authorization: 'Bearer good', origin: `http://127.0.0.1:${previewPort}` },
    });
    expect(res.status).toBe(403);
    const opaque = await request(mainPort, '/api/preview/ticket', {
      method: 'POST',
      headers: { authorization: 'Bearer good', origin: 'null' },
      body: { port: upstreamPort },
    });
    expect(opaque.status).toBe(403);
  });

  it('only the VibeTunnel origin that asked may frame the preview', async () => {
    const { cookie } = await login();
    const boot = await request(previewPort, `/preview/${upstreamPort}/`, {
      headers: { cookie, 'sec-fetch-mode': 'navigate' },
    });
    expect(boot.body).toContain('serviceWorker');
    expect(boot.headers['content-security-policy']).toBe(`frame-ancestors ${parentOrigin}`);
    const app = await request(previewPort, `/preview/${upstreamPort}/`, {
      headers: { cookie, 'sec-fetch-mode': 'navigate', [PREVIEW_SW_HEADER]: '1' },
    });
    expect(app.body).toContain(`<script src="/preview/${upstreamPort}/__vt_preview_client.js">`);
    expect(app.headers['x-frame-options']).toBeUndefined();
    // Node joins repeated CSP headers with ", ": the app's policy, then ours.
    expect(app.headers['content-security-policy']).toBe(
      `default-src 'self', frame-ancestors ${parentOrigin}`
    );
    const client = await request(previewPort, `/preview/${upstreamPort}/__vt_preview_client.js`, {
      headers: { cookie },
    });
    expect(client.body).toContain(JSON.stringify(parentOrigin));
  });

  it('sends a stray full load back under the last port', async () => {
    const res = await request(previewPort, '/about?x=1', {
      headers: { 'sec-fetch-dest': 'iframe', cookie: `vt_preview_port=${upstreamPort}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/preview/${upstreamPort}/about?x=1`);
    const own = await request(previewPort, '/about', {
      headers: { 'sec-fetch-dest': 'document', cookie: `vt_preview_port=${mainPort}` },
    });
    expect(own.status).toBe(404);
  });

  const openSocket = (port: number, path: string, headers: Record<string, string>) =>
    new Promise<{ ok: boolean; message?: string; status?: number }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
      ws.on('message', (data) => {
        resolve({ ok: true, message: String(data) });
        ws.close();
      });
      ws.on('unexpected-response', (_req, res) => resolve({ ok: false, status: res.statusCode }));
      ws.on('error', () => resolve({ ok: false }));
    });

  it('WebSocket upgrades (HMR) need the preview cookie for that port', async () => {
    const path = `/preview/${upstreamPort}/?token=vite`;
    expect((await openSocket(previewPort, path, {})).status).toBe(401);
    expect((await openSocket(previewPort, path, { authorization: 'Bearer good' })).status).toBe(
      401
    );
    expect((await openSocket(previewPort, '/ws', {})).status).toBe(404);
    const { cookie } = await login();
    const result = await openSocket(previewPort, path, { cookie });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.message ?? '{}')).toEqual({
      type: 'connected',
      url: '/?token=vite',
      host: `localhost:${upstreamPort}`,
    });
  });
});
