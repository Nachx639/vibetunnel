import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  execScriptPatches,
  findCodexRollout,
  forgetCodexSession,
  isCodexCommand,
  parseCodexLine,
  readCodexChat,
} from './codex-chat.js';

const at = (offsetSec: number) => new Date(Date.UTC(2025, 9, 2, 10, 0, offsetSec)).toISOString();
const line = (timestamp: string, type: string, payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp, type, payload });

const meta = (cwd: string, timestamp: string) =>
  line(timestamp, 'session_meta', {
    id: 'thread-1',
    timestamp,
    cwd,
    originator: 'codex_cli_rs',
    cli_version: '0.154.0',
    base_instructions: { text: 'x'.repeat(5000) },
  });
const userMessage = (timestamp: string, ...texts: string[]) =>
  line(timestamp, 'response_item', {
    type: 'message',
    role: 'user',
    content: texts.map((text) => ({ type: 'input_text', text })),
  });
const assistantMessage = (timestamp: string, text: string) =>
  line(timestamp, 'response_item', {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
    phase: 'final_answer',
  });
const shellCall = (timestamp: string, callId: string, command: string) =>
  line(timestamp, 'response_item', {
    type: 'function_call',
    name: 'shell_command',
    arguments: JSON.stringify({ command, workdir: '/w' }),
    call_id: callId,
  });
const shellOutput = (timestamp: string, callId: string, output: string) =>
  line(timestamp, 'response_item', { type: 'function_call_output', call_id: callId, output });
const event = (timestamp: string, type: string) =>
  line(timestamp, 'event_msg', { type, turn_id: 't1' });

describe('isCodexCommand', () => {
  it('spots codex as the command or inside a shell command string', () => {
    expect(isCodexCommand(['codex'])).toBe(true);
    expect(isCodexCommand(['/opt/homebrew/bin/codex', '--yolo'])).toBe(true);
    expect(isCodexCommand(['zsh', '-lic', 'codex resume'])).toBe(true);
    expect(isCodexCommand(['claude'])).toBe(false);
    expect(isCodexCommand(['zsh', '-c', 'cd ~/vt-agent-codex && ls'])).toBe(false);
    expect(isCodexCommand(undefined)).toBe(false);
  });
});

describe('parseCodexLine', () => {
  it('keeps what the user typed and drops what Codex injects', () => {
    const parsed = parseCodexLine(
      userMessage(
        at(1),
        '<environment_context>\n  <cwd>/w</cwd>\n</environment_context>',
        '# AGENTS.md instructions for /w\n\nbe nice'
      )
    );
    expect(parsed.messages).toEqual([]);
    const [message] = parseCodexLine(userMessage(at(2), 'fix the build'), 7).messages;
    expect(message).toEqual({
      id: `${at(2)}:7`,
      role: 'user',
      text: 'fix the build',
      timestamp: at(2),
    });
  });

  it('turns shell calls into Bash tool rows and summarizes their output', () => {
    const [tool] = parseCodexLine(shellCall(at(3), 'c1', 'npm test')).messages;
    expect(tool).toMatchObject({
      role: 'tool',
      tool: 'Bash',
      text: 'npm test',
      detail: '$ npm test',
      toolUseId: 'c1',
    });
    const output = parseCodexLine(
      shellOutput(
        at(4),
        'c1',
        `Exit code: 1\nWall time: 2.1 seconds\nOutput:\n${'fail\n'.repeat(40)}`
      )
    ).result;
    expect(output?.isError).toBe(true);
    expect(output?.text.startsWith('fail\n')).toBe(true);
    expect(output?.text.split('\n')).toHaveLength(21);
    expect(output?.text.endsWith('…')).toBe(true);
  });

  it('reads exec_command arrays, JSON outputs and apply_patch edits', () => {
    const [array] = parseCodexLine(
      line(at(5), 'response_item', {
        type: 'function_call',
        name: 'shell',
        arguments: JSON.stringify({ command: ['bash', '-lc', 'ls -la'] }),
        call_id: 'c2',
      })
    ).messages;
    expect(array.text).toBe('ls -la');
    expect(
      parseCodexLine(
        shellOutput(at(6), 'c2', JSON.stringify({ output: 'ok\n', metadata: { exit_code: 0 } }))
      ).result
    ).toEqual({ callId: 'c2', text: 'ok', isError: false });
    const [patch] = parseCodexLine(
      line(at(7), 'response_item', {
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: 'c3',
        input: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-a\n+b\n*** End Patch',
      })
    ).messages;
    expect(patch).toMatchObject({
      tool: 'Edit',
      text: 'app.ts',
      detail: 'src/app.ts',
      diff: ['-a', '+b'],
    });
  });

  it('shows a code-mode script that runs apply_patch as the edit, with its change', () => {
    // The shape a Codex model writes when it edits from a code-mode script.
    const [edit] = parseCodexLine(
      line(at(9), 'response_item', {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'c9',
        input:
          'text(await tools.apply_patch("*** Begin Patch\\n*** Update File: /repo/notes.md\\n@@\\n-line three\\n+LINE THREE\\n*** End Patch"));',
      })
    ).messages;
    expect(edit).toMatchObject({
      tool: 'Edit',
      text: 'notes.md',
      detail: '/repo/notes.md',
      diff: ['-line three', '+LINE THREE'],
    });
    expect(
      execScriptPatches(
        'await tools.apply_patch(`*** Begin Patch\n*** Add File: a.md\n+one \\`two\\`\n*** End Patch`)'
      )
    ).toEqual(['*** Begin Patch\n*** Add File: a.md\n+one `two`\n*** End Patch']);
  });

  it('skips reasoning, token counts and broken lines', () => {
    expect(
      parseCodexLine(line(at(8), 'response_item', { type: 'reasoning', summary: [] })).messages
    ).toEqual([]);
    expect(parseCodexLine(line(at(8), 'event_msg', { type: 'token_count' })).messages).toEqual([]);
    expect(parseCodexLine('{not json').messages).toEqual([]);
  });
});

