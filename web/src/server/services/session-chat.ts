/**
 * The agent conversation running in a local session, in the chat shape, for the phone chat
 * view. Claude Code is read from its transcript (claude-chat.ts).
 */
import { createHash } from 'node:crypto';
import type { SessionInfo } from '../../shared/types.js';
import { type ClaudeChat, readClaudeChat } from './claude-chat.js';

type ChatSession = SessionInfo & { pid: number };

/** `programPid`: the process the agent runs under; the session's own pid by default. */
export async function readSessionChat(
  session: ChatSession,
  programPid: number = session.pid
): Promise<ClaudeChat> {
  return readClaudeChat(programPid);
}

/**
 * A short fingerprint of a chat's messages. The phone polls the chat every 1.5 s while the
 * agent works, but the messages change only every few seconds; it sends back the fingerprint
 * it has (`?have=`) and an unchanged list is left out of the answer. Without it a long
 * conversation was ~200 KB of JSON (~50 KB compressed) on every poll, ~2 MB a minute.
 */
export function chatMessagesVersion(messages: readonly unknown[]): string {
  return createHash('sha1').update(JSON.stringify(messages)).digest('base64url').slice(0, 16);
}

/** The chat answer for a client that already shows the messages with fingerprint `have`. */
export function chatAnswer<T extends { messages: readonly unknown[] }>(chat: T, have: unknown) {
  const messagesVersion = chatMessagesVersion(chat.messages);
  if (typeof have === 'string' && have === messagesVersion) {
    const { messages: _messages, ...rest } = chat;
    return { ...rest, messagesVersion, messagesUnchanged: true as const };
  }
  return { ...chat, messagesVersion };
}
