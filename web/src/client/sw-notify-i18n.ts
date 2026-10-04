/**
 * Push notifications in the user's language. The server can't know it, and the service
 * worker can't load the i18n bundle, so the app stores these few strings in Cache Storage
 * while online (utils/offline-page.ts) and the worker rebuilds the title and body from the
 * raw fields the server sends (`data.where`, `data.detail`). A push without those fields, or
 * a worker that never got the strings, shows the server's English text unchanged.
 */
export const NOTIFY_STRINGS_URL = '/__vibetunnel/notify-strings.json';

export interface NotifyStrings {
  needsYou: string; // "⏳ Claude needs you · {where}"
  finished: string; // "✅ Claude finished · {where}"
  waiting: string; // body when Claude didn't say what it waits for
  yourTurn: string; // body when there's no answer preview
  open: string;
  dismiss: string;
  // Optional so a string set cached by an older app version stays valid.
  attention?: string; // "🔔 {where} needs attention" (terminal bell)
  bellBody?: string;
  commandFailed?: string; // "❌ {where} failed" (command error)
  commandFailedBody?: string; // "Exit code {code} · {duration}"
}

interface LocalizableNotification {
  title: string;
  body: string;
  actions?: Array<{ action: string; title: string }>;
  data?: { type?: string; where?: string; detail?: string };
}

/** A cached string set is only trusted when every required field is a string. */
export function isNotifyStrings(value: unknown): value is NotifyStrings {
  if (!value || typeof value !== 'object') return false;
  const fields: Array<keyof NotifyStrings> = [
    'needsYou',
    'finished',
    'waiting',
    'yourTurn',
    'open',
    'dismiss',
  ];
  return fields.every((field) => typeof (value as Record<string, unknown>)[field] === 'string');
}

export function localizeNotification<T extends LocalizableNotification>(
  payload: T,
  strings: NotifyStrings | null
): T {
  const { type, where, detail } = payload.data ?? {};
  if (!strings || typeof where !== 'string') return payload;
  // split/join, not replace(): a name with "$'" or "$$" is a replacement pattern there.
  const fill = (template: string) => template.split('{where}').join(where);
  let title: string;
  let body: string;
  if (type === 'claude-waiting') {
    title = fill(strings.needsYou);
    body = detail || strings.waiting;
  } else if (type === 'claude-finished') {
    title = fill(strings.finished);
    body = detail || strings.yourTurn;
  } else if (type === 'command-error' && strings.commandFailed) {
    title = fill(strings.commandFailed);
    const code = (payload.data as { exitCode?: unknown } | undefined)?.exitCode;
    body = (strings.commandFailedBody ?? payload.body)
      .split('{code}')
      .join(String(code ?? '?'))
      .split('{duration}')
      .join(detail ?? '');
  } else if (type === 'bell' && strings.attention) {
    title = fill(strings.attention);
    body = strings.bellBody || payload.body;
  } else {
    return payload;
  }
  const actions = payload.actions?.map((action) =>
    action.action === 'view-session'
      ? { ...action, title: strings.open }
      : action.action === 'dismiss'
        ? { ...action, title: strings.dismiss }
        : action
  );
  return { ...payload, title, body, ...(actions ? { actions } : {}) };
}
