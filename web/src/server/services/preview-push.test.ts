import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { previewReadyTapPath } from '../../shared/preview-push.js';
import {
  PREVIEW_PUSH_DELAY_MS,
  previewReadyPush,
  schedulePreviewReadyPush,
} from './preview-push.js';

const event = { id: 'pshop123', sessionId: 's1', port: 5173, path: '/cart' };

describe('previewReadyPush', () => {
  it('names the session and the dev server, and deep-links to the preview view', () => {
    const push = previewReadyPush(event, 'web app');
    expect(push.type).toBe('preview-ready');
    expect(push.title).toBe('👀 Preview ready · web app');
    expect(push.body).toBe('localhost:5173');
    expect(push.tag).toBe('vibetunnel-preview-pshop123');
    expect(push.data).toEqual({
      type: 'preview-ready',
      id: 'pshop123',
      sessionId: 's1',
      port: 5173,
      path: '/cart',
      url: '/preview/pshop123?path=%2Fcart',
    });
  });

  it('shows the title or host:port only, never the path or a query token', () => {
    const jupyter = { ...event, port: 8888, path: '/lab?token=abc123#x' };
    const push = previewReadyPush(jupyter, 'notebook');
    expect(push.body).toBe('localhost:8888');
    expect(JSON.stringify([push.title, push.body])).not.toContain('abc123');
    expect(previewReadyPush(jupyter, 'notebook', '  JupyterLab ').body).toBe('JupyterLab');
    expect(previewReadyPush(jupyter, 'notebook', '   ').body).toBe('localhost:8888');
    // The tap still opens the exact page: the path stays in data only.
    expect(push.data?.path).toBe('/lab?token=abc123#x');
  });

  it('leaves "/" out of the link', () => {
    const push = previewReadyPush({ ...event, path: '/' }, 'web app');
    expect(push.body).toBe('localhost:5173');
    expect(push.data?.url).toBe('/preview/pshop123');
  });
});

describe('previewReadyTapPath', () => {
  it('opens /preview/<id> only for a preview-ready push with a valid id', () => {
    expect(previewReadyTapPath({ type: 'preview-ready', id: 'pshop123', path: '/' })).toBe(
      '/preview/pshop123'
    );
    expect(previewReadyTapPath({ type: 'preview-ready', id: '../x', path: '/' })).toBeNull();
    expect(previewReadyTapPath({ type: 'session-exit', id: 'pshop123' })).toBeNull();
    expect(previewReadyTapPath(undefined)).toBeNull();
  });

  it('ignores a path that is not absolute', () => {
    expect(previewReadyTapPath({ type: 'preview-ready', id: 'pshop123', path: 'evil' })).toBe(
      '/preview/pshop123'
    );
  });
});

describe('schedulePreviewReadyPush', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends the push after the wait when the preview is not on screen', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const titleOf = vi.fn().mockReturnValue('Shop');
    schedulePreviewReadyPush(event, 'web app', { send, isOnScreen: () => false, titleOf });
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PREVIEW_PUSH_DELAY_MS);
    expect(send).toHaveBeenCalledTimes(1);
    // The title is read when the push goes out (the health check may have found it by then).
    expect(titleOf).toHaveBeenCalledWith(event);
    expect(send.mock.calls[0][0].body).toBe('Shop');
    expect(send.mock.calls[0][0].data.url).toBe('/preview/pshop123?path=%2Fcart');
  });

  it('skips the push when a screen already shows the preview', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const isOnScreen = vi.fn().mockReturnValue(true);
    schedulePreviewReadyPush(event, 'web app', { send, isOnScreen });
    await vi.advanceTimersByTimeAsync(PREVIEW_PUSH_DELAY_MS);
    expect(isOnScreen).toHaveBeenCalledWith(event);
    expect(send).not.toHaveBeenCalled();
  });

  it('reports a failed send instead of throwing', async () => {
    const error = new Error('no subscriptions');
    const onError = vi.fn();
    schedulePreviewReadyPush(event, 'web app', {
      send: vi.fn().mockRejectedValue(error),
      onError,
    });
    await vi.advanceTimersByTimeAsync(PREVIEW_PUSH_DELAY_MS);
    expect(onError).toHaveBeenCalledWith(error);
  });
});
