import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  castReplayStart,
  findLastResizeBefore,
  forEachCastLine,
  readCastHeaderLine,
} from './cast-tail.js';

const HEADER = JSON.stringify({ version: 2, width: 50, height: 12 });

describe('cast-tail', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  /** A cast of `count` output events full of 3-byte characters, and each line's end offset. */
  function writeCast(count: number): { file: string; lines: string[]; ends: number[] } {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-tail-'));
    const file = path.join(tmpDir, 'stdout');
    const lines = [HEADER];
    for (let i = 0; i < count; i++) {
      lines.push(JSON.stringify([i / 10, 'o', `${i} ╭${'─'.repeat(97 + (i % 13))}╮ é\r\n`]));
    }
    const ends: number[] = [];
    let offset = 0;
    for (const line of lines) {
      offset += Buffer.byteLength(line) + 1;
      ends.push(offset);
    }
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    return { file, lines, ends };
  }

  it('reads the header line on its own', async () => {
    const { file, ends } = writeCast(10);

    expect(await readCastHeaderLine(file)).toEqual({ line: HEADER, end: ends[0] });
  });

  it('starts a cut replay on the first whole line inside the window', async () => {
    const { file, ends } = writeCast(5000);
    const size = fs.statSync(file).size;

    for (const maxBytes of [1000, 4097, 65_537, 300_001]) {
      const { start, truncated } = await castReplayStart(file, ends[0], size, maxBytes);
      expect(truncated).toBe(true);
      // A line start (just after a newline), never before the window.
      expect(ends).toContain(start);
      expect(start).toBeGreaterThanOrEqual(size - maxBytes);
      expect(ends.filter((end) => end >= size - maxBytes)[0]).toBe(start);
    }
  });

  it('replays everything that fits, and prefers the last clear inside the window', async () => {
    const { file, ends } = writeCast(1000);
    const size = fs.statSync(file).size;

    expect(await castReplayStart(file, ends[0], size, size)).toEqual({
      start: ends[0],
      truncated: false,
    });
    // A clear offset points inside its event's line: the replay starts at that line.
    const clearLineStart = ends[990];
    expect(await castReplayStart(file, ends[0], size, 5000, clearLineStart + 20)).toEqual({
      start: clearLineStart,
      truncated: true,
    });
    // One before the window does not pull the replay back past it.
    const early = await castReplayStart(file, ends[0], size, 5000, ends[10] + 20);
    expect(early.start).toBeGreaterThanOrEqual(size - 5000);
  });

  it('streams whole lines, with characters split across reads kept intact', async () => {
    // Bigger than one 256 KB read, so lines and 3-byte characters straddle chunk boundaries.
    const { file, lines, ends } = writeCast(8000);
    const size = fs.statSync(file).size;
    expect(size).toBeGreaterThan(3 * 256 * 1024);

    const seen: string[] = [];
    const seenEnds: number[] = [];
    const end = await forEachCastLine(file, 0, size, (line, lineEnd) => {
      seen.push(line);
      seenEnds.push(lineEnd);
    });

    expect(end).toBe(size);
    expect(seen).toEqual(lines);
    expect(seenEnds).toEqual(ends);
  });

  it('leaves a half-written last line for the next read', async () => {
    const { file, lines, ends } = writeCast(3);
    fs.appendFileSync(file, '[9.9,"o","half');
    const seen: string[] = [];

    const end = await forEachCastLine(file, ends[0], fs.statSync(file).size, (line) =>
      seen.push(line)
    );

    expect(seen).toEqual(lines.slice(1));
    expect(end).toBe(ends[3]);
  });

  it('finds the size in effect before an offset', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-tail-'));
    const file = path.join(tmpDir, 'stdout');
    // Output that quotes a resize-looking text is escaped and must not count.
    const filler = JSON.stringify([1, 'o', 'x'.repeat(3 * 1024 * 1024)]);
    const lines = [
      HEADER,
      JSON.stringify([0.5, 'r', '91x33']),
      filler,
      JSON.stringify([2, 'o', ',"r","12x3"]']),
    ];
    const before = Buffer.byteLength(`${lines.join('\n')}\n`);
    lines.push(JSON.stringify([3, 'r', '70x20']));
    fs.writeFileSync(file, `${lines.join('\n')}\n`);

    expect(await findLastResizeBefore(file, before)).toBe('91x33');
    expect(await findLastResizeBefore(file, fs.statSync(file).size)).toBe('70x20');
    expect(await findLastResizeBefore(file, before, 0, 1024 * 1024)).toBeNull();
  });
});
