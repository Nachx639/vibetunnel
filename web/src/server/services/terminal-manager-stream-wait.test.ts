import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalManager } from './terminal-manager.js';

type Internals = {
  terminals: Map<string, unknown>;
  watchStreamFile(sessionId: string): Promise<void>;
  resumeFileWatcher(sessionId: string): Promise<void>;
  destroy(): void;
};

describe('TerminalManager stream file of a brand-new session', () => {
  let dir: string;
  let manager: Internals | undefined;
  afterEach(() => {
    manager?.destroy();
    manager = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('waits for the cast file instead of leaving the screen empty for good', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'vt-tm-'));
    manager = new TerminalManager(dir) as unknown as Internals;
    const written: string[] = [];
    const terminal = {
      write: (data: string) => written.push(data),
      resize: () => {},
      close: () => {},
      free: () => {},
    };
    manager.terminals.set('s1', { terminal, lastUpdate: Date.now() });

    // The terminal is asked for before the session wrote its first byte.
    await manager.watchStreamFile('s1');
    expect(written).toEqual([]);

    mkdirSync(path.join(dir, 's1'));
    writeFileSync(
      path.join(dir, 's1', 'stdout'),
      '{"version":2,"width":80,"height":24}\n[0.1,"o","hello"]\n'
    );
    await vi.waitFor(() => expect(written.join('')).toContain('hello'), { timeout: 2000 });
  });

  it('goes on from where it stopped when flow control resumes its watcher', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'vt-tm-'));
    manager = new TerminalManager(dir) as unknown as Internals;
    const written: string[] = [];
    const sessionTerminal: { terminal: unknown; watcher?: { close(): void } } = {
      terminal: {
        write: (data: string) => written.push(data),
        resize: () => {},
        free: () => {},
      },
    };
    manager.terminals.set('s1', sessionTerminal);
    mkdirSync(path.join(dir, 's1'));
    const file = path.join(dir, 's1', 'stdout');
    writeFileSync(file, '{"version":2,"width":80,"height":24}\n[0.1,"o","hello"]\n');
    await manager.watchStreamFile('s1');

    // Paused under buffer pressure: the watcher is closed, output keeps coming.
    sessionTerminal.watcher?.close();
    sessionTerminal.watcher = undefined;
    appendFileSync(file, '[0.2,"o","bye"]\n');
    await manager.resumeFileWatcher('s1');

    // It used to read the whole file again from the start, writing every line twice.
    await vi.waitFor(() => expect(written.join('')).toBe('hellobye'), { timeout: 2000 });
  });
});
