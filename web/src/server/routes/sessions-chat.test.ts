import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readSessionChat } from '../services/session-chat';
import { createSessionRoutes } from './sessions';

vi.mock('../utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../services/session-chat', async (importActual) => ({
  ...(await importActual<typeof import('../services/session-chat')>()),
  readSessionChat: vi.fn(),
}));

type Handler = (req: Request, res: Response) => Promise<void>;

const running = {
  id: 's1',
  pid: 4242,
  status: 'running',
  command: ['claude'],
  workingDir: '/work',
  startedAt: '2025-01-02T10:00:00.000Z',
};

function chatRoute(options: { enabled?: () => boolean; session?: unknown }): Handler {
  const router = createSessionRoutes({
    ptyManager: {
      getSession: vi.fn(() => options.session),
      programRootPid: (session: { pid?: number }) => session.pid,
    } as never,
    terminalManager: {} as never,
    remoteRegistry: null,
    isHQMode: false,
    agentChatEnabled: options.enabled,
  });
  const layer = (
    router as unknown as {
      stack: Array<{ route?: { path: string; stack: Array<{ handle: Handler }> } }>;
    }
  ).stack.find((entry) => entry.route?.path === '/sessions/:sessionId/claude-chat');
  if (!layer?.route) throw new Error('no chat route');
  return layer.route.stack[0].handle;
}

async function call(handler: Handler, query: Record<string, unknown> = {}) {
  const res = { json: vi.fn(), status: vi.fn() };
  res.status.mockReturnValue(res);
  await handler({ params: { sessionId: 's1' }, query } as unknown as Request, res as never);
  return res;
}

describe('GET /sessions/:sessionId/claude-chat', () => {
  const chat = {
    available: true,
    status: 'idle',
    messages: [{ id: '1', role: 'user' as const, text: 'hello' }],
  };

  beforeEach(() => {
    vi.mocked(readSessionChat).mockReset();
    vi.mocked(readSessionChat).mockResolvedValue(chat);
  });

  it('is refused, and reads nothing, while agent chat is off', async () => {
    for (const enabled of [undefined, () => false]) {
      const res = await call(chatRoute({ enabled, session: running }));
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'disabled' }));
    }
    expect(readSessionChat).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown session', async () => {
    const res = await call(chatRoute({ enabled: () => true, session: undefined }));
    expect(res.status).toHaveBeenCalledWith(404);
    expect(readSessionChat).not.toHaveBeenCalled();
  });

  it('has no conversation for a session that is not running', async () => {
    const res = await call(
      chatRoute({ enabled: () => true, session: { ...running, status: 'exited' } })
    );
    expect(res.json).toHaveBeenCalledWith({ available: false, messages: [] });
    expect(readSessionChat).not.toHaveBeenCalled();
  });

  it("serves the session's conversation with a fingerprint, then leaves an unchanged list out", async () => {
    const handler = chatRoute({ enabled: () => true, session: running });
    const first = await call(handler);
    expect(readSessionChat).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1', pid: 4242 }),
      4242
    );
    const answer = first.json.mock.calls[0][0] as { messagesVersion: string; messages: unknown[] };
    expect(answer.messages).toEqual(chat.messages);

    const again = await call(handler, { have: answer.messagesVersion });
    const unchanged = again.json.mock.calls[0][0] as Record<string, unknown>;
    expect(unchanged).toMatchObject({ available: true, messagesUnchanged: true });
    expect(unchanged.messages).toBeUndefined();
  });

  it('reads the switch on every request', async () => {
    let on = false;
    const handler = chatRoute({ enabled: () => on, session: running });
    expect((await call(handler)).status).toHaveBeenCalledWith(403);
    on = true;
    expect((await call(handler)).status).not.toHaveBeenCalled();
  });
});
