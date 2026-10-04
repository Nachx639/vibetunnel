import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  activityFromLines,
  parseToolResults,
  parseTranscriptLine,
  plainPreview,
  readClaudeChat,
  readClaudeStatuses,
} from './claude-chat.js';

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

describe('readClaudeStatuses', () => {
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

      const statuses = await readClaudeStatuses([process.pid, 999_999_999], claudeDir);

      expect(statuses.get(process.pid)).toEqual({
        status: 'waiting',
        waitingFor: 'input needed',
        sessionId: 's',
      });
      expect(statuses.has(999_999_999)).toBe(false);

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
      expect((await readClaudeStatuses([process.pid], claudeDir)).has(process.pid)).toBe(false);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
      fs.rmSync(claudeDir, { recursive: true, force: true });
    }
  });
});

describe('readClaudeStatuses previews', () => {
  it('adds the conversation title and last message for the session list', async () => {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dir-'));
    try {
      fs.mkdirSync(path.join(claudeDir, 'sessions'));
      fs.writeFileSync(
        path.join(claudeDir, 'sessions', `${process.pid}.json`),
        JSON.stringify({ sessionId: 'p', cwd: '/proj', status: 'idle' })
      );
      const projectDir = path.join(claudeDir, 'projects', '-proj');
      fs.mkdirSync(projectDir, { recursive: true });
      const long = 'x'.repeat(300);
      fs.writeFileSync(
        path.join(projectDir, 'p.jsonl'),
        [
          line({ type: 'ai-title', aiTitle: 'Fix the login' }),
          line({ type: 'user', uuid: 'a', message: { content: 'fix the login' } }),
          line({
            type: 'assistant',
            uuid: 'b',
            message: { content: [{ type: 'text', text: `Done.\n\n${long}` }] },
          }),
          line({
            type: 'assistant',
            uuid: 'c',
            message: {
              content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }],
            },
          }),
          '',
        ].join('\n')
      );

      const status = (await readClaudeStatuses([process.pid], claudeDir)).get(process.pid);

      expect(status?.title).toBe('Fix the login');
      expect(status?.preview?.role).toBe('assistant');
      expect(status?.preview?.text.startsWith('Done. xxx')).toBe(true);
      expect(status?.preview?.text).toHaveLength(160);
    } finally {
      fs.rmSync(claudeDir, { recursive: true, force: true });
    }
  });
});

describe('plainPreview', () => {
  it('turns a markdown answer into one line of plain text', () => {
    expect(
      plainPreview(
        '## Ideas\n1. **Key bar** with `Tab` and [docs](https://x.io)\n> note\n```sh\nls\n```\nend _now_.'
      )
    ).toBe('Ideas 1. Key bar with Tab and docs note end now.');
  });

  it('reads a table as its cells and drops bullets, not their words', () => {
    expect(
      plainPreview(
        '| Language | Year created |\n|-----------|-----------------|\n| C | 1972 |\n| Python | 1991 |\n\n- **done** the *change*'
      )
    ).toBe('Language · Year created; C · 1972; Python · 1991 done the change');
  });
});

