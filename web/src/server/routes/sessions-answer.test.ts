import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseScreenChoices } from '../../shared/claude-screen';
import { readClaudeStatuses } from '../services/claude-chat';
import { menuKeyHash } from '../services/menu-key-hash';
import { createSessionRoutes } from './sessions';

vi.mock('../websocket/control-unix-handler', () => ({
  controlUnixHandler: { isMacAppConnected: vi.fn() },
}));
vi.mock('../utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));
vi.mock('../services/claude-chat', async () => {
  const actual =
    await vi.importActual<typeof import('../services/claude-chat')>('../services/claude-chat');
  return { ...actual, readClaudeStatuses: vi.fn() };
});

const fixture = (name: string) =>
  readFileSync(path.join(__dirname, '../services/__fixtures__/claude-waiting', name), 'utf8');

type Handler = (req: Request, res: Response) => Promise<void>;

function setup(
  screenName: string,
  claudeStatus = 'waiting',
  session: object = {},
  agentChat = true
) {
  let screen = fixture(screenName);
  vi.mocked(readClaudeStatuses).mockImplementation(
    async () => new Map([[42, { status: claudeStatus, waitingFor: 'permission to run Bash' }]])
  );
  const sendInput = vi.fn();
  const ptyManager = {
    getSession: vi.fn(() => ({ id: 's1', pid: 42, status: 'running', ...session })),
    sendInput,
  };
  const terminalManager = {
    getBufferSnapshot: vi.fn(async () => ({
      cells: screen.split('\n').map((line) => [...line].map((char) => ({ char }))),
      cols: 80,
      rows: 24,
    })),
    // What the server reads a menu's key from: here the same screen, as text.
    getRecentText: vi.fn(async () => ({ text: screen, rows: screen.split('\n').length })),
  };
  const router = createSessionRoutes({
    ptyManager: ptyManager as never,
    terminalManager: terminalManager as never,
    remoteRegistry: null,
    isHQMode: false,
    agentChatEnabled: () => agentChat,
  });
  const route = (method: 'get' | 'post', routePath: string): Handler => {
    const layer = (
      router as unknown as {
        stack: Array<{
          route?: {
            path: string;
            methods: Record<string, boolean>;
            stack: Array<{ handle: Handler }>;
          };
        }>;
      }
    ).stack.find((r) => r.route?.path === routePath && r.route.methods[method]);
    if (!layer?.route) throw new Error(`no route ${method} ${routePath}`);
    return layer.route.stack[0].handle;
  };
  const call = async (method: 'get' | 'post', routePath: string, body?: unknown) => {
    const res = { json: vi.fn(), status: vi.fn() };
    res.status.mockReturnValue(res);
    // What a phone sends with an answer: the key of the menu it read (here, the one on screen),
    // unless the test sends its own.
    const sent =
      body && typeof body === 'object' && !('key' in body) && /answer|reply/.test(routePath)
        ? { ...body, key: parseScreenChoices(screen)?.key }
        : body;
    await route(method, routePath)(
      { params: { sessionId: 's1' }, body: sent } as never,
      res as never
    );
    return res;
  };
  return {
    sendInput,
    call,
    setScreen: (name: string) => {
      screen = fixture(name);
    },
    setScreenText: (text: string) => {
      screen = text;
    },
    setStatus: (status: string) => {
      vi.mocked(readClaudeStatuses).mockImplementation(async () => new Map([[42, { status }]]));
    },
  };
}

describe('answering Claude from the answer sheet', () => {
  afterEach(() => vi.useRealTimers());

  it('refuses an answer without the key of a menu that has one', async () => {
    // An answer sheet still on a push's choices, or an app not reloaded since: its question and
    // options match any of Claude's permission prompts.
    const { call, sendInput } = setup('permission-bash.txt');
    const res = await call('post', '/sessions/:sessionId/answer', {
      option: 1,
      question: 'Do you want to proceed?',
      key: null,
    });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it("answers a push's choices by the push's fingerprint of the key, exactly", async () => {
    // A sheet opened from a push before it could read the prompt sends this instead of the key.
    const { call, sendInput } = setup('permission-bash.txt');
    const key = parseScreenChoices(fixture('permission-bash.txt'))?.key ?? '';
    const answer = (keyHash: string) =>
      call('post', '/sessions/:sessionId/answer', {
        option: 1,
        question: 'Do you want to proceed?',
        key: null,
        keyHash,
      });
    expect((await answer('0123456789abcdef')).status).toHaveBeenCalledWith(409);
    expect(sendInput).not.toHaveBeenCalled();
    const res = await answer(menuKeyHash(key));
    expect(res.status).not.toHaveBeenCalled();
    expect(sendInput).toHaveBeenCalled();
  });

  it('tells apart two commands whose prompts scrolled out of a short screen', async () => {
    // A small phone with its keyboard up: only the question and options are in sight, the command in
    // the scrollback. A key of the visible rows took the next command for the one shown.
    const shown = fixture('permission-bash.txt');
    const next = shown.replaceAll('rm -rf dist/ && pnpm build', 'rm -rf src/ && pnpm build');
    const short = { visibleRows: 6 };
    const { call, sendInput, setScreenText } = setup('permission-bash.txt');
    setScreenText(next);
    const res = await call('post', '/sessions/:sessionId/answer', {
      option: 1,
      question: 'Do you want to proceed?',
      key: parseScreenChoices(shown, short)?.key,
    });
    expect(parseScreenChoices(shown, short)?.key).not.toBe(parseScreenChoices(next, short)?.key);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('reads the live prompt with its choices', async () => {
    const { call } = setup('permission-bash.txt');
    const res = await call('get', '/sessions/:sessionId/prompt');
    expect(res.json).toHaveBeenCalledWith({
      waiting: true,
      waitingFor: 'permission to run Bash',
      choices: expect.objectContaining({
        question: 'Do you want to proceed?',
        options: expect.arrayContaining(['Yes']),
      }),
    });
  });

  it("moves a numbered menu's cursor, and types a yes/no question's letter with Enter", async () => {
    const menu = setup('permission-bash.txt');
    menu.sendInput.mockImplementation((_id: string, input: { key?: string }) => {
      if (input.key === 'arrow_down') menu.setScreenText(cursorOnSecond);
    });
    await menu.call('post', '/sessions/:sessionId/answer', {
      option: 2,
      question: 'Do you want to proceed?',
    });
    expect(menu.sendInput.mock.calls).toEqual([
      ['s1', { key: 'arrow_down' }],
      ['s1', { key: 'enter' }],
    ]);

    const yesNo = setup('yes-no.txt');
    await yesNo.call('post', '/sessions/:sessionId/answer', {
      option: 2,
      question: 'Overwrite it with the new defaults? (y/n)',
    });
    // The letter alone left a line-reading prompt waiting.
    expect(yesNo.sendInput.mock.calls).toEqual([
      ['s1', { text: 'n' }],
      ['s1', { key: 'enter' }],
    ]);
  });

  it('moves the cursor of an unnumbered menu and presses Enter once it shows there', async () => {
    const { call, sendInput, setScreen } = setup('trust-folder.txt', 'none');
    sendInput.mockImplementation((_id: string, input: { key?: string }) => {
      if (input.key === 'arrow_down') setScreen('trust-folder-yes.txt');
    });
    const res = await call('post', '/sessions/:sessionId/answer', {
      option: 2,
      // The phone's copy of the screen may have lost the question above the menu.
      question: '',
      options: ['No, exit', 'Yes, I trust this folder'],
    });
    expect(res.json).toHaveBeenCalledWith({ success: true });
    expect(sendInput.mock.calls).toEqual([
      ['s1', { key: 'arrow_down' }],
      ['s1', { key: 'enter' }],
    ]);
  });

  it('never presses Enter on an unnumbered menu whose cursor did not move', async () => {
    vi.useFakeTimers();
    const { call, sendInput } = setup('trust-folder.txt', 'none');
    const pending = call('post', '/sessions/:sessionId/answer', {
      option: 2,
      question: 'Quick safety check: Is this a project you created or one you trust?',
    });
    await vi.advanceTimersByTimeAsync(3000);
    const res = await pending;
    expect(res.status).toHaveBeenCalledWith(409);
    // Enter would have confirmed "No, exit" and closed Claude.
    expect(sendInput.mock.calls).toEqual([['s1', { key: 'arrow_down' }]]);
  });

  it("moves to an option of a numbered menu with a cursor, like Codex's update prompt", async () => {
    const { call, sendInput, setScreen } = setup('codex-update.txt', 'none');
    sendInput.mockImplementation((_id: string, input: { key?: string }) => {
      if (input.key === 'arrow_down') setScreen('codex-update-skip.txt');
    });
    const res = await call('post', '/sessions/:sessionId/answer', {
      option: 2,
      // Read from other rows on the phone: the options identify the menu.
      question: 'a line of whatever scrolled above it',
      options: [
        'Update now (runs `npm install -g @openai/codex`)',
        'Skip',
        'Skip until next version',
      ],
    });
    expect(res.json).toHaveBeenCalledWith({ success: true });
    // Not the digit: Codex's update prompt confirms on it, its trust prompt does not.
    expect(sendInput.mock.calls).toEqual([
      ['s1', { key: 'arrow_down' }],
      ['s1', { key: 'enter' }],
    ]);
  });

  it('never presses Enter once another menu took the place of the one answered', async () => {
    vi.useFakeTimers();
    const { call, sendInput, setScreenText } = setup('codex-update.txt', 'none');
    sendInput.mockImplementation((_id: string, input: { key?: string }) => {
      // The update prompt went away and the trust prompt came, its cursor on option 2:
      // where the answer was headed, but "No, quit" is not "Skip".
      if (input.key === 'arrow_down') {
        setScreenText(
          fixture('codex-trust.txt')
            .replace('› 1. Yes, continue', '  1. Yes, continue')
            .replace('  2. No, quit', '› 2. No, quit')
        );
      }
    });
    const pending = call('post', '/sessions/:sessionId/answer', {
      option: 2,
      question: '✨\u200aUpdate available! 0.155.1 -> 0.160.0',
      options: [
        'Update now (runs `npm install -g @openai/codex`)',
        'Skip',
        'Skip until next version',
      ],
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect((await pending).status).toHaveBeenCalledWith(409);
    expect(sendInput.mock.calls).toEqual([['s1', { key: 'arrow_down' }]]);
  });

  it('presses only Enter when the cursor is already on the chosen option', async () => {
    const { call, sendInput } = setup('codex-trust.txt', 'none');
    const res = await call('post', '/sessions/:sessionId/answer', {
      option: 1,
      question: 'Do you trust the contents of this directory?',
    });
    expect(res.json).toHaveBeenCalledWith({ success: true });
    // Typing "1" there only selected it: Codex kept waiting.
    expect(sendInput.mock.calls).toEqual([['s1', { key: 'enter' }]]);
  });

  it('refuses when the prompt on screen changed', async () => {
    const { call, sendInput, setScreen } = setup('permission-bash.txt');
    setScreen('plan-approval.txt');
    const answer = await call('post', '/sessions/:sessionId/answer', {
      option: 1,
      question: 'Do you want to proceed?',
    });
    expect(answer.status).toHaveBeenCalledWith(409);
    const reply = await call('post', '/sessions/:sessionId/reply', {
      text: 'use pnpm instead',
      question: 'Do you want to proceed?',
    });
    expect(reply.status).toHaveBeenCalledWith(409);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('refuses a written reply once Claude stopped waiting', async () => {
    const { call, sendInput } = setup('busy.txt', 'busy');
    const res = await call('post', '/sessions/:sessionId/reply', { text: 'hi', question: null });
    expect(res.status).toHaveBeenCalledWith(409);
    // Apart from a changed prompt: the phone then types the message itself.
    expect(res.json).toHaveBeenCalledWith({ error: 'not-waiting' });
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('answers a menu whose question only the phone sees by its options', async () => {
    // The phone's keyboard shortened the terminal: the server sees the options, not the
    // question the phone read from the scrollback above them.
    vi.useFakeTimers();
    const { call, sendInput, setScreen, setStatus } = setup('plan-approval-short.txt');
    sendInput.mockImplementation((_id: string, input: { key?: string }) => {
      if (input.key === 'escape') {
        setScreen('busy.txt');
        setStatus('idle');
      }
    });
    const pending = call('post', '/sessions/:sessionId/reply', {
      text: 'no, call it goodbye.txt',
      question: 'Would you like to proceed?',
      options: planOptions,
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect((await pending).json).toHaveBeenCalledWith({ success: true });
    expect(sendInput.mock.calls).toEqual([
      ['s1', { key: 'escape' }],
      ['s1', { text: 'no, call it goodbye.txt' }],
      ['s1', { key: 'enter' }],
    ]);
  });

  it('refuses a reply from a phone that saw no menu where there is one', async () => {
    const { call, sendInput } = setup('plan-approval-short.txt');
    const res = await call('post', '/sessions/:sessionId/reply', { text: 'hello', question: null });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('answers only once Claude is back at its prompt and the text is typed', async () => {
    vi.useFakeTimers();
    const { call, sendInput, setScreen, setStatus } = setup('permission-bash.txt');
    const pending = call('post', '/sessions/:sessionId/reply', {
      text: 'use pnpm instead',
      question: 'Do you want to proceed?',
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(sendInput.mock.calls).toEqual([['s1', { key: 'escape' }]]);

    setScreen('busy.txt');
    setStatus('idle');
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending).json).toHaveBeenCalledWith({ success: true });
    expect(sendInput.mock.calls.slice(1)).toEqual([
      ['s1', { text: 'use pnpm instead' }],
      ['s1', { key: 'enter' }],
    ]);
  });

  it('types the reply although a question and a numbered list stay on screen', async () => {
    // Claude, back at its prompt, still showed its earlier answer; read
    // as a dialog, the text waited for it to go away for 10 minutes, then was dropped.
    vi.useFakeTimers();
    const { call, sendInput, setScreenText, setStatus } = setup('permission-bash.txt');
    sendInput.mockImplementation((_id: string, input: { key?: string }) => {
      if (input.key !== 'escape') return;
      setStatus('idle');
      setScreenText(
        [
          '⏺ Two ways to do it. Which one do you prefer?',
          '  1. Rewrite it',
          '  2. Patch it',
          '',
          '⏺ Bash(rm -rf dist/ && pnpm build)',
          '  ⎿  Interrupted · What should Claude do instead?',
          '',
          '─'.repeat(40),
          '❯\u00a0',
          '─'.repeat(40),
        ].join('\n')
      );
    });
    const pending = call('post', '/sessions/:sessionId/reply', {
      text: 'usa pnpm',
      question: 'Do you want to proceed?',
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect((await pending).json).toHaveBeenCalledWith({ success: true });
    expect(sendInput.mock.calls.slice(1)).toEqual([
      ['s1', { text: 'usa pnpm' }],
      ['s1', { key: 'enter' }],
    ]);
  });

  it('says when Claude never got back to its prompt, the text left untyped', async () => {
    vi.useFakeTimers();
    const { call, sendInput } = setup('permission-bash.txt');
    const pending = call('post', '/sessions/:sessionId/reply', {
      text: 'use pnpm instead',
      question: 'Do you want to proceed?',
    });
    await vi.advanceTimersByTimeAsync(20_000);
    const res = await pending;
    expect(res.status).toHaveBeenCalledWith(504);
    expect(res.json).toHaveBeenCalledWith({ error: 'not-delivered' });
    expect(sendInput.mock.calls).toEqual([['s1', { key: 'escape' }]]);
  });

  it('takes one answer or reply per session at a time', async () => {
    vi.useFakeTimers();
    const { call, sendInput } = setup('permission-bash.txt');
    const body = { text: 'use pnpm instead', question: 'Do you want to proceed?' };
    const first = call('post', '/sessions/:sessionId/reply', body);
    const second = await call('post', '/sessions/:sessionId/reply', body);
    expect(second.status).toHaveBeenCalledWith(409);
    expect(second.json).toHaveBeenCalledWith({ error: 'busy' });
    const answer = await call('post', '/sessions/:sessionId/answer', {
      option: 1,
      question: 'Do you want to proceed?',
    });
    expect(answer.json).toHaveBeenCalledWith({ error: 'busy' });
    await vi.advanceTimersByTimeAsync(20_000);
    await first;
    expect(sendInput.mock.calls).toEqual([['s1', { key: 'escape' }]]);
  });

  it('never answers the next permission prompt for the one the phone showed', async () => {
    // Same question and options; only the command differs.
    const { call, sendInput, setScreenText } = setup('permission-bash.txt');
    setScreenText(
      fixture('permission-bash.txt').replaceAll('rm -rf dist/ && pnpm build', 'rm -rf ~/Projects')
    );
    const res = await call('post', '/sessions/:sessionId/answer', {
      option: 1,
      question: 'Do you want to proceed?',
      key: parseScreenChoices(fixture('permission-bash.txt'))?.key,
    });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('answers the same prompt whatever the phone kept of its emoji or how its rows wrapped', async () => {
    // The phone keeps a character cluster's first code point, the server the whole cluster;
    // a phone of another width wraps the rows elsewhere.
    const screen = fixture('permission-bash.txt').replace(
      'Remove the stale build output and rebuild',
      'Remove the 👩‍💻 build output and rebuild'
    );
    const { call, sendInput, setScreenText } = setup('permission-bash.txt');
    setScreenText(screen);
    const phone = parseScreenChoices(
      screen.replace('👩‍💻', '👩').replace('pnpm build', 'pnpm\nbuild')
    );
    const res = await call('post', '/sessions/:sessionId/answer', {
      option: 1,
      question: 'Do you want to proceed?',
      key: phone?.key,
    });
    expect(res.json).toHaveBeenCalledWith({ success: true });
    expect(sendInput.mock.calls).toEqual([['s1', { key: 'enter' }]]);
  });

  it('never sends Esc when the menu the phone saw is gone, Claude maybe working already', async () => {
    // Its status file still said waiting while the screen showed it working: Esc interrupted
    // the work.
    const { call, sendInput } = setup('busy.txt');
    const res = await call('post', '/sessions/:sessionId/reply', {
      text: 'usa pnpm',
      question: 'Do you want to proceed?',
    });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('never types a reply into a menu Claude does not report', async () => {
    // The trust-folder dialog at startup: Enter would confirm "No, exit".
    const { call, sendInput } = setup('trust-folder.txt', 'none');
    const res = await call('post', '/sessions/:sessionId/reply', { text: 'Yes', question: null });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: 'The prompt changed' });
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('never answers with Esc a menu where Esc exits', async () => {
    const { call, sendInput } = setup('trust-folder.txt');
    const res = await call('post', '/sessions/:sessionId/reply', {
      text: 'Yes',
      question: 'Quick safety check: Is this a project you created or one you trust?',
    });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('answers, replies and reads nothing while agent chat is off', async () => {
    const off = setup('permission-bash.txt', 'waiting', {}, false);
    vi.mocked(readClaudeStatuses).mockClear();
    const results = [
      await off.call('post', '/sessions/:sessionId/answer', {
        option: 1,
        question: 'Do you want to proceed?',
      }),
      await off.call('post', '/sessions/:sessionId/reply', {
        text: 'use pnpm instead',
        question: 'Do you want to proceed?',
      }),
      await off.call('get', '/sessions/:sessionId/prompt'),
    ];
    for (const res of results) {
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'disabled' }));
    }
    expect(off.sendInput).not.toHaveBeenCalled();
    expect(readClaudeStatuses).not.toHaveBeenCalled();
  });

  it('refuses an option out of range, a missing question and an oversized reply', async () => {
    const { call, sendInput } = setup('permission-bash.txt');
    for (const body of [
      { option: 0, question: 'Do you want to proceed?' },
      { option: 10, question: 'Do you want to proceed?' },
      { option: 1.5, question: 'Do you want to proceed?' },
      { option: '1', question: 'Do you want to proceed?' },
      { option: 1 },
    ]) {
      expect((await call('post', '/sessions/:sessionId/answer', body)).status).toHaveBeenCalledWith(
        400
      );
    }
    // A valid number past the menu's options: the prompt is not the one the phone showed.
    expect(
      (
        await call('post', '/sessions/:sessionId/answer', {
          option: 9,
          question: 'Do you want to proceed?',
        })
      ).status
    ).toHaveBeenCalledWith(409);
    const long = await call('post', '/sessions/:sessionId/reply', {
      text: 'x'.repeat(20_001),
      question: 'Do you want to proceed?',
    });
    expect(long.status).toHaveBeenCalledWith(413);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('answers nothing for a session that is not running', async () => {
    const { call, sendInput } = setup('permission-bash.txt', 'waiting', { status: 'exited' });
    const res = await call('post', '/sessions/:sessionId/answer', {
      option: 1,
      question: 'Do you want to proceed?',
    });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('lets the phone type a long message itself when Claude is not waiting', async () => {
    const { call } = setup('busy.txt', 'idle');
    const res = await call('post', '/sessions/:sessionId/reply', {
      text: 'x'.repeat(5000),
      question: null,
    });
    // Not a 400: the phone falls back to typing it, as for any message.
    expect(res.json).toHaveBeenCalledWith({ error: 'not-waiting' });
  });
});

const planOptions = [
  'Yes, and switch to BYPASS PERMISSIONS (no further prompts) for this session',
  'Yes, manually approve edits',
  'Tell Claude what to change',
];

const cursorOnSecond = fixture('permission-bash.txt')
  .replace(' ❯ 1. Yes', '   1. Yes')
  .replace('   2. Yes, and', ' ❯ 2. Yes, and');
