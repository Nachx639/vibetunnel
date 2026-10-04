/**
 * "Preview ready" push for `vt preview`: the phone in a pocket learns that the dev server it
 * asked for is up, and the tap opens the preview's own view.
 */

import {
  PREVIEW_READY_PUSH_TYPE,
  type PreviewReadyPushData,
  previewReadyTapPath,
} from '../../shared/preview-push.js';
import type { PreviewOpenEvent } from './preview-registry.js';
import type { NotificationPayload } from './push-notification-service.js';

/**
 * How long the push waits after `vt preview`. A screen showing the session switches to the
 * preview on the same event; the wait gives it time to say so before the push is sent.
 */
export const PREVIEW_PUSH_DELAY_MS = 1500;

/** The push for one opened preview; `where` names the session it was opened from. */
export function previewReadyPush(event: PreviewOpenEvent, where: string): NotificationPayload {
  const data: PreviewReadyPushData = {
    type: PREVIEW_READY_PUSH_TYPE,
    id: event.id,
    sessionId: event.sessionId,
    port: event.port,
    path: event.path,
  };
  return {
    type: PREVIEW_READY_PUSH_TYPE,
    title: `👀 Preview ready · ${where}`,
    body: `localhost:${event.port}${event.path === '/' ? '' : event.path}`,
    tag: `vibetunnel-preview-${event.id}`,
    actions: [
      { action: 'view-session', title: 'Open' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
    data: { ...data, url: previewReadyTapPath(data) },
  };
}

export interface PreviewPushOptions {
  send: (payload: NotificationPayload) => Promise<unknown>;
  /**
   * Whether some screen already shows this preview. Without a way to tell, every open is
   * pushed (the push is replaced, not stacked, by the next one for the same preview).
   */
  isOnScreen?: (event: PreviewOpenEvent) => boolean;
  delayMs?: number;
  onError?: (error: unknown) => void;
}

/** Sends "Preview ready" for an opened preview after a short wait, unless it is on screen. */
export function schedulePreviewReadyPush(
  event: PreviewOpenEvent,
  where: string,
  options: PreviewPushOptions
): void {
  const timer = setTimeout(() => {
    if (options.isOnScreen?.(event)) return;
    options.send(previewReadyPush(event, where)).catch((error) => options.onError?.(error));
  }, options.delayMs ?? PREVIEW_PUSH_DELAY_MS);
  timer.unref?.();
}
