import { type MessageKey, t } from '../i18n/index.js';

/**
 * Claude Code says what it waits for in English ("permission prompt"). Known reasons are shown
 * in the user's language; anything else is shown as Claude wrote it.
 */
const KNOWN: Record<string, MessageKey> = {
  'permission prompt': 'claudeWaiting.permission',
  'plan approval': 'claudeWaiting.plan',
  'user input': 'claudeWaiting.input',
};

export function claudeWaitingLabel(reason: string | null | undefined): string | undefined {
  if (!reason) return undefined;
  const key = KNOWN[reason.trim().toLowerCase()];
  return key ? t(key) : reason;
}
