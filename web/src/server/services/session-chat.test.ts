import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../../shared/types';
import { readClaudeChat } from './claude-chat';
import { readCodexChat } from './codex-chat';
import { codexSessionRef } from './codex-process';
import { readSessionChat } from './session-chat';

vi.mock('./claude-chat', () => ({ readClaudeChat: vi.fn() }));
vi.mock('./codex-chat', async (importActual) => ({
  ...(await importActual<typeof import('./codex-chat')>()),
  readCodexChat: vi.fn(() => ({ available: true, agent: 'codex', messages: [] })),
}));
vi.mock('./codex-process', () => ({ codexSessionRef: vi.fn() }));

function session(command: string[]): SessionInfo & { pid: number } {
  return {
    id: 's1',
    name: 'work',
    command,
    workingDir: '/Users/me/project',
    status: 'running',
    startedAt: '2025-10-03T10:00:00.000Z',
    pid: 500,
  };
}

describe('readSessionChat', () => {
  const claudeChat = { available: true, status: 'idle', messages: [] };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readClaudeChat).mockResolvedValue(claudeChat);
    vi.mocked(codexSessionRef).mockResolvedValue(null);
  });

  it('reads a session started with codex from its rollout, without looking for Claude', async () => {
    expect(await readSessionChat(session(['codex', '--model', 'o3']))).toMatchObject({
      agent: 'codex',
    });
    expect(readClaudeChat).not.toHaveBeenCalled();
  });

  it('reads Claude Code first in a shell, from the given program pid', async () => {
    expect(await readSessionChat(session(['zsh']), 700)).toBe(claudeChat);
    expect(readClaudeChat).toHaveBeenCalledWith(700);
    expect(codexSessionRef).not.toHaveBeenCalled();
  });

  it('finds Codex typed in a shell from its process when no Claude runs there', async () => {
    vi.mocked(readClaudeChat).mockResolvedValue({ available: false, messages: [] });
    const ref = { id: 'proc:701:1790000000000', workingDir: '/x', startedAt: '2025-10-03' };
    vi.mocked(codexSessionRef).mockResolvedValue(ref);
    const chat = await readSessionChat(session(['zsh']));
    expect(codexSessionRef).toHaveBeenCalledWith(expect.objectContaining({ pid: 500 }));
    expect(readCodexChat).toHaveBeenCalledWith(ref);
    expect(chat).toMatchObject({ agent: 'codex' });
  });

  it('reports no conversation when neither agent runs', async () => {
    vi.mocked(readClaudeChat).mockResolvedValue({ available: false, messages: [] });
    expect((await readSessionChat(session(['zsh']))).available).toBe(false);
  });
});
