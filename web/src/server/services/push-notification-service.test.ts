import { describe, expect, it, vi } from 'vitest';
import type { VapidManager } from '../utils/vapid-manager.js';
import { PushNotificationService } from './push-notification-service.js';

describe('PushNotificationService mute filter', () => {
  it('drops notifications about a muted session and still sends the others', async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const vapid = { isEnabled: () => true, sendNotification } as unknown as VapidManager;
    const service = new PushNotificationService(vapid);
    (service as unknown as { subscriptions: Map<string, unknown> }).subscriptions.set('sub1', {
      id: 'sub1',
      endpoint: 'https://push.example/1',
      keys: { p256dh: 'p', auth: 'a' },
      subscribedAt: new Date().toISOString(),
      isActive: true,
    });
    service.setMuteFilter((id) => id === 'quiet');

    const muted = await service.sendNotification({
      type: 'claude-finished',
      title: 't',
      body: 'b',
      data: { sessionId: 'quiet' },
    });
    expect(muted.sent).toBe(0);
    expect(sendNotification).not.toHaveBeenCalled();

    const loud = await service.sendNotification({
      type: 'claude-finished',
      title: 't',
      body: 'b',
      data: { sessionId: 'loud' },
    });
    expect(loud.sent).toBe(1);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });
});
