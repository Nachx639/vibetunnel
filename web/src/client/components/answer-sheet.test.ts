// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANSWER_OPEN_GUARD_MS, closeAnswerSheet, openAnswerSheet } from './answer-sheet';

const permission = {
  question: 'Do you want to proceed?',
  options: ['Yes', "Yes, and don't ask again", 'No, and tell Claude what to do differently (esc)'],
};

type Route = (init?: RequestInit) => { status: number; body?: unknown };

function mockApi(routes: Record<string, Route>) {
  const calls: Array<{ path: string; body?: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace('/api/sessions/s1', '');
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const handler = routes[`${init?.method ?? 'GET'} ${path}`];
      const { status, body } = handler ? handler(init) : { status: 500 };
      return new Response(JSON.stringify(body ?? {}), { status });
    })
  );
  return calls;
}

const sheet = () => document.querySelector('[data-testid="answer-sheet"]');
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const tap = (el: Element | null | undefined) => {
  el?.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
  el?.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true }));
};

describe('answer sheet', () => {
  let now = 1_000_000;
  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => {
    closeAnswerSheet();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('answers with the key of what it shows, never with one read at the tap', async () => {
    // Taking the key read at the tap made the server compare the screen with itself: a stale
    // sheet approved whatever came next with the same question.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const answers = () => calls.filter((c) => c.path === '/answer').map((c) => c.body);
    let live: unknown = { ...permission, key: 'K1' };
    const calls = mockApi({
      'GET /prompt': () =>
        live ? { status: 200, body: { waiting: true, choices: live } } : { status: 500 },
      'POST /answer': () => ({ status: 200, body: { success: true } }),
    });
    openAnswerSheet({ sessionId: 's1', choices: permission });
    await vi.advanceTimersByTimeAsync(10);
    now += ANSWER_OPEN_GUARD_MS + 1;
    live = { ...permission, key: 'K2' };
    tap(document.querySelectorAll('[data-testid="answer-choice"]')[0]);
    await vi.advanceTimersByTimeAsync(10);
    expect(answers()).toEqual([expect.objectContaining({ option: 1, key: 'K1' })]);
    vi.useRealTimers();
  });

  it("answers from a push's choices with its fingerprint of the key, and long options match", async () => {
    // Opened from a push and unable to read at first (the phone waking up): the push carries
    // the key's fingerprint, and its options are cut to 80 characters.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const longOption = `Yes, and don't ask again for pnpm build commands in ${'/x'.repeat(30)}`;
    const full = { question: permission.question, options: ['Yes', longOption, 'No'] };
    const fromPush = { ...full, options: full.options.map((o) => o.slice(0, 80)), keyHash: 'H' };
    let live: unknown = null;
    const calls = mockApi({
      'GET /prompt': () =>
        live ? { status: 200, body: { waiting: true, choices: live } } : { status: 500 },
      'POST /answer': () => ({ status: 200, body: { success: true } }),
    });
    openAnswerSheet({ sessionId: 's1', choices: fromPush });
    await vi.advanceTimersByTimeAsync(3000);
    now += ANSWER_OPEN_GUARD_MS + 1;
    live = { ...full, key: 'K' };
    tap(document.querySelectorAll('[data-testid="answer-choice"]')[0]);
    await vi.advanceTimersByTimeAsync(10);
    expect(document.querySelector('[data-testid="answer-gone"]')).toBeNull();
    expect(calls.filter((c) => c.path === '/answer').map((c) => c.body)).toEqual([
      expect.objectContaining({ option: 1, keyHash: 'H' }),
    ]);
    vi.useRealTimers();
  });

  it('sends the chosen option after re-reading the live prompt', async () => {
    const calls = mockApi({
      'GET /prompt': () => ({ status: 200, body: { waiting: true, choices: permission } }),
      'POST /answer': () => ({ status: 200, body: { success: true } }),
    });
    const onSent = vi.fn();
    openAnswerSheet({ sessionId: 's1', choices: permission, onSent });
    await flush();
    const buttons = document.querySelectorAll('[data-testid="answer-choice"]');
    expect(buttons).toHaveLength(3);

    // The tap that opened the sheet must not pick an option.
    tap(buttons[0]);
    await flush();
    expect(calls.filter((c) => c.path === '/answer')).toHaveLength(0);

    now += ANSWER_OPEN_GUARD_MS + 1;
    tap(buttons[1]);
    await flush();
    await flush();
    expect(calls.map((c) => c.path)).toEqual(['/prompt', '/prompt', '/answer']);
    expect(calls[2].body).toEqual({
      option: 2,
      question: 'Do you want to proceed?',
      options: permission.options,
    });
    expect(onSent).toHaveBeenCalled();
    expect(sheet()).toBeNull();
  });

  it('refuses to send when the prompt changed meanwhile', async () => {
    let live: unknown = { waiting: true, choices: permission };
    const calls = mockApi({
      'GET /prompt': () => ({ status: 200, body: live }),
      'POST /answer': () => ({ status: 200 }),
    });
    openAnswerSheet({ sessionId: 's1', choices: permission });
    await flush();
    now += ANSWER_OPEN_GUARD_MS + 1;

    live = {
      waiting: true,
      choices: { question: 'Would you like to proceed?', options: ['Yes', 'No'] },
    };
    tap(document.querySelectorAll('[data-testid="answer-choice"]')[0]);
    await flush();
    await flush();
    expect(calls.some((c) => c.path === '/answer')).toBe(false);
    expect(document.querySelector('[data-testid="answer-gone"]')).not.toBeNull();
    expect(sheet()).not.toBeNull();
  });

  it('says Claude is no longer waiting when the push is stale', async () => {
    mockApi({ 'GET /prompt': () => ({ status: 200, body: { waiting: false, choices: null } }) });
    openAnswerSheet({ sessionId: 's1', choices: permission });
    await flush();
    expect(document.querySelector('[data-testid="answer-gone"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-testid="answer-choice"]')).toHaveLength(0);
  });

  it('sends a written reply with the question it answers', async () => {
    const calls = mockApi({
      'GET /prompt': () => ({ status: 200, body: { waiting: true, choices: permission } }),
      'POST /reply': () => ({ status: 200, body: { success: true } }),
    });
    openAnswerSheet({ sessionId: 's1' });
    await flush();
    now += ANSWER_OPEN_GUARD_MS + 1;
    const input = document.querySelector<HTMLInputElement>('[data-testid="answer-reply"]');
    if (!input) throw new Error('no reply box');
    input.value = 'use pnpm instead';
    input.dispatchEvent(new Event('input'));
    tap(document.querySelector('[data-testid="answer-send"]'));
    await flush();
    await flush();
    expect(calls.find((c) => c.path === '/reply')?.body).toEqual({
      text: 'use pnpm instead',
      question: 'Do you want to proceed?',
      options: permission.options,
      key: null,
      keyHash: null,
    });
  });

  it('keeps the sheet open when the server says the prompt changed', async () => {
    mockApi({
      'GET /prompt': () => ({ status: 200, body: { waiting: true, choices: permission } }),
      'POST /answer': () => ({ status: 409 }),
    });
    openAnswerSheet({ sessionId: 's1' });
    await flush();
    now += ANSWER_OPEN_GUARD_MS + 1;
    tap(document.querySelectorAll('[data-testid="answer-choice"]')[0]);
    await flush();
    await flush();
    expect(document.querySelector('[data-testid="answer-gone"]')).not.toBeNull();
  });

  it('shows what the answer approves, and sends it for the server to check', async () => {
    const calls = mockApi({
      'GET /prompt': () => ({
        status: 200,
        body: {
          waiting: true,
          choices: {
            ...permission,
            detail: ['Bash command', 'rm -rf dist/ && pnpm build'],
            key: 'Bashcommandrm-rfdist/&&pnpmbuild',
          },
        },
      }),
      'POST /answer': () => ({ status: 200 }),
    });
    openAnswerSheet({ sessionId: 's1' });
    await flush();
    expect(document.querySelector('[data-testid="answer-detail"]')?.textContent).toContain(
      'rm -rf dist/ && pnpm build'
    );
    now += ANSWER_OPEN_GUARD_MS + 1;
    tap(document.querySelectorAll('[data-testid="answer-choice"]')[0]);
    await flush();
    await flush();
    expect(calls.find((c) => c.path === '/answer')?.body).toMatchObject({
      option: 1,
      key: 'Bashcommandrm-rfdist/&&pnpmbuild',
    });
  });

  it('lets an answer be retried while another one to the session is on its way', async () => {
    // The server takes one answer per session at a time: "busy" is not a changed prompt.
    mockApi({
      'GET /prompt': () => ({ status: 200, body: { waiting: true, choices: permission } }),
      'POST /answer': () => ({ status: 409, body: { error: 'busy' } }),
    });
    openAnswerSheet({ sessionId: 's1' });
    await flush();
    now += ANSWER_OPEN_GUARD_MS + 1;
    tap(document.querySelectorAll('[data-testid="answer-choice"]')[0]);
    await flush();
    await flush();
    expect(document.querySelector('[data-testid="answer-gone"]')).toBeNull();
    expect(document.querySelectorAll('[data-testid="answer-choice"]')).toHaveLength(3);
  });
});
