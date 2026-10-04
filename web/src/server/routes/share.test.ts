import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { es as esMessages } from '../../client/i18n/locales/es.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import type { AuthService } from '../services/auth-service.js';
import { ShareStore } from '../services/share-store.js';
import {
  createShareApiRoutes,
  createShareViewRoutes,
  type ShareScreen,
  viewerLocale,
} from './share.js';

const JWT = 'valid-login-jwt';

function setup(options: { enabled?: boolean; realAuth?: boolean } = {}) {
  let now = 1_000_000;
  let enabled = options.enabled ?? true;
  const store = new ShareStore({ now: () => now });
  const screens: Record<string, ShareScreen | null> = {
    s1: { title: 'shop', running: true, text: '$ npm test\n<b>ok</b>', cols: 100 },
    s2: { title: 'other', running: true, text: 'secret of another session', cols: 80 },
  };
  const config = {
    store,
    isEnabled: () => enabled,
    sessionExists: (id: string) => id in screens,
    readScreen: async (id: string) => screens[id] ?? null,
  };
  const app = express();
  app.use(express.json());
  app.use(createShareViewRoutes(config));
  if (options.realAuth) {
    // The server's own login middleware, with a stand-in JWT check.
    const authService = {
      verifyToken: (token: string) =>
        token === JWT ? { valid: true, userId: 'alice' } : { valid: false },
    } as unknown as AuthService;
    app.use(
      '/api',
      createAuthMiddleware({
        enableSSHKeys: false,
        disallowUserPassword: false,
        noAuth: false,
        isHQMode: false,
        authService,
      })
    );
  } else {
    // Stand-in for the login in front of /api.
    app.use('/api', (req, res, next) =>
      req.headers.authorization === `Bearer ${JWT}`
        ? next()
        : res.status(401).json({ error: 'auth' })
    );
  }
  app.use('/api', createShareApiRoutes(config));
  // Everything else on the API: what a share token must never reach.
  app.get('/api/sessions', (_req, res) => res.json([{ id: 's1' }, { id: 's2' }]));
  app.use((_req, res) => res.status(404).send('server 404'));
  return {
    app,
    store,
    screens,
    advance: (ms: number) => (now += ms),
    setEnabled: (on: boolean) => (enabled = on),
  };
}

const create = (app: express.Express, sessionId = 's1', minutes = 60) =>
  request(app)
    .post(`/api/sessions/${sessionId}/shares`)
    .set('Authorization', `Bearer ${JWT}`)
    .send({ minutes });

