import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseProcessTable } from './claude-chat.js';
import type { CodexProcessDeps } from './codex-process.js';
import { forgetGeminiSession, readGeminiChat } from './gemini-chat.js';
import { findGeminiPid, geminiSessionRef, isGeminiProcessArgs } from './gemini-process.js';

const NPM = '/opt/homebrew/lib/node_modules/@google/gemini-cli';

// What `TZ=UTC ps -A -o pid=,ppid=,lstart=,args=` shows for `gemini` typed in a VibeTunnel zsh:
// the launcher and the copy it relaunches with a bigger heap.
const PS = [
  `  100     1 Thu Oct  2 09:59:00 2025     -zsh`,
  `  300   100 Thu Oct  2 10:00:20 2025     node /opt/homebrew/bin/gemini -m gemini-2.5-pro`,
  `  301   300 Thu Oct  2 10:00:21 2025     /opt/homebrew/bin/node --max-old-space-size=8192 ${NPM}/dist/index.js -m gemini-2.5-pro`,
  `  400     1 Thu Oct  2 09:00:00 2025     -zsh`,
  `  401   400 Thu Oct  2 09:00:01 2025     vim gemini.md`,
].join('\n');

describe('isGeminiProcessArgs', () => {
  it('spots the interactive CLI as launcher, relaunched child or binary', () => {
    expect(isGeminiProcessArgs('node /opt/homebrew/bin/gemini')).toBe(true);
    expect(isGeminiProcessArgs(`node --max-old-space-size=8192 ${NPM}/dist/index.js`)).toBe(true);
    expect(isGeminiProcessArgs('gemini --yolo')).toBe(true);
    expect(isGeminiProcessArgs('gemini -m pro -i "fix the tests"')).toBe(true);
    expect(isGeminiProcessArgs('gemini --resume latest')).toBe(true);
  });

  it('ignores one-shot runs, subcommands and other programs', () => {
    expect(isGeminiProcessArgs('gemini -p "summarize"')).toBe(false);
    expect(isGeminiProcessArgs('gemini --prompt=summarize')).toBe(false);
    expect(isGeminiProcessArgs('gemini -m pro mcp list')).toBe(false);
    expect(isGeminiProcessArgs('gemini --version')).toBe(false);
    expect(isGeminiProcessArgs('vim gemini.md')).toBe(false);
    expect(isGeminiProcessArgs('node /usr/lib/node_modules/other/index.js gemini')).toBe(false);
    expect(isGeminiProcessArgs('gemini-helper')).toBe(false);
  });
});

describe('findGeminiPid', () => {
  it('finds the launcher among the descendants of the session process', () => {
    const table = parseProcessTable(PS);
    expect(findGeminiPid(table, 100)).toBe(300);
    expect(findGeminiPid(table, 301)).toBe(301);
    expect(findGeminiPid(table, 400)).toBeUndefined();
  });
});

describe('geminiSessionRef', () => {
  let home: string;
  let geminiDir: string;
  const projectDir = '/Users/me/project';
  const deps = (ps = PS): CodexProcessDeps => ({
    table: async () => parseProcessTable(ps),
    cwdOf: async () => projectDir,
  });
  const at = (sec: number) => new Date(Date.UTC(2025, 9, 2, 10, 0, sec)).toISOString();
  const shell = {
    id: 'gemini-shell-session',
    command: ['zsh'],
    workingDir: '/Users/me',
    startedAt: at(-61),
    pid: 100,
    status: 'running',
  };
  // The launcher (pid 300) started at 10:00:20: its chat is claimed under the process.
  const geminiClaim = `proc:300:${Date.UTC(2025, 9, 2, 10, 0, 20)}`;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-process-test-'));
    geminiDir = path.join(home, '.gemini');
  });

  afterEach(() => {
    forgetGeminiSession(geminiClaim);
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** A chat Gemini started at 10:00 in the project, with its first prompt. */
  function writeChat() {
    fs.mkdirSync(path.join(geminiDir, 'tmp', 'project', 'chats'), { recursive: true });
    fs.writeFileSync(
      path.join(geminiDir, 'projects.json'),
      JSON.stringify({ projects: { [projectDir]: 'project' } })
    );
    fs.writeFileSync(
      path.join(geminiDir, 'tmp', 'project', 'chats', 'session-2025-10-02T10-00-abcdef12.jsonl'),
      `${JSON.stringify({ sessionId: 'x', projectHash: 'h', startTime: at(20) })}\n${JSON.stringify({ id: 'u1', timestamp: at(30), type: 'user', content: [{ text: 'fix the login page' }] })}\n`
    );
  }

  it('uses the cwd and start of the Gemini typed in a shell to find its chat', async () => {
    writeChat();
    const ref = await geminiSessionRef(shell, deps());
    expect(ref).toEqual({ id: geminiClaim, workingDir: projectDir, startedAt: at(20) });
    const chat = readGeminiChat(ref as NonNullable<typeof ref>, geminiDir);
    expect(chat.agent).toBe('gemini');
    expect(chat.title).toBe('fix the login page');
  });

  it('gives every reader of one Gemini process the same chat', async () => {
    // Two sessions whose process trees reach the same Gemini process.
    writeChat();
    const first = await geminiSessionRef({ ...shell, id: 'other-session' }, deps());
    const second = await geminiSessionRef(
      { id: 'third-session', workingDir: '/', startedAt: at(0), pid: 300, status: 'running' },
      deps()
    );
    for (const ref of [first, second]) {
      expect(ref?.id).toBe(geminiClaim);
      expect(readGeminiChat(ref as NonNullable<typeof ref>, geminiDir).title).toBe(
        'fix the login page'
      );
    }
  });

  it('gives a chat back once its process is gone, for gemini --resume in the same shell', async () => {
    writeChat();
    const first = await geminiSessionRef(shell, deps());
    expect(readGeminiChat(first as NonNullable<typeof first>, geminiDir).title).toBe(
      'fix the login page'
    );
    // That Gemini ended; `gemini --resume latest` in the same shell writes to the same chat.
    const resumedPs = [
      '  100     1 Thu Oct  2 09:59:00 2025     -zsh',
      '  310   100 Thu Oct  2 10:05:00 2025     node /opt/homebrew/bin/gemini --resume latest',
    ].join('\n');
    const resumed = await geminiSessionRef(shell, deps(resumedPs));
    expect(resumed?.id).not.toBe(first?.id);
    expect(readGeminiChat(resumed as NonNullable<typeof resumed>, geminiDir).title).toBe(
      'fix the login page'
    );
    forgetGeminiSession(resumed?.id ?? '');
  });

  it('is nothing for a shell without Gemini or a session that exited', async () => {
    expect(await geminiSessionRef({ ...shell, pid: 400 }, deps())).toBeNull();
    expect(await geminiSessionRef({ ...shell, status: 'exited' }, deps())).toBeNull();
  });

  it('keeps sessions started with gemini as they are', async () => {
    const direct = { ...shell, command: ['gemini'] };
    expect(await geminiSessionRef(direct, deps())).toBe(direct);
  });
});
