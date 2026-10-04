/**
 * Security properties of dev-server previews that the PR description promises: off by
 * default, the proxy only ever reaches loopback on an allowed port, the server never follows
 * a redirect, headers can't retarget it, and nothing a request carries can end the inline
 * scripts of the preview origin's pages.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPreviewDisabledRoutes, createPreviewRoutes } from '../routes/preview.js';
import { createPreviewFeature, previewsRequested } from './preview-feature.js';
import {
  bootstrapPage,
  createPreviewProxy,
  PREVIEW_MESSAGE_MAX,
  sanitizePreviewMessages,
  scriptString,
} from './preview-proxy.js';
import { PreviewRegistry } from './preview-registry.js';
import { createPreviewServer } from './preview-server.js';

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };

// node:http, not fetch: fetch drops Origin and lets us set no Host of our own.
function request(
  port: number,
  urlPath: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method: options.method ?? 'GET',
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...options.headers },
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
  });
}

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe('previews are off by default', () => {
  it('only a named port turns them on', () => {
    expect(previewsRequested(null, undefined)).toBe(false);
    expect(previewsRequested(undefined, '')).toBe(false);
    expect(previewsRequested(null, 'off')).toBe(false);
    expect(previewsRequested('false', undefined)).toBe(false);
    expect(previewsRequested('0', undefined)).toBe(false);
    expect(previewsRequested(null, '8081')).toBe(true);
    expect(previewsRequested('8081', undefined)).toBe(true);
    // A bad value is "asked for": the server logs why previews are unavailable.
    expect(previewsRequested('abc', undefined)).toBe(true);
  });

  it('off, the API only says so: no list, no tickets, no candidates', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createPreviewDisabledRoutes());
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const config = await request(port, '/api/preview/config');
      expect(JSON.parse(config.body)).toEqual({ enabled: false, port: null, origin: null });
      expect((await request(port, '/api/previews')).status).toBe(404);
      expect((await request(port, '/api/previews/candidates')).status).toBe(404);
      expect(
        (await request(port, '/api/preview/ticket', { method: 'POST', body: { port: 3000 } }))
          .status
      ).toBe(404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('on, nothing is written until there is a preview, and the listener takes the named port', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-preview-feature-'));
    const controlDir = path.join(dir, 'control');
    const feature = createPreviewFeature({
      controlDir,
      getMainPort: () => 1,
      isVibeTunnelAuthorization: () => false,
      env: {},
    });
    try {
      expect(fs.existsSync(path.join(dir, 'previews.json'))).toBe(false);
      const port = await freePort();
      const listened = await feature.listen(String(port), 1, '127.0.0.1');
      expect(listened).toEqual({ port });
      expect(feature.listenPort()).toBe(port);
      expect(feature.portError(port)).toBe("VibeTunnel's own port");
      // The main port is refused as a preview port.
      expect(await feature.listen('1', 1, '127.0.0.1')).toMatchObject({ port: null });
    } finally {
      feature.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('texts the preview origin shows', () => {
  it('scriptString never lets a value end the inline script', () => {
    const literal = scriptString('</script><script>alert(1)</script>\u2028&');
    expect(literal).not.toMatch(/[<>&\u2028]/);
    // Still the same string once parsed.
    expect(JSON.parse(literal)).toBe('</script><script>alert(1)</script>\u2028&');
  });

  it('the bootstrap page keeps a hostile path and message inside their strings', () => {
    const page = bootstrapPage(5173, '/</script><img src=x onerror=alert(1)>', '</script>x');
    expect(page.match(/<\/script>/g)).toHaveLength(1); // only its own closing tag
    expect(page).not.toContain('<img');
  });

  it('localized messages: known keys only, plain text, bounded', () => {
    expect(sanitizePreviewMessages(undefined)).toBeUndefined();
    expect(sanitizePreviewMessages('nope')).toBeUndefined();
    expect(sanitizePreviewMessages({ evil: 'x', unsupported: '' })).toBeUndefined();
    const long = 'a'.repeat(PREVIEW_MESSAGE_MAX + 50);
    expect(
      sanitizePreviewMessages({ unsupported: 'line\r\nbreak\u0000', notListening: long, x: 1 })
    ).toEqual({ unsupported: 'line  break ', notListening: 'a'.repeat(PREVIEW_MESSAGE_MAX) });
  });
});

describe('the proxy only reaches loopback, on an allowed port', () => {
  let upstream: http.Server;
  let upstreamPort = 0;
  let main: http.Server;
  let mainPort = 0;
  let preview: http.Server;
  let previewPort = 0;
  const seen: Array<{ url: string; host?: string }> = [];
  const parentOrigin = 'http://vt.test:8080';

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      seen.push({ url: req.url ?? '', host: req.headers.host });
      if (req.url === '/go-away') {
        // A dev server redirecting to a metadata address: the proxy must not follow it.
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`upstream ${req.url}`);
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as AddressInfo).port;

    const proxy = createPreviewProxy({ getOwnPorts: () => [mainPort, previewPort] });
    const app = express();
    app.use(express.json());
    app.use('/api', (req, res, next) => {
      if (req.headers.authorization === 'Bearer good') return next();
      res.status(401).json({ error: 'auth' });
    });
    app.use(
      '/api',
      createPreviewRoutes({
        previewProxy: proxy,
        previewRegistry: new PreviewRegistry(),
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
    for (const server of [upstream, main, preview]) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  const login = async (body: Record<string, unknown> = {}) => {
    const ticket = await request(mainPort, '/api/preview/ticket', {
      method: 'POST',
      headers: { authorization: 'Bearer good', origin: parentOrigin },
      body: { port: upstreamPort, path: '/', ...body },
    });
    expect(ticket.status).toBe(200);
    const res = await request(previewPort, JSON.parse(ticket.body).loginPath);
    expect(res.status).toBe(302);
    return String(res.headers['set-cookie']?.[0] ?? '').split(';')[0];
  };

  it('tickets need VibeTunnel auth and refuse ports that are not plain, allowed numbers', async () => {
    const ask = (body: unknown, auth = true) =>
      request(mainPort, '/api/preview/ticket', {
        method: 'POST',
        headers: { ...(auth ? { authorization: 'Bearer good' } : {}), origin: parentOrigin },
        body,
      });
    expect((await ask({ port: upstreamPort }, false)).status).toBe(401);
    for (const port of [80, 0, -1, 65536, 1.5, '3000abc', 'localhost', null, mainPort]) {
      expect((await ask({ port })).status).toBe(403);
    }
    expect((await ask({ port: previewPort })).status).toBe(403);
  });

  it('odd paths and a forged Host still go to the same loopback port, as localhost', async () => {
    const cookie = await login();
    const odd = await request(previewPort, `/preview/${upstreamPort}//evil.example/x?y=1`, {
      headers: { cookie, host: 'evil.example', 'sec-fetch-mode': 'no-cors' },
    });
    expect(odd.status).toBe(200);
    expect(odd.body).toBe('upstream //evil.example/x?y=1');
    expect(seen.at(-1)).toEqual({ url: '//evil.example/x?y=1', host: `localhost:${upstreamPort}` });
    const dots = await request(previewPort, `/preview/${upstreamPort}/../../etc/passwd`, {
      headers: { cookie, 'sec-fetch-mode': 'no-cors' },
    });
    // Whatever the path, it is the dev server on that port that answers (or nothing).
    expect([200, 404]).toContain(dots.status);
    if (dots.status === 200) expect(dots.body.startsWith('upstream ')).toBe(true);
  });

  it('malformed or out-of-range ports in the path are refused before connecting anywhere', async () => {
    const cookie = await login();
    const before = seen.length;
    const status = async (p: string) =>
      (await request(previewPort, p, { headers: { cookie, 'sec-fetch-mode': 'no-cors' } })).status;
    expect(await status('/preview/99999/')).toBe(403);
    expect(await status('/preview/80/')).toBe(403);
    expect(await status(`/preview/${upstreamPort}abc/`)).toBe(404);
    expect(await status('/preview/+3000/')).toBe(404);
    expect(await status(`/preview/${mainPort}/`)).toBe(403);
    expect(seen.length).toBe(before);
  });

  it('never follows a redirect: the browser gets it, the server fetches nothing else', async () => {
    const cookie = await login();
    const res = await request(previewPort, `/preview/${upstreamPort}/go-away`, {
      headers: { cookie, 'sec-fetch-mode': 'no-cors' },
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://169.254.169.254/latest/meta-data/');
    expect(seen.at(-1)?.url).toBe('/go-away');
  });

  it("shows the app's own language in the frame's messages, as plain text", async () => {
    const quiet = await freePort();
    const messages = { notListening: 'Port {port} is quiet <b>', unsupported: 'No workers here' };
    const cookie = await login({ port: quiet, messages });
    const page = await request(previewPort, `/preview/${quiet}/`, {
      headers: { cookie, 'sec-fetch-mode': 'navigate' },
    });
    expect(page.body).toContain('"No workers here"');
    const down = await request(previewPort, `/preview/${quiet}/app.js`, {
      headers: { cookie, 'sec-fetch-mode': 'no-cors' },
    });
    expect(down.status).toBe(502);
    expect(down.headers['content-type']).toMatch(/^text\/plain/);
    expect(down.body).toBe(`Port ${quiet} is quiet <b>`);
    // A preview session is bound to its port: another port needs its own ticket.
    const other = await request(previewPort, `/preview/${upstreamPort}/x`, {
      headers: { cookie, 'sec-fetch-mode': 'no-cors' },
    });
    expect(other.status).toBe(401);
  });
});
