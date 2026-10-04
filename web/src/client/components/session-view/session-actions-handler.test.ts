// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../shared/types.js';

const terminateSession = vi.fn();
vi.mock('../../services/session-action-service.js', () => ({
  sessionActionService: { terminateSession: (...args: unknown[]) => terminateSession(...args) },
}));

import { type SessionActionsCallbacks, SessionActionsHandler } from './session-actions-handler.js';

describe('SessionActionsHandler', () => {
  const session = {
    id: 's1',
    name: 'build',
    command: ['zsh'],
    status: 'running',
  } as unknown as Session;

  const handlerWith = (dispatchEvent: SessionActionsCallbacks['dispatchEvent']) => {
    const handler = new SessionActionsHandler();
    handler.setCallbacks({
      getSession: () => session,
      setSession: () => {},
      getViewMode: () => 'terminal',
      setViewMode: () => {},
      dispatchEvent,
      requestUpdate: () => {},
      handleBack: () => {},
      ensureTerminalInitialized: () => {},
    });
    return handler;
  };

  it('returns a rename failure, toasting it only when the caller does not show it itself', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const events: Event[] = [];
      const handler = handlerWith((event) => events.push(event) > 0);
      const first = await handler.handleRename('s1', 'release build');
      expect(first.success).toBe(false);
      expect(events.map((event) => event.type)).toEqual(['error']);

      events.length = 0;
      const second = await handler.handleRename('s1', 'release build', { showError: false });
      expect(second.success).toBe(false);
      expect(events).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('tells the app when a session it ended here is gone, and not when that failed', async () => {
    const events: Event[] = [];
    const handler = handlerWith((event) => events.push(event) > 0);

    terminateSession.mockImplementationOnce(async (_session, options) => {
      options.callbacks.onSuccess();
      return { success: true };
    });
    await handler.handleTerminateSession();
    const killed = events.find((event) => event.type === 'session-killed') as CustomEvent;
    expect(killed?.detail).toEqual({ sessionId: 's1', session });
    expect(killed.bubbles && killed.composed).toBe(true);

    events.length = 0;
    terminateSession.mockImplementationOnce(async (_session, options) => {
      options.callbacks.onError('nope');
      return { success: false, error: 'nope' };
    });
    await handler.handleTerminateSession();
    expect(events.map((event) => event.type)).toEqual(['error']);
  });
});