describe('activityFromLines', () => {
  const at = '2025-10-02T10:00:00.000Z';
  const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
    line({
      type: 'assistant',
      uuid: `a-${id}`,
      timestamp: at,
      message: { content: [{ type: 'tool_use', id, name, input }] },
    });
  const toolResult = (id: string) =>
    line({
      type: 'user',
      uuid: `r-${id}`,
      timestamp: '2025-10-02T10:00:05.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    });

  it('names the tool call that has no result yet, with its start time', () => {
    expect(activityFromLines([toolUse('t1', 'Bash', { command: 'pnpm test --run' })])).toEqual({
      kind: 'tool',
      tool: 'Bash',
      target: 'pnpm test --run',
      since: Date.parse(at),
    });
  });

  it('is thinking once the tool result is back', () => {
    expect(
      activityFromLines([toolUse('t1', 'Read', { file_path: '/r/a.ts' }), toolResult('t1')])
    ).toEqual({ kind: 'thinking', since: Date.parse('2025-10-02T10:00:05.000Z') });
  });

  it('keeps showing a parallel call that is still running', () => {
    const activity = activityFromLines([
      toolUse('t1', 'Read', { file_path: '/r/a.ts' }),
      toolUse('t2', 'Grep', { pattern: 'TODO' }),
      toolResult('t2'),
    ]);
    expect(activity).toMatchObject({ kind: 'tool', tool: 'Read', target: 'a.ts' });
  });

  it('describes each tool kind by its subject', () => {
    const target = (name: string, input: Record<string, unknown>) =>
      activityFromLines([toolUse('t', name, input)])?.target;
    expect(target('Bash', { command: 'npm run build', description: 'Build the app' })).toBe(
      'Build the app'
    );
    expect(target('Bash', { command: `echo ${'x'.repeat(100)}` })).toHaveLength(60);
    expect(target('Edit', { file_path: '/repo/src/app.ts' })).toBe('app.ts');
    expect(target('Write', { file_path: '/repo/new.md' })).toBe('new.md');
    expect(target('Read', { file_path: '/repo/README.md' })).toBe('README.md');
    expect(target('Grep', { pattern: 'claudeStatus' })).toBe('claudeStatus');
    expect(target('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts');
    expect(target('WebFetch', { url: 'https://docs.example.com/a/b?c=1' })).toBe(
      'docs.example.com'
    );
    expect(target('WebSearch', { query: 'lit reactive controllers' })).toBe(
      'lit reactive controllers'
    );
    expect(target('Task', { description: 'Explore the server' })).toBe('Explore the server');
    expect(target('TodoWrite', { todos: [] })).toBeUndefined();
  });

  it('is thinking during a thinking block or after a prompt, writing during text', () => {
    const thinking = line({
      type: 'assistant',
      timestamp: at,
      message: { content: [{ type: 'thinking', thinking: 'hmm' }] },
    });
    expect(activityFromLines([thinking])).toEqual({ kind: 'thinking', since: Date.parse(at) });
    expect(
      activityFromLines([line({ type: 'user', timestamp: at, message: { content: 'hello' } })])
    ).toEqual({ kind: 'thinking', since: Date.parse(at) });
    expect(
      activityFromLines([
        thinking,
        line({
          type: 'assistant',
          timestamp: at,
          message: { content: [{ type: 'text', text: 'Ok' }] },
        }),
        line({ type: 'ai-title', aiTitle: 'x' }),
      ])
    ).toEqual({ kind: 'writing', since: Date.parse(at) });
    expect(activityFromLines([])).toBeUndefined();
  });
});

describe('readClaudeStatuses activity', () => {
  it('reports the running tool only while Claude is busy', async () => {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dir-'));
    try {
      fs.mkdirSync(path.join(claudeDir, 'sessions'));
      const sessionFile = path.join(claudeDir, 'sessions', `${process.pid}.json`);
      fs.writeFileSync(
        sessionFile,
        JSON.stringify({ sessionId: 'act', cwd: '/proj', status: 'busy' })
      );
      const projectDir = path.join(claudeDir, 'projects', '-proj');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, 'act.jsonl'),
        `${line({
          type: 'assistant',
          timestamp: '2025-10-02T10:00:00.000Z',
          message: {
            content: [{ type: 'tool_use', id: 't', name: 'Edit', input: { file_path: '/p/x.ts' } }],
          },
        })}\n`
      );

      const busy = (await readClaudeStatuses([process.pid], claudeDir)).get(process.pid);
      expect(busy?.activity).toEqual({
        kind: 'tool',
        tool: 'Edit',
        target: 'x.ts',
        since: Date.parse('2025-10-02T10:00:00.000Z'),
      });

      fs.writeFileSync(
        sessionFile,
        JSON.stringify({ sessionId: 'act', cwd: '/proj', status: 'idle' })
      );
      const idle = (await readClaudeStatuses([process.pid], claudeDir)).get(process.pid);
      expect(idle?.activity).toBeUndefined();
    } finally {
      fs.rmSync(claudeDir, { recursive: true, force: true });
    }
  });
});

describe('waiting for background agents', () => {
  // Shapes as Claude Code 2.x writes them (checked on a live session with background agents);
  // the text is synthetic.
  const at = (s: number) =>
    new Date(Date.parse('2025-10-04T00:00:00.000Z') + s * 1000).toISOString();
  const prompt = (s: number, text = 'start an agent in the background') =>
    line({
      type: 'user',
      uuid: `p${s}`,
      timestamp: at(s),
      origin: { kind: 'human' },
      message: { role: 'user', content: text },
    });
  const toolUse = (s: number, id: string, extra: Record<string, unknown> = {}) =>
    line({
      type: 'assistant',
      uuid: `a${s}`,
      timestamp: at(s),
      ...extra,
      message: {
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'pnpm test' } }],
      },
    });
  const toolResult = (s: number, id: string) =>
    line({
      type: 'user',
      uuid: `r${s}`,
      timestamp: at(s),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    });
  /** The reply's thinking and text blocks: separate entries, both with stop_reason end_turn. */
  const endTurn = (s: number) => [
    line({
      type: 'assistant',
      uuid: `t${s}`,
      timestamp: at(s),
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'thinking', thinking: '' }],
      },
    }),
    line({
      type: 'assistant',
      uuid: `e${s}`,
      timestamp: at(s),
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Done, the agent keeps going.' }],
      },
    }),
    line({ type: 'system', subtype: 'stop_hook_summary', timestamp: at(s) }),
    line({ type: 'system', subtype: 'turn_duration', timestamp: at(s) }),
    line({ type: 'last-prompt', lastPrompt: 'x' }),
    line({ type: 'ai-title', aiTitle: 'Agents' }),
    line({ type: 'permission-mode', permissionMode: 'default' }),
  ];
  const taskNotification = (s: number) => [
    line({ type: 'queue-operation', operation: 'enqueue', timestamp: at(s), content: 'x' }),
    line({ type: 'queue-operation', operation: 'dequeue', timestamp: at(s) }),
    line({
      type: 'user',
      uuid: `n${s}`,
      timestamp: at(s),
      origin: { kind: 'task-notification', producer: 'session-task' },
      message: {
        role: 'user',
        content: '<task-notification>\n<task-id>abc</task-id>\n</task-notification>',
      },
    }),
  ];

  async function withTranscript(
    sessionId: string,
    lines: string[],
    run: (
      chat: () => ReturnType<typeof readClaudeChat>,
      append: (more: string[]) => void,
      claudeDir: string
    ) => Promise<void>,
    session: Record<string, unknown> = {}
  ) {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dir-'));
    try {
      fs.mkdirSync(path.join(claudeDir, 'sessions'));
      fs.writeFileSync(
        path.join(claudeDir, 'sessions', `${process.pid}.json`),
        JSON.stringify({
          sessionId,
          cwd: '/bg',
          status: 'busy',
          statusUpdatedAt: Date.parse(at(0)),
          ...session,
        })
      );
      const projectDir = path.join(claudeDir, 'projects', '-bg');
      fs.mkdirSync(projectDir, { recursive: true });
      const transcript = path.join(projectDir, `${sessionId}.jsonl`);
      fs.writeFileSync(transcript, `${lines.join('\n')}\n`);
      await run(
        () => readClaudeChat(process.pid, claudeDir),
        (more) => fs.appendFileSync(transcript, `${more.join('\n')}\n`),
        claudeDir
      );
    } finally {
      fs.rmSync(claudeDir, { recursive: true, force: true });
    }
  }

  it('is waiting when the last main-thread entry is an end_turn reply, busy again at a task notification', async () => {
    await withTranscript(
      'bg-1',
      [prompt(1), toolUse(2, 'k'), toolResult(3, 'k'), ...endTurn(4)],
      async (chat, append) => {
        const waiting = await chat();
        expect(waiting.status).toBe('busy');
        expect(waiting.waitingForBackground).toBe(true);
        expect(waiting.activity).toBeUndefined();

        append(taskNotification(60));
        const working = await chat();
        expect(working.waitingForBackground).toBeUndefined();
        expect(working.activity).toBeDefined();

        append(endTurn(70));
        expect((await chat()).waitingForBackground).toBe(true);
      }
    );
  });

  it('ignores sidechain (subagent) entries after the reply', async () => {
    await withTranscript(
      'bg-2',
      [
        prompt(1),
        ...endTurn(4),
        toolUse(5, 's1', { isSidechain: true }),
        toolResult(6, 's1').replace('{', '{"isSidechain":true,'),
      ],
      async (chat) => {
        expect((await chat()).waitingForBackground).toBe(true);
      }
    );
  });

  it('is a real turn while a tool call has no result yet', async () => {
    await withTranscript(
      'bg-3',
      [prompt(1), ...endTurn(4), prompt(10, 'otra cosa'), toolUse(11, 'k2')],
      async (chat) => {
        const chatNow = await chat();
        expect(chatNow.waitingForBackground).toBeUndefined();
        expect(chatNow.activity).toMatchObject({ kind: 'tool', tool: 'Bash' });
      }
    );
  });

  it('is a real turn at a tool result or a peer message after the reply', async () => {
    await withTranscript('bg-4', [prompt(1), ...endTurn(4)], async (chat, append) => {
      expect((await chat()).waitingForBackground).toBe(true);
      append([
        line({
          type: 'user',
          uuid: 'peer',
          isMeta: true,
          timestamp: at(30),
          origin: { kind: 'peer', from: 'uds:/tmp/x.sock' },
          message: { role: 'user', content: 'message from another session' },
        }),
      ]);
      expect((await chat()).waitingForBackground).toBeUndefined();
    });
  });

  it('stays waiting through a local slash command, and after an interrupt', async () => {
    await withTranscript('bg-5', [prompt(1), ...endTurn(4)], async (chat, append) => {
      append([
        line({
          type: 'user',
          timestamp: at(20),
          message: {
            role: 'user',
            content: '<command-name>/effort</command-name>\n<command-args>high</command-args>',
          },
        }),
        line({
          type: 'user',
          timestamp: at(20),
          message: {
            role: 'user',
            content: '<local-command-stdout>Effort set</local-command-stdout>',
          },
        }),
      ]);
      expect((await chat()).waitingForBackground).toBe(true);
      append([
        prompt(30),
        toolUse(31, 'k3'),
        line({
          type: 'user',
          timestamp: at(32),
          message: {
            role: 'user',
            content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }],
          },
        }),
      ]);
      expect((await chat()).waitingForBackground).toBe(true);
    });
  });

  it('is not waiting for a reply that ended before Claude became busy again (a new prompt)', async () => {
    await withTranscript(
      'bg-6',
      [prompt(1), ...endTurn(4)],
      async (chat) => {
        const chatNow = await chat();
        expect(chatNow.waitingForBackground).toBeUndefined();
      },
      { statusUpdatedAt: Date.parse(at(50)) }
    );
  });

  it('is never set when Claude is idle or waiting', async () => {
    await withTranscript(
      'bg-7',
      [prompt(1), ...endTurn(4)],
      async (chat) => {
        expect((await chat()).waitingForBackground).toBeUndefined();
      },
      { status: 'idle' }
    );
  });

  it('reaches the session list status (readClaudeStatuses)', async () => {
    await withTranscript('bg-8', [prompt(1), ...endTurn(4)], async (_chat, _append, claudeDir) => {
      const status = (await readClaudeStatuses([process.pid], claudeDir)).get(process.pid);
      expect(status).toMatchObject({ status: 'busy', waitingForBackground: true });
      expect(status?.activity).toBeUndefined();
    });
  });
});
