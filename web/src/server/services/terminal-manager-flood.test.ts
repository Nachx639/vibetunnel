import * as fs from 'fs';
import type { GhosttyCell } from 'ghostty-web';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalManager } from './terminal-manager.js';

// The real ghostty-web and its WASM: the test setup mocks the module for unit tests.
vi.unmock('ghostty-web');

/**
 * Flow control paused a session's server-side terminal once its scrollback passed 8,000 lines
 * (80% of SCROLLBACK_LIMIT) and resumed it below 5,000, which never happens: the scrollback
 * does not shrink. Its screen (/text, buffer snapshots) then
 * froze until a 5-minute timeout that also dropped the lines queued meanwhile. ghostty's limit
 * is a byte budget, so its line count passes 8,000 only on a narrow terminal (about 15,000
 * lines at 5 columns, 1,100 at 80): the session here is 5 columns wide.
 */
const COLS = 5;
const ROWS = 10;
const HISTORY_LINES = 20_000;
const FLOOD_EVENTS = 20_000;

/** Short enough for one row: base 36, at most 4 characters with the prefix up to 46,655. */
const label = (prefix: string, i: number) => `${prefix}${i.toString(36)}`;

/** The terminal's last `maxLines` lines, scrollback included, trailing blanks trimmed. */
async function recentText(manager: TerminalManager, maxLines: number): Promise<string> {
  const terminal = await manager.getTerminal('s1');
  terminal.update();
  const { rows, cols } = terminal;
  const text = (cells: GhosttyCell[] | null | undefined) => {
    let line = '';
    for (const cell of cells ?? []) {
      if (!cell || cell.width === 0) continue;
      line += cell.codepoint ? String.fromCodePoint(cell.codepoint) : ' ';
    }
    return line.trimEnd();
  };
  const lines: string[] = [];
  const fromScreen = Math.min(rows, maxLines);
  const scrollback = terminal.getScrollbackLength();
  for (let i = Math.max(0, scrollback - (maxLines - fromScreen)); i < scrollback; i++) {
    lines.push(text(terminal.getScrollbackLine(i)));
  }
  const viewport = terminal.getViewport();
  for (let row = rows - fromScreen; row < rows; row++) {
    lines.push(text(viewport.slice(row * cols, (row + 1) * cols)));
  }
  return lines.join('\n');
}

describe('TerminalManager under an output flood with a full scrollback', () => {
  let controlDir: string | null = null;
  let manager: TerminalManager | null = null;

  afterEach(() => {
    manager?.destroy();
    manager = null;
    if (controlDir) fs.rmSync(controlDir, { recursive: true, force: true });
    controlDir = null;
  });

  function event(t: number, data: string): string {
    return `${JSON.stringify([t, 'o', data])}\n`;
  }

  /** A session whose replay alone takes the scrollback past the old pause mark. */
  function writeLongSession(sessionId: string): string {
    controlDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'vt-flood-'));
    const dir = path.join(controlDir, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'stdout');
    const lines = [`${JSON.stringify({ version: 2, width: COLS, height: ROWS })}\n`];
    for (let i = 0; i < HISTORY_LINES; i++) lines.push(event(i / 1000, `${label('h', i)}\r\n`));
    fs.writeFileSync(file, lines.join(''));
    return file;
  }

  it('keeps the screen current and drops no line of the flood', async () => {
    const file = writeLongSession('s1');
    manager = new TerminalManager(controlDir as string);
    const terminal = await manager.getTerminal('s1');
    expect(terminal.getScrollbackLength() + ROWS).toBeGreaterThan(8000);
    expect(await recentText(manager, 2)).toBe(`${label('h', HISTORY_LINES - 1)}\n`);

    await new Promise((resolve) => setTimeout(resolve, 200)); // the file watcher starts
    // One small event per line, the way a busy program writes them.
    const flood: string[] = [];
    for (let i = 0; i < FLOOD_EVENTS; i++) flood.push(event(30 + i / 1000, `${label('f', i)}\r\n`));
    fs.appendFileSync(file, `${flood.join('')}${event(99, 'END')}`);

    await vi.waitFor(
      async () => expect(await recentText(manager as TerminalManager, 1)).toBe('END'),
      { timeout: 5000, interval: 50 }
    );

    // Every flood line reached the terminal, in order: its scrollback ends with the last 8000.
    const kept = 8000;
    const recent = (await recentText(manager, kept + 1)).split('\n');
    expect(recent.at(-1)).toBe('END');
    expect(recent.slice(0, -1)).toEqual(
      Array.from({ length: kept }, (_, i) => label('f', FLOOD_EVENTS - kept + i))
    );

    // And it goes on following what comes next.
    fs.appendFileSync(file, event(100, '\r\nnext'));
    await vi.waitFor(
      async () => expect(await recentText(manager as TerminalManager, 1)).toBe('next'),
      { timeout: 2000, interval: 50 }
    );
  });
});
