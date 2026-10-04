import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// /api/fs/diff used to run `git diff HEAD -- "${path}"` through a shell, so a file named
// `a$(cmd).txt` ran `cmd` when its diff was opened. Commands that take paths or user input go
// through execFile/spawn with an argument array. Interpolating plain numbers (a pid) is fine.
// Reviewed exceptions: numeric pids, a constant service name, the local account name, and
// the program of a session the user starts themselves (it can already run anything).
// A tripwire, not a proof: it reads template literals passed straight to exec*, so a command
// built in a variable first (process-tree-analyzer, pty-manager: pid-only today) escapes it.
const ALLOWED = [
  /^[^$]*\$\{(?:pid|pgid|currentPid|rootPid)\}[^$]*$/,
  /^systemctl --user [\w-]+ \$\{SERVICE_NAME\}$/,
  /^loginctl enable-linger \$\{username\}$/,
  /^(?:which|command -v) "\$\{baseCommand\}" 2>\/dev\/null$/,
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('server shell commands', () => {
  it('never interpolate values into a shell command string', () => {
    const offenders = sources(__dirname).flatMap((file) =>
      [
        ...readFileSync(file, 'utf8').matchAll(
          /\b(?:exec|execAsync|execSync)\(\s*`([^`]*\$\{[^`]*)`/g
        ),
      ]
        .map((m) => m[1])
        .filter((cmd) => !ALLOWED.some((ok) => ok.test(cmd)))
        .map((cmd) => `${file}: ${cmd}`)
    );
    expect(offenders).toEqual([]);
  });

  it('never splice values into a `-c` script or run with shell: true', () => {
    const offenders = sources(__dirname).flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return [
        ...[...text.matchAll(/'-(?:l?i?c)'\s*,\s*`([^`]*\$\{[^`]*)`/g)]
          .map((m) => m[1])
          // process-utils checks commandName against /^[A-Za-z0-9_@%+,./:-]+$/ first and
          // passes the arguments separately ("$@" / $argv).
          .filter((script) => !/^\$\{commandName\} (?:"\$@"|\$argv)$/.test(script)),
        ...[...text.matchAll(/shell:\s*true/g)].map(() => 'shell: true'),
      ].map((hit) => `${file}: ${hit}`);
    });
    expect(offenders).toEqual([]);
  });
});
