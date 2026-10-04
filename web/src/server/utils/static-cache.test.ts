import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staticFileOptions } from './static-cache.js';

describe('static file caching', () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-static-'));
    fs.mkdirSync(path.join(dir, 'bundle'));
    fs.writeFileSync(path.join(dir, 'bundle', 'client-bundle.js'), 'console.log(1);');
    fs.writeFileSync(path.join(dir, 'bundle', 'styles.css'), 'body{}');
    fs.writeFileSync(path.join(dir, 'font.woff2'), 'font');
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const appFor = (isDevelopment: boolean) =>
    express().use(express.static(dir, staticFileOptions(isDevelopment)));

  it.each([
    false,
    true,
  ])('revalidates the bundle (development: %s): no-cache, then 304 for an unchanged file', async (isDevelopment) => {
    const app = appFor(isDevelopment);
    for (const file of ['/bundle/client-bundle.js', '/bundle/styles.css']) {
      const first = await request(app).get(file);
      expect(first.status).toBe(200);
      expect(first.headers['cache-control']).toBe('no-cache');
      expect(first.headers.etag).toBeTruthy();
      const again = await request(app).get(file).set('If-None-Match', first.headers.etag);
      expect(again.status).toBe(304);
    }
  });

  it('caches fonts for a year in production', async () => {
    const res = await request(appFor(false)).get('/font.woff2');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });
});
