/**
 * PushNotificationService - Simplified push notification system
 *
 * This simplified service provides:
 * - Basic subscription storage
 * - Notification sending, filtered by the notification settings (no user tracking)
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type webpush from 'web-push';
import type { NotificationPreferences } from '../../types/config.js';
import { createLogger } from '../utils/logger.js';
import type { VapidManager } from '../utils/vapid-manager.js';
import type { BellNotificationPayload } from './bell-event-handler.js';

const logger = createLogger('push-notification-service');

/**
 * Simplified push subscription data structure
 */
export interface PushSubscription {
  id: string;
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  subscribedAt: string;
  isActive: boolean;
}

/**
 * Generic notification payload
 */
export interface NotificationPayload {
  type: string;
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  requireInteraction?: boolean;
  actions?: Array<{
    action: string;
    title: string;
  }>;
  data?: Record<string, unknown>;
}

/**
 * Send notification result
 */
export interface SendNotificationResult {
  success: boolean;
  sent: number;
  failed: number;
  errors: string[];
  /** Why nothing was sent, when it was skipped on purpose. */
  skipped?: 'preferences' | 'no-subscriptions';
}

/** How long the push service keeps an undelivered notification (phone offline). */
const PUSH_TTL_SECONDS = 60 * 60;
/** Per-subscription network timeout for one push request. */
const PUSH_TIMEOUT_MS = 10_000;

/**
 * Which Settings switch governs each push type. Types not listed (test pushes) are always
 * sent.
 */
export const NOTIFICATION_PREFERENCE_FOR_TYPE: Record<string, keyof NotificationPreferences> = {
  'session-start': 'sessionStart',
  'session-exit': 'sessionExit',
  // A non-zero exit is usually a session the user killed: same switch as a normal exit.
  'session-error': 'sessionExit',
  'command-finished': 'commandCompletion',
  'command-error': 'commandError',
  bell: 'bell',
};

/** At most one bell push per session in this window. */
export const BELL_THROTTLE_MS = 60_000;

/**
 * Simplified push notification service
 */
export class PushNotificationService {
  private vapidManager: VapidManager;
  private subscriptions = new Map<string, PushSubscription>();
  private initialized = false;
  private isTypeAllowed: (type: string) => boolean = () => true;
  private lastBellAt = new Map<string, number>();
  private readonly subscriptionsFile: string;

  constructor(vapidManager: VapidManager, storageDir?: string) {
    this.vapidManager = vapidManager;
    storageDir ??= path.join(os.homedir(), '.vibetunnel/notifications');
    this.subscriptionsFile = path.join(storageDir, 'subscriptions.json');
  }

  /**
   * Initialize the service
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      // Ensure storage directory exists
      await fs.mkdir(path.dirname(this.subscriptionsFile), { recursive: true });

      // Load existing subscriptions
      await this.loadSubscriptions();

      this.initialized = true;
      logger.log('PushNotificationService initialized');
    } catch (error) {
      logger.error('Failed to initialize PushNotificationService:', error);
      throw error;
    }
  }

  /**
   * Add a new subscription
   */
  async addSubscription(endpoint: string, keys: { p256dh: string; auth: string }): Promise<string> {
    const subscriptionId = this.generateSubscriptionId(endpoint, keys);

    const subscription: PushSubscription = {
      id: subscriptionId,
      endpoint,
      keys,
      subscribedAt: new Date().toISOString(),
      isActive: true,
    };

    this.subscriptions.set(subscriptionId, subscription);
    await this.saveSubscriptions();

    logger.log(`New subscription added: ${subscriptionId}`);
    return subscriptionId;
  }

  /**
   * Remove a subscription
   */
  async removeSubscription(subscriptionId: string): Promise<boolean> {
    const existed = this.subscriptions.delete(subscriptionId);
    if (existed) {
      await this.saveSubscriptions();
      logger.log(`Subscription removed: ${subscriptionId}`);
    }
    return existed;
  }

  /**
   * Get all active subscriptions
   */
  getSubscriptions(): PushSubscription[] {
    return Array.from(this.subscriptions.values()).filter((sub) => sub.isActive);
  }

