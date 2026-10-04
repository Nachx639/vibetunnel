// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../shared/types.js';
import {
  ClaudeLiveOutsideError,
  claudeResumeCommand,
  findLiveClaudeSession,
  liveOutsideText,
  preferChatMode,
  resumeClaudeConversation,
} from './claude-resume.js';

const session = (overrides: Partial<Session>): Session =>
  ({ id: 's', command: ['zsh'], workingDir: '/w', status: 'running', ...overrides }) as Session;

describe('claude-resume', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds the resume command with the permissions flag only when asked', () => {
    expect(claudeResumeCommand('abc', false)).toEqual(['claude', '--resume', 'abc']);
    expect(claudeResumeCommand('abc', true)).toEqual([
      'claude',
      '--resume',
      'abc',
      '--dangerously-skip-permissions',
    ]);
  });

  it('never adds the permissions flag on its own, whatever other sessions ran', async () => {
    // Other sessions started with the bypass, and the phone's last start too: still not added.
    localStorage.setItem(
      'vt-phone-recent-starts',
      JSON.stringify({ tool: 'claude --dangerously-skip-permissions' })
    );
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ sessionId: 'new' }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    await resumeClaudeConversation({
      claudeSessionId: 'c1',
      workingDir: '/w',
      skipPermissions: false,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).command).toEqual([
      'claude',
      '--resume',
      'c1',
    ]);
  });

  it('finds a running session already showing the conversation', () => {
    const sessions = [
      session({ id: 'old', status: 'exited', claudeSessionId: 'c1' }),
      session({ id: 'live', claudeSessionId: 'c1' }),
    ];
    expect(findLiveClaudeSession(sessions, 'c1')?.id).toBe('live');
    expect(findLiveClaudeSession(sessions, 'c2')).toBeUndefined();
  });

  it('keeps other app preferences when asking for chat mode', () => {
    localStorage.setItem('vibetunnel_app_preferences', JSON.stringify({ theme: 'dark' }));
    preferChatMode();
    expect(JSON.parse(localStorage.getItem('vibetunnel_app_preferences') || '{}')).toEqual({
      theme: 'dark',
      chatMode: true,
    });
  });

  it('posts the session and reports server errors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: 'new' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'nope' }), { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      resumeClaudeConversation({ claudeSessionId: 'c1', workingDir: '/w', skipPermissions: false })
    ).resolves.toMatchObject({ sessionId: 'new' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      command: ['claude', '--resume', 'c1'],
      workingDir: '/w',
      spawn_terminal: false,
    });
    await expect(
      resumeClaudeConversation({ claudeSessionId: 'c1', workingDir: '/w', skipPermissions: false })
    ).rejects.toThrow('nope');
  });

  it('says where a conversation runs when the server won’t resume it there', async () => {
    const live = { where: 'terminal', app: 'Terminal', chatId: 'a-530-1759395600' };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ error: 'live-elsewhere', live }), { status: 409 })
      )
    );
    const error = await resumeClaudeConversation({
      claudeSessionId: 'c1',
      workingDir: '/w',
      skipPermissions: false,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClaudeLiveOutsideError);
    expect((error as ClaudeLiveOutsideError).live).toEqual(live);
    expect((error as Error).message).toBe(
      'Open in Terminal right now. Close it there to continue here.'
    );
  });

  it('words where it runs: an app, tmux, or just outside VibeTunnel', () => {
    expect(liveOutsideText({ where: 'terminal', app: 'iTerm' })).toBe(
      'Open in iTerm right now. Close it there to continue here.'
    );
    expect(liveOutsideText({ where: 'terminal', app: 'SSH' })).toBe(
      'Open in SSH session right now. Close it there to continue here.'
    );
    expect(liveOutsideText({ where: 'terminal' })).toBe(
      'Running outside VibeTunnel right now. Close it there to continue here.'
    );
    expect(liveOutsideText({ where: 'tmux', tmuxId: 't-1-2-3' })).toBe(
      'Running in tmux right now. Open it from the list to continue.'
    );
  });
});
