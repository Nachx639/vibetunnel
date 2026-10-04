import type { Request, Response } from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeConversationExists, readClaudeStatuses } from '../services/claude-chat';
import { claudeResumeTarget, createSessionRoutes } from './sessions';

vi.mock('../websocket/control-unix-handler', () => ({
  controlUnixHandler: { isMacAppConnected: vi.fn() },
}));
vi.mock('../utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));
vi.mock('../utils/git-info', () => ({ detectGitInfo: vi.fn(async () => ({})) }));
vi.mock('../services/claude-chat', async (importActual) => ({
  ...(await importActual<typeof import('../services/claude-chat')>()),
  readClaudeStatuses: vi.fn(async () => new Map()),
  claudeConversationExists: vi.fn(() => true),
}));
vi.mock('../services/codex-process', () => ({ codexSessionRef: vi.fn(async () => null) }));
vi.mock('../services/gemini-process', () => ({ geminiSessionRef: vi.fn(async () => null) }));

type Handler = (req: Request, res: Response) => Promise<void>;

function routes(options: {
  agentChat?: boolean;
  live?: Map<string, { where: 'terminal' | 'tmux'; app?: string }>;
  sessions?: Array<Record<string, unknown>>;
  screen?: () => string;
}) {
  const sendInput = vi.fn();
  const ptyManager = {
    listSessions: vi.fn(() => (options.sessions ?? []).map((s) => ({ ...s }))),
    getSession: vi.fn(() => ({ id: 'new-1', pid: 12345, status: 'running' })),
    programRootPid: (session: { pid?: number }) => session.pid,
    setClaudeTitle: vi.fn(),
    setClaudeSessionId: vi.fn(),
    sendInput,
    createSession: vi.fn(async () => ({
      sessionId: 'new-1',
      sessionInfo: { id: 'new-1', pid: 12345, name: 'claude' },
    })),
  };
  const terminalManager = {
    canSnapshotCheaply: vi.fn(() => false),
    getChangeCount: vi.fn(() => 1),
    outputModifiedAt: vi.fn(() => 1),
    getBufferSnapshot: vi.fn(async () => {
      const text = options.screen?.() ?? '';
      return {
        cells: text.split('\n').map((line) => [...line].map((char) => ({ char, width: 1 }))),
        cols: 80,
        rows: 24,
      };
    }),
    getRecentText: vi.fn(async () => ({ text: '', rows: 24, cols: 80, wrappedRows: [] })),
  };
  const liveClaudeConversations = vi.fn(async () => options.live ?? new Map());
  const router = createSessionRoutes({
    ptyManager: ptyManager as never,
    terminalManager: terminalManager as never,
    remoteRegistry: null,
    isHQMode: false,
    agentChatEnabled: () => options.agentChat ?? true,
    liveClaudeConversations,
  });
  const handler = (method: 'get' | 'post') => {
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
    ).stack.find((r) => r.route?.path === '/sessions' && r.route.methods[method]);
    if (!layer?.route) throw new Error(`no ${method} /sessions`);
    return layer.route.stack[0].handle;
  };
  const call = async (method: 'get' | 'post', req: Record<string, unknown>) => {
    const res = { json: vi.fn(), status: vi.fn() };
    res.status.mockReturnValue(res);
    await handler(method)({ query: {}, ...req } as never, res as never);
    return res;
  };
  return { call, ptyManager, sendInput, liveClaudeConversations };
}

describe('claudeResumeTarget', () => {
  it('finds the conversation of claude --resume / -r / --resume=', () => {
    expect(claudeResumeTarget(['claude', '--resume', 'abc'])).toBe('abc');
    expect(claudeResumeTarget(['/usr/local/bin/claude', '-r', 'abc'])).toBe('abc');
    expect(claudeResumeTarget(['claude', '--resume=abc'])).toBe('abc');
    expect(claudeResumeTarget(['claude'])).toBeNull();
    expect(claudeResumeTarget(['claude', '--resume', '--model'])).toBeNull();
    expect(claudeResumeTarget(['codex', 'resume', 'abc'])).toBeNull();
    expect(claudeResumeTarget(['zsh', '-c', 'claude --resume abc'])).toBeNull();
  });
});