  /** Drop push types the user switched off in Settings. */
  setPreferenceFilter(filter: (type: string) => boolean): void {
    this.isTypeAllowed = filter;
  }

  /**
   * A terminal bell from a session. Programs ring it in bursts, so on its own it flooded the
   * phone: at most one bell push per session per BELL_THROTTLE_MS. Returns false when this
   * bell should not be pushed.
   */
  allowBell(sessionId: string): boolean {
    const now = Date.now();
    if (now - (this.lastBellAt.get(sessionId) ?? 0) < BELL_THROTTLE_MS) return false;
    this.lastBellAt.set(sessionId, now);
    if (this.lastBellAt.size > 1000) {
      for (const [id, at] of this.lastBellAt) {
        if (now - at >= BELL_THROTTLE_MS) this.lastBellAt.delete(id);
      }
    }
    return true;
  }

  /**
   * Send notification to all subscriptions
   */
  async sendNotification(payload: NotificationPayload): Promise<SendNotificationResult> {
    // Say in the log why a push was not sent. Bells ring constantly: theirs stay at debug.
    const skip = (
      skipped: NonNullable<SendNotificationResult['skipped']>,
      why: string
    ): SendNotificationResult => {
      const line = `push ${payload.type} not sent: ${why}`;
      if (payload.type === 'bell') logger.debug(line);
      else logger.log(line);
      return { success: true, sent: 0, failed: 0, errors: [], skipped };
    };
    if (!this.isTypeAllowed(payload.type)) {
      return skip('preferences', 'turned off in the notification settings');
    }

    if (!this.vapidManager.isEnabled()) {
      throw new Error('VAPID not properly configured');
    }

    const activeSubscriptions = this.getSubscriptions();
    if (activeSubscriptions.length === 0) {
      return skip('no-subscriptions', 'no phone or browser is subscribed');
    }

    let successful = 0;
    let failed = 0;
    const errors: string[] = [];

    const webPushPayload = JSON.stringify({
      title: payload.title,
      body: payload.body,
      icon: payload.icon || '/apple-touch-icon.png',
      badge: payload.badge || '/favicon-32.png',
      tag: payload.tag || `vibetunnel-${payload.type}`,
      requireInteraction: payload.requireInteraction || false,
      actions: payload.actions || [],
      data: {
        type: payload.type,
        timestamp: new Date().toISOString(),
        ...payload.data,
      },
    });

    // Send to every subscription in parallel, each with its own timeout: one dead push
    // endpoint used to hold POST /api/push/test (and every later alert) for minutes.
    await Promise.all(
      activeSubscriptions.map(async (subscription) => {
        try {
          const webpushSubscription: webpush.PushSubscription = {
            endpoint: subscription.endpoint,
            keys: subscription.keys,
          };

          await this.vapidManager.sendNotification(webpushSubscription, webPushPayload, {
            TTL: PUSH_TTL_SECONDS,
            timeout: PUSH_TIMEOUT_MS,
          });
          successful++;

          logger.debug(`Notification sent to: ${subscription.id}`);
        } catch (error) {
          failed++;
          const errorMsg = `Failed to send to ${subscription.id}: ${error}`;
          errors.push(errorMsg);
          logger.warn(errorMsg);

          // Remove expired/invalid subscriptions
          const shouldRemove = this.shouldRemoveSubscription(error);
          if (shouldRemove) {
            this.subscriptions.delete(subscription.id);
            const webPushError = error as Error & { statusCode?: number };
            logger.log(
              `Removed expired subscription: ${subscription.id} (status: ${webPushError.statusCode})`
            );
          } else {
            // Debug log for unhandled errors
            const webPushError = error as Error & { statusCode?: number };
            logger.debug(
              `Not removing subscription ${subscription.id}, error: ${error instanceof Error ? error.message : String(error)}, statusCode: ${webPushError.statusCode}`
            );
          }
        }
      })
    );

    // Save updated subscriptions
    await this.saveSubscriptions();

    logger.log(`Notification sent: ${successful} successful, ${failed} failed`, {
      type: payload.type,
      title: payload.title,
    });

    return {
      success: true,
      sent: successful,
      failed,
      errors,
    };
  }

