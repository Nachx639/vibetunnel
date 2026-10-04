import { Router } from 'express';
import { z } from 'zod';
import { DEFAULT_REPOSITORY_BASE_PATH } from '../../shared/constants.js';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferences,
  type QuickStartCommand,
  type VibeTunnelConfig,
} from '../../types/config.js';
import type { ConfigService } from '../services/config-service.js';
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
  notificationPreferences?: NotificationPreferences;
  /** Days after which exited sessions are removed automatically; 0 = off. */
  autoCleanupExitedAfterDays: number;
}

const AutoCleanupDaysSchema = z.number().int().min(0).max(3650);

interface ConfigRouteOptions {
  configService: ConfigService;
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

      const config: AppConfig = {
        repositoryBasePath: repositoryBasePath,
        serverConfigured: true, // Always configured when server is running
        quickStartCommands: vibeTunnelConfig.quickStartCommands,
        notificationPreferences: configService.getNotificationPreferences(),
        autoCleanupExitedAfterDays: vibeTunnelConfig.autoCleanupExitedAfterDays ?? 0,
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
        autoCleanupExitedAfterDays,
      } = req.body;
      const updates: { [key: string]: unknown } = {};
      let validatedCommands: QuickStartCommand[] | undefined;
      let validatedPath: string | undefined;
      let validatedPrefs: Partial<NotificationPreferences> | undefined;
      let validatedCleanupDays: number | undefined;

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

      if (autoCleanupExitedAfterDays !== undefined) {
        const parsed = AutoCleanupDaysSchema.safeParse(autoCleanupExitedAfterDays);
        if (parsed.success) {
          validatedCleanupDays = parsed.data;
          updates.autoCleanupExitedAfterDays = validatedCleanupDays;
        } else {
          logger.error('[PUT /api/config] Invalid autoCleanupExitedAfterDays:', parsed.error);
        }
      }

      if (Object.keys(updates).length > 0) {
        const currentConfig = configService.getConfig();
        const updatedConfig: VibeTunnelConfig = { ...currentConfig };

        if (validatedCommands) {
          updatedConfig.quickStartCommands = validatedCommands;
        }
        if (validatedPath) {
          updatedConfig.repositoryBasePath = validatedPath;
        }
        if (validatedCleanupDays !== undefined) {
          updatedConfig.autoCleanupExitedAfterDays = validatedCleanupDays;
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
