import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { parseToolResults, parseTranscriptLine, readClaudeChat } from './claude-chat.js';

const line = (entry: Record<string, unknown>) => JSON.stringify({ uuid: 'u1', ...entry });

describe('parseTranscriptLine', () => {
  it('turns user and assistant turns into chat messages, tools into summaries', () => {
    expect(parseTranscriptLine(line({ type: 'user', message: { content: 'hello' } }))).toEqual([
      { id: 'u1:0', role: 'user', text: 'hello', timestamp: undefined },
    ]);

    const assistant = parseTranscriptLine(
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: '…' },
            { type: 'text', text: ' Done. ' },
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: 'ls -la', description: 'List files' },
            },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/app.ts' } },
          ],
        },
      })
    );
    expect(assistant.map(({ role, text, tool }) => ({ role, text, tool }))).toEqual([
      { role: 'assistant', text: 'Done.', tool: undefined },
      { role: 'tool', text: 'List files', tool: 'Bash' },
      { role: 'tool', text: 'app.ts', tool: 'Edit' },
    ]);
  });

  it('carries what an Edit changed, so it can be reviewed from the phone', () => {
    const [tool] = parseTranscriptLine(
      line({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'e1',
              name: 'Edit',
              input: {
                file_path: '/repo/a.ts',
                old_string: 'x = 1\ny = 2',
                new_string: 'x = 1\ny = 3',
              },
            },
          ],
        },
      })
    );
    expect(tool).toMatchObject({
      tool: 'Edit',
      detail: '/repo/a.ts',
      diff: [' x = 1', '-y = 2', '+y = 3'],
    });
    // Nothing left out: no count in the message.
    expect('diffMore' in tool && tool.diffMore !== undefined).toBe(false);
  });

  it('exposes single-choice AskUserQuestion options so the chat can answer them', () => {
    const ask = (questions: unknown[]) =>
      parseTranscriptLine(
        line({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions } }],
          },
        })
      )[0]?.question;

    expect(
      ask([{ question: 'Fruit?', options: [{ label: 'Apple' }, { label: 'Strawberry' }] }])
    ).toEqual({ text: 'Fruit?', options: ['Apple', 'Strawberry'] });
    expect(
      ask([{ question: 'Several', multiSelect: true, options: [{ label: 'a' }] }])
    ).toBeUndefined();
    expect(
      ask([
        { question: 'a', options: [{ label: 'x' }] },
        { question: 'b', options: [{ label: 'y' }] },
      ])
    ).toBeUndefined();
  });

  it('keeps tool details and reads their results, truncated', () => {
    const [bash] = parseTranscriptLine(
      line({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
        },
      })
    );
    expect(bash).toMatchObject({ toolUseId: 't1', detail: '$ ls' });

    const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const [result] = parseToolResults(
      line({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              is_error: true,
              content: [{ type: 'text', text: long }],
            },
          ],
        },
      })
    );
    expect(result.toolUseId).toBe('t1');
    expect(result.isError).toBe(true);
    expect(result.text.split('\n')).toHaveLength(21);
    expect(result.text.endsWith('…')).toBe(true);
  });

  it('turns an interruption into a note', () => {
    expect(
      parseTranscriptLine(
        line({
          type: 'user',
          message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] },
        })
      )
    ).toEqual([{ id: 'u1:0', role: 'note', text: 'Interrupted', timestamp: undefined }]);
  });

  it('shows slash commands and drops Claude Code bookkeeping', () => {
    const command = line({
      type: 'user',
      message: { content: '<command-name>/model</command-name><command-args>opus</command-args>' },
    });
    expect(parseTranscriptLine(command)[0]?.text).toBe('/model opus');

    for (const hidden of [
      line({
        type: 'user',
        message: { content: '<local-command-stdout>ok</local-command-stdout>' },
      }),
      line({ type: 'user', isMeta: true, message: { content: 'meta' } }),
      line({
        type: 'assistant',
        isSidechain: true,
        message: { content: [{ type: 'text', text: 'x' }] },
      }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'output' }] } }),
      line({ type: 'attachment' }),
      'not json',
    ]) {
      expect(parseTranscriptLine(hidden)).toEqual([]);
    }
  });
});

describe('readClaudeChat process lookup', () => {
  it('reports the Claude Code status found in a session process tree', async () => {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dir-'));
    const tz = process.env.TZ;
    // The server's local zone must not leak into the comparison.
    process.env.TZ = 'America/New_York';
    try {
      // Claude Code writes procStart as `ps` lstart rendered in UTC.
      const procStart = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], {
        env: { ...process.env, TZ: 'UTC' },
      })
        .toString()
        .trim();
      fs.mkdirSync(path.join(claudeDir, 'sessions'));
      fs.writeFileSync(
        path.join(claudeDir, 'sessions', `${process.pid}.json`),
        JSON.stringify({
          sessionId: 's',
          cwd: '/x',
          status: 'waiting',
          waitingFor: 'input needed',
          procStart,
        })
      );

      expect(await readClaudeChat(process.pid, claudeDir)).toEqual({
        available: true,
        status: 'waiting',
        waitingFor: 'input needed',
        title: undefined,
        messages: [],
      });
      expect((await readClaudeChat(999_999_999, claudeDir)).available).toBe(false);

      // A file left behind by an earlier process with the same pid is ignored.
      fs.writeFileSync(
        path.join(claudeDir, 'sessions', `${process.pid}.json`),
        JSON.stringify({
          sessionId: 's',
          cwd: '/x',
          status: 'busy',
          procStart: 'Mon Jan  1 00:00:00 2001',
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 2100)); // process table cache
      expect((await readClaudeChat(process.pid, claudeDir)).available).toBe(false);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
      fs.rmSync(claudeDir, { recursive: true, force: true });
    }
  });
});

