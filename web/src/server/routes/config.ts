import { Router } from 'express';
import { z } from 'zod';
import { DEFAULT_REPOSITORY_BASE_PATH } from '../../shared/constants.js';
import type { MacOpenMode } from '../../shared/mac-sessions.js';
import type { MacShareLauncher, MacShareOffReason } from '../../shared/mac-share.js';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferences,
  type QuickStartCommand,
  type VibeTunnelConfig,
} from '../../types/config.js';
import {
  type ConfigService,
  MacOpenModeSchema,
  MacShareLauncherSchema,
} from '../services/config-service.js';
import {
  type MacSessionsStartOptions,
  macSessionsSettings,
} from '../services/mac-sessions/settings.js';
import {
  type MacShareStartOptions,
  macShareSettings,
} from '../services/mac-sessions/share-settings.js';
import { agentChatEnabled } from '../utils/agent-chat.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('config');

// Validation schemas
const NotificationPreferencesSchema = z
  .object({
    enabled: z.boolean(),
    sessionStart: z.boolean(),
    sessionExit: z.boolean(),
    commandCompletion: z.boolean(),
    commandError: z.boolean(),
    bell: z.boolean(),
    soundEnabled: z.boolean(),
    vibrationEnabled: z.boolean(),
    agentStatus: z.boolean().optional(),
  })
  .partial();

const QuickStartCommandSchema = z.object({
  name: z.string().optional(),
  command: z.string().min(1).trim(),
});

export interface AppConfig {
  repositoryBasePath: string;
  serverConfigured?: boolean;
  quickStartCommands?: QuickStartCommand[];
  /** Phone chat view of agent conversations (config.json `agentChat` or VIBETUNNEL_AGENT_CHAT). */
  agentChat: boolean;
  notificationPreferences?: NotificationPreferences;
  /** "On this computer" in the session list: the switch, forced or from config.json (default off). */
  macSessions: boolean;
  /** What a tap on a tmux session there opens (default control: ready to type). */
  macSessionsOpenMode: MacOpenMode;
  /** The switch was forced when the server started; macSessionsLockedBy names how. */
  macSessionsLocked: boolean;
  macSessionsLockedBy?: string;
  /** False where nothing can be listed (not macOS or Linux, HQ mode): Settings hides it. */
  macSessionsSupported: boolean;
  /** "Share with phone": the switch, forced or from config.json (default off). */
  macShare: boolean;
  /** What is typed to reopen an agent (default vt). */
  macShareLauncher: MacShareLauncher;
  /** The switch was forced when the server started; macShareLockedBy names how. */
  macShareLocked: boolean;
  macShareLockedBy?: string;
  /** False off macOS and in HQ mode: Settings hides it. */
  macShareSupported: boolean;
  /** Why it isn't offered although supported: off, "On this computer" off, or no login. */
  macShareReason?: MacShareOffReason;
  /** The server's platform ("darwin", "linux"…): the app says "this Mac" only on macOS. */
  platform: string;
}

interface ConfigRouteOptions {
  configService: ConfigService;
  /** How the server was started, for the Mac sessions switch (--[no-]mac-sessions, HQ mode). */
  macSessions?: MacSessionsStartOptions;
  /** Same, for "Share with phone" (--[no-]mac-share, --no-auth); defaults to macSessions. */
  macShare?: MacShareStartOptions;
}

/**
 * Create routes for application configuration
 */
