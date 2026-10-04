import * as net from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { portIsFree, waitForFreePort } from './startup-port';

const holders: net.Server[] = [];

function hold(host = '127.0.0.1'): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    holders.push(server);
    server.once('error', reject);
    server.listen(0, host, () => {
      resolve({ server, port: (server.address() as net.AddressInfo).port });
    });
  });
}

const release = (server: net.Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

afterEach(async () => {
  await Promise.all(holders.splice(0).map((server) => (server.listening ? release(server) : null)));
});

describe('startup port', () => {
  it('tells a port another server listens on from a free one', async () => {
    const { server, port } = await hold();
    expect(await portIsFree(port, '127.0.0.1')).toBe(false);
    await release(server);
    expect(await portIsFree(port, '127.0.0.1')).toBe(true);
  });

  it('checks once and does not wait by default', async () => {
    const { port } = await hold();
    const onWait = vi.fn();
    const started = Date.now();
    expect(await waitForFreePort(port, '127.0.0.1', { onWait })).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(onWait).not.toHaveBeenCalled();
    expect(await waitForFreePort(0, '127.0.0.1')).toBe(true);
  });

  it('waits for a predecessor that is shutting down', async () => {
    const { server, port } = await hold();
    const onWait = vi.fn();
    setTimeout(() => server.close(), 120);
    expect(await waitForFreePort(port, '127.0.0.1', { waitMs: 3000, pollMs: 20, onWait })).toBe(
      true
    );
    expect(onWait).toHaveBeenCalledOnce();
  });

  it('gives up on a port that stays taken, so the caller exits without touching anything', async () => {
    const { port } = await hold();
    const onWait = vi.fn();
    const started = Date.now();
    expect(await waitForFreePort(port, '127.0.0.1', { waitMs: 150, pollMs: 30, onWait })).toBe(
      false
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(onWait).toHaveBeenCalledOnce();
  });

  // macOS binds 0.0.0.0 next to a server on 127.0.0.1 or ::1: a second server started with
  // the default bind took the first one's sessions anyway.
  it.for([
    '127.0.0.1',
    '::1',
  ])('sees a server on %s that a bind on 0.0.0.0 alone would miss', async (host, { skip }) => {
    const held = await hold(host).catch(() => null);
    if (!held) return skip(`no ${host} on this machine`);
    expect(await portIsFree(held.port, '0.0.0.0')).toBe(false);
    expect(await waitForFreePort(held.port, '0.0.0.0', { waitMs: 100, pollMs: 20 })).toBe(false);
    await release(held.server);
    expect(await portIsFree(held.port, '0.0.0.0')).toBe(true);
  });

  it('does not wait at all for a free port or an ephemeral one', async () => {
    const onWait = vi.fn();
    const { server, port } = await hold();
    await release(server);
    expect(await waitForFreePort(port, '127.0.0.1', { onWait })).toBe(true);
    expect(await waitForFreePort(0, '127.0.0.1', { onWait })).toBe(true);
    expect(onWait).not.toHaveBeenCalled();
  });
});
