import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionManager } from '../pty/session-manager.js';
import { CastOutputHub, type CastOutputHubEvent } from './cast-output-hub.js';

const HEADER = JSON.stringify({ version: 2, width: 48, height: 20 });
const OUTPUT = JSON.stringify([0.1, 'o', 'current screen']);

describe('CastOutputHub replay of terminal modes', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  async function replayOutputs(
    terminalModes?: Record<string, boolean>,
    status?: 'running' | 'exited'
  ): Promise<string[]> {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-hub-'));
    const stdoutPath = path.join(tmpDir, 'stdout');
    fs.writeFileSync(stdoutPath, [HEADER, OUTPUT, ''].join('\n'));
    const sessionManager = {
      getSessionPaths: () => ({ stdoutPath }),
      loadSessionInfo: () => ({ terminalModes, status }),
      saveSessionInfo: vi.fn(),
    } as unknown as SessionManager;

    const events: CastOutputHubEvent[] = [];
    const unsubscribe = new CastOutputHub(sessionManager).subscribe('s1', (e) => events.push(e));
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'header')).toBe(true));
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'output')).toBe(true));
    unsubscribe();

    return events
      .filter((e): e is Extract<CastOutputHubEvent, { kind: 'output' }> => e.kind === 'output')
      .map((e) => e.data);
  }

  it('restores terminal modes the app set before the replayed output', async () => {
    const outputs = await replayOutputs({ '1000': true, '1006': true });
    expect(outputs[0]).toBe('\x1b[?1000h\x1b[?1006h');
    expect(outputs.join('')).toContain('current screen');
  });

  it('restores no terminal modes for a session that has exited', async () => {
    // Marked exited by the zombie scan: its modes were never cleared.
    const outputs = await replayOutputs({ '1000': true, '1006': true }, 'exited');
    expect(outputs.join('')).toBe('current screen');
  });

  it('replays as before when the app set no modes', async () => {
    const outputs = await replayOutputs(undefined);
    expect(outputs.join('')).toBe('current screen');
  });
});
