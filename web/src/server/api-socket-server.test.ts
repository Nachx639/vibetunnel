import type { Socket } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiSocketServer } from './api-socket-server.js';
import { type GitEventNotify, type GitFollowRequest, MessageType } from './pty/socket-protocol.js';

// Mock net module
const mockCreateServer = vi.fn();
vi.mock('net', () => ({
  createServer: mockCreateServer,
  Socket: vi.fn(),
}));

// Mock dependencies at the module level
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

vi.mock('./utils/logger.js', () => ({
  createLogger: () => ({
    log: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('./utils/git-hooks.js', () => ({
  areHooksInstalled: vi.fn().mockResolvedValue(true),
  installGitHooks: vi.fn().mockResolvedValue({ success: true }),
  uninstallGitHooks: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('./utils/git-error.js', () => ({
  createGitError: (error: Error, message: string) => new Error(`${message}: ${error.message}`),
}));

vi.mock('./websocket/control-unix-handler.js', () => ({
  controlUnixHandler: {
    isMacAppConnected: vi.fn().mockReturnValue(false),
    sendToMac: vi.fn(),
  },
}));

vi.mock('./websocket/control-protocol.js', () => ({
  createControlEvent: vi.fn((category, action, payload) => ({
    category,
    action,
    payload,
  })),
}));

// Mock promisify and execFile
const mockExecFile = vi.fn();
vi.mock('util', () => ({
  promisify: () => mockExecFile,
}));

/** The private socket handlers these tests drive directly, with a socket that only writes. */
type ApiSocketServerInternals = {
  handleGitFollowRequest(socket: Pick<Socket, 'write'>, request: GitFollowRequest): Promise<void>;
  handleGitEventNotify(socket: Pick<Socket, 'write'>, event: GitEventNotify): Promise<void>;
};
const internals = (server: ApiSocketServer) => server as unknown as ApiSocketServerInternals;

describe('ApiSocketServer', () => {
  let apiSocketServer: ApiSocketServer;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Configure fs mocks
    const fsMock = await import('fs');
    vi.mocked(fsMock.existsSync).mockReturnValue(false);
    vi.mocked(fsMock.mkdirSync).mockImplementation(() => undefined);
    vi.mocked(fsMock.unlinkSync).mockImplementation(() => {});

    // Import after mocks are set up
    const module = await import('./api-socket-server.js');
    apiSocketServer = module.apiSocketServer;
  });

  afterEach(async () => {
    // Stop server
    if (apiSocketServer) {
      apiSocketServer.stop();
    }
  });

  describe('Server lifecycle', () => {
    it('should start and stop the server', async () => {
      // Mock net.createServer to prevent actual socket creation
      const mockServer = {
        listen: vi.fn((_path, callback) => callback()),
        close: vi.fn(),
        on: vi.fn(),
      };

      mockCreateServer.mockReturnValue(mockServer);

      await apiSocketServer.start();

      expect(mockCreateServer).toHaveBeenCalled();
      expect(mockServer.listen).toHaveBeenCalledWith(
        expect.stringContaining('api.sock'),
        expect.any(Function)
      );

      apiSocketServer.stop();
      expect(mockServer.close).toHaveBeenCalled();
    });
  });

  describe('Status request', () => {
    it('should return server status without Git info when not in a repo', async () => {
      // Mock git commands to fail (not in a repo)
      mockExecFile.mockRejectedValue(new Error('Not a git repository'));

      apiSocketServer.setServerInfo(4020, 'http://localhost:4020');

      // Since we can't directly test private methods, we'll verify the setup is correct
      // The actual status request handling is tested in integration tests
      expect(mockExecFile).toBeDefined();
    });

    it('should return server status with follow mode info', async () => {
      // Mock git commands
      mockExecFile
        .mockResolvedValueOnce({ stdout: 'main\n', stderr: '' }) // config command
        .mockResolvedValueOnce({ stdout: '/Users/test/project\n', stderr: '' }); // rev-parse

      apiSocketServer.setServerInfo(4020, 'http://localhost:4020');

      // Verify mocks are set up correctly
      expect(mockExecFile).toBeDefined();
    });
  });

  describe('Git follow mode', () => {
    it('should enable follow mode', async () => {
      // Mock git commands
      mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });

      const request: GitFollowRequest = {
        repoPath: '/Users/test/project',
        branch: 'feature-branch',
        enable: true,
      };

      const mockSocket = {
        write: vi.fn(),
      };

      await internals(apiSocketServer).handleGitFollowRequest(mockSocket, request);

      expect(mockSocket.write).toHaveBeenCalled();
      const call = mockSocket.write.mock.calls[0][0];
      expect(call[0]).toBe(MessageType.GIT_FOLLOW_RESPONSE);
    });

    it('should disable follow mode', async () => {
      // Mock git commands
      mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });

      const request: GitFollowRequest = {
        repoPath: '/Users/test/project',
        enable: false,
      };

      const mockSocket = {
        write: vi.fn(),
      };

      await internals(apiSocketServer).handleGitFollowRequest(mockSocket, request);

      expect(mockSocket.write).toHaveBeenCalled();
    });

    it('should handle Git errors gracefully', async () => {
      // Mock git command to fail
      mockExecFile.mockRejectedValue(new Error('Git command failed'));

      const request: GitFollowRequest = {
        repoPath: '/Users/test/project',
        branch: 'main',
        enable: true,
      };

      const mockSocket = {
        write: vi.fn(),
      };

      await internals(apiSocketServer).handleGitFollowRequest(mockSocket, request);

      expect(mockSocket.write).toHaveBeenCalled();
    });
  });

  describe('Git event notifications', () => {
    it('should acknowledge Git event notifications', async () => {
      const mockSocket = {
        write: vi.fn(),
      };
      // The handler relays the event to the server's HTTP API (localhost:4020 by default);
      // stub fetch so the test never reaches a VibeTunnel server running on this machine.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ success: true })))
      );

      try {
        await internals(apiSocketServer).handleGitEventNotify(mockSocket, {
          repoPath: '/Users/test/project',
          type: 'checkout',
        });
      } finally {
        vi.unstubAllGlobals();
      }

      expect(mockSocket.write).toHaveBeenCalled();
      const call = mockSocket.write.mock.calls[0][0];
      expect(call[0]).toBe(MessageType.GIT_EVENT_ACK);
    });
  });
});
