/**
 * Finding tmux and the environment its commands run with. "On this computer"
 * (services/mac-sessions) uses these for the user's own tmux servers.
 */
import * as fs from 'fs';
import * as path from 'path';

const TMUX_CANDIDATES = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'];

let cachedTmux: string | null | undefined;

/** The tmux binary (`VIBETUNNEL_TMUX_BIN` first), or null when tmux isn't installed. */
export function findTmuxBinary(): string | null {
  if (cachedTmux !== undefined) return cachedTmux;
  const fromEnv = process.env.VIBETUNNEL_TMUX_BIN;
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const candidates = [
    ...(fromEnv ? [fromEnv] : []),
    ...TMUX_CANDIDATES,
    ...pathDirs.map((dir) => path.join(dir, 'tmux')),
  ];
  cachedTmux = candidates.find((candidate) => isExecutable(candidate)) ?? null;
  return cachedTmux;
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The environment tmux commands run with: never inside another tmux. */
export function tmuxEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && key !== 'TMUX' && key !== 'TMUX_PANE') env[key] = value;
  }
  return env;
}
