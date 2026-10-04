import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseProcessTable } from './claude-chat.js';
import { readCodexChat } from './codex-chat.js';
import {
  type CodexProcessDeps,
  codexSessionRef,
  findCodexPid,
  isCodexProcessArgs,
  parseUtcStart,
} from './codex-process.js';

const NVM = '/Users/me/.nvm/versions/node/v24.21.0';
const NATIVE = `${NVM}/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex`;

// What `TZ=UTC ps -A -o pid=,ppid=,lstart=,args=` shows for `codex` typed in a VibeTunnel zsh.
const PS = [
  '    1     0 Fri Oct  2 09:00:00 2026     /sbin/launchd',
  '  100     1 Fri Oct  2 09:59:00 2026     /usr/local/bin/vibetunnel fwd zsh',
  '  200   100 Fri Oct  2 09:59:01 2026     -zsh',
  `  300   200 Fri Oct  2 10:00:20 2026     node ${NVM}/bin/codex --model gpt-5`,
  `  301   300 Fri Oct  2 10:00:21 2026     ${NATIVE} --model gpt-5`,
  '  400     1 Fri Oct  2 09:30:00 2026     /bin/zsh -il',
  '  401   400 Fri Oct  2 09:30:05 2026     /usr/bin/vim notes.md',
  '',
].join('\n');

describe('isCodexProcessArgs', () => {
  it('spots the npm launcher and the native binary', () => {
    expect(isCodexProcessArgs(`node ${NVM}/bin/codex`)).toBe(true);
    expect(isCodexProcessArgs(`/opt/homebrew/bin/node --no-warnings ${NVM}/bin/codex`)).toBe(true);
    expect(
      isCodexProcessArgs(`node ${NVM}/lib/node_modules/@openai/codex/bin/codex.js resume`)
    ).toBe(true);
    expect(isCodexProcessArgs(`${NATIVE} "fix the tests"`)).toBe(true);
    expect(isCodexProcessArgs('codex')).toBe(true);
  });

  it('ignores other programs and Codex runs without a TUI', () => {
    expect(isCodexProcessArgs('node server.js')).toBe(false);
    expect(isCodexProcessArgs('/usr/bin/vim codex')).toBe(false);
    expect(isCodexProcessArgs('-zsh')).toBe(false);
    expect(isCodexProcessArgs('codex exec "summarize"')).toBe(false);
    expect(isCodexProcessArgs(`${NATIVE} app-server`)).toBe(false);
    expect(isCodexProcessArgs('codex --version')).toBe(false);
    expect(isCodexProcessArgs('codex-helper')).toBe(false);
  });

  it('skips option values when looking for the subcommand', () => {
    expect(isCodexProcessArgs('codex -m o3 exec "summarize"')).toBe(false);
    expect(isCodexProcessArgs(`${NATIVE} -c model=o3 --cd /repo exec x`)).toBe(false);
    expect(isCodexProcessArgs(`node ${NVM}/bin/codex -p work -s read-only app-server`)).toBe(false);
    // A value that happens to be a subcommand name is still just a value.
    expect(isCodexProcessArgs('codex -m exec')).toBe(true);
    expect(isCodexProcessArgs('codex -m o3 "fix the tests"')).toBe(true);
    expect(isCodexProcessArgs('codex --oss --model=o3 resume')).toBe(true);
    expect(isCodexProcessArgs('codex -a never -i shot.png')).toBe(true);
  });
});

describe('findCodexPid', () => {
  it('finds the launcher among the descendants of the session process', () => {
    const table = parseProcessTable(PS);
    expect(findCodexPid(table, 100)).toBe(300);
    expect(findCodexPid(table, 301)).toBe(301);
    expect(findCodexPid(table, 400)).toBeUndefined();
    expect(table.starts.get(300)).toBe('Fri Oct 2 10:00:20 2026');
    expect(parseUtcStart(table.starts.get(300))).toBe(Date.UTC(2026, 9, 2, 10, 0, 20));
  });
});

describe('codexSessionRef', () => {
  let codexDir: string;
  let dayDir: string;
  let cwdLookups: number[];
  const projectDir = '/Users/me/project';
  const deps = (ps = PS): CodexProcessDeps => ({
    table: async () => parseProcessTable(ps),
    cwdOf: async (pid) => {
      cwdLookups.push(pid);
      return projectDir;
    },
  });
  const at = (sec: number) => new Date(Date.UTC(2026, 9, 2, 10, 0, sec)).toISOString();
  const shell = {
    id: 'shell-session',
    command: ['zsh'],
    workingDir: '/Users/me',
    startedAt: at(-61),
    pid: 100,
    status: 'running',
  };
  // The launcher (pid 300) started at 10:00:20: its rollout is claimed under the process.
  const codexClaim = `proc:300:${Date.UTC(2026, 9, 2, 10, 0, 20)}`;

  beforeEach(() => {
    cwdLookups = [];
    codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-process-test-'));
    const day = new Date(at(0));
    dayDir = path.join(
      codexDir,
      'sessions',
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, '0'),
      String(day.getDate()).padStart(2, '0')
    );
    fs.mkdirSync(dayDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(codexDir, { recursive: true, force: true });
  });

  const rollout = (name: string, cwd: string, startedAt: string, prompt: string) =>
    fs.writeFileSync(
      path.join(dayDir, `rollout-${name}.jsonl`),
      `${[
        JSON.stringify({
          timestamp: startedAt,
          type: 'session_meta',
          payload: { id: name, timestamp: startedAt, cwd },
        }),
        JSON.stringify({
          timestamp: startedAt,
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: prompt }],
          },
        }),
      ].join('\n')}\n`
    );

  it('uses the cwd and start of the Codex typed in a shell to find its rollout', async () => {
    rollout('earlier-run', projectDir, at(-120), 'an earlier Codex run');
    rollout('this-run', projectDir, at(25), 'fix the login page');
    const ref = await codexSessionRef(shell, deps());
    expect(ref).toEqual({ id: codexClaim, workingDir: projectDir, startedAt: at(20) });
    const chat = readCodexChat(ref as NonNullable<typeof ref>, codexDir);
    expect(chat.agent).toBe('codex');
    expect(chat.title).toBe('fix the login page');
    // The cwd is looked up once per process.
    await codexSessionRef(shell, deps());
    expect(cwdLookups).toEqual([300]);
  });

  it('is nothing for a shell without Codex or a session that exited', async () => {
    expect(await codexSessionRef({ ...shell, pid: 400 }, deps())).toBeNull();
    expect(await codexSessionRef({ ...shell, status: 'exited' }, deps())).toBeNull();
    expect(cwdLookups).toEqual([]);
  });

  it('keeps sessions started with codex as they are', async () => {
    const direct = { ...shell, command: ['codex'] };
    expect(await codexSessionRef(direct, deps())).toBe(direct);
  });

  it('gives every reader of one Codex process the same rollout', async () => {
    // Two readers of one process (two sessions, or a session and another view of it). Claimed
    // per reader, the second found the rollout taken and showed nothing.
    rollout('this-run', projectDir, at(25), 'fix the login page');
    const attached = await codexSessionRef({ ...shell, id: 'other-session' }, deps());
    const paneRead = await codexSessionRef(
      { id: 'second-reader', workingDir: '/', startedAt: at(0), pid: 300, status: 'running' },
      deps()
    );
    expect(attached?.id).toBe(codexClaim);
    expect(paneRead?.id).toBe(codexClaim);
    for (const ref of [attached, paneRead]) {
      expect(readCodexChat(ref as NonNullable<typeof ref>, codexDir).title).toBe(
        'fix the login page'
      );
    }
  });
});
