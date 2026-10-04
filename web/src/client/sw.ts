/// <reference no-default-lib="true" />
/// <reference lib="es2020" />
/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;

import { handleNotificationClick } from './sw-notification-click.js';
import {
  isGuardedNavigation,
  OFFLINE_CACHE,
  OFFLINE_PAGE_URL,
  respondToNavigation,
} from './sw-offline.js';
import {
  SHELL_CACHE_PREFERENCE_MESSAGE,
  SHELL_UPDATED_MESSAGE,
  ShellCache,
  ShellSetting,
  shellRule,
} from './sw-shell.js';

/** The client's files, one shell version at a time (sw-shell.ts). */
const shell = new ShellCache({ caches, fetch: (input, init) => fetch(input, init) });

/** Whether the shell cache is on: Settings on this device and config.json, both on by default. */
const shellSetting = new ShellSetting(caches, () => shell.clear());

// Notification tag prefix for VibeTunnel notifications
const NOTIFICATION_TAG_PREFIX = 'vibetunnel-';

// Types for push notification payloads
interface SessionExitData {
  type: 'session-exit';
  sessionId: string;
  sessionName?: string;
  command?: string;
  exitCode: number;
  duration?: number;
  timestamp: number;
}

interface SessionStartData {
  type: 'session-start';
  sessionId: string;
  sessionName?: string;
  command?: string;
  timestamp: number;
}

interface SessionErrorData {
  type: 'session-error';
  sessionId: string;
  sessionName?: string;
  command?: string;
  error: string;
  timestamp: number;
}

interface SystemAlertData {
  type: 'system-alert';
  message: string;
  level: 'info' | 'warning' | 'error';
  timestamp: number;
}

interface CommandFinishedData {
  type: 'command-finished';
  sessionId: string;
  command: string;
  exitCode: number;
  duration: number;
  timestamp: string;
}

interface CommandErrorData {
  type: 'command-error';
  sessionId: string;
  command: string;
  exitCode: number;
  duration: number;
  timestamp: string;
}

type NotificationData =
  | SessionExitData
  | SessionStartData
  | SessionErrorData
  | SystemAlertData
  | CommandFinishedData
  | CommandErrorData;

interface PushNotificationPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  data: NotificationData;
  actions?: Array<{
    action: string;
    title: string;
    icon?: string;
  }>;
  tag?: string;
  requireInteraction?: boolean;
}

// Install event
self.addEventListener('install', (event: ExtendableEvent) => {
  console.log('[SW] Installing service worker');

  // Force activation of new service worker
  self.skipWaiting();
  // With the shell cache on, the current shell version, so the next cold start doesn't wait
  // on the network for it (sw-shell.ts). Best effort: a failure must not keep the new worker
  // from installing.
  event.waitUntil(
    shellSetting
      .read()
      .then((on) => (on ? shell.precache() : undefined))
      .catch(() => {})
  );
});

// Activate event
self.addEventListener('activate', (event: ExtendableEvent) => {
  console.log('[SW] Activating service worker');

  event.waitUntil(
    Promise.all([
      // Take control of all pages
      self.clients.claim(),
      // Page loads start on the network while the worker boots, so guarding them with a
      // fetch handler doesn't slow every launch down.
      self.registration.navigationPreload?.enable().catch(() => {}),
      // Shell versions beyond the newest two, half-installed ones; everything while the shell
      // cache is off (sw-shell.ts).
      shellSetting
        .read()
        .then((on) => (on ? shell.prune() : shell.clear()))
        .catch(() => {}),
    ])
  );
});

// Failed page loads (server down or unreachable) get a retrying offline page instead of the
// browser's error screen. Network first; nothing but that static page is ever cached.
self.addEventListener('fetch', (event: FetchEvent) => {
  // The client's files: one shell version at a time from the worker's cache (sw-shell.ts),
  // only with the shell cache on; otherwise straight to the network.
  const rule = shellSetting.known === false ? null : shellRule(event.request, self.location.origin);
  if (rule) {
    event.respondWith(
      shellSetting.read().then((on) =>
        on
          ? shell.respond(new URL(event.request.url), rule, {
              waitUntil: (work) => event.waitUntil(work),
              notifyUpdated: () => notifyShellUpdated(event.clientId),
            })
          : fetch(event.request)
      )
    );
    return;
  }
  // A page load: note whether the server has the shell cache on.
  const loadPage = async () => {
    const response =
      ((await event.preloadResponse) as Response | undefined) ?? (await fetch(event.request));
    event.waitUntil(shellSetting.note(response).catch(() => {}));
    return response;
  };
  if (!isGuardedNavigation(event.request, self.location.origin)) {
    // Other navigations (an /api/fs/raw file opened in a tab) go to the network as usual,
    // but through the preload already in flight so they aren't requested twice.
    if (event.request.mode === 'navigate') {
      event.respondWith(
        (async () =>
          ((await event.preloadResponse) as Response | undefined) ?? fetch(event.request))()
      );
    }
    return;
  }
  event.respondWith(
    respondToNavigation(loadPage, async () => {
      const cache = await caches.open(OFFLINE_CACHE);
      return cache.match(OFFLINE_PAGE_URL);
    })
  );
});

