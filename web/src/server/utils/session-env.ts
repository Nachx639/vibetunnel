/**
 * Environment for a new terminal session.
 *
 * A VibeTunnel server started from inside Claude Code (an agent, or `open -a`
 * from its shell) passed Claude Code's own session variables to every terminal. A `claude`
 * started there then believed it was a child session: no ~/.claude/sessions entry, no
 * transcript ("Transcript saving is off"), and the chat view/status badges found nothing.
 * These variables identify the launching Claude Code process and never belong to a new
 * terminal; user configuration (ANTHROPIC_API_KEY, CLAUDE_CODE_USE_BEDROCK, ...) is kept.
 */
const INHERITED_CLAUDE_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  // Exported next to the token.
  'CLAUDE_CODE_MESSAGING_SOCKET',
  // An OAuth token handed to the launching process (an SDK host, a bot): a session's own
  // `claude` must use the user's login, not borrow that identity. Claude Code itself does not
  // export it.
  'ANTHROPIC_OAUTH_TOKEN',
];

/**
 * The server's own secrets never reach a session: any program run there (an install script,
 * an agent) could read them. VIBETUNNEL_PASSWORD (the env alternative to --password) logs in
 * from elsewhere; JWT_SECRET signs VibeTunnel tokens, so it mints a login for anyone;
 * NGROK_AUTHTOKEN is the operator's ngrok account. Defense in depth: a session runs as the
 * same user, who can still read the persisted JWT secret file.
 */
const SERVER_SECRET_VARS = ['VIBETUNNEL_PASSWORD', 'JWT_SECRET', 'NGROK_AUTHTOKEN'];

export function terminalSessionEnv(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string>
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (
      value !== undefined &&
      !INHERITED_CLAUDE_SESSION_VARS.includes(key) &&
      !SERVER_SECRET_VARS.includes(key)
    ) {
      env[key] = value;
    }
  }
  return { ...env, ...overrides };
}
