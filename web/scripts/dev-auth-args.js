/**
 * Auth flags dev.js adds to the server command line.
 *
 * Plain `pnpm run dev` (no server arguments) stays open for local hacking: --no-auth. Anything
 * that passes server arguments owns auth. The Mac app always passes --port and, in its "none"
 * mode, --no-auth itself; in password mode (the default) it passes no auth flag at all, so
 * looking for auth flags would still open a server the app meant to protect.
 */
function devServerAuthArgs(serverArgs) {
  const given = serverArgs.filter((arg) => arg !== '--');
  return given.length === 0 ? ['--no-auth'] : [];
}

module.exports = { devServerAuthArgs };
