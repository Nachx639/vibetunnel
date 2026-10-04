import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalManager } from './terminal-manager.js';

type Internals = {
  terminals: Map<string, unknown>;
  watchStreamFile(sessionId: string): Promise<void>;
  handleStreamLine(sessionId: string, terminal: unknown, line: string): void;
  destroy?: () => void;
};

describe('TerminalManager stream file of a brand-new session', () => {
  let dir: string;
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('waits for the cast file instead of leaving the screen empty for good', async () => {
    vi.useFakeTimers();
    dir = mkdtempSync(path.join(tmpdir(), 'vt-tm-'));
    const manager = new TerminalManager(dir) as unknown as Internals;
    const lines: string[] = [];
    vi.spyOn(manager, 'handleStreamLine').mockImplementation((_id, _t, line) => {
      lines.push(line);
    });
    const sessionTerminal = { terminal: {}, lastUpdate: Date.now() };
    manager.terminals.set('s1', sessionTerminal);

    // The terminal is asked for before the session wrote its first byte.
    await manager.watchStreamFile('s1');
    expect(lines).toEqual([]);

    mkdirSync(path.join(dir, 's1'));
    writeFileSync(
      path.join(dir, 's1', 'stdout'),
      '{"version":2,"width":80,"height":24}\n[0.1,"o","hello"]\n'
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(lines.some((line) => line.includes('hello'))).toBe(true);
  });
});
