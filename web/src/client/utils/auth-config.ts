/**
 * GET /api/auth/config, shared by the callers that ask within a few seconds of each other. At
 * startup the app asked it, then the terminal socket asked it again before the session list
 * could load: one more round trip in a row on every cold start. The answer only changes when
 * the server restarts with other flags.
 */
const SHARE_MS = 5000;

export interface AuthConfig {
  noAuth?: boolean;
  authenticatedUser?: string;
  [key: string]: unknown;
}

let shared: { at: number; answer: Promise<AuthConfig | null> } | null = null;

/** The server's auth config; null when it answers with an error status. Rejects like fetch. */
export function fetchAuthConfig(): Promise<AuthConfig | null> {
  const now = Date.now();
  if (shared && now - shared.at < SHARE_MS) return shared.answer;
  const answer = fetch('/api/auth/config').then(async (response) =>
    response.ok ? ((await response.json()) as AuthConfig) : null
  );
  const entry = { at: now, answer };
  shared = entry;
  // A failed request is not shared: the next caller tries again.
  answer.catch(() => {
    if (shared === entry) shared = null;
  });
  return answer;
}
