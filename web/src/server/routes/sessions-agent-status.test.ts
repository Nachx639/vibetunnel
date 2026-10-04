import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readClaudeStatuses } from '../services/claude-chat';
import { readCodexChat } from '../services/codex-chat';
import { codexSessionRef } from '../services/codex-process';
import { createSessionRoutes } from './sessions';

vi.mock('../websocket/control-unix-handler', () => ({
  controlUnixHandler: { isMacAppConnected: vi.fn() },
}));
vi.mock('../utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));
vi.mock('../utils/git-info', () => ({ detectGitInfo: vi.fn(async () => ({})) }));
vi.mock('../services/claude-chat', async (importActual) => ({
  ...(await importActual<typeof import('../services/claude-chat')>()),
  readClaudeStatuses: vi.fn(),
}));

vi.mock('../services/codex-process', () => ({ codexSessionRef: vi.fn() }));
vi.mock('../services/codex-chat', async (importActual) => ({
  ...(await importActual<typeof import('../services/codex-chat')>()),
  readCodexChat: vi.fn(),
}));

type Handler = (req: Request, res: Response) => Promise<void>;

function listRoute(agentChat: boolean) {
  const sessions = [
    { id: 'claude', name: 'claude', pid: 42, status: 'running', workingDir: '/w' },
    { id: 'shell', name: 'zsh', pid: 43, status: 'running', workingDir: '/w' },
  ];
  const ptyManager = {
    listSessions: vi.fn(() => sessions.map((s) => ({ ...s }))),
    setClaudeTitle: vi.fn(),
    setClaudeSessionId: vi.fn(),
  };
  const screen = 'user@host ~/w % make\nbuilding target 3 of 9';
  const terminalManager = {
    canSnapshotCheaply: vi.fn(() => true),
    getChangeCount: vi.fn(() => 1),
    outputModifiedAt: vi.fn(() => 1),
    getBufferSnapshot: vi.fn(async () => ({
      cells: screen.split('\n').map((line) => [...line].map((char) => ({ char, width: 1 }))),
      cols: 80,
      rows: 2,
    })),
    getRecentText: vi.fn(async () => ({ text: '', rows: 24, cols: 80, wrappedRows: [] })),
  };
  const router = createSessionRoutes({
    ptyManager: ptyManager as never,
    terminalManager: terminalManager as never,
    remoteRegistry: null,
    isHQMode: false,
    agentChatEnabled: () => agentChat,
  });
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
  ).stack.find((r) => r.route?.path === '/sessions' && r.route.methods.get);
  if (!layer?.route) throw new Error('no GET /sessions');
  const handler = layer.route.stack[0].handle;
  const list = async (query: Record<string, string> = {}) => {
    const res = { json: vi.fn(), status: vi.fn() };
    res.status.mockReturnValue(res);
    await handler({ query } as never, res as never);
    return res.json.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
  };
  return { list, ptyManager, terminalManager };
}

describe('GET /sessions agent status', () => {
  beforeEach(() => {
    vi.mocked(readClaudeStatuses).mockReset();
    vi.mocked(readClaudeStatuses).mockResolvedValue(
      new Map([[42, { status: 'busy', title: 'Fix login', sessionId: 'abc-123' }]])
    );
    vi.mocked(codexSessionRef).mockReset();
    vi.mocked(codexSessionRef).mockResolvedValue(null);
    vi.mocked(readCodexChat).mockReset();
  });

  it('looks for Codex only with agent chat on, and only where no Claude Code runs', async () => {
    const ref = { id: 'proc:43:1', workingDir: '/w', startedAt: '2025-10-02T10:00:00.000Z' };
    vi.mocked(codexSessionRef).mockImplementation(async (session) =>
      session.id === 'shell' ? ref : null
    );
    vi.mocked(readCodexChat).mockReturnValue({
      available: true,
      agent: 'codex',
      title: 'add a dark mode',
      messages: [],
    });

    expect((await listRoute(false).list()).some((s) => s.codexActive)).toBe(false);
    expect(codexSessionRef).not.toHaveBeenCalled();

    const sessions = await listRoute(true).list();
    expect(sessions.find((s) => s.id === 'shell')).toMatchObject({
      codexActive: true,
      codexTitle: 'add a dark mode',
    });
    expect(sessions.find((s) => s.id === 'claude')?.codexActive).toBeUndefined();
    expect(codexSessionRef).toHaveBeenCalledTimes(1);
    expect(readCodexChat).toHaveBeenCalledWith(ref);
  });

  it('reads no process, transcript or screen and writes nothing while agent chat is off', async () => {
    const { list, ptyManager, terminalManager } = listRoute(false);
    const sessions = await list();
    expect(readClaudeStatuses).not.toHaveBeenCalled();
    expect(terminalManager.getBufferSnapshot).not.toHaveBeenCalled();
    expect(ptyManager.setClaudeTitle).not.toHaveBeenCalled();
    expect(sessions.every((s) => s.claudeStatus === undefined && s.lastLine === undefined)).toBe(
      true
    );
  });

  it("adds Claude's status and keeps its title and conversation id when on", async () => {
    const { list, ptyManager } = listRoute(true);
    const sessions = await list();
    const claude = sessions.find((s) => s.id === 'claude');
    expect(claude?.claudeStatus).toEqual({ status: 'busy', title: 'Fix login' });
    expect(ptyManager.setClaudeTitle).toHaveBeenCalledWith('claude', 'Fix login');
    expect(ptyManager.setClaudeSessionId).toHaveBeenCalledWith('claude', 'abc-123');
    expect(sessions.find((s) => s.id === 'shell')?.claudeStatus).toBeUndefined();
  });

  it("reads a shell's last line only when the list asks for it", async () => {
    const { list, terminalManager } = listRoute(false);
    expect((await list()).find((s) => s.id === 'shell')?.lastLine).toBeUndefined();
    expect(terminalManager.getBufferSnapshot).not.toHaveBeenCalled();
    const asked = await list({ lastLine: '1' });
    expect(asked.find((s) => s.id === 'shell')?.lastLine).toBe('building target 3 of 9');
  });
});
