import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../../types/config.js';
import type { VapidManager } from '../utils/vapid-manager.js';
import {
  BELL_THROTTLE_MS,
  NOTIFICATION_PREFERENCE_FOR_TYPE,
  PushNotificationService,
} from './push-notification-service.js';

let dir: string;
beforeEach(() => {
  // Never the real ~/.vibetunnel/notifications.
  dir = mkdtempSync(path.join(tmpdir(), 'vt-push-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeService(sendNotification: ReturnType<typeof vi.fn>) {
  const vapid = { isEnabled: () => true, sendNotification } as unknown as VapidManager;
  const service = new PushNotificationService(vapid, dir);
  const subs = (service as unknown as { subscriptions: Map<string, unknown> }).subscriptions;
  const add = (id: string) =>
    subs.set(id, {
      id,
      endpoint: `https://push.example/${id}`,
      keys: { p256dh: 'p', auth: 'a' },
      subscribedAt: new Date().toISOString(),
      isActive: true,
    });
  return { service, add, subs };
}

function pushError(message: string, statusCode?: number) {
  return Object.assign(new Error(message), { statusCode });
}

describe('PushNotificationService', () => {
  it('says why a push was not sent', async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const { service, add } = makeService(sendNotification);
    const push = (type: string, sessionId: string) =>
      service.sendNotification({ type, title: 't', body: 'b', data: { sessionId } });
    expect((await push('command-error', 's1')).skipped).toBe('no-subscriptions');
    add('sub1');
    service.setPreferenceFilter((type) => type !== 'session-exit');
    expect((await push('session-exit', 's1')).skipped).toBe('preferences');
    const sent = await push('command-error', 's1');
    expect(sent.skipped).toBeUndefined();
    expect(sent.sent).toBe(1);
  });

  it('skips bell and command pushes about a session on screen, not the others', async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const { service, add } = makeService(sendNotification);
    add('sub1');
    service.setViewedFilter((id) => id === 'on-screen');
    const push = (type: string, sessionId: string) =>
      service.sendNotification({ type, title: 't', body: 'b', data: { sessionId } });

    for (const type of ['bell', 'command-finished', 'command-error']) {
      expect((await push(type, 'on-screen')).skipped, type).toBe('on-screen');
    }
    expect(sendNotification).not.toHaveBeenCalled();

    // Another session, a test push and session start/exit still go out.
    await push('command-error', 'elsewhere');
    await push('test', 'on-screen');
    await push('session-exit', 'on-screen');
    await push('session-start', 'on-screen');
    expect(sendNotification).toHaveBeenCalledTimes(4);
  });

  it('sends with a timeout and does not wait on one stuck endpoint before the others', async () => {
    const started: string[] = [];
    // VapidManager's parameters, so the options it is called with are typed below.
    const sendNotification = vi.fn((...[sub]: Parameters<VapidManager['sendNotification']>) => {
      started.push(sub.endpoint);
      return sub.endpoint.endsWith('stuck') ? new Promise(() => {}) : Promise.resolve();
    });
    const { service, add } = makeService(sendNotification);
    add('stuck');
    add('ok');

    void service.sendNotification({ type: 'test', title: 't', body: 'b' });
    await Promise.resolve();
    expect(started).toEqual(['https://push.example/stuck', 'https://push.example/ok']);
    expect(sendNotification.mock.calls[0][2]).toMatchObject({
      timeout: expect.any(Number),
      TTL: expect.any(Number),
    });
  });

  it('removes gone or unusable subscriptions but keeps them on server-side auth errors', async () => {
    const sendNotification = vi.fn((sub: { endpoint: string }) => {
      const id = sub.endpoint.split('/').pop();
      if (id === 'gone') return Promise.reject(pushError('Received unexpected response code', 410));
      if (id === 'missing')
        return Promise.reject(pushError('Received unexpected response code', 404));
      if (id === 'badkey')
        return Promise.reject(pushError('The subscription p256dh value should be 65 bytes long.'));
      if (id === 'jwt') return Promise.reject(pushError('Received unexpected response code', 403));
      return Promise.resolve();
    });
    const { service, add, subs } = makeService(sendNotification);
    for (const id of ['gone', 'missing', 'badkey', 'jwt', 'ok']) add(id);

    const result = await service.sendNotification({ type: 'test', title: 't', body: 'b' });
    expect(result).toMatchObject({ sent: 1, failed: 4 });
    expect([...subs.keys()].sort()).toEqual(['jwt', 'ok']);
    const saved = JSON.parse(readFileSync(path.join(dir, 'subscriptions.json'), 'utf8'));
    expect(saved.map((s: { id: string }) => s.id).sort()).toEqual(['jwt', 'ok']);
  });
});

describe('PushNotificationService bells', () => {
  afterEach(() => vi.useRealTimers());

  it('allows one bell per session per minute', () => {
    vi.useFakeTimers();
    const { service } = makeService(vi.fn());
    expect(service.allowBell('s1')).toBe(true);
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(1000);
      expect(service.allowBell('s1')).toBe(false);
    }
    // Another session is not held back by the first one.
    expect(service.allowBell('s2')).toBe(true);
    vi.advanceTimersByTime(BELL_THROTTLE_MS);
    expect(service.allowBell('s1')).toBe(true);
  });
});

describe('PushNotificationService preference filter', () => {
  it('with default preferences, sends exactly the types switched on by default', async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const { service, add } = makeService(sendNotification);
    add('phone');
    service.setPreferenceFilter((type) => {
      const key = NOTIFICATION_PREFERENCE_FOR_TYPE[type];
      return key ? DEFAULT_NOTIFICATION_PREFERENCES[key] !== false : true;
    });

    for (const type of ['session-start', 'command-finished']) {
      expect((await service.sendNotification({ type, title: 't', body: 'b' })).sent, type).toBe(0);
    }
    expect(sendNotification).not.toHaveBeenCalled();
    for (const type of ['session-exit', 'session-error', 'command-error', 'bell', 'test']) {
      expect((await service.sendNotification({ type, title: 't', body: 'b' })).sent, type).toBe(1);
    }
  });
});