describe('POST /sessions: a conversation running outside VibeTunnel', () => {
  const live = new Map([['conv-live', { where: 'terminal' as const, app: 'Terminal' }]]);

  it.each([
    [['claude', '--resume', 'conv-live', '--dangerously-skip-permissions']],
    [['/opt/homebrew/bin/claude', '-r', 'conv-live']],
    [['claude', '--resume=conv-live']],
  ])('is never resumed here: %j', async (command) => {
    const { call, ptyManager } = routes({ live });
    const res = await call('post', { body: { command, workingDir: os.tmpdir() } });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'live-elsewhere', live: live.get('conv-live') })
    );
    expect(ptyManager.createSession).not.toHaveBeenCalled();
  });

  it('starts anything else, and asks for live conversations only for a resume', async () => {
    for (const command of [['claude'], ['codex', 'resume', 'conv-live'], ['zsh']]) {
      const { call, ptyManager, liveClaudeConversations } = routes({ live });
      const res = await call('post', { body: { command, workingDir: os.tmpdir() } });
      expect(res.status).not.toHaveBeenCalledWith(409);
      expect(ptyManager.createSession).toHaveBeenCalledTimes(1);
      expect(liveClaudeConversations).not.toHaveBeenCalled();
    }
    const { call, ptyManager } = routes({ live });
    await call('post', { body: { command: ['claude', '--resume', 'conv-done'], workingDir: '/' } });
    expect(ptyManager.createSession).toHaveBeenCalledTimes(1);
  });

  it('starts the command exactly as given: no permission flag is ever added', async () => {
    const { call, ptyManager } = routes({});
    await call('post', { body: { command: ['claude', '--resume', 'conv-1'], workingDir: '/' } });
    expect(ptyManager.createSession).toHaveBeenCalledWith(
      ['claude', '--resume', 'conv-1'],
      expect.anything()
    );
  });
});

describe('POST /sessions: initialInput ("Ask Claude" / "Ask Codex")', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('types it once Claude is idle, as keyboard input', async () => {
    let status = 'busy';
    vi.mocked(readClaudeStatuses).mockImplementation(async () => new Map([[12345, { status }]]));
    const { call, sendInput } = routes({});
    const res = await call('post', {
      body: { command: ['claude'], workingDir: '/', initialInput: 'fix the tests' },
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'new-1' }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(sendInput).not.toHaveBeenCalled();
    status = 'idle';
    await vi.advanceTimersByTimeAsync(3000);
    expect(sendInput.mock.calls).toEqual([
      ['new-1', { text: 'fix the tests' }],
      ['new-1', { key: 'enter' }],
    ]);
  });

  it("waits for Codex's prompt on screen for a codex command", async () => {
    let screen = 'user@host ~ % codex';
    const { call, sendInput } = routes({ screen: () => screen });
    await call('post', {
      body: { command: ['codex'], workingDir: '/', initialInput: 'hello' },
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(sendInput).not.toHaveBeenCalled();
    screen = '› Ask Codex to do anything\n\n  100% context left';
    await vi.advanceTimersByTimeAsync(5000);
    expect(sendInput.mock.calls[0]).toEqual(['new-1', { text: 'hello' }]);
  });

  it('is refused while agent chat is off, and checked before anything starts', async () => {
    const off = routes({ agentChat: false });
    const res = await off.call('post', {
      body: { command: ['claude'], workingDir: '/', initialInput: 'hi' },
    });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(off.ptyManager.createSession).not.toHaveBeenCalled();

    for (const body of [
      { initialInput: ['rm -rf'] },
      { initialInput: 'x'.repeat(20001) },
      { initialInput: 'hi', initialInputAgent: 'bash' },
    ]) {
      const on = routes({});
      const bad = await on.call('post', {
        body: { command: ['claude'], workingDir: '/', ...body },
      });
      expect(bad.status).toHaveBeenCalledWith(400);
      expect(on.ptyManager.createSession).not.toHaveBeenCalled();
    }
  });
});

describe('GET /sessions: claudeResumable', () => {
  const exited = {
    id: 'done',
    name: 'claude',
    pid: 1,
    status: 'exited',
    workingDir: '/w',
    command: ['claude'],
    claudeSessionId: 'conv-1',
  };

  it('is computed for exited Claude sessions only while agent chat is on', async () => {
    vi.mocked(claudeConversationExists).mockClear();
    const on = await routes({ sessions: [exited] }).call('get', {});
    expect(on.json.mock.calls[0][0][0].claudeResumable).toBe(true);
    const off = await routes({ agentChat: false, sessions: [exited] }).call('get', {});
    expect(off.json.mock.calls[0][0][0].claudeResumable).toBeUndefined();
    expect(claudeConversationExists).toHaveBeenCalledTimes(1);
  });
});

describe('claudeConversationExists', () => {
  it('never looks up an id that could name a path', async () => {
    const actual =
      await vi.importActual<typeof import('../services/claude-chat')>('../services/claude-chat');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-resumable-'));
    try {
      fs.mkdirSync(path.join(dir, 'projects', '-w'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'projects', '-w', 'conv-1.jsonl'), '{}\n');
      fs.writeFileSync(path.join(dir, 'outside.jsonl'), '{}\n');
      expect(actual.claudeConversationExists('/w', 'conv-1', dir)).toBe(true);
      expect(actual.claudeConversationExists('/w', '../../outside', dir)).toBe(false);
      expect(actual.claudeConversationExists('/w', 'conv-2', dir)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
