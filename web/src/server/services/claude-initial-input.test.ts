import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  codexDialogOnScreen,
  codexReadyOnScreen,
  type InitialInputDeps,
  typeWhenClaudeReady,
  typeWhenCodexReady,
} from './claude-initial-input';

describe('typeWhenClaudeReady', () => {
  let status: string | undefined;
  let dialog: boolean;
  let running: boolean;
  let sent: Array<{ text: string } | { key: 'enter' }>;
  let deps: InitialInputDeps;

  beforeEach(() => {
    vi.useFakeTimers();
    status = undefined;
    dialog = false;
    running = true;
    sent = [];
    deps = {
      claudeStatus: async () => status,
      dialogOnScreen: async () => dialog,
      isRunning: () => running,
      send: (input) => sent.push(input),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for Claude to be idle before typing the text and Enter', async () => {
    const done = typeWhenClaudeReady('hello', deps);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual([]);

    status = 'idle';
    await vi.advanceTimersByTimeAsync(2000);
    await expect(done).resolves.toBe(true);
    expect(sent).toEqual([{ text: 'hello' }, { key: 'enter' }]);
  });

  it('waits while a startup dialog is on screen', async () => {
    status = 'idle';
    dialog = true;
    const done = typeWhenClaudeReady('hello', deps);
    await vi.advanceTimersByTimeAsync(3000);
    expect(sent).toEqual([]);

    dialog = false;
    await vi.advanceTimersByTimeAsync(2000);
    await expect(done).resolves.toBe(true);
    expect(sent).toEqual([{ text: 'hello' }, { key: 'enter' }]);
  });

  it('never types blind when Claude never becomes ready (a late dialog would take the Enter)', async () => {
    const onGiveUp = vi.fn();
    const done = typeWhenClaudeReady('hello', { ...deps, onGiveUp }, { timeoutMs: 30000 });
    await vi.advanceTimersByTimeAsync(31000);
    await expect(done).resolves.toBe(false);
    expect(sent).toEqual([]);
    expect(onGiveUp).toHaveBeenCalledWith('Claude never became ready');
  });

  it('keeps waiting while a dialog shows, then types once the user answers it', async () => {
    dialog = true;
    const done = typeWhenClaudeReady('hello', deps, { timeoutMs: 30000 });
    await vi.advanceTimersByTimeAsync(120_000); // the user takes two minutes
    expect(sent).toEqual([]);
    dialog = false;
    status = 'idle';
    await vi.advanceTimersByTimeAsync(2000);
    await expect(done).resolves.toBe(true);
    expect(sent).toEqual([{ text: 'hello' }, { key: 'enter' }]);
  });

  it('treats an unreadable screen as a dialog', async () => {
    status = 'idle';
    const done = typeWhenClaudeReady(
      'hello',
      { ...deps, dialogOnScreen: async () => Promise.reject(new Error('no screen')) },
      { timeoutMs: 3000 }
    );
    await vi.advanceTimersByTimeAsync(4000);
    await expect(done).resolves.toBe(false);
    expect(sent).toEqual([]);
  });

  it('does not press Enter into a dialog that is still open at the longest wait', async () => {
    dialog = true;
    const onGiveUp = vi.fn();
    const done = typeWhenClaudeReady(
      'hello',
      { ...deps, onGiveUp },
      { timeoutMs: 30000, maxWaitMs: 120_000 }
    );
    await vi.advanceTimersByTimeAsync(121_000);
    await expect(done).resolves.toBe(false);
    expect(sent).toEqual([]);
    expect(onGiveUp).toHaveBeenCalled();
  });

  it('gives up when the session exits', async () => {
    const done = typeWhenClaudeReady('hello', deps, { timeoutMs: 30000 });
    running = false;
    await vi.advanceTimersByTimeAsync(31000);
    await expect(done).resolves.toBe(false);
    expect(sent).toEqual([]);
  });

  it('sends multi-line text as a bracketed paste', async () => {
    status = 'idle';
    const done = typeWhenClaudeReady('one\ntwo', deps);
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(sent).toEqual([{ text: '\x1b[200~one\ntwo\x1b[201~' }, { key: 'enter' }]);
  });
});

// Codex 0.155 screens (plain text, as cellsToText renders them).
const CODEX_BANNER = [
  '╭──────────────────────────────────────────────╮',
  '│ >_ OpenAI Codex (v0.155.1)                    │',
  '│                                               │',
  '│ model:     gpt-5.5 high   /model to change    │',
  '│ directory: ~/Projects/app                     │',
  '╰──────────────────────────────────────────────╯',
  '',
];
const CODEX_PROMPT = [
  ...CODEX_BANNER,
  '  Tip: Use /review to get a code review of your changes.',
  '',
  '',
  '› Ask Codex to do anything',
  '',
  '  gpt-5.5 high · 100% context left · ~/Projects/app',
  '',
].join('\n');
const CODEX_UPDATE = [
  '  ✨ Update available! 0.155.1 -> 0.156.0',
  '',
  '  Release notes: https://github.com/openai/codex/releases/latest',
  '',
  '› 1. Update now (runs `npm install -g @openai/codex`)',
  '  2. Skip',
  '  3. Skip until next version',
  '',
  '  Press enter to continue',
].join('\n');
const CODEX_TRUST = [
  ...CODEX_BANNER,
  '> You are running Codex in /Users/me/Projects/app',
  '',
  '  Since this folder is version controlled, you may wish to allow Codex to work in this',
  '  folder without asking for approval.',
  '',
  '› 1. Yes, allow Codex to work in this folder without asking for approval',
  '  2. No, ask me to approve edits and commands',
  '',
].join('\n');

describe('Codex screen readiness', () => {
  it('is ready at the prompt with its footer', () => {
    expect(codexReadyOnScreen(CODEX_PROMPT)).toBe(true);
    expect(codexDialogOnScreen(CODEX_PROMPT)).toBe(false);
  });

  it('is not ready on the update prompt or the trust dialog', () => {
    expect(codexDialogOnScreen(CODEX_UPDATE)).toBe(true);
    expect(codexReadyOnScreen(CODEX_UPDATE)).toBe(false);
    expect(codexDialogOnScreen(CODEX_TRUST)).toBe(true);
    expect(codexReadyOnScreen(CODEX_TRUST)).toBe(false);
  });

  it('is not ready while the shell or the banner is all there is', () => {
    expect(codexReadyOnScreen('me@mac app % codex\n')).toBe(false);
    expect(codexReadyOnScreen(CODEX_BANNER.join('\n'))).toBe(false);
    expect(codexReadyOnScreen('')).toBe(false);
  });

  it('does not take a numbered list in the conversation above the prompt for a dialog', () => {
    const screen = ['• Plan:', '  1. Read the code', '  then run the tests', '', ''].join('\n');
    expect(codexDialogOnScreen(screen)).toBe(false);
  });
});

describe('typeWhenCodexReady', () => {
  let screen: string;
  let running: boolean;
  let sent: Array<{ text: string } | { key: 'enter' }>;
  const deps = () => ({
    screenText: async () => screen,
    isRunning: () => running,
    send: (input: { text: string } | { key: 'enter' }) => sent.push(input),
  });

  beforeEach(() => {
    vi.useFakeTimers();
    screen = '';
    running = true;
    sent = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('types the text once the prompt has shown for two polls', async () => {
    const done = typeWhenCodexReady('hello', deps());
    await vi.advanceTimersByTimeAsync(3000);
    expect(sent).toEqual([]);
    screen = CODEX_PROMPT;
    await vi.advanceTimersByTimeAsync(2500);
    await expect(done).resolves.toBe(true);
    expect(sent).toEqual([{ text: 'hello' }, { key: 'enter' }]);
  });

  it('presses Enter once more when Codex kept the text in its input', async () => {
    // Codex can take an Enter 80 ms after the text as part of the burst: the question then
    // stays in its input, unsent.
    screen = CODEX_PROMPT;
    const typed = CODEX_PROMPT.replace('› Ask Codex to do anything', '› hello');
    const done = typeWhenCodexReady('hello', {
      ...deps(),
      send: (input) => {
        sent.push(input);
        // The text shows in the input; only the second Enter sends it.
        if ('text' in input) screen = typed;
        else if (sent.filter((s) => 'key' in s).length === 2) screen = CODEX_PROMPT;
      },
    });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(done).resolves.toBe(true);
    expect(sent).toEqual([{ text: 'hello' }, { key: 'enter' }, { key: 'enter' }]);
  });

  it('presses Enter only once when Codex takes it', async () => {
    screen = CODEX_PROMPT;
    const done = typeWhenCodexReady('hello', deps());
    await vi.advanceTimersByTimeAsync(5000);
    await expect(done).resolves.toBe(true);
    expect(sent).toEqual([{ text: 'hello' }, { key: 'enter' }]);
  });

  it('waits while the user answers the update prompt, then types', async () => {
    screen = CODEX_UPDATE;
    const done = typeWhenCodexReady('hello', deps());
    await vi.advanceTimersByTimeAsync(10000);
    expect(sent).toEqual([]);
    screen = CODEX_PROMPT;
    await vi.advanceTimersByTimeAsync(2500);
    await expect(done).resolves.toBe(true);
  });

  it('reads the screen once per poll while a dialog is up', async () => {
    screen = CODEX_UPDATE;
    const screenText = vi.fn(async () => screen);
    const done = typeWhenCodexReady(
      'hello',
      { ...deps(), screenText },
      { pollMs: 500, timeoutMs: 60_000 }
    );
    await vi.advanceTimersByTimeAsync(4_900); // polls at 0, 500, ..., 4500: ten of them
    expect(screenText).toHaveBeenCalledTimes(10);
    running = false;
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(done).resolves.toBe(false);
  });

  it('never answers a dialog still open at the longest wait', async () => {
    screen = CODEX_TRUST;
    const onGiveUp = vi.fn();
    const done = typeWhenCodexReady(
      'hello',
      { ...deps(), onGiveUp },
      { timeoutMs: 30000, maxWaitMs: 120_000 }
    );
    await vi.advanceTimersByTimeAsync(121_000);
    await expect(done).resolves.toBe(false);
    expect(sent).toEqual([]);
    expect(onGiveUp).toHaveBeenCalledWith('Codex never became ready');
  });

  it('does not type into a screen it cannot read', async () => {
    const done = typeWhenCodexReady(
      'hello',
      { ...deps(), screenText: async () => Promise.reject(new Error('no screen')) },
      { timeoutMs: 3000 }
    );
    await vi.advanceTimersByTimeAsync(4000);
    await expect(done).resolves.toBe(false);
    expect(sent).toEqual([]);
  });
});
