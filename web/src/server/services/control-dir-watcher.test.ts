import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteRegistry } from './remote-registry.js';

vi.mock('../server.js', () => ({ isShuttingDown: () => false }));
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { ControlDirWatcher } = await import('./control-dir-watcher.js');

describe('ControlDirWatcher', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('treats only session-id names as sessions, never the log file beside them', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-watch-'));
    const removeSessionFromRemote = vi.fn();
    const watcher = new ControlDirWatcher({
      controlDir: dir,
      remoteRegistry: { removeSessionFromRemote } as unknown as RemoteRegistry,
      isHQMode: true,
      hqClient: null,
    }) as unknown as { handleFileChange(filename: string): Promise<void> };

    // A log rotation renames log.txt to log.txt.1: neither is a removed session.
    await watcher.handleFileChange('log.txt');
    await watcher.handleFileChange('log.txt.1');
    expect(removeSessionFromRemote).not.toHaveBeenCalled();

    await watcher.handleFileChange('a1b2-c3');
    expect(removeSessionFromRemote).toHaveBeenCalledExactlyOnceWith('a1b2-c3');
  });
});