describe('read-only share links', () => {
  it('only a logged-in user creates, lists and revokes them', async () => {
    const { app } = setup();
    expect((await request(app).post('/api/sessions/s1/shares').send({})).status).toBe(401);
    expect((await request(app).get('/api/sessions/s1/shares')).status).toBe(401);
    const created = await create(app);
    expect(created.status).toBe(201);
    expect(created.body.share.path).toBe(`/share/${created.body.share.token}`);
    expect((await request(app).delete(`/api/shares/${created.body.share.token}`)).status).toBe(401);
    expect((await create(app, 'nope')).status).toBe(404);
    expect((await create(app, 's1', -5)).status).toBe(400);
    const list = await request(app)
      .get('/api/sessions/s1/shares')
      .set('Authorization', `Bearer ${JWT}`);
    expect(list.body.shares).toHaveLength(1);
    const revoked = await request(app)
      .delete(`/api/shares/${created.body.share.token}`)
      .set('Authorization', `Bearer ${JWT}`);
    expect(revoked.body.revoked).toBe(true);
    expect((await request(app).get(`${created.body.share.path}/screen`)).status).toBe(404);
  });

  it('the link shows that session’s screen only, as data, without the login', async () => {
    const { app } = setup();
    const { path: link } = (await create(app)).body.share;
    const page = await request(app).get(link);
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toMatch(/script-src 'nonce-[^']+'/);
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['x-robots-tag']).toContain('noindex');
    // The page itself carries no screen content; the feed does, as JSON.
    expect(page.text).not.toContain('npm test');
    const feed = await request(app).get(`${link}/screen`);
    expect(feed.headers['content-type']).toMatch(/application\/json/);
    expect(feed.body).toMatchObject({ title: 'shop', running: true, cols: 100 });
    expect(feed.body.text).toBe('$ npm test\n<b>ok</b>');
    expect(JSON.stringify(feed.body)).not.toContain('secret');
    // Nothing in the answer names the session id or other sessions.
    expect(Object.keys(feed.body).sort()).toEqual([
      'cols',
      'expiresAt',
      'running',
      'text',
      'title',
    ]);
  });

  it('is read-only: nothing under /share/<token> accepts input, resize or kill', async () => {
    const { app } = setup();
    const { path: link } = (await create(app)).body.share;
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      for (const sub of ['', '/screen', '/input', '/resize', '/kill']) {
        const res = await request(app)[method](`${link}${sub}`).send({ text: 'rm -rf ~\n' });
        expect(res.status, `${method} ${sub}`).toBe(404);
      }
    }
    for (const sub of ['/input', '/stream', '/files', '/../../api/sessions']) {
      expect((await request(app).get(`${link}${sub}`)).text).not.toContain('npm test');
    }
  });

  it('a share token is not a login: the API refuses it as a credential', async () => {
    const { app } = setup({ realAuth: true });
    const { token } = (await create(app)).body.share;
    for (const target of ['/api/sessions', '/api/sessions/s1/shares', '/api/sessions/s2/shares']) {
      expect((await request(app).get(target).set('Authorization', `Bearer ${token}`)).status).toBe(
        401
      );
      expect((await request(app).get(`${target}?token=${token}`)).status).toBe(401);
    }
    expect(
      (await request(app).get('/api/sessions').set('Authorization', `Bearer ${JWT}`)).status
    ).toBe(200);
  });

  it('an unknown, malformed or expired link is a 404 page', async () => {
    const { app, advance } = setup();
    const { path: link } = (await create(app, 's1', 15)).body.share;
    expect((await request(app).get('/share/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).status).toBe(404);
    expect((await request(app).get('/share/..%2F..%2Fapi')).status).toBe(404);
    expect((await request(app).get('/share/..%2F..%2Fapi/screen')).status).toBe(404);
    expect((await request(app).get(`${link.slice(0, -1)}/screen`)).status).toBe(404);
    advance(15 * 60_000);
    const page = await request(app).get(link);
    expect(page.status).toBe(404);
    expect(page.text).toContain('expired');
    expect(page.text).not.toContain('id="meta"');
    expect((await request(app).get(`${link}/screen`)).status).toBe(404);
  });

  it('expiry is the server’s: at most 24 h whatever the app asks', async () => {
    const { app, advance } = setup();
    const { path: link, expiresAt, createdAt } = (await create(app, 's1', 100_000)).body.share;
    expect(expiresAt - createdAt).toBe(24 * 60 * 60_000);
    advance(24 * 60 * 60_000 - 1);
    expect((await request(app).get(`${link}/screen`)).status).toBe(200);
    advance(1);
    expect((await request(app).get(`${link}/screen`)).status).toBe(404);
  });

  it('says the session ended when it is gone', async () => {
    const { app, screens } = setup();
    const { path: link } = (await create(app)).body.share;
    screens.s1 = null;
    const feed = await request(app).get(`${link}/screen`);
    expect(feed.body).toMatchObject({ ended: true });
  });

  it('while off, the view is not there (404) and the API refuses (403)', async () => {
    const { app, setEnabled } = setup();
    const { path: link, token } = (await create(app)).body.share;
    setEnabled(false);
    const page = await request(app).get(link);
    expect(page.status).toBe(404);
    expect(page.text).toBe('server 404');
    expect((await request(app).get(`${link}/screen`)).text).toBe('server 404');
    const refused = await create(app);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('disabled');
    expect(
      (await request(app).get('/api/sessions/s1/shares').set('Authorization', `Bearer ${JWT}`))
        .status
    ).toBe(403);
    expect(
      (await request(app).delete(`/api/shares/${token}`).set('Authorization', `Bearer ${JWT}`))
        .status
    ).toBe(403);
    // Logged-out requests still meet the login first.
    expect((await request(app).post('/api/sessions/s1/shares').send({})).status).toBe(401);
    // Turned back on, a link that hasn't expired works again.
    setEnabled(true);
    expect((await request(app).get(`${link}/screen`)).status).toBe(200);
  });

  it('the viewer speaks the visitor’s language from the app’s locale table', async () => {
    const { app } = setup();
    const { path: link } = (await create(app)).body.share;
    const es = await request(app).get(link).set('Accept-Language', 'es-ES,es;q=0.9');
    expect(es.text).toContain('<html lang="es"');
    expect(es.text).toContain(esMessages['shareViewer.title']);
    const ar = await request(app).get(link).set('Accept-Language', 'ar');
    expect(ar.text).toContain('dir="rtl"');
    expect(ar.text).toContain('<pre id="screen" dir="ltr"');
    const fallback = await request(app).get(link).set('Accept-Language', 'xx');
    expect(fallback.text).toContain('Shared session');
  });

  it('picks the locale from Accept-Language', () => {
    expect(viewerLocale(undefined)).toBe('en');
    expect(viewerLocale('pt')).toBe('pt-BR');
    expect(viewerLocale('zh-TW, en;q=0.5')).toBe('zh-CN');
    expect(viewerLocale('de, fr;q=0.8, es;q=0.9')).toBe('es');
    expect(viewerLocale('fr;q=0, hi')).toBe('hi');
  });
});