describe('readCodexChat', () => {
  let codexDir: string;
  let dayDir: string;
  const cwd = '/Users/someone/project';
  const sessionStart = at(0);

  beforeEach(() => {
    codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-chat-test-'));
    const day = new Date(sessionStart);
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

  const writeRollout = (name: string, lines: string[]) => {
    const file = path.join(dayDir, `rollout-${name}.jsonl`);
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    return file;
  };

  it('matches the newest rollout started in the session directory after it began', () => {
    writeRollout('2025-10-02T09-00-00-old', [meta(cwd, at(-3600))]);
    writeRollout('2025-10-02T10-00-10-other', [meta('/elsewhere', at(10))]);
    const mine = writeRollout('2025-10-02T10-00-05-mine', [meta(cwd, at(5))]);
    expect(findCodexRollout(codexDir, cwd, Date.parse(sessionStart))).toBe(mine);
    expect(findCodexRollout(codexDir, cwd, Date.parse(sessionStart), new Set([mine]))).toBeNull();
    expect(findCodexRollout(codexDir, '/nowhere', Date.parse(sessionStart))).toBeNull();
  });

  it('matches through a symlinked folder (macOS /tmp is /private/tmp)', () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-codex-real-'));
    const link = `${real}-link`;
    fs.symlinkSync(real, link);
    try {
      const mine = writeRollout('2025-10-02T10-00-05-linked', [meta(fs.realpathSync(real), at(5))]);
      expect(findCodexRollout(codexDir, link, Date.parse(sessionStart))).toBe(mine);
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(real, { recursive: true, force: true });
    }
  });

  it('only ever reads rollouts in the sessions/YYYY/MM/DD folders of CODEX_HOME', () => {
    // A rollout-shaped file anywhere else (sessions/ itself, a non-date folder, outside
    // sessions/) is never matched, whatever its first line says.
    const stray = [
      path.join(codexDir, 'sessions', 'rollout-x.jsonl'),
      path.join(codexDir, 'sessions', 'other', 'rollout-x.jsonl'),
      path.join(codexDir, 'rollout-x.jsonl'),
    ];
    for (const file of stray) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${meta(cwd, at(5))}\n`);
    }
    expect(findCodexRollout(codexDir, cwd, Date.parse(sessionStart))).toBeNull();
  });

  it('serves the conversation, follows appends and reports busy while a turn is open', () => {
    const file = writeRollout('2025-10-02T10-00-05-chat', [
      meta(cwd, at(5)),
      event(at(6), 'task_started'),
      userMessage(at(6), '<environment_context></environment_context>'),
      userMessage(at(7), 'list the files'),
      line(at(8), 'response_item', { type: 'reasoning', summary: [] }),
      shellCall(at(9), 'c1', 'ls'),
    ]);
    const session = { id: 'vt-1', workingDir: cwd, startedAt: sessionStart };
    const now = Date.now;
    Date.now = () => Date.parse(at(20));
    try {
      const busy = readCodexChat(session, codexDir);
      expect(busy).toMatchObject({ available: true, agent: 'codex', status: 'busy' });
      expect(busy.title).toBe('list the files');
      expect(busy.activity).toMatchObject({ kind: 'tool', tool: 'Bash', target: 'ls' });
      expect(busy.messages.map((m) => m.role)).toEqual(['user', 'tool']);

      fs.appendFileSync(
        file,
        `${[
          shellOutput(at(10), 'c1', 'Exit code: 0\nWall time: 0.1 seconds\nOutput:\na.txt\n'),
          assistantMessage(at(11), 'There is one file.'),
          event(at(12), 'task_complete'),
        ].join('\n')}\n`
      );
      const idle = readCodexChat(session, codexDir);
      expect(idle.status).toBe('idle');
      expect(idle.activity).toBeUndefined();
      expect(idle.messages.map((m) => [m.role, m.text, m.result])).toEqual([
        ['user', 'list the files', undefined],
        ['tool', 'ls', 'a.txt'],
        ['assistant', 'There is one file.', undefined],
      ]);
    } finally {
      Date.now = now;
      forgetCodexSession('vt-1');
    }
  });

  it('is an empty chat until Codex writes its rollout', () => {
    const chat = readCodexChat({ id: 'vt-2', workingDir: cwd, startedAt: sessionStart }, codexDir);
    expect(chat).toEqual({ available: true, agent: 'codex', status: 'idle', messages: [] });
    forgetCodexSession('vt-2');
  });

  it('gives two sessions in one directory different rollouts', () => {
    const first = writeRollout('2025-10-02T10-00-05-a', [
      meta(cwd, at(5)),
      userMessage(at(6), 'A'),
    ]);
    readCodexChat({ id: 'vt-a', workingDir: cwd, startedAt: sessionStart }, codexDir);
    writeRollout('2025-10-02T10-01-00-b', [meta(cwd, at(60)), userMessage(at(61), 'B')]);
    const b = readCodexChat({ id: 'vt-b', workingDir: cwd, startedAt: at(55) }, codexDir);
    const a = readCodexChat({ id: 'vt-a', workingDir: cwd, startedAt: sessionStart }, codexDir);
    expect(a.title).toBe('A');
    expect(b.title).toBe('B');
    expect(first).toContain('-a.jsonl');
    forgetCodexSession('vt-a');
    forgetCodexSession('vt-b');
  });
});
