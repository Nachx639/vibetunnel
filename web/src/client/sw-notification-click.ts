/**
 * Where a tapped push notification takes you. Tapping the notification itself (iOS shows no
 * action buttons on web pushes) opens its session, like "View Session" does where buttons
 * exist. An open app window is reused: it gets the action by postMessage and navigates in
 * place; otherwise a new window opens at the deep link.
 */

export interface ClickData {
  type?: string;
  sessionId?: string;
}

export interface ClickTarget {
  /** Path to open when no app window exists. */
  url: string;
  /** Action posted to an open app window (it navigates in place). */
  action: string;
}

export function notificationClickTarget(action: string, data: ClickData | undefined): ClickTarget {
  const sessionId = data?.sessionId;
  // Tapping the notification itself (no action button) opens its session too.
  // (Not for session-exit: that session is gone.)
  if (!action && sessionId && data?.type !== 'session-exit') action = 'view-session';
  if (action === 'view-session' && sessionId) {
    return { url: `/session/${encodeURIComponent(sessionId)}`, action };
  }
  if (action === 'view-logs') return { url: '/logs', action };
  return { url: '/', action };
}

interface WindowClientLike {
  url: string;
  focused?: boolean;
  focus(): Promise<unknown>;
  postMessage(message: unknown): void;
}

export interface ClientsLike {
  matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<readonly unknown[]>;
  openWindow(url: string): Promise<unknown>;
}

/** Reuses an open app window (the focused one first), or opens a new one at the deep link. */
export async function handleNotificationClick(
  action: string,
  data: ClickData | undefined,
  clients: ClientsLike,
  origin: string
): Promise<void> {
  if (action === 'dismiss') return;
  const target = notificationClickTarget(action, data);
  const windows = (await clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  })) as WindowClientLike[];
  const ours = windows
    .filter((client) => client.url.startsWith(origin))
    .sort((a, b) => Number(Boolean(b.focused)) - Number(Boolean(a.focused)));
  for (const client of ours) {
    try {
      await client.focus();
      client.postMessage({ type: 'notification-action', action: target.action, data });
      return;
    } catch (error) {
      console.warn('[SW] Failed to focus client:', error);
    }
  }
  try {
    await clients.openWindow(origin + target.url);
  } catch (error) {
    console.error('[SW] Failed to open window:', error);
  }
}
