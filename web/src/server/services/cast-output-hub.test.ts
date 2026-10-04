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

describe('CastOutputHub live follow', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it('keeps a UTF-8 character that one read splits in two', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-hub-'));
    const stdoutPath = path.join(tmpDir, 'stdout');
    fs.writeFileSync(stdoutPath, `${HEADER}\n`);
    const sessionManager = {
      getSessionPaths: () => ({ stdoutPath }),
      loadSessionInfo: () => ({ lastClearOffset: 0 }),
      saveSessionInfo: vi.fn(),
    } as unknown as SessionManager;
    const live: string[] = [];
    const unsubscribe = new CastOutputHub(sessionManager).subscribe('s1', (event) => {
      if (event.kind === 'output' && !event.historical) live.push(event.data);
    });
    try {
      const fd = fs.openSync(stdoutPath, 'a');
      // Once a line arrives live, the watcher is armed (its very first change can be missed).
      await vi.waitFor(
        () => {
          if (live.length === 0) fs.writeSync(fd, `${JSON.stringify([0.1, 'o', 'ready'])}\n`);
          expect(live.length).toBeGreaterThan(0);
        },
        { timeout: 3000, interval: 100 }
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      live.length = 0;

      const line = Buffer.from(`${JSON.stringify([0.5, 'o', '╭─ résumé ─╮'])}\n`);
      const split = line.indexOf(Buffer.from('╭')) + 1; // inside the 3-byte box character
      fs.writeSync(fd, line.subarray(0, split));
      await new Promise((resolve) => setTimeout(resolve, 200));
      fs.writeSync(fd, line.subarray(split));
      fs.closeSync(fd);

      await vi.waitFor(() => expect(live).toEqual(['╭─ résumé ─╮']), { timeout: 3000 });
    } finally {
      unsubscribe();
    }
  });

  it('follows a session that fell far behind from a whole event near the end', async () => {
    // The live read took all new bytes at once: a 540 MB burst (a sparse hole of NUL bytes
    // here, no disk used) was one buffer and one string past V8's limit, so it threw and
    // every line in it, the last frames too, was lost.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-hub-'));
    const stdoutPath = path.join(tmpDir, 'stdout');
    fs.writeFileSync(stdoutPath, `${HEADER}\n`);
    const sessionManager = {
      getSessionPaths: () => ({ stdoutPath }),
      loadSessionInfo: () => ({ lastClearOffset: 0 }),
      saveSessionInfo: vi.fn(),
    } as unknown as SessionManager;
    const replayMaxBytes = 64 * 1024;
    const live: string[] = [];
    const errors: CastOutputHubEvent[] = [];
    const unsubscribe = new CastOutputHub(sessionManager, { replayMaxBytes }).subscribe(
      's1',
      (event) => {
        if (event.kind === 'output' && !event.historical) live.push(event.data);
        if (event.kind === 'error') errors.push(event);
      }
    );
    try {
      const fd = fs.openSync(stdoutPath, 'r+');
      await vi.waitFor(
        () => {
          if (live.length === 0) {
            fs.writeSync(fd, `${JSON.stringify([0.1, 'o', 'ready'])}\n`, fs.fstatSync(fd).size);
          }
          expect(live.length).toBeGreaterThan(0);
        },
        { timeout: 3000, interval: 100 }
      );
      live.length = 0;

      const frames: string[] = [];
      for (let n = 1; n <= 2000; n++) frames.push(`\x1b[H<frame ${n} ─ é>${'x'.repeat(60)}\x1b[K`);
      const data = Buffer.from(
        `\n${frames.map((frame, i) => JSON.stringify([1 + i, 'o', frame])).join('\n')}\n`
      );
      expect(data.length).toBeGreaterThan(2 * replayMaxBytes);
      // One write past the end: the hole and the frames arrive together.
      fs.writeSync(fd, data, 0, data.length, fs.fstatSync(fd).size + 540 * 1024 * 1024);
      fs.closeSync(fd);

      await vi.waitFor(() => expect(live.at(-1)).toBe(frames.at(-1)), { timeout: 5000 });
      // Whole events only, in order, ending with the last one, no more than the window.
      expect(frames.slice(-live.length)).toEqual(live);
      expect(Buffer.byteLength(live.join(''))).toBeLessThanOrEqual(replayMaxBytes);
      expect(errors).toEqual([]);
    } finally {
      unsubscribe();
    }
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

describe('CastOutputHub replay of a cast too big for memory', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it('replays only the end of the history, from a whole event, at the size in effect there', async () => {
    // 430 MB after the last clear used to be kept in memory and queued on the
    // socket. A 600 MB hole of NUL bytes (sparse: no disk used) stands for that history.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-hub-'));
    const stdoutPath = path.join(tmpDir, 'stdout');
    const hole = 600 * 1024 * 1024;
    const replayMaxBytes = 64 * 1024;
    const frames: string[] = [];
    for (let n = 1; n <= 2000; n++) frames.push(`\x1b[H<frame ${n} ─ é>${'x'.repeat(60)}\x1b[K`);
    const tail = [
      JSON.stringify([1, 'r', '91x33']),
      ...frames.map((data, i) => JSON.stringify([2 + i, 'o', data])),
    ];
    const fd = fs.openSync(stdoutPath, 'w');
    fs.writeSync(fd, `${HEADER}\n`);
    fs.ftruncateSync(fd, hole);
    const data = Buffer.from(`\n${tail.join('\n')}\n`);
    fs.writeSync(fd, data, 0, data.length, hole);
    fs.closeSync(fd);
    expect(data.length).toBeGreaterThan(2 * replayMaxBytes);

    const sessionManager = {
      getSessionPaths: () => ({ stdoutPath }),
      loadSessionInfo: () => ({ lastClearOffset: 0 }),
      saveSessionInfo: vi.fn(),
    } as unknown as SessionManager;
    const events: CastOutputHubEvent[] = [];
    const unsubscribe = new CastOutputHub(sessionManager, { replayMaxBytes }).subscribe(
      's1',
      (event) => events.push(event)
    );
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'header')).toBe(true));
    unsubscribe();

    const header = events.find((e) => e.kind === 'header');
    expect(header).toMatchObject({ header: { width: 91, height: 33 } });
    const outputs = events
      .filter((e): e is Extract<CastOutputHubEvent, { kind: 'output' }> => e.kind === 'output')
      .map((e) => e.data);
    // Whole events only, ending with the last one, and no more than the window.
    expect(outputs.length).toBeGreaterThan(0);
    expect(frames.slice(-outputs.length)).toEqual(outputs);
    expect(Buffer.byteLength(outputs.join(''))).toBeLessThanOrEqual(replayMaxBytes);
    expect(events.some((e) => e.kind === 'error')).toBe(false);
  });
});