export function createConfigRoutes(options: ConfigRouteOptions): Router {
  const router = Router();
  const { configService } = options;

  /**
   * Get application configuration
   * GET /api/config
   */
  router.get('/config', (_req, res) => {
    try {
      const vibeTunnelConfig = configService.getConfig();
      const repositoryBasePath =
        vibeTunnelConfig.repositoryBasePath || DEFAULT_REPOSITORY_BASE_PATH;
      const macSessions = macSessionsSettings(vibeTunnelConfig, options.macSessions);
      const macShare = macShareSettings(vibeTunnelConfig, options.macShare ?? options.macSessions);

      const config: AppConfig = {
        repositoryBasePath: repositoryBasePath,
        serverConfigured: true, // Always configured when server is running
        quickStartCommands: vibeTunnelConfig.quickStartCommands,
        agentChat: agentChatEnabled(vibeTunnelConfig),
        notificationPreferences: configService.getNotificationPreferences(),
        macSessions: macSessions.on,
        macSessionsOpenMode: macSessions.openMode,
        macSessionsLocked: macSessions.lockedBy !== undefined,
        ...(macSessions.lockedBy ? { macSessionsLockedBy: macSessions.lockedBy } : {}),
        macSessionsSupported: macSessions.supported,
        macShare: macShare.on,
        macShareLauncher: macShare.launcher,
        macShareLocked: macShare.lockedBy !== undefined,
        ...(macShare.lockedBy ? { macShareLockedBy: macShare.lockedBy } : {}),
        macShareSupported: macShare.supported,
        ...(macShare.reason && macShare.supported ? { macShareReason: macShare.reason } : {}),
        platform: options.macSessions?.platform ?? process.platform,
      };

      logger.debug('[GET /api/config] Returning app config:', config);
      res.json(config);
    } catch (error) {
      logger.error('[GET /api/config] Error getting app config:', error);
      res.status(500).json({ error: 'Failed to get app config' });
    }
  });

  /**
   * Update application configuration
   * PUT /api/config
   */
  router.put('/config', (req, res) => {
    try {
      const {
        quickStartCommands,
        repositoryBasePath,
        notificationPreferences,
        macSessions,
        macSessionsOpenMode,
        macShare,
        macShareLauncher,
      } = req.body;
      const updates: { [key: string]: unknown } = {};
      let validatedOpenMode: MacOpenMode | undefined;
      let validatedLauncher: MacShareLauncher | undefined;
      let validatedCommands: QuickStartCommand[] | undefined;
      let validatedPath: string | undefined;
      let validatedPrefs: Partial<NotificationPreferences> | undefined;

      if (quickStartCommands !== undefined) {
        // First check if it's an array
        if (!Array.isArray(quickStartCommands)) {
          logger.error('[PUT /api/config] Invalid quick start commands: not an array');
          // Don't return immediately - let it fall through to "No valid updates"
        } else {
          // Filter and validate commands, keeping only valid ones
          validatedCommands = [];

          for (const cmd of quickStartCommands) {
            try {
              // Skip null/undefined entries
              if (cmd == null) continue;

              const validated = QuickStartCommandSchema.parse(cmd);
              // Skip empty commands
              if (validated.command.trim()) {
                validatedCommands.push(validated);
              }
            } catch {
              // Skip invalid commands
            }
          }

          updates.quickStartCommands = validatedCommands;
        }
      }

      if (repositoryBasePath !== undefined) {
        try {
          // Validate repository base path
          validatedPath = z.string().min(1).parse(repositoryBasePath);

          updates.repositoryBasePath = validatedPath;
        } catch (validationError) {
          logger.error('[PUT /api/config] Invalid repository base path:', validationError);
          // Skip invalid values instead of returning error
        }
      }

      if (notificationPreferences !== undefined) {
        try {
          // Validate notification preferences
          validatedPrefs = NotificationPreferencesSchema.parse(notificationPreferences);

          updates.notificationPreferences = validatedPrefs;
        } catch (validationError) {
          logger.error('[PUT /api/config] Invalid notification preferences:', validationError);
          // Skip invalid values instead of returning error
        }
      }

      // Saved even while the server's start forces the switch: it applies once that is gone.
      if (typeof macSessions === 'boolean') {
        updates.macSessions = macSessions;
      }

      if (macSessionsOpenMode !== undefined) {
        const parsed = MacOpenModeSchema.safeParse(macSessionsOpenMode);
        if (parsed.success) {
          validatedOpenMode = parsed.data;
          updates.macSessionsOpenMode = validatedOpenMode;
        } else {
          logger.error('[PUT /api/config] Invalid macSessionsOpenMode:', parsed.error);
        }
      }

      // Likewise saved while forced. The other macShare* keys (auto-trust, Codex, vt path,
      // timeout) are edited in config.json only.
      if (typeof macShare === 'boolean') {
        updates.macShare = macShare;
      }

      if (macShareLauncher !== undefined) {
        const parsed = MacShareLauncherSchema.safeParse(macShareLauncher);
        if (parsed.success) {
          validatedLauncher = parsed.data;
          updates.macShareLauncher = validatedLauncher;
        } else {
          logger.error('[PUT /api/config] Invalid macShareLauncher:', parsed.error);
        }
      }

      if (Object.keys(updates).length > 0) {
        const currentConfig = configService.getConfig();
        const updatedConfig: VibeTunnelConfig = { ...currentConfig };

        if (typeof macSessions === 'boolean') {
          updatedConfig.macSessions = macSessions;
        }
        if (validatedOpenMode) {
          updatedConfig.macSessionsOpenMode = validatedOpenMode;
        }
        if (typeof macShare === 'boolean') {
          updatedConfig.macShare = macShare;
        }
        if (validatedLauncher) {
          updatedConfig.macShareLauncher = validatedLauncher;
        }

        if (validatedCommands) {
          updatedConfig.quickStartCommands = validatedCommands;
        }
        if (validatedPath) {
          updatedConfig.repositoryBasePath = validatedPath;
        }
        if (validatedPrefs) {
          const currentPreferences = currentConfig.preferences ?? {
            updateChannel: 'stable',
            showInDock: false,
            preventSleepWhenRunning: true,
          };
          updatedConfig.preferences = {
            ...currentPreferences,
            notifications: {
              ...DEFAULT_NOTIFICATION_PREFERENCES,
              ...configService.getNotificationPreferences(),
              ...validatedPrefs,
            },
          };
        }

        configService.updateConfig(updatedConfig);
        logger.debug('[PUT /api/config] Updated app config:', updates);
        res.json({ success: true, ...updates });
      } else {
        res.status(400).json({ error: 'No valid updates provided' });
      }
    } catch (error) {
      logger.error('[PUT /api/config] Error updating config:', error);
      res.status(500).json({ error: 'Failed to update config' });
    }
  });

  return router;
}
