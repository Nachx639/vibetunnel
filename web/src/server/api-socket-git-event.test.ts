import type { Socket } from 'net';
import { describe, expect, it, vi } from 'vitest';
import type { ApiSocketServer } from './api-socket-server.js';
import { type GitEventNotify, MessageType } from './pty/socket-protocol.js';

const mockCreateServer = vi.fn();
vi.mock('net', () => ({ createServer: mockCreateServer, Socket: vi.fn() }));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    chmodSync: vi.fn(),
  };
});

vi.mock('./utils/logger.js', () => ({
  createLogger: () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

type Internals = {
  handleGitEventNotify(socket: Pick<Socket, 'write'>, event: GitEventNotify): Promise<void>;
};

async function server(): Promise<ApiSocketServer> {
  return (await import('./api-socket-server.js')).apiSocketServer;
}

function ackOf(socket: { write: ReturnType<typeof vi.fn> }) {
  const frame = socket.write.mock.calls[0][0] as Buffer;
  expect(frame[0]).toBe(MessageType.GIT_EVENT_ACK);
  return JSON.parse(frame.subarray(5).toString('utf8')) as { handled: boolean };
}

describe('the API socket and `vt git-event`', () => {
  it('handles the event in-process, never over HTTP', async () => {
    const api = await server();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const handler = vi.fn(async () => ({ status: 200 }));
    try {
      api.setGitEventHandler(handler);
      const socket = { write: vi.fn() };
      await (api as unknown as Internals).handleGitEventNotify(socket, {
        repoPath: '/Users/test/project',
        type: 'commit',
      });
      expect(handler).toHaveBeenCalledWith({ repoPath: '/Users/test/project', event: 'commit' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(ackOf(socket)).toEqual({ handled: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('acknowledges a failed event as not handled', async () => {
    const api = await server();
    api.setGitEventHandler(async () => ({ status: 400 }));
    const socket = { write: vi.fn() };
    await (api as unknown as Internals).handleGitEventNotify(socket, {
      repoPath: '',
      type: 'checkout',
    });
    expect(ackOf(socket)).toEqual({ handled: false });
  });

  it('restricts the socket to its owner', async () => {
    const api = await server();
    mockCreateServer.mockReturnValue({
      listen: vi.fn((_path: string, callback: () => void) => callback()),
      close: vi.fn(),
      on: vi.fn(),
    });
    await api.start();
    const fs = await import('fs');
    expect(fs.chmodSync).toHaveBeenCalledWith(expect.stringContaining('api.sock'), 0o600);
    api.stop();
  });
});
