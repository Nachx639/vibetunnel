import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAuthMiddleware } from '../middleware/auth.js';
import type { AuthService } from '../services/auth-service.js';
import { createFilesystemRoutes } from './filesystem.js';

vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

/**
 * The file browser previews images through /api/fs/raw. An `<img src>` can't send the Bearer
 * header, so the client fetches the bytes with it and shows a blob URL. These tests pin the
 * server side of that contract: raw file content is never served without credentials.
 */
describe('filesystem routes behind the auth middleware', () => {
  let dir: string;
  let file: string;
  let app: express.Express;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-fs-auth-'));
    file = path.join(dir, 'pixel.png');
    fs.writeFileSync(file, 'png-bytes');

    const authService = {
      verifyToken: vi.fn((token: string) =>
        token === 'good-token' ? { valid: true, userId: 'alice' } : { valid: false }
      ),
    } as unknown as AuthService;

    app = express();
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
    app.use('/api', createFilesystemRoutes());
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses raw file content without credentials', async () => {
    const res = await request(app).get('/api/fs/raw').query({ path: file });
    expect(res.status).toBe(401);
    expect(res.text).not.toContain('png-bytes');
  });

  it('refuses raw file content with a bad token', async () => {
    const res = await request(app)
      .get('/api/fs/raw')
      .query({ path: file })
      .set('Authorization', 'Bearer forged');
    expect(res.status).toBe(401);
  });

  it('refuses previews and listings without credentials', async () => {
    expect((await request(app).get('/api/fs/preview').query({ path: file })).status).toBe(401);
    expect((await request(app).get('/api/fs/browse').query({ path: dir })).status).toBe(401);
  });

  it('serves the bytes with the Bearer header the client now sends', async () => {
    const res = await request(app)
      .get('/api/fs/raw')
      .query({ path: file })
      .set('Authorization', 'Bearer good-token')
      .buffer(true)
      .parse((response, done) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect((res.body as Buffer).toString()).toBe('png-bytes');
  });
});