describe('readClaudeChat session files', () => {
  it('ignores a session id that would name a file outside the projects folder', async () => {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dir-'));
    try {
      fs.mkdirSync(path.join(claudeDir, 'sessions'));
      // A transcript-shaped file outside projects/: it must never be read.
      fs.writeFileSync(
        path.join(claudeDir, 'secret.jsonl'),
        `${JSON.stringify({ type: 'user', uuid: 'x', message: { content: 'secret' } })}\n`
      );
      fs.mkdirSync(path.join(claudeDir, 'projects', '-x'), { recursive: true });
      fs.writeFileSync(
        path.join(claudeDir, 'sessions', `${process.pid}.json`),
        JSON.stringify({ sessionId: '../../secret', cwd: '/x', status: 'idle' })
      );
      const chat = await readClaudeChat(process.pid, claudeDir);
      expect(chat.available).toBe(false);
      expect(chat.messages).toEqual([]);
    } finally {
      fs.rmSync(claudeDir, { recursive: true, force: true });
    }
  });
});

describe('readClaudeChat transcript reading', () => {
  it('starts large transcripts from their tail and follows appends', async () => {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dir-'));
    try {
      fs.mkdirSync(path.join(claudeDir, 'sessions'));
      fs.writeFileSync(
        path.join(claudeDir, 'sessions', `${process.pid}.json`),
        JSON.stringify({ sessionId: 'big', cwd: '/x', status: 'idle' })
      );
      const projectDir = path.join(claudeDir, 'projects', '-x');
      fs.mkdirSync(projectDir, { recursive: true });
      const transcript = path.join(projectDir, 'big.jsonl');
      const userLine = (text: string) =>
        `${JSON.stringify({ type: 'user', uuid: text, message: { content: text } })}\n`;
      // ~6 MB of old history (more than the 4 MB tail), then a recent message.
      const filler = userLine('x'.repeat(1024 * 1024));
      fs.writeFileSync(transcript, filler.repeat(6) + userLine('recent'));

      const first = await readClaudeChat(process.pid, claudeDir);
      expect(first.messages.at(-1)?.text).toBe('recent');
      expect(first.messages.length).toBeLessThan(6);

      fs.appendFileSync(transcript, userLine('newer'));
      const second = await readClaudeChat(process.pid, claudeDir);
      expect(second.messages.at(-1)?.text).toBe('newer');
    } finally {
      fs.rmSync(claudeDir, { recursive: true, force: true });
    }
  });
});

describe('readClaudeChat images sent with a prompt', () => {
  const upload = '/Users/me/.vibetunnel/control/uploads/0b5e-photo.jpg';
  const entries = (promptId: string, text: string | null, extra: string[] = []) => [
    JSON.stringify({
      type: 'user',
      uuid: `p-${promptId}`,
      promptId,
      message: {
        content: [
          ...(text === null ? [] : [{ type: 'text', text }]),
          { type: 'image', source: { type: 'base64', data: 'AAAA' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      uuid: `m-${promptId}`,
      promptId,
      isMeta: true,
      turnCompanion: true,
      message: {
        content: [upload, ...extra].map((p) => ({ type: 'text', text: `[Image: source: ${p}]` })),
      },
    }),
  ];

  async function chatFor(lines: string[]) {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dir-'));
    try {
      fs.mkdirSync(path.join(claudeDir, 'sessions'));
      fs.writeFileSync(
        path.join(claudeDir, 'sessions', `${process.pid}.json`),
        JSON.stringify({ sessionId: 'imgs', cwd: '/x', status: 'idle' })
      );
      const projectDir = path.join(claudeDir, 'projects', '-x');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'imgs.jsonl'), `${lines.join('\n')}\n`);
      return await readClaudeChat(process.pid, claudeDir);
    } finally {
      fs.rmSync(claudeDir, { recursive: true, force: true });
    }
  }

  it('puts the uploaded image path in the prompt bubble, with its text', async () => {
    const chat = await chatFor(entries('a', 'which flowers are these?', ['/tmp/Screen Shot.png']));
    const users = chat.messages.filter((m) => m.role === 'user');
    expect(users).toHaveLength(1);
    // Only VibeTunnel uploads (which the files route can serve) become thumbnails.
    expect(users[0].text).toBe(`${upload}\nwhich flowers are these?`);
  });

  it('shows an image sent without text on its own', async () => {
    const chat = await chatFor([...entries('a', 'hello'), ...entries('b', null)]);
    const users = chat.messages.filter((m) => m.role === 'user').map((m) => m.text);
    expect(users).toEqual([`${upload}\nhello`, upload]);
  });
});
