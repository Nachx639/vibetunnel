import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isVibeTunnelServer, PreviewHealthMonitor, VIBETUNNEL } from './preview-health.js';
import { PreviewRegistry } from './preview-registry.js';

const servers: http.Server[] = [];
async function serve(headers: Record<string, string>): Promise<number> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', ...headers });
    res.end('<title>App</title>');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

describe('VibeTunnel servers are not dev servers', () => {
  it('isVibeTunnelServer tells VibeTunnel from a dev server and from a closed port', async () => {
    expect(await isVibeTunnelServer(await serve({ 'x-vibetunnel-server': '1' }))).toBe(true);
    expect(await isVibeTunnelServer(await serve({}))).toBe(false);
    const closed = await serve({});
    const server = servers.pop() as http.Server;
    await new Promise((resolve) => server.close(resolve));
    expect(await isVibeTunnelServer(closed)).toBe(false);
  });

  it('the health check reports a row that turns out to be VibeTunnel instead of reading its title', async () => {
    const registry = new PreviewRegistry();
    registry.upsert(7030, { source: 'detected' });
    const onVibeTunnel = vi.fn();
    const monitor = new PreviewHealthMonitor({
      registry,
      probe: async () => '127.0.0.1',
      title: async () => VIBETUNNEL,
      onVibeTunnel,
    });
    expect(await monitor.check(7030)).toBe(false);
    expect(onVibeTunnel).toHaveBeenCalledWith(7030);
    expect(registry.knownTitle(7030)).toBeFalsy();
  });
});
