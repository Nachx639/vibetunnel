import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionManager } from '../pty/session-manager.js';
import { CastOutputHub, type CastOutputHubEvent } from './cast-output-hub.js';

const HEADER = JSON.stringify({ version: 2, width: 48, height: 20 });
const OLD = JSON.stringify([0.1, 'o', 'stale screen']);
// Claude Code clears and redraws the whole screen in a single write.
const CLEAR_AND_REDRAW = JSON.stringify([0.2, 'o', 'tail\x1b[2J\x1b[Hcurrent screen']);
const AFTER = JSON.stringify([0.3, 'o', ' + typing']);

describe('CastOutputHub replay', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  async function replay(lastClearOffset: (content: string) => number): Promise<string> {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-hub-'));
    const stdoutPath = path.join(tmpDir, 'stdout');
    const content = [HEADER, OLD, CLEAR_AND_REDRAW, AFTER, ''].join('\n');
    fs.writeFileSync(stdoutPath, content);

    const sessionManager = {
      getSessionPaths: () => ({ stdoutPath }),
      loadSessionInfo: () => ({ lastClearOffset: lastClearOffset(content) }),
      saveSessionInfo: vi.fn(),
    } as unknown as SessionManager;

    const hub = new CastOutputHub(sessionManager);
    const events: CastOutputHubEvent[] = [];
    const unsubscribe = hub.subscribe('s1', (event) => events.push(event));
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'header')).toBe(true));
    unsubscribe();

    return events
      .filter((e): e is Extract<CastOutputHubEvent, { kind: 'output' }> => e.kind === 'output')
      .map((e) => e.data)
      .join('');
  }

  it.each([
    ['from the start of the file', () => 0],
    // The writer records the clear position inside the event's JSON line.
    ['from a stored offset inside the clearing event', (c: string) => c.indexOf('\\u001b[2J')],
  ])('replays the frame drawn after the last clear %s', async (_name, offset) => {
    const output = await replay(offset);

    expect(output).toBe('\x1b[Hcurrent screen + typing');
  });
});

describe('CastOutputHub subscribe while the session is writing', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  async function subscribeDuringWrites(subscribers: number): Promise<number[][]> {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-hub-'));
    const stdoutPath = path.join(tmpDir, 'stdout');
    // Enough history that the replay read spans many ticks.
    const filler = 'x'.repeat(200);
    const lines = [HEADER];
    let next = 0;
    for (; next < 20000; next++) lines.push(JSON.stringify([next, 'o', `<${next}:${filler}>`]));
    fs.writeFileSync(stdoutPath, `${lines.join('\n')}\n`);

    const sessionManager = {
      getSessionPaths: () => ({ stdoutPath }),
      loadSessionInfo: () => ({ lastClearOffset: 0 }),
      saveSessionInfo: vi.fn(),
    } as unknown as SessionManager;
    const hub = new CastOutputHub(sessionManager);

    const fd = fs.openSync(stdoutPath, 'a');
    const writeSome = () => {
      for (let i = 0; i < 20; i++, next++) {
        fs.writeSync(fd, `${JSON.stringify([next, 'o', `<${next}:${filler}>`])}\n`);
      }
    };

    const received: number[][] = [];
    const unsubscribes: Array<() => void> = [];
    for (let s = 0; s < subscribers; s++) {
      const seen: number[] = [];
      received.push(seen);
      unsubscribes.push(
        hub.subscribe('s1', (event) => {
          if (event.kind !== 'output') return;
          for (const m of event.data.matchAll(/<(\d+):/g)) seen.push(Number(m[1]));
        })
      );
      writeSome();
    }
    // Keep writing while the replays are still being read.
    for (let i = 0; i < 30; i++) {
      writeSome();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    fs.closeSync(fd);
    const total = next;
    await vi.waitFor(
      () => {
        for (const seen of received) expect(seen.length).toBeGreaterThanOrEqual(total);
      },
      { timeout: 5000 }
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const unsubscribe of unsubscribes) unsubscribe();
    return received;
  }

  it('delivers history then live output once each, in order', async () => {
    const received = await subscribeDuringWrites(2);
    for (const seen of received) {
      const expected = Array.from({ length: seen.length }, (_, i) => i);
      expect(seen.length).toBeGreaterThan(20000);
      expect(seen).toEqual(expected);
    }
  });
});
