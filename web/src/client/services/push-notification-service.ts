import type { PushSubscription } from '../../shared/types';
import { HttpMethod } from '../../shared/types';
import type { NotificationPreferences } from '../../types/config.js';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  RECOMMENDED_NOTIFICATION_PREFERENCES,
} from '../../types/config.js';
import { t } from '../i18n/index.js';
import { syncAppBadge } from '../sw-badge.js';
import { isIOSDevice, isStandaloneApp } from '../utils/ios-install';
import { createLogger } from '../utils/logger';
import { authClient } from './auth-client';
import { serverConfigService } from './server-config-service';
import { serverEventService } from './server-event-service';

/** How long the service worker may take to be ready, or to hand over the push subscription. */
const SW_READY_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

// Re-export types for components
export type { NotificationPreferences, PushSubscription };

const logger = createLogger('push-notification-service');

type NotificationPermissionChangeCallback = (permission: NotificationPermission) => void;
type SubscriptionChangeCallback = (subscription: PushSubscription | null) => void;

export class PushNotificationService {
  private serviceWorkerRegistration: ServiceWorkerRegistration | null = null;
  private pushSubscription: globalThis.PushSubscription | null = null;
  private permissionChangeCallbacks: Set<NotificationPermissionChangeCallback> = new Set();
  private subscriptionChangeCallbacks: Set<SubscriptionChangeCallback> = new Set();
  private initialized = false;
  private vapidPublicKey: string | null = null;
  private initializationPromise: Promise<void> | null = null;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Used for feature detection
  private pushNotificationsAvailable = false;
  private resolveInitialized: () => void = () => {};
  /** Settles once initialize() has finished, even when awaited before it was called. */
  private readonly initializedPromise = new Promise<void>((resolve) => {
    this.resolveInitialized = resolve;
  });

  // biome-ignore lint/complexity/noUselessConstructor: This constructor documents the intentional design decision to not auto-initialize
  constructor() {
    // Do not initialize automatically - wait for explicit initialization
  }

  /**
   * Initialize the push notification service
   * Should be called after authentication is complete
   */
  async initialize(): Promise<void> {
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this._initialize()
      .catch((error) => {
        logger.error('failed to initialize push notification service:', error);
        // Don't throw here - just log the error
        // Push notifications are optional functionality
      })
      .finally(() => this.resolveInitialized());

    return this.initializationPromise;
  }

  private async _initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Check if service workers are supported
      if (!('serviceWorker' in navigator)) {
        logger.warn('service workers not supported');
        return;
      }

