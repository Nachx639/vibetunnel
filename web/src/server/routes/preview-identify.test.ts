import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isVibeTunnelServer } from '../services/preview-health.js';
import { createPreviewProxy } from '../services/preview-proxy.js';
import { PreviewRegistry } from '../services/preview-registry.js';
import { createPreviewRoutes } from './preview.js';

// Other VibeTunnel servers (a second one on 7030, say) are found by asking the port, before
// anything is added or opened, so VibeTunnel is never previewed through itself.
describe('another VibeTunnel server is never added or opened as a preview', () => {
  const servers: http.Server[] = [];
  let otherVibeTunnel = 0;
  let devServer = 0;
  const registry = new PreviewRegistry();
  const proxy = createPreviewProxy({
    getOwnPorts: () => [7020, 7021],
    onVibeTunnelPort: () => registry.removeRefused(),
  });
  registry.setPortFilter((port) => proxy.portError(port));
  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    createPreviewRoutes({
      previewProxy: proxy,
      previewRegistry: registry,
      getOwnPort: () => 7020,
      getPreviewPort: () => 7021,
      sessionExists: (id) => id === 's1',
      identifyPort: async (port) => {
        if (await isVibeTunnelServer(port)) proxy.noteVibeTunnelPort(port);
      },
    })
  );

  const listen = async (headers: Record<string, string>) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', ...headers });
      res.end('<title>x</title>');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  };

  beforeAll(async () => {
    otherVibeTunnel = await listen({ 'x-vibetunnel-server': '1' });
    devServer = await listen({});
  });

  afterAll(async () => {
    for (const server of servers) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('"+ Add preview", a ticket and the in-session open all refuse it', async () => {
    const add = await request(app).post('/api/previews').send({ port: otherVibeTunnel });
    expect(add.status).toBe(403);
    expect(add.body.error).toContain('another VibeTunnel server');
    const ticket = await request(app)
      .post('/api/preview/ticket')
      .set('Origin', 'http://vt.test:7020')
      .send({ port: otherVibeTunnel });
    expect(ticket.status).toBe(403);
    const open = await request(app)
      .post('/api/sessions/s1/preview/open')
      .send({ target: String(otherVibeTunnel) });
    expect(open.status).toBe(403);
    expect(registry.ports()).toEqual([]);
  });

  it('a dev server is still added', async () => {
    const add = await request(app).post('/api/previews').send({ port: devServer });
    expect(add.status).toBe(201);
    expect(registry.ports()).toEqual([devServer]);
  });

  it("VibeTunnel's own port is refused without asking it", async () => {
    const add = await request(app).post('/api/previews').send({ port: 7020 });
    expect(add.status).toBe(403);
    expect(add.body.error).toContain("VibeTunnel's own port");
  });
});
