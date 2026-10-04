/**
 * Home-screen icon badge for an installed app. The service worker counts the sessions that
 * have a Claude notification on screen ("Claude needs you" / "Claude finished", one per
 * session by tag) and badges the icon with that number; it lowers as they are tapped,
 * dismissed or cleared. Other notices (session ended, command finished, bell) don't count.
 */

const CLAUDE_TAG_PREFIX = 'vibetunnel-claude-';

interface BadgeNavigator {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

interface NotificationSource {
  getNotifications(): Promise<Array<{ tag: string }>>;
}

export async function syncAppBadge(
  registration: NotificationSource,
  nav: BadgeNavigator
): Promise<void> {
  if (!nav.setAppBadge) return;
  try {
    const notifications = await registration.getNotifications();
    const count = notifications.filter((n) => n.tag?.startsWith(CLAUDE_TAG_PREFIX)).length;
    await (count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge?.());
  } catch {
    // Badging is a nicety; never let it break showing the notification.
  }
}