  /**
   * Send bell notification
   */
  async sendBellNotification(
    bellPayload: BellNotificationPayload
  ): Promise<SendNotificationResult> {
    const payload: NotificationPayload = {
      type: 'bell',
      title: bellPayload.title,
      body: bellPayload.body,
      icon: bellPayload.icon,
      badge: bellPayload.badge,
      tag: bellPayload.tag,
      requireInteraction: bellPayload.requireInteraction,
      actions: bellPayload.actions,
      data: bellPayload.data,
    };

    return await this.sendNotification(payload);
  }

  /**
   * Determine if a subscription should be removed based on the error
   */
  private shouldRemoveSubscription(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    // Check for HTTP 410 Gone status (subscription expired)
    // WebPushError has a statusCode property
    const webPushError = error as Error & { statusCode?: number };
    // 404/410: the push service forgot it. Key errors are thrown by web-push before any
    // request (e.g. a p256dh that isn't a P-256 point): that subscription can never work.
    if (webPushError.statusCode === 410 || webPushError.statusCode === 404) {
      return true;
    }
    if (
      /subscription (p256dh|auth key|endpoint)|No user (public key|auth) provided|pass in a subscription/i.test(
        error.message
      )
    ) {
      return true;
    }

    // Also check message content for other error formats
    if (error.message.includes('410') || error.message.includes('Gone')) {
      return true;
    }

    // Check for other expired/invalid subscription indicators
    const errorMessage = error.message.toLowerCase();
    return (
      errorMessage.includes('invalid') ||
      errorMessage.includes('expired') ||
      errorMessage.includes('no such subscription') ||
      errorMessage.includes('unsubscribed')
    );
  }

  /**
   * Clean up inactive subscriptions
   */
  async cleanupInactiveSubscriptions(): Promise<number> {
    const beforeCount = this.subscriptions.size;

    // Remove all inactive subscriptions
    const activeSubscriptions = Array.from(this.subscriptions.values()).filter(
      (subscription) => subscription.isActive
    );

    this.subscriptions.clear();
    for (const subscription of activeSubscriptions) {
      this.subscriptions.set(subscription.id, subscription);
    }

    const removedCount = beforeCount - this.subscriptions.size;

    if (removedCount > 0) {
      await this.saveSubscriptions();
      logger.log(`Cleaned up ${removedCount} inactive subscriptions`);
    }

    return removedCount;
  }

  /**
   * Load subscriptions from file
   */
  private async loadSubscriptions(): Promise<void> {
    try {
      const data = await fs.readFile(this.subscriptionsFile, 'utf8');
      const subscriptions: PushSubscription[] = JSON.parse(data);

      this.subscriptions.clear();
      for (const subscription of subscriptions) {
        this.subscriptions.set(subscription.id, subscription);
      }

      logger.debug(`Loaded ${subscriptions.length} subscriptions`);
    } catch (error) {
      const fsError = error as NodeJS.ErrnoException;
      if (fsError.code === 'ENOENT') {
        logger.debug('No existing subscriptions file found');
      } else {
        logger.error('Failed to load subscriptions:', error);
      }
    }
  }

  /**
   * Save subscriptions to file
   */
  private async saveSubscriptions(): Promise<void> {
    try {
      const subscriptions = Array.from(this.subscriptions.values());
      await fs.writeFile(this.subscriptionsFile, JSON.stringify(subscriptions, null, 2));
      logger.debug(`Saved ${subscriptions.length} subscriptions`);
    } catch (error) {
      logger.error('Failed to save subscriptions:', error);
    }
  }

  /**
   * Shutdown the service
   */
  async shutdown(): Promise<void> {
    await this.saveSubscriptions();
    logger.log('PushNotificationService shutdown');
  }

  /**
   * Generate unique subscription ID
   */
  private generateSubscriptionId(endpoint: string, keys: { p256dh: string; auth: string }): string {
    try {
      const url = new URL(endpoint);
      const hash = Buffer.from(keys.p256dh).toString('base64').substring(0, 8);
      return `${url.hostname}-${hash}`;
    } catch {
      // Fallback to a hash of the entire endpoint
      return Buffer.from(endpoint).toString('base64').substring(0, 16);
    }
  }
}
