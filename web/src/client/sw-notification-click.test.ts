import { describe, expect, it, vi } from 'vitest';
import { handleNotificationClick, notificationClickTarget } from './sw-notification-click';

const finished = { type: 'command-finished', sessionId: 'abc' };
const origin = 'https://vt.example';

function clients(windows: Array<{ url: string; focused?: boolean }>) {
  const opened: string[] = [];
  const posted: Array<{ url: string; message: unknown }> = [];
  const list = windows.map((w) => ({
    ...w,
    focus: vi.fn(async () => {}),
    postMessage: (message: unknown) => posted.push({ url: w.url, message }),
  }));
  return {
    opened,
    posted,
    api: {
      matchAll: async () => list,
      openWindow: async (url: string) => {
        opened.push(url);
        return null;
      },
    },
  };
}

describe('notification click', () => {
  it('a tap on the notification itself opens its session', async () => {
    expect(notificationClickTarget('', finished)).toEqual({
      url: '/session/abc',
      action: 'view-session',
    });
    expect(notificationClickTarget('view-session', { sessionId: 'a b' }).url).toBe(
      '/session/a%20b'
    );
    // A session that ended is gone: the list opens instead.
    expect(notificationClickTarget('', { type: 'session-exit', sessionId: 'abc' }).url).toBe('/');
    expect(notificationClickTarget('view-logs', undefined).url).toBe('/logs');

    const { api, opened } = clients([]);
    await handleNotificationClick('', finished, api, origin);
    expect(opened).toEqual(['https://vt.example/session/abc']);
  });

  it('reuses the focused app window and asks it to open the session', async () => {
    const { api, opened, posted } = clients([
      { url: 'https://other.example/' },
      { url: `${origin}/` },
      { url: `${origin}/session/other`, focused: true },
    ]);
    await handleNotificationClick('', finished, api, origin);
    expect(opened).toEqual([]);
    expect(posted).toEqual([
      {
        url: `${origin}/session/other`,
        message: { type: 'notification-action', action: 'view-session', data: finished },
      },
    ]);
  });

  it('does nothing for Dismiss', async () => {
    const { api, opened, posted } = clients([{ url: `${origin}/` }]);
    await handleNotificationClick('dismiss', finished, api, origin);
    expect(opened).toEqual([]);
    expect(posted).toEqual([]);
  });
});
