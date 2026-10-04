import type * as Pty from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseForegroundPgids, readForegroundPgids } from './foreground-pgids.js';

describe('parseForegroundPgids', () => {
  it('maps pids to their terminal foreground group and skips pids without a terminal', () => {
    expect(parseForegroundPgids('  101   205\n  102     0\n 103    -1\ngarbage\n')).toEqual(
      new Map([[101, 205]])
    );
  });
});

describe('readForegroundPgids', () => {
  let shell: Pty.IPty | undefined;
  afterEach(() => {
    shell?.kill('SIGKILL');
    shell = undefined;
  });

  it('sees a command take over the terminal and give it back', { timeout: 15000 }, async () => {
    if (process.platform === 'win32') return;
    // The test setup mocks node-pty; this needs a real terminal.
    const pty = await vi.importActual<typeof Pty>('node-pty');
    const term = pty.spawn('/bin/sh', ['-i'], {
      cols: 80,
      rows: 24,
      env: { PATH: '/bin:/usr/bin', PS1: '$ ' },
    });
    shell = term;
    const foreground = async () => (await readForegroundPgids([term.pid])).get(term.pid);
    const waitFor = async (check: (pgid: number | undefined) => boolean) => {
      for (let i = 0; i < 100; i++) {
        const pgid = await foreground();
        if (check(pgid)) return pgid;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('foreground group never changed');
    };

    // An interactive shell owns its terminal…
    await waitFor((pgid) => pgid === term.pid);
    term.write('sleep 30\r');
    // …a job it runs gets its own foreground group…
    const job = await waitFor((pgid) => pgid !== undefined && pgid !== term.pid);
    expect(job).toBeGreaterThan(0);
    term.write('\x03');
    // …and the shell gets the terminal back when the job ends.
    await waitFor((pgid) => pgid === term.pid);
  });

  it('leaves out pids that are gone', async () => {
    expect(await readForegroundPgids([2 ** 22 + 12345])).toEqual(new Map());
    expect(await readForegroundPgids([])).toEqual(new Map());
  });
});
