import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Real unix socket in a throwaway control dir: `vt preview` → api.sock → server handler.
const dir = mkdtempSync(join(tmpdir(), 'vtp-sock-'));
process.env.VIBETUNNEL_CONTROL_DIR = dir;

describe('vt preview over the API socket', () => {
  let server: import('./api-socket-server.js').ApiSocketServer;

  beforeAll(async () => {
    const { ApiSocketServer } = await import('./api-socket-server.js');
    server = new ApiSocketServer();
    server.setPreviewOpenHandler(({ sessionId, target }) =>
      sessionId === 's1' && target === '5173'
        ? { success: true, port: 5173, path: '/' }
        : { success: false, error: 'unknown session' }
    );
    await server.start();
  });

  afterAll(() => {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('asks the server to open the preview of the current session', async () => {
    const { SocketApiClient } = await import('./socket-api-client.js');
    const client = new SocketApiClient();
    expect(await client.openPreview({ sessionId: 's1', target: '5173' })).toEqual({
      success: true,
      port: 5173,
      path: '/',
    });
    expect(await client.openPreview({ sessionId: 'nope', target: '5173' })).toEqual({
      success: false,
      error: 'unknown session',
    });
  });
});
