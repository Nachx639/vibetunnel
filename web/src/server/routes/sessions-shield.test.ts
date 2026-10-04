import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readClaudeStatuses } from '../services/claude-chat';
import { createSessionRoutes } from './sessions';

vi.mock('../websocket/control-unix-handler', () => ({
  controlUnixHandler: { isMacAppConnected: vi.fn(() => false) },
}));
vi.mock('../utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));
vi.mock('../utils/git-info', () => ({ detectGitInfo: vi.fn(async () => ({})) }));
vi.mock('../services/claude-chat', async (importActual) => ({
  ...(await importActual<typeof import('../services/claude-chat')>()),
  readClaudeStatuses: vi.fn(async () => new Map()),
}));

type Handler = (req: Request, res: Response) => Promise<void>;
type Routes = Parameters<typeof createSessionRoutes>[0];

function route(router: ReturnType<typeof createSessionRoutes>, method: string, path: string) {
  const layer = (
    router as unknown as {
      stack: Array<{
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: Array<{ handle: Handler }>;
        };
      }>;
    }
  ).stack.find((entry) => entry.route?.path === path && entry.route.methods[method]);
  if (!layer?.route) throw new Error(`no ${method} ${path}`);
  return layer.route.stack[0].handle;
}

function response() {
  const res = { json: vi.fn(), status: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe('POST /sessions shielding (off by default)', () => {
  async function created(
    body: Record<string, unknown>,
    options: { setting?: boolean | 'missing'; tmux?: boolean } = {}
  ) {
    const createSession = vi.fn(async () => ({
      sessionId: 's-1',
      sessionInfo: { id: 's-1', pid: 1, name: 'x', command: ['zsh'], workingDir: '/tmp' },
    }));
    const router = createSessionRoutes({
      ptyManager: { createSession, isShieldAvailable: () => options.tmux ?? true } as never,
      terminalManager: {} as never,
      remoteRegistry: null,
      isHQMode: false,
      ...(options.setting === 'missing'
        ? {}
        : { shieldNewSessionsByDefault: () => options.setting ?? false }),
    } as Routes);
    const res = response();
    await route(
      router,
      'post',
      '/sessions'
    )({ body: { command: ['zsh'], workingDir: '/tmp', ...body } } as Request, res as never);
    const call = createSession.mock.calls[0] as unknown[] | undefined;
    return (call?.[1] as { shielded?: boolean } | undefined)?.shielded === true;
  }

  it.each([
    ['no choice, no setting wired', {}, { setting: 'missing' as const }, false],
    ['no choice, setting off (the default)', {}, { setting: false }, false],
    ['no choice, setting on, tmux there', {}, { setting: true }, true],
    ['no choice, setting on, no tmux', {}, { setting: true, tmux: false }, false],
    ['explicit shielded: true with the setting off', { shielded: true }, {}, true],
    ['explicit shielded: false with the setting on', { shielded: false }, { setting: true }, false],
    [
      'a terminal-window session with the setting on',
      { spawn_terminal: true },
      { setting: true },
      false,
    ],
  ])('%s', async (_label, body, options, expected) => {
    expect(await created(body, options)).toBe(expected);
  });

  it('answers 501 for an explicit shielded session without tmux', async () => {
    const createSession = vi.fn();
    const router = createSessionRoutes({
      ptyManager: { createSession, isShieldAvailable: () => false } as never,
      terminalManager: {} as never,
      remoteRegistry: null,
      isHQMode: false,
    });
    const res = response();
    await route(
      router,
      'post',
      '/sessions'
    )({ body: { command: ['zsh'], workingDir: '/tmp', shielded: true } } as Request, res as never);
    expect(res.status).toHaveBeenCalledWith(501);
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe('POST /sessions/:sessionId/shield', () => {
  function shieldRoute(session: Record<string, unknown> | undefined, tmux = true) {
    const killSession = vi.fn(async () => {});
    const createSession = vi.fn(async () => ({ sessionId: 'new-1', sessionInfo: {} }));
    const router = createSessionRoutes({
      ptyManager: {
        getSession: vi.fn(() => session),
        isShieldAvailable: () => tmux,
        killSession,
        createSession,
      } as never,
      terminalManager: {} as never,
      remoteRegistry: null,
      isHQMode: false,
    });
    const handler = route(router, 'post', '/sessions/:sessionId/shield');
    return {
      killSession,
      createSession,
      call: async () => {
        const res = response();
        await handler({ params: { sessionId: 'x' }, body: {} } as unknown as Request, res as never);
        return res;
      },
    };
  }

  it('refuses a session opened with vt in a terminal window, never closing it there', async () => {
    const shield = shieldRoute({
      id: 'fwd_1700000000000_6805',
      status: 'running',
      command: ['claude'],
      claudeSessionId: 'conv-1',
      workingDir: '/tmp',
    });
    expect((await shield.call()).status).toHaveBeenCalledWith(409);
    expect(shield.killSession).not.toHaveBeenCalled();
    expect(shield.createSession).not.toHaveBeenCalled();
  });

  it('answers 404, 409 for an already shielded session, and 501 without tmux', async () => {
    expect((await shieldRoute(undefined).call()).status).toHaveBeenCalledWith(404);
    const running = { id: 'a', status: 'running', command: ['zsh'], workingDir: '/tmp' };
    expect((await shieldRoute({ ...running, shielded: true }).call()).status).toHaveBeenCalledWith(
      409
    );
    expect((await shieldRoute(running, false).call()).status).toHaveBeenCalledWith(501);
  });

  it('continues a Claude conversation shielded and closes the old session', async () => {
    const shield = shieldRoute({
      id: 'a',
      status: 'running',
      command: ['claude', '--dangerously-skip-permissions'],
      claudeSessionId: 'conv-1',
      workingDir: '/tmp',
    });
    const res = await shield.call();
    expect(shield.killSession).toHaveBeenCalledWith('x');
    // The user asked for it in a session that already runs this way: its flag stays.
    expect(shield.createSession).toHaveBeenCalledWith(
      ['claude', '--resume', 'conv-1', '--dangerously-skip-permissions'],
      expect.objectContaining({ shielded: true })
    );
    expect(res.json).toHaveBeenCalledWith({ sessionId: 'new-1', replaced: true });
  });

  it('starts anything else again shielded and leaves the old session alone', async () => {
    const shield = shieldRoute({
      id: 'a',
      status: 'running',
      command: ['zsh'],
      workingDir: '/tmp',
    });
    const res = await shield.call();
    expect(shield.killSession).not.toHaveBeenCalled();
    expect(shield.createSession).toHaveBeenCalledWith(
      ['zsh'],
      expect.objectContaining({ shielded: true })
    );
    expect(res.json).toHaveBeenCalledWith({ sessionId: 'new-1', replaced: false });
  });
});

describe('GET /sessions in a shielded session', () => {
  beforeEach(() => vi.mocked(readClaudeStatuses).mockClear());

  it("reads Claude's status under the program inside tmux, not the tmux client", async () => {
    const session = {
      id: 's1',
      pid: 100,
      status: 'running',
      shielded: true,
      command: ['claude'],
      workingDir: '/tmp',
      gitRepoPath: '/tmp',
    };
    const router = createSessionRoutes({
      ptyManager: {
        listSessions: () => [session],
        programRootPid: (s: { pid?: number; shielded?: boolean }) => (s.shielded ? 200 : s.pid),
      } as never,
      terminalManager: {} as never,
      remoteRegistry: null,
      isHQMode: false,
      agentChatEnabled: () => true,
    });
    await route(
      router,
      'get',
      '/sessions'
    )({ query: {} } as unknown as Request, response() as never);
    expect(readClaudeStatuses).toHaveBeenCalledWith([200]);
  });
});
