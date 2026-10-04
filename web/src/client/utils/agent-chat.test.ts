import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentChatEnabled, resetAgentChatCache } from './agent-chat.js';

describe('agentChatEnabled (client)', () => {
  beforeEach(() => resetAgentChatCache());
  afterEach(() => vi.unstubAllGlobals());

  const answer = (body: unknown, ok = true) =>
    vi.fn(async () => ({ ok, json: async () => body }) as Response);

  it('is on only when the server says agentChat: true', async () => {
    vi.stubGlobal('fetch', answer({ agentChat: true }));
    expect(await agentChatEnabled()).toBe(true);
    resetAgentChatCache();
    vi.stubGlobal('fetch', answer({ agentChat: false }));
    expect(await agentChatEnabled()).toBe(false);
    resetAgentChatCache();
    vi.stubGlobal('fetch', answer({}));
    expect(await agentChatEnabled()).toBe(false);
  });

  it('is off when the config cannot be read', async () => {
    vi.stubGlobal('fetch', answer({ agentChat: true }, false));
    expect(await agentChatEnabled()).toBe(false);
    resetAgentChatCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      })
    );
    expect(await agentChatEnabled()).toBe(false);
  });

  it('asks the server once for concurrent and quick repeated checks', async () => {
    const fetch = answer({ agentChat: true });
    vi.stubGlobal('fetch', fetch);
    await Promise.all([agentChatEnabled(), agentChatEnabled()]);
    await agentChatEnabled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
