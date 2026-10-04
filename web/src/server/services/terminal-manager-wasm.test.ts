import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveGhosttyWasmPath, TerminalManager } from './terminal-manager.js';

// The real ghostty-web and its WASM: the test setup mocks the module for unit tests.
vi.unmock('ghostty-web');

describe('resolveGhosttyWasmPath', () => {
  let testRoot: string | undefined;

  afterEach(async () => {
    if (testRoot) {
      await rm(testRoot, { recursive: true, force: true });
      testRoot = undefined;
    }
  });

  it('finds the wasm asset next to a bundled npm package lib directory', async () => {
    testRoot = await mkdtemp(path.join(tmpdir(), 'vibetunnel-wasm-'));
    const moduleDir = path.join(testRoot, 'lib');
    const wasmPath = path.join(testRoot, 'public', 'ghostty-vt.wasm');
    await mkdir(moduleDir, { recursive: true });
    await mkdir(path.dirname(wasmPath), { recursive: true });
    await writeFile(wasmPath, 'wasm');

    expect(resolveGhosttyWasmPath(moduleDir)).toBe(wasmPath);
  });

  it('finds the installed ghostty-web wasm before assets are copied', () => {
    expect(resolveGhosttyWasmPath(path.join(tmpdir(), 'missing-module'))).toContain(
      'ghostty-web/ghostty-vt.wasm'
    );
  });
});

describe('TerminalManager terminals on the real WASM', () => {
  let controlDir: string | undefined;
  let manager: TerminalManager | undefined;

  afterEach(async () => {
    manager?.destroy();
    manager = undefined;
    if (controlDir) {
      await rm(controlDir, { recursive: true, force: true });
      controlDir = undefined;
    }
  });

  /** A session whose cast file has a 45x30 header and `output` as its only event. */
  async function writeSession(dir: string, sessionId: string, output: string) {
    const header = JSON.stringify({ version: 2, width: 45, height: 30 });
    await mkdir(path.join(dir, sessionId), { recursive: true });
    await writeFile(
      path.join(dir, sessionId, 'stdout'),
      `${header}\n${JSON.stringify([0.1, 'o', output])}\n`
    );
  }

  it("never shows a closed session's text in a new session's screen", async () => {
    controlDir = await mkdtemp(path.join(tmpdir(), 'vibetunnel-ghostty-'));
    let oldOutput = '';
    for (let i = 1; i <= 4000; i++) {
      oldOutput += `line ${i} · the quick brown fox jumps over the lazy dog, again\r\n`;
    }
    await writeSession(controlDir, 'old', oldOutput);
    // Only one word, on row 5: every other cell of the new screen was never written.
    await writeSession(controlDir, 'new', '\x1b[5;3Hhello');
    manager = new TerminalManager(controlDir);

    const screenOf = async (sessionId: string) =>
      (await manager?.getBufferSnapshot(sessionId))?.cells
        .map((row) => row.map((cell) => cell.char).join(''))
        .join('\n') ?? '';
    expect(await screenOf('old')).toContain('lazy dog');
    manager.closeTerminal('old');

    const screen = await screenOf('new');
    expect(screen).toContain('hello');
    expect(screen).not.toMatch(/brown fox|lazy dog/);
  });

  it('gives two reads of a new session at once the same terminal', async () => {
    controlDir = await mkdtemp(path.join(tmpdir(), 'vibetunnel-ghostty-'));
    await writeSession(controlDir, 'new', 'hello');
    manager = new TerminalManager(controlDir);

    const [first, second] = await Promise.all([
      manager.getTerminal('new'),
      manager.getTerminal('new'),
    ]);
    // Not toBe: a failure would print both terminals, WASM memory and all.
    expect(first === second).toBe(true);
  });
});