      // Check if push messaging is supported. Without it (Safari outside the home-screen
      // app, Chrome on iOS) the worker is still registered for its offline page.
      if (!('PushManager' in window)) {
        logger.warn('push messaging not supported');
        if ((window as Window).isSecureContext) {
          await navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error) => {
            logger.warn('service worker registration failed', error);
          });
        }
        return;
      }

      // Check if we're in a secure context (HTTPS or localhost)
      // Service workers require HTTPS except for localhost/127.0.0.1
      if (!window.isSecureContext) {
        logger.warn(
          'Push notifications require HTTPS or localhost. Current context is not secure.'
        );
        return;
      }

      // Fetch VAPID public key from server
      await this.fetchVapidPublicKey();

      // Register service worker
      this.serviceWorkerRegistration = await navigator.serviceWorker.register('/sw.js', {
        scope: '/',
      });

      logger.log('service worker registered successfully');

      // Wait for service worker to be ready (bounded: it may never come, and the settings
      // wait for this initialization)
      const registration = await withTimeout(
        navigator.serviceWorker.ready,
        SW_READY_TIMEOUT_MS,
        'the service worker never became ready'
      );

      // Use the ready registration if our registration failed
      if (!this.serviceWorkerRegistration) {
        this.serviceWorkerRegistration = registration;
      }

      // Get existing subscription if any
      this.pushSubscription = await withTimeout(
        this.serviceWorkerRegistration.pushManager.getSubscription(),
        SW_READY_TIMEOUT_MS,
        'reading the push subscription timed out'
      );

      logger.log('Existing push subscription found:', {
        hasSubscription: !!this.pushSubscription,
        endpoint: `${this.pushSubscription?.endpoint?.substring(0, 50)}...`,
      });

      // The icon may still count notifications cleared while the app was closed
      void this.recountAppBadge();

      // Listen for service worker messages
      navigator.serviceWorker.addEventListener(
        'message',
        this.handleServiceWorkerMessage.bind(this)
      );

      // Monitor permission changes
      this.monitorPermissionChanges();

      // Auto-resubscribe if notifications were previously enabled
      await this.autoResubscribe();

      this.initialized = true;
      logger.log('push notification service initialized');
    } catch (error) {
      logger.error('failed to initialize service worker:', error);
      throw error;
    }
  }

  private handleServiceWorkerMessage(event: MessageEvent): void {
    const { data } = event;

    switch (data.type) {
      case 'notification-action': {
        // Handle notification action from service worker
        this.handleNotificationAction(data.action, data.data);
        break;
      }
    }
  }

  private handleNotificationAction(action: string, data: unknown): void {
    // Dispatch custom event for app to handle
    window.dispatchEvent(
      new CustomEvent('notification-action', {
        detail: { action, data },
      })
    );
  }

  private monitorPermissionChanges(): void {
    // Modern browsers support permission change events
    if ('permissions' in navigator) {
      navigator.permissions
        .query({ name: 'notifications' as PermissionName })
        .then((permissionStatus) => {
          permissionStatus.addEventListener('change', () => {
            this.notifyPermissionChange(permissionStatus.state as NotificationPermission);
          });
        })
        .catch((error) => {
          logger.warn('failed to monitor permission changes:', error);
        });
    }
  }

  private notifyPermissionChange(permission: NotificationPermission): void {
    this.permissionChangeCallbacks.forEach((callback) => {
      try {
        callback(permission);
      } catch (error) {
        logger.error('error in permission change callback:', error);
      }
    });
  }

  private notifySubscriptionChange(subscription: PushSubscription | null): void {
    this.subscriptionChangeCallbacks.forEach((callback) => {
      try {
        callback(subscription);
      } catch (error) {
        logger.error('error in subscription change callback:', error);
      }
    });
  }

  /**
   * Auto-resubscribe if notifications were previously enabled
   */
  private async autoResubscribe(): Promise<void> {
    try {
      // Don't wait for initialization here - we're already in the initialization process!

      // Load saved preferences
      const preferences = await this.loadPreferences();

      logger.log('Auto-resubscribe checking preferences:', {
        enabled: preferences.enabled,
        hasPermission: this.getPermission() === 'granted',
        hasServiceWorker: !!this.serviceWorkerRegistration,
        hasVapidKey: !!this.vapidPublicKey,
        hasExistingSubscription: !!this.pushSubscription,
      });

      // Check if notifications were previously enabled
      if (preferences.enabled) {
        logger.log('Notifications were previously enabled, checking subscription state...');

        // Check if we have permission
        const permission = this.getPermission();
        if (permission !== 'granted') {
          logger.warn('Permission not granted, cannot auto-resubscribe');
          // Update preferences to reflect the failed state
          preferences.enabled = false;
          await this.savePreferences(preferences);
          return;
        }

        // Ensure service worker is ready and VAPID key is available
        if (!this.serviceWorkerRegistration) {
          logger.warn('Service worker not ready, cannot auto-resubscribe');
          return;
        }

        if (!this.vapidPublicKey) {
          logger.warn('VAPID key not available, cannot auto-resubscribe');
          return;
        }

        // Check current subscription state from push manager
        if (!this.pushSubscription) {
          logger.log('No active subscription found, attempting to resubscribe...');

          // Attempt to resubscribe
          const subscription = await this.subscribe();
          if (subscription) {
            logger.log('Successfully auto-resubscribed to push notifications');

            // Notify listeners that subscription is now active
            this.notifySubscriptionChange(subscription);

            // Show a welcome notification to confirm notifications are working
            await this.showWelcomeNotification();
          } else {
            logger.warn('Failed to auto-resubscribe, user will need to manually enable');
            // Update preferences to reflect the failed state
            preferences.enabled = false;
            await this.savePreferences(preferences);
          }
        } else {
          logger.log('Active subscription already exists');

          // Convert and notify listeners about the existing subscription
          const subscription = this.pushSubscriptionToInterface(this.pushSubscription);
          this.notifySubscriptionChange(subscription);

          // Sync subscription with server to ensure it's registered
          await this.sendSubscriptionToServer(subscription);
        }
      } else {
        logger.log('Notifications not previously enabled, skipping auto-resubscribe');
      }
    } catch (error) {
      logger.error('Error during auto-resubscribe:', error);
    }
  }

  /**
   * Request notification permission from user
   */
  async requestPermission(): Promise<NotificationPermission> {
    if (!('Notification' in window)) {
      throw new Error('Notifications not supported');
    }

    let permission = Notification.permission;

    if (permission === 'default') {
      permission = await Notification.requestPermission();
    }

    this.notifyPermissionChange(permission);
    return permission;
  }

  /**
   * Get current notification permission status
   */
  getPermission(): NotificationPermission {
    if (!('Notification' in window)) {
      return 'denied';
    }
    return Notification.permission;
  }

  /**
   * Subscribe to push notifications
   */
  async subscribe(): Promise<PushSubscription | null> {
    if (!this.serviceWorkerRegistration) {
      throw new Error('Service worker not initialized');
    }

    try {
      // Request permission first
      const permission = await this.requestPermission();
      if (permission !== 'granted') {
        throw new Error('Notification permission denied');
      }

      // Check if VAPID key is available
      if (!this.vapidPublicKey) {
        throw new Error('VAPID public key not available');
      }

      // Convert VAPID key to Uint8Array
      const vapidKey = this.urlBase64ToUint8Array(this.vapidPublicKey);

      // Subscribe to push notifications
      this.pushSubscription = await this.serviceWorkerRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKey as BufferSource,
      });

      // Convert to our interface format
      const subscription = this.pushSubscriptionToInterface(this.pushSubscription);

      // Send subscription to server
      await this.sendSubscriptionToServer(subscription);

      this.notifySubscriptionChange(subscription);
      logger.log('successfully subscribed to push notifications');

      return subscription;
    } catch (error) {
      logger.error('failed to subscribe to push notifications:', error);
      throw error;
    }
  }

  /**
   * Unsubscribe from push notifications
   */
  async unsubscribe(): Promise<void> {
    if (!this.pushSubscription) {
      return;
    }

    try {
      // Unsubscribe from push manager
      await this.pushSubscription.unsubscribe();

      // Remove subscription from server
      await this.removeSubscriptionFromServer();

      this.pushSubscription = null;
      this.notifySubscriptionChange(null);
      logger.log('successfully unsubscribed from push notifications');
    } catch (error) {
      logger.error('failed to unsubscribe from push notifications:', error);
      throw error;
    }
  }

  /**
   * Get current push subscription
   */
  getSubscription(): PushSubscription | null {
    if (!this.pushSubscription) {
      return null;
    }
    return this.pushSubscriptionToInterface(this.pushSubscription);
  }

  /**
   * Wait for the service to be initialized
   */
  async waitForInitialization(): Promise<void> {
    if (this.initializationPromise) {
      await this.initializationPromise;
    }
  }

  /**
   * Resolves once initialize() has run (existing subscription known). Unlike
   * waitForInitialization() it also waits when initialize() has not been called yet, so a
   * component that renders first does not mistake "not loaded yet" for "not subscribed".
   */
  whenInitialized(): Promise<void> {
    return this.initializedPromise;
  }

  /**
   * Check if push notifications are supported
   */
  isSupported(): boolean {
    // Basic feature detection
    const hasBasicSupport =
      'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

    if (!hasBasicSupport) {
      return false;
    }

    // Check if we're on HTTPS or localhost
    // Service workers require HTTPS except for localhost/127.0.0.1
    const isSecureContext = window.isSecureContext;
    if (!isSecureContext) {
      logger.warn('Push notifications require HTTPS or localhost');
      return false;
    }

    // iOS (any browser, iPadOS desktop mode included) supports push only in the installed
    // web app opened from the Home Screen (iOS 16.4+).
    if (isIOSDevice()) {
      return isStandaloneApp();
    }

    return true;
  }

  /**
   * Check if currently subscribed
   */
  isSubscribed(): boolean {
    return this.pushSubscription !== null;
  }

  /**
   * Test notification functionality
   * Sends a test notification through the server to verify the full flow:
   * Web → Server → WS v3 (global EVENT) → client + push.
   */
  async testNotification(): Promise<void> {
    logger.log('🔔 Testing notification system...');

    if (!this.serviceWorkerRegistration) {
      throw new Error('Service worker not initialized');
    }

    try {
      serverEventService.initialize();
      // Promise that resolves when we receive the test notification
      const notificationPromise = new Promise<void>((resolve) => {
        let receivedNotification = false;

        const timeout = setTimeout(() => {
          if (!receivedNotification) {
            logger.warn('⏱️ Timeout waiting for test notification');
            unsubscribe();
            resolve();
          }
        }, 5000); // 5 second timeout

        const unsubscribe = serverEventService.on('test-notification', async (event) => {
          logger.log('📨 Received test notification:', event);
          receivedNotification = true;
          clearTimeout(timeout);
          unsubscribe();

          // Show notification if we have permission
          if (this.serviceWorkerRegistration && this.getPermission() === 'granted') {
            await this.serviceWorkerRegistration.showNotification(
              event.title || t('push.test.title'),
              {
                body: event.body || t('push.test.received'),
                icon: '/apple-touch-icon.png',
                badge: '/favicon-32.png',
                tag: 'vibetunnel-test',
                requireInteraction: false,
              }
            );
            logger.log('✅ Displayed test notification');
          }
          resolve();
        });
      });

      // Send the test notification request to server
      logger.log('📤 Sending test notification request to server...');
      const response = await fetch('/api/test-notification', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authClient.getAuthHeader(),
        },
      });

      if (!response.ok) {
        const error = await response.json();
        logger.error('❌ Server test notification failed:', error);
        throw new Error(error.error || 'Failed to send test notification');
      }

      const result = await response.json();
      logger.log('✅ Server test notification sent successfully:', result);

      // Wait for the server event (WS v3 global `EVENT`)
      await notificationPromise;

      logger.log('🎉 Test notification complete - notification sent to all connected clients');
    } catch (error) {
      logger.error('❌ Test notification failed:', error);
      throw error;
    }
  }

  /**
   * Clear all VibeTunnel notifications
   */
  async clearAllNotifications(): Promise<void> {
    if (!this.serviceWorkerRegistration) {
      return;
    }

    try {
      const notifications = await this.serviceWorkerRegistration.getNotifications();

      for (const notification of notifications) {
        if (notification.tag?.startsWith('vibetunnel-')) {
          notification.close();
        }
      }

      logger.log('cleared all notifications');
    } catch (error) {
      logger.error('failed to clear notifications:', error);
    }
  }

  /**
   * Close the notifications about one session: opening it means they've been seen,
   * so they shouldn't stay on the lock screen.
   */
  async clearSessionNotifications(sessionId: string): Promise<void> {
    if (!this.serviceWorkerRegistration?.getNotifications) return;
    try {
      const notifications = await this.serviceWorkerRegistration.getNotifications();
      for (const notification of notifications) {
        const data = notification.data as { sessionId?: unknown } | null;
        if (notification.tag?.startsWith('vibetunnel-') && data?.sessionId === sessionId) {
          notification.close();
        }
      }
    } catch (error) {
      logger.debug('failed to clear session notifications:', error);
    }
  }

  /**
   * Recount the home-screen icon badge from the notifications still on screen. iOS fires no
   * `notificationclose` when they are cleared from Notification Center, so the worker's own
   * count can stay too high until the app looks again.
   */
  async recountAppBadge(): Promise<void> {
    const registration = this.serviceWorkerRegistration;
    if (!registration?.getNotifications || typeof navigator === 'undefined') return;
    await syncAppBadge(registration, navigator);
  }

  /**
   * Save notification preferences
   */
  async savePreferences(preferences: NotificationPreferences): Promise<void> {
    try {
      // Save directly - no mapping needed with unified type
      await serverConfigService.updateNotificationPreferences(preferences);
      logger.debug('saved notification preferences to config');
    } catch (error) {
      logger.error('failed to save notification preferences:', error);
      throw error;
    }
  }

  /**
   * Load notification preferences
   */
  async loadPreferences(): Promise<NotificationPreferences> {
    try {
      // Load from config service
      const configPreferences = await serverConfigService.getNotificationPreferences();
      // Return preferences directly - no mapping needed
      return configPreferences || this.getDefaultPreferences();
    } catch (error) {
      logger.error('failed to load notification preferences from config:', error);
      return this.getDefaultPreferences();
    }
  }

  /**
   * Get default notification preferences
   */
  private getDefaultPreferences(): NotificationPreferences {
    return DEFAULT_NOTIFICATION_PREFERENCES;
  }

  /**
   * Get recommended notification preferences for new users
   */
  getRecommendedPreferences(): NotificationPreferences {
    return RECOMMENDED_NOTIFICATION_PREFERENCES;
  }

  /**
   * Register callback for permission changes
   */
  onPermissionChange(callback: NotificationPermissionChangeCallback): () => void {
    this.permissionChangeCallbacks.add(callback);
    return () => this.permissionChangeCallbacks.delete(callback);
  }

  /**
   * Register callback for subscription changes
   */
  onSubscriptionChange(callback: SubscriptionChangeCallback): () => void {
    this.subscriptionChangeCallbacks.add(callback);
    return () => this.subscriptionChangeCallbacks.delete(callback);
  }

  private pushSubscriptionToInterface(subscription: globalThis.PushSubscription): PushSubscription {
    const keys = subscription.getKey('p256dh');
    const auth = subscription.getKey('auth');

    if (!keys || !auth) {
      throw new Error('Failed to get subscription keys');
    }

    return {
      endpoint: subscription.endpoint,
      keys: {
        p256dh: this.arrayBufferToBase64(keys),
        auth: this.arrayBufferToBase64(auth),
      },
    };
  }

  private async sendSubscriptionToServer(subscription: PushSubscription): Promise<void> {
    try {
      const response = await fetch('/api/push/subscribe', {
        method: HttpMethod.POST,
        headers: {
          'Content-Type': 'application/json',
          ...authClient.getAuthHeader(),
        },
        body: JSON.stringify(subscription),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Server responded with ${response.status}: ${errorText || response.statusText}`
        );
      }

      const result = await response.json();
      logger.log('subscription sent to server successfully', result);
    } catch (error) {
      logger.error('failed to send subscription to server:', error);
      throw error;
    }
  }

  private async removeSubscriptionFromServer(): Promise<void> {
    try {
      const response = await fetch('/api/push/unsubscribe', {
        method: HttpMethod.POST,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          endpoint: this.pushSubscription?.endpoint,
        }),
      });

      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}: ${response.statusText}`);
      }

      logger.log('subscription removed from server');
    } catch (error) {
      logger.error('failed to remove subscription from server:', error);
      // Don't throw here - local unsubscribe should still work
    }
  }

  private urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }

    return outputArray;
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  /**
   * Fetch VAPID public key from server
   */
  private async fetchVapidPublicKey(): Promise<void> {
    try {
      const response = await fetch('/api/push/vapid-public-key', {
        headers: authClient.getAuthHeader(),
      });

      if (!response.ok) {
        if (response.status === 503) {
          logger.warn('Push notifications not configured on server');
          this.pushNotificationsAvailable = false;
          return;
        }
        throw new Error(`Server responded with ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      if (!data.publicKey || !data.enabled) {
        logger.warn('Push notifications disabled on server');
        this.pushNotificationsAvailable = false;
        return;
      }

      this.vapidPublicKey = data.publicKey;
      this.pushNotificationsAvailable = true;

      logger.log('VAPID public key fetched from server');
      logger.debug(`Public key: ${data.publicKey.substring(0, 20)}...`);
    } catch (error) {
      logger.error('Failed to fetch VAPID public key:', error);
      this.pushNotificationsAvailable = false;
      throw error;
    }
  }

  /**
   * Get server push notification status
   */
  async getServerStatus(): Promise<{
    enabled: boolean;
    configured: boolean;
    subscriptions: number;
    errors?: string[];
  }> {
    try {
      const response = await fetch('/api/push/status');

      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      logger.error('Failed to get server push status:', error);
      throw error;
    }
  }

  /**
   * Send test notification via server
   */
  async sendTestNotification(message?: string): Promise<void> {
    try {
      logger.log('Sending test notification...');

      // Validate prerequisites
      if (!this.serviceWorkerRegistration) {
        throw new Error('Service worker not registered');
      }

      if (!this.vapidPublicKey) {
        throw new Error('VAPID public key not available');
      }

      if (!this.pushSubscription) {
        throw new Error('No active push subscription');
      }

      // Check server status first
      const serverStatus = await this.getServerStatus();
      if (!serverStatus.enabled) {
        throw new Error('Push notifications disabled on server');
      }

      if (!serverStatus.configured) {
        throw new Error('VAPID keys not configured on server');
      }

      // Send test notification to server
      const response = await fetch('/api/push/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: message || t('settings.testNotification.body'),
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Server responded with ${response.status}: ${errorText}`);
      }

      const result = await response.json();
      logger.log('Test notification sent successfully:', result);
    } catch (error) {
      logger.error('Failed to send test notification:', error);
      throw error; // Re-throw for the calling code to handle
    }
  }

  /**
   * Check if VAPID key is available
   */
  hasVapidKey(): boolean {
    return !!this.vapidPublicKey;
  }

  /**
   * Get current VAPID public key
   */
  getVapidPublicKey(): string | null {
    return this.vapidPublicKey;
  }

  /**
   * Refresh VAPID configuration from server
   */
  async refreshVapidConfig(): Promise<void> {
    try {
      await this.fetchVapidPublicKey();
    } catch (_error) {
      // Error is already logged in fetchVapidPublicKey
      // Don't re-throw to match test expectations
    }
  }

  /**
   * Show a welcome notification when auto-resubscribed
   */
  private async showWelcomeNotification(): Promise<void> {
    if (!this.serviceWorkerRegistration) {
      return;
    }

    try {
      // Show notification directly
      await this.serviceWorkerRegistration.showNotification(t('push.welcome.title'), {
        body: t('push.welcome.body'),
        icon: '/apple-touch-icon.png',
        badge: '/favicon-32.png',
        tag: 'vibetunnel-welcome',
        requireInteraction: false,
        silent: false,
      });
      logger.log('Welcome notification displayed');
    } catch (error) {
      logger.error('Failed to show welcome notification:', error);
    }
  }

  /**
   * Force refresh subscription state - useful for debugging and manual recovery
   */
  async forceRefreshSubscription(): Promise<void> {
    try {
      logger.log('Force refreshing subscription state');

      // Clear current subscription state
      this.pushSubscription = null;

      // Wait for initialization to complete
      await this.waitForInitialization();

      // Check if we should auto-resubscribe
      const preferences = await this.loadPreferences();
      if (preferences.enabled) {
        await this.autoResubscribe();
      }

      logger.log('Subscription state refresh completed');
    } catch (error) {
      logger.error('Error during subscription refresh:', error);
    }
  }

  /**
   * Get current subscription status for debugging
   */
  getSubscriptionStatus(): {
    hasPermission: boolean;
    hasServiceWorker: boolean;
    hasVapidKey: boolean;
    hasSubscription: boolean;
    preferences: NotificationPreferences | null;
  } {
    return {
      hasPermission: this.getPermission() === 'granted',
      hasServiceWorker: !!this.serviceWorkerRegistration,
      hasVapidKey: !!this.vapidPublicKey,
      hasSubscription: !!this.pushSubscription,
      preferences: null, // Will be loaded asynchronously
    };
  }

  /**
   * Clean up service
   */
  dispose(): void {
    this.permissionChangeCallbacks.clear();
    this.subscriptionChangeCallbacks.clear();
    this.initialized = false;
    this.vapidPublicKey = null;
    this.pushNotificationsAvailable = false;
  }
}

// Create singleton instance
export const pushNotificationService = new PushNotificationService();