/** The page that got an older shell version (or, unknown, every page) is told to reload. */
async function notifyShellUpdated(clientId: string): Promise<void> {
  const client = clientId ? await self.clients.get(clientId) : undefined;
  const targets = client ? [client] : await self.clients.matchAll({ type: 'window' });
  for (const target of targets) target.postMessage({ type: SHELL_UPDATED_MESSAGE });
}

// Push event - handle incoming push notifications
self.addEventListener('push', (event: PushEvent) => {
  console.log('[SW] Push event received');

  if (!event.data) {
    console.warn('[SW] Push event has no data');
    return;
  }

  let payload: PushNotificationPayload;

  try {
    payload = event.data.json();
  } catch (error) {
    console.error('[SW] Failed to parse push payload:', error);
    return;
  }

  event.waitUntil(handlePushNotification(payload));
});

// Notification click event - handle user interactions
self.addEventListener('notificationclick', (event: NotificationEvent) => {
  console.log('[SW] Notification clicked:', event.notification.tag);

  event.notification.close();

  const data = event.notification.data as NotificationData;

  event.waitUntil(handleNotificationClick(event.action, data, self.clients, self.location.origin));
});

// Notification close event - track dismissals
self.addEventListener('notificationclose', (event: NotificationEvent) => {
  console.log('[SW] Notification closed:', event.notification.tag);

  const data = event.notification.data as NotificationData;

  // Optional: Send analytics or cleanup
  if (data.type === 'session-exit' || data.type === 'session-error') {
    // Could track notification dismissal metrics
  }
});

// No background sync needed

async function handlePushNotification(payload: PushNotificationPayload): Promise<void> {
  const { title, body, icon, badge, data, actions, tag, requireInteraction } = payload;

  try {
    // Create notification options
    const notificationOptions: NotificationOptions = {
      body,
      icon: icon || '/apple-touch-icon.png',
      badge: badge || '/favicon-32.png',
      data,
      tag: tag || `${NOTIFICATION_TAG_PREFIX}${data.type}-${Date.now()}`,
      requireInteraction: requireInteraction || data.type === 'session-error',
      silent: false,
      // @ts-expect-error - renotify is a valid option but not in TypeScript types
      renotify: true,
      actions: actions || getDefaultActions(data),
      timestamp: data.timestamp,
    };

    // Add vibration pattern for mobile devices
    if ('vibrate' in navigator) {
      // @ts-expect-error - vibrate is a valid option but not in TypeScript types
      notificationOptions.vibrate = getVibrationPattern(data.type);
    }

    // Show the notification
    await self.registration.showNotification(title, notificationOptions);

    console.log('[SW] Notification shown:', title);
  } catch (error) {
    console.error('[SW] Failed to show notification:', error);
  }
}

interface NotificationAction {
  action: string;
  title: string;
}

function getDefaultActions(data: NotificationData): NotificationAction[] {
  const baseActions: NotificationAction[] = [
    {
      action: 'dismiss',
      title: 'Dismiss',
    },
  ];

  switch (data.type) {
    case 'session-exit':
    case 'session-error':
    case 'session-start':
    case 'command-finished':
    case 'command-error': {
      return [
        {
          action: 'view-session',
          title: 'View Session',
        },
        ...baseActions,
      ];
    }
    case 'system-alert': {
      return [
        {
          action: 'view-logs',
          title: 'View Logs',
        },
        ...baseActions,
      ];
    }
    default:
      return baseActions;
  }
}

function getVibrationPattern(notificationType: string): number[] {
  switch (notificationType) {
    case 'session-error':
    case 'command-error':
      return [200, 100, 200, 100, 200]; // Urgent pattern
    case 'session-exit':
      return [100, 50, 100]; // Short notification
    case 'session-start':
      return [50]; // Very brief
    case 'command-finished':
      return [75, 50, 75]; // Medium notification
    case 'system-alert':
      return [150, 75, 150]; // Moderate pattern
    default:
      return [100]; // Default brief vibration
  }
}

// Message handler for communication with main thread
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const { data } = event;

  switch (data.type) {
    case 'CLEAR_NOTIFICATIONS': {
      // Clear all VibeTunnel notifications
      clearAllNotifications();
      break;
    }
    case 'SKIP_WAITING': {
      self.skipWaiting();
      break;
    }
    case SHELL_CACHE_PREFERENCE_MESSAGE: {
      // Settings > "Keep the app's files on this device" (utils/shell-cache-preference.ts).
      event.waitUntil(shellSetting.setDevice(data.on !== false).catch(() => {}));
      break;
    }
  }
});

// No queueing needed

async function clearAllNotifications(): Promise<void> {
  try {
    const notifications = await self.registration.getNotifications();

    for (const notification of notifications) {
      if (notification.tag?.startsWith(NOTIFICATION_TAG_PREFIX)) {
        notification.close();
      }
    }

    console.log('[SW] Cleared all VibeTunnel notifications');
  } catch (error) {
    console.error('[SW] Failed to clear notifications:', error);
  }
}

console.log('[SW] Service worker loaded');
