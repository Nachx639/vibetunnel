import type { Express } from 'express';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuickStartCommand, VibeTunnelConfig } from '../../types/config.js';
import type { ConfigService } from '../services/config-service.js';
import type { MacSessionsStartOptions } from '../services/mac-sessions/settings.js';
import type { MacShareStartOptions } from '../services/mac-sessions/share-settings.js';
import { createConfigRoutes } from './config.js';

// Never the real environment: a developer's VIBETUNNEL_MAC_SESSIONS must not change the answers.
const macOnly = { env: {}, platform: 'darwin' as const };
/** "On this computer" is off unless turned on, and opens ready to type. */
const macSessionsDefaults = {
  macSessions: false,
  macSessionsOpenMode: 'control',
  macSessionsLocked: false,
  macSessionsSupported: true,
  platform: 'darwin',
  // "Share with phone" is off unless turned on, and types `vt <agent> …`.
  macShare: false,
  macShareLauncher: 'vt',
  macShareLocked: false,
  macShareSupported: true,
  macShareReason: 'disabled',
};

describe('Config Routes', () => {
  let app: Express;
  let mockConfigService: ConfigService;

  const defaultConfig: VibeTunnelConfig = {
    version: 1,
    repositoryBasePath: '/home/user/repos',
    quickStartCommands: [
      { name: '✨ claude', command: 'claude' },
      { command: 'zsh' },
      { name: '▶️ pnpm run dev', command: 'pnpm run dev' },
    ],
  };

  beforeEach(() => {
    app = express();
    app.use(express.json());

    // Mock config service
    mockConfigService = {
      getConfig: vi.fn(() => defaultConfig),
      updateQuickStartCommands: vi.fn(),
      updateRepositoryBasePath: vi.fn(),
      updateConfig: vi.fn(),
      startWatching: vi.fn(),
      stopWatching: vi.fn(),
      onConfigChange: vi.fn(),
      getConfigPath: vi.fn(() => '/home/user/.vibetunnel/config.json'),
      getNotificationPreferences: vi.fn(),
      updateNotificationPreferences: vi.fn(),
    } as unknown as ConfigService;

    // Create routes
    const configRoutes = createConfigRoutes({
      configService: mockConfigService,
      macSessions: macOnly,
    });

    app.use('/api', configRoutes);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/config', () => {
    it('should return application configuration', async () => {
      const response = await request(app).get('/api/config');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        repositoryBasePath: '/home/user/repos',
        serverConfigured: true,
        quickStartCommands: defaultConfig.quickStartCommands,
        agentChat: false,
        ...macSessionsDefaults,
      });

      expect(mockConfigService.getConfig).toHaveBeenCalledOnce();
    });

    it('should use default repository path when not configured', async () => {
      mockConfigService.getConfig = vi.fn(() => ({
        ...defaultConfig,
        repositoryBasePath: null,
      }));

      const response = await request(app).get('/api/config');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        repositoryBasePath: '~/Documents',
        serverConfigured: true,
        quickStartCommands: defaultConfig.quickStartCommands,
        agentChat: false,
        ...macSessionsDefaults,
      });
    });

    it('should handle config service errors', async () => {
      mockConfigService.getConfig = vi.fn(() => {
        throw new Error('Config read error');
      });

      const response = await request(app).get('/api/config');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to get app config',
      });
    });
  });

  describe('agentChat', () => {
    const saved = process.env.VIBETUNNEL_AGENT_CHAT;
    afterEach(() => {
      if (saved === undefined) delete process.env.VIBETUNNEL_AGENT_CHAT;
      else process.env.VIBETUNNEL_AGENT_CHAT = saved;
    });

    it('is off unless config.json or VIBETUNNEL_AGENT_CHAT turns it on', async () => {
      delete process.env.VIBETUNNEL_AGENT_CHAT;
      expect((await request(app).get('/api/config')).body.agentChat).toBe(false);
      mockConfigService.getConfig = vi.fn(() => ({ ...defaultConfig, agentChat: true }));
      expect((await request(app).get('/api/config')).body.agentChat).toBe(true);
      process.env.VIBETUNNEL_AGENT_CHAT = '0';
      expect((await request(app).get('/api/config')).body.agentChat).toBe(false);
    });

    it('cannot be turned on from the web UI', async () => {
      const response = await request(app)
        .put('/api/config')
        .send({ agentChat: true, repositoryBasePath: '/x' });
      expect(response.status).toBe(200);
      const written = vi.mocked(mockConfigService.updateConfig).mock.calls.map((c) => c[0]);
      for (const config of written) expect(config).not.toHaveProperty('agentChat', true);
    });
  });

  describe('PUT /api/config', () => {
    it('should update quick start commands', async () => {
      const newCommands: QuickStartCommand[] = [
        { command: 'python3' },
        { name: '🚀 node', command: 'node' },
      ];

      const response = await request(app)
        .put('/api/config')
        .send({ quickStartCommands: newCommands });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        quickStartCommands: newCommands,
      });

      expect(mockConfigService.updateConfig).toHaveBeenCalledWith({
        ...defaultConfig,
        quickStartCommands: newCommands,
      });
    });

    it('should filter out empty commands', async () => {
      const commandsWithEmpty: QuickStartCommand[] = [
        { command: 'python3' },
        { command: '' }, // Empty command
        { name: 'Empty', command: '   ' }, // Whitespace only
        { name: '🚀 node', command: 'node' },
      ];

      const expectedFiltered: QuickStartCommand[] = [
        { command: 'python3' },
        { name: '🚀 node', command: 'node' },
      ];

      const response = await request(app)
        .put('/api/config')
        .send({ quickStartCommands: commandsWithEmpty });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        quickStartCommands: expectedFiltered,
      });

      expect(mockConfigService.updateConfig).toHaveBeenCalledWith({
        ...defaultConfig,
        quickStartCommands: expectedFiltered,
      });
    });

    it('should validate command structure', async () => {
      const invalidCommands = [
        { command: 'valid' },
        { notCommand: 'invalid' }, // Missing command field
        null, // Null entry
        { command: 123 }, // Invalid type
      ];

      const expectedValid = [{ command: 'valid' }];

      const response = await request(app)
        .put('/api/config')
        .send({ quickStartCommands: invalidCommands });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        quickStartCommands: expectedValid,
      });

      expect(mockConfigService.updateConfig).toHaveBeenCalledWith({
        ...defaultConfig,
        quickStartCommands: expectedValid,
      });
    });

    it('should return 400 for missing quickStartCommands', async () => {
      const response = await request(app).put('/api/config').send({});

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: 'No valid updates provided',
      });

      expect(mockConfigService.updateQuickStartCommands).not.toHaveBeenCalled();
    });

    it('should return 400 for non-array quickStartCommands', async () => {
      const response = await request(app)
        .put('/api/config')
        .send({ quickStartCommands: 'not-an-array' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: 'No valid updates provided',
      });

      expect(mockConfigService.updateQuickStartCommands).not.toHaveBeenCalled();
    });

    it('should handle config service update errors', async () => {
      mockConfigService.updateConfig = vi.fn(() => {
        throw new Error('Write error');
      });

      const response = await request(app)
        .put('/api/config')
        .send({ quickStartCommands: [{ command: 'test' }] });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to update config',
      });
    });

    it('should allow empty array of commands', async () => {
      const response = await request(app).put('/api/config').send({ quickStartCommands: [] });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        quickStartCommands: [],
      });

      expect(mockConfigService.updateConfig).toHaveBeenCalledWith({
        ...defaultConfig,
        quickStartCommands: [],
      });
    });

    it('should preserve optional name field', async () => {
      const commandsWithNames: QuickStartCommand[] = [
        { name: 'Python REPL', command: 'python3' },
        { command: 'node' }, // No name
        { name: undefined, command: 'bash' }, // Explicitly undefined
      ];

      const response = await request(app)
        .put('/api/config')
        .send({ quickStartCommands: commandsWithNames });

      expect(response.status).toBe(200);
      expect(mockConfigService.updateConfig).toHaveBeenCalledWith({
        ...defaultConfig,
        quickStartCommands: commandsWithNames,
      });
    });

    it('should update repository base path', async () => {
      const newPath = '/new/repo/path';

      const response = await request(app).put('/api/config').send({ repositoryBasePath: newPath });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        repositoryBasePath: newPath,
      });

      expect(mockConfigService.updateConfig).toHaveBeenCalledWith({
        ...defaultConfig,
        repositoryBasePath: newPath,
      });
    });

    it('should update both repository base path and quick start commands', async () => {
      const newPath = '/new/repo/path';
      const newCommands = [{ command: 'test' }];

      const response = await request(app).put('/api/config').send({
        repositoryBasePath: newPath,
        quickStartCommands: newCommands,
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        repositoryBasePath: newPath,
        quickStartCommands: newCommands,
      });

      expect(mockConfigService.updateConfig).toHaveBeenCalledOnce();
      expect(mockConfigService.updateConfig).toHaveBeenCalledWith({
        ...defaultConfig,
        repositoryBasePath: newPath,
        quickStartCommands: newCommands,
      });
    });

    it('should reject invalid repository base path', async () => {
      const response = await request(app).put('/api/config').send({ repositoryBasePath: 123 }); // Not a string

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: 'No valid updates provided',
      });

      expect(mockConfigService.updateRepositoryBasePath).not.toHaveBeenCalled();
    });
  });

  describe('notification preferences', () => {
    describe('GET /api/config with notification preferences', () => {
      it('should include notification preferences in response', async () => {
        const notificationPreferences = {
          enabled: true,
          sessionStart: false,
          sessionExit: true,
          commandCompletion: true,
          commandError: true,
          bell: true,
        };

        mockConfigService.getNotificationPreferences = vi.fn(() => notificationPreferences);

        const response = await request(app).get('/api/config');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
          repositoryBasePath: '/home/user/repos',
          serverConfigured: true,
          quickStartCommands: defaultConfig.quickStartCommands,
          agentChat: false,
          notificationPreferences,
          ...macSessionsDefaults,
        });
      });

      it('should handle missing notification preferences', async () => {
        mockConfigService.getNotificationPreferences = vi.fn(() => undefined);

        const response = await request(app).get('/api/config');

        expect(response.status).toBe(200);
        expect(response.body.notificationPreferences).toBeUndefined();
      });
    });

    describe('PUT /api/config with notification preferences', () => {
      it('should update notification preferences', async () => {
        const newPreferences = {
          enabled: false,
          sessionStart: true,
          sessionExit: false,
          commandCompletion: false,
          commandError: false,
          bell: false,
        };

        const response = await request(app)
          .put('/api/config')
          .send({ notificationPreferences: newPreferences });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
          success: true,
          notificationPreferences: newPreferences,
        });

        expect(mockConfigService.updateConfig).toHaveBeenCalledWith(
          expect.objectContaining({
            preferences: expect.objectContaining({
              notifications: expect.objectContaining(newPreferences),
            }),
          })
        );
      });

      it('should update notification preferences along with other settings', async () => {
        const newPath = '/new/repository/path';
        const newPreferences = {
          enabled: true,
          sessionStart: true,
          sessionExit: true,
          commandCompletion: true,
          commandError: true,
          bell: true,
        };

        const response = await request(app).put('/api/config').send({
          repositoryBasePath: newPath,
          notificationPreferences: newPreferences,
        });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
          success: true,
          repositoryBasePath: newPath,
          notificationPreferences: newPreferences,
        });

        expect(mockConfigService.updateConfig).toHaveBeenCalledOnce();
        expect(mockConfigService.updateConfig).toHaveBeenCalledWith(
          expect.objectContaining({
            repositoryBasePath: newPath,
            preferences: expect.objectContaining({
              notifications: expect.objectContaining(newPreferences),
            }),
          })
        );
      });

      it('should reject invalid notification preferences', async () => {
        const response = await request(app)
          .put('/api/config')
          .send({ notificationPreferences: 'invalid' }); // Not an object

        expect(response.status).toBe(400);
        expect(response.body).toEqual({
          error: 'No valid updates provided',
        });

        expect(mockConfigService.updateNotificationPreferences).not.toHaveBeenCalled();
      });
    });
  });

  describe('Mac sessions', () => {
    function macApp(config: Partial<VibeTunnelConfig>, macSessions: MacSessionsStartOptions) {
      const macApp = express();
      macApp.use(express.json());
      macApp.use(
        '/api',
        createConfigRoutes({
          configService: {
            ...mockConfigService,
            getConfig: () => ({ ...defaultConfig, ...config }),
          } as unknown as ConfigService,
          macSessions,
        })
      );
      return macApp;
    }

    it('are off unless turned on, and open ready to type unless chosen otherwise', async () => {
      let response = await request(app).get('/api/config');
      expect(response.body).toMatchObject(macSessionsDefaults);
      expect(response.body.macSessionsLockedBy).toBeUndefined();

      response = await request(
        macApp({ macSessions: true, macSessionsOpenMode: 'watch' }, macOnly)
      ).get('/api/config');
      expect(response.body).toMatchObject({
        macSessions: true,
        macSessionsOpenMode: 'watch',
        macSessionsLocked: false,
      });
    });

    it('a switch forced at start wins over config.json and is reported locked', async () => {
      const env = { VIBETUNNEL_MAC_SESSIONS: '0' };
      let response = await request(macApp({ macSessions: true }, { ...macOnly, env })).get(
        '/api/config'
      );
      expect(response.body).toMatchObject({
        macSessions: false,
        macSessionsLocked: true,
        macSessionsLockedBy: 'VIBETUNNEL_MAC_SESSIONS=0',
      });

      response = await request(macApp({}, { ...macOnly, cliEnabled: true })).get('/api/config');
      expect(response.body).toMatchObject({
        macSessions: true,
        macSessionsLockedBy: '--mac-sessions',
      });

      response = await request(macApp({}, { ...macOnly, cliDisabled: true })).get('/api/config');
      expect(response.body).toMatchObject({
        macSessions: false,
        macSessionsLockedBy: '--no-mac-sessions',
      });
    });

    it('are not offered where nothing can be listed', async () => {
      for (const options of [
        { ...macOnly, platform: 'win32' as const },
        { ...macOnly, hqMode: true },
      ]) {
        const response = await request(macApp({}, options)).get('/api/config');
        expect(response.body.macSessionsSupported).toBe(false);
      }
    });

    it("say which platform the server runs on, for Settings' words", async () => {
      const linux = await request(macApp({}, { ...macOnly, platform: 'linux' })).get('/api/config');
      expect(linux.body.platform).toBe('linux');
      const mac = await request(macApp({}, macOnly)).get('/api/config');
      expect(mac.body.platform).toBe('darwin');
    });

    it('PUT saves the switch and the open mode', async () => {
      const response = await request(app)
        .put('/api/config')
        .send({ macSessions: true, macSessionsOpenMode: 'watch' });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        macSessions: true,
        macSessionsOpenMode: 'watch',
      });
      expect(mockConfigService.updateConfig).toHaveBeenCalledWith({
        ...defaultConfig,
        macSessions: true,
        macSessionsOpenMode: 'watch',
      });
    });

    it('PUT refuses an open mode other than control or watch, and a switch that is not a boolean', async () => {
      for (const body of [
        { macSessionsOpenMode: 'type' },
        { macSessionsOpenMode: '' },
        { macSessionsOpenMode: null },
        { macSessionsOpenMode: ['watch'] },
        { macSessions: 'yes' },
        { macSessions: 1 },
      ]) {
        const response = await request(app).put('/api/config').send(body);
        expect(response.status, JSON.stringify(body)).toBe(400);
      }
      expect(mockConfigService.updateConfig).not.toHaveBeenCalled();
    });
  });
  describe('Share with phone', () => {
    function shareApp(config: Partial<VibeTunnelConfig>, macShare: MacShareStartOptions) {
      const shareApp = express();
      shareApp.use(express.json());
      shareApp.use(
        '/api',
        createConfigRoutes({
          configService: {
            ...mockConfigService,
            getConfig: () => ({ ...defaultConfig, ...config }),
          } as unknown as ConfigService,
          macSessions: macOnly,
          macShare,
        })
      );
      return shareApp;
    }

    it('is off until turned on, and then offered with the launcher chosen', async () => {
      const off = await request(shareApp({}, macOnly)).get('/api/config');
      expect(off.body).toMatchObject({ macShare: false, macShareReason: 'disabled' });

      const response = await request(
        shareApp({ macSessions: true, macShare: true, macShareLauncher: 'shell' }, macOnly)
      ).get('/api/config');
      expect(response.body).toMatchObject({
        macShare: true,
        macShareLauncher: 'shell',
        macShareLocked: false,
        macShareSupported: true,
      });
      expect(response.body).not.toHaveProperty('macShareReason');
      expect(response.body).not.toHaveProperty('macShareLockedBy');
    });

    it('a switch forced at start wins over config.json and is reported locked', async () => {
      let response = await request(
        shareApp(
          { macSessions: true, macShare: false },
          { ...macOnly, env: { VIBETUNNEL_MAC_SHARE: '1' } }
        )
      ).get('/api/config');
      expect(response.body).toMatchObject({
        macShare: true,
        macShareLocked: true,
        macShareLockedBy: 'VIBETUNNEL_MAC_SHARE=1',
      });

      response = await request(
        shareApp({ macSessions: true }, { ...macOnly, shareCliEnabled: true })
      ).get('/api/config');
      expect(response.body).toMatchObject({
        macShare: true,
        macShareLocked: true,
        macShareLockedBy: '--mac-share',
      });

      response = await request(
        shareApp(
          { macShare: true },
          { ...macOnly, env: { VIBETUNNEL_MAC_SHARE: '1' }, shareCliDisabled: true }
        )
      ).get('/api/config');
      expect(response.body).toMatchObject({
        macShare: false,
        macShareLocked: true,
        macShareLockedBy: '--no-mac-share',
        macShareReason: 'disabled',
      });
    });

    it('says why it is not offered while on: no login, or "On this computer" off', async () => {
      let response = await request(
        shareApp({ macSessions: true, macShare: true }, { ...macOnly, noAuth: true })
      ).get('/api/config');
      expect(response.body).toMatchObject({ macShare: true, macShareReason: 'no-auth' });

      response = await request(shareApp({ macShare: true }, macOnly)).get('/api/config');
      expect(response.body.macShareReason).toBe('mac-sessions-off');
    });

    it('is not offered off macOS or in HQ mode, without a reason to show', async () => {
      for (const options of [
        { ...macOnly, platform: 'linux' as const },
        { ...macOnly, hqMode: true },
      ]) {
        const response = await request(shareApp({ macShare: true }, options)).get('/api/config');
        expect(response.body.macShareSupported).toBe(false);
        expect(response.body).not.toHaveProperty('macShareReason');
      }
    });

    it('PUT saves the switch and the launcher', async () => {
      const response = await request(app)
        .put('/api/config')
        .send({ macShare: true, macShareLauncher: 'shell' });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, macShare: true, macShareLauncher: 'shell' });
      expect(mockConfigService.updateConfig).toHaveBeenCalledWith({
        ...defaultConfig,
        macShare: true,
        macShareLauncher: 'shell',
      });
    });

    it('PUT refuses another launcher, a switch that is not a boolean, and config.json-only keys', async () => {
      for (const body of [
        { macShareLauncher: 'zsh' },
        { macShareLauncher: '' },
        { macShareLauncher: null },
        { macShare: 'yes' },
        { macShare: 1 },
        { macShareVtPath: '/tmp/vt' },
        { macShareCodex: true },
        { macShareAutoTrust: false },
        { macShareStartTimeoutSec: 60 },
      ]) {
        const response = await request(app).put('/api/config').send(body);
        expect(response.status, JSON.stringify(body)).toBe(400);
      }
      expect(mockConfigService.updateConfig).not.toHaveBeenCalled();
    });
  });
});
