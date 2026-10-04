/**
 * Finding and supervising local helper programs (voice: ffmpeg, whisper.cpp, TTS engines).
 *
 * Paths from environment variables must be absolute existing files; a set but unusable one is
 * not replaced by another copy found on PATH. Recorded helper processes left behind by a
 * crashed server are signalled only if their command line still matches.
 */
import { execFileSync } from 'child_process';
import { accessSync, constants, readFileSync, rmSync, statSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

/** An absolute path to an existing regular file (executable when `executable`), or null. */
export function usableFile(candidate: string | undefined, executable: boolean): string | null {
  if (!candidate || !path.isAbsolute(candidate)) return null;
  try {
    if (!statSync(candidate).isFile()) return null;
    if (executable) accessSync(candidate, constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * `envVar` when set (and usable), else `name` on PATH plus the Homebrew folders (the macOS
 * app's server may start with a minimal PATH) and `extraDirs`.
 */
export function findBinary(name: string, envVar: string, extraDirs: string[] = []): string | null {
  const fromEnv = process.env[envVar];
  if (fromEnv) return usableFile(fromEnv, true);
  const dirs = [
    ...(process.env.PATH ?? '').split(':'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...extraDirs,
  ];
  for (const dir of dirs) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const found = usableFile(path.join(dir, name), true);
    if (found) return found;
  }
  return null;
}

/** Where a helper's pid file lives: next to this server's control dir. */
export function helperPidFile(name: string): string {
  return path.join(
    process.env.VIBETUNNEL_CONTROL_DIR
      ? path.dirname(process.env.VIBETUNNEL_CONTROL_DIR)
      : path.join(os.homedir(), '.vibetunnel'),
    name
  );
}

/** The command line of a running process, or null (gone, or `ps` failed). */
export function processArgs(pid: number): string | null {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Stop the helper recorded in `pidFile` by an earlier run, but only if that pid still runs a
 * command line containing every one of `mustContain`: a stale file whose pid now belongs to
 * another program is removed, never signalled. Never signals this process.
 */
export function stopRecordedHelper(
  pidFile: string,
  mustContain: string[],
  readArgs: (pid: number) => string | null = processArgs
): void {
  let pid: number;
  try {
    pid = Number(readFileSync(pidFile, 'utf8').trim());
  } catch {
    return; // no pid file
  }
  try {
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
    const args = readArgs(pid);
    if (args && mustContain.every((part) => args.includes(part))) process.kill(pid, 'SIGTERM');
  } catch {
    // That process is gone.
  } finally {
    rmSync(pidFile, { force: true });
  }
}
