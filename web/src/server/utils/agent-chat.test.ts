import { describe, expect, it } from 'vitest';
import { agentChatEnabled } from './agent-chat.js';

describe('agentChatEnabled', () => {
  it('is off when nothing turns it on', () => {
    expect(agentChatEnabled({}, {})).toBe(false);
    expect(agentChatEnabled({ agentChat: false }, {})).toBe(false);
  });

  it('follows config.json', () => {
    expect(agentChatEnabled({ agentChat: true }, {})).toBe(true);
  });

  it('lets the environment turn it on or off, whatever config.json says', () => {
    expect(agentChatEnabled({}, { VIBETUNNEL_AGENT_CHAT: '1' })).toBe(true);
    expect(agentChatEnabled({}, { VIBETUNNEL_AGENT_CHAT: ' TRUE ' })).toBe(true);
    expect(agentChatEnabled({ agentChat: true }, { VIBETUNNEL_AGENT_CHAT: '0' })).toBe(false);
    expect(agentChatEnabled({ agentChat: true }, { VIBETUNNEL_AGENT_CHAT: 'off' })).toBe(false);
  });

  it('ignores an unknown value of the variable', () => {
    expect(agentChatEnabled({ agentChat: true }, { VIBETUNNEL_AGENT_CHAT: 'maybe' })).toBe(true);
    expect(agentChatEnabled({}, { VIBETUNNEL_AGENT_CHAT: 'maybe' })).toBe(false);
  });
});
