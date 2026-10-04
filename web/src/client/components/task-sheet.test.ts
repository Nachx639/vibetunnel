// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskRecord } from '../../shared/tasks.js';
import type { TaskSheet } from './task-sheet.js';

vi.mock('../services/auth-client.js', () => ({
  authClient: { getAuthHeader: () => ({ Authorization: 'Bearer t' }) },
}));

let openTaskSheet: typeof import('./task-sheet.js').openTaskSheet;

interface Call {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

describe('task-sheet', () => {
  let calls: Call[];
  let tasks: TaskRecord[];
  let templates: Array<{ id: string; name: string; prompt: string }>;
  let failWith: string | null;

  beforeAll(async () => {
    ({ openTaskSheet } = await import('./task-sheet.js'));
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2030, 0, 15, 15, 30));
    calls = [];
    tasks = [];
    failWith = null;
    templates = [{ id: 'mine', name: 'Docs', prompt: 'Document {folder}' }];
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      let reply: unknown = {};
      if (url === '/api/task-templates' && method === 'GET') reply = { templates };
      else if (url === '/api/tasks' && method === 'GET') reply = { tasks };
      else if (url === '/api/tasks' && method === 'POST' && failWith) {
        return new Response(JSON.stringify({ error: 'Folder not found: x', code: failWith }), {
          status: 400,
        });
      } else if (url === '/api/tasks' && method === 'POST') {
        reply = {
          task: {
            ...body,
            id: 'new',
            state: body?.runAt ? 'scheduled' : 'running',
            sessionId: body?.runAt ? undefined : 'sess-9',
          },
        };
      }
      return new Response(JSON.stringify(reply), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    document.querySelector('task-sheet')?.remove();
    vi.useRealTimers();
  });

  const open = async (onStarted = vi.fn()) => {
    const sheet = openTaskSheet({
      folders: ['/home/user/app', '/home/user/web'],
      command: ['claude', '--model', 'opus'],
      onStarted,
    });
    // Past the 500 ms that ignore the tap which opened the sheet.
    vi.setSystemTime(Date.now() + 600);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await sheet.updateComplete;
    return sheet;
  };

  const touch = async (sheet: TaskSheet, selector: string) => {
    const el = sheet.querySelector(selector) as HTMLElement;
    expect(el, selector).toBeTruthy();
    el.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sheet.updateComplete;
  };

  it('keeps its main button in view, pinned under a form that scrolls', async () => {
    // On a short phone screen "Start now" would sit below the form, out of sight.
    const sheet = await open();
    const style = sheet.querySelector('style')?.textContent ?? '';
    expect(style).toMatch(/\.task-primary \{[^}]*position: sticky;[^}]*bottom: 0;/);
    // Opaque even disabled (before a prompt is typed): the form scrolls beneath it.
    expect(style).not.toMatch(/\.task-primary:disabled \{[^}]*opacity/);
    expect(sheet.querySelector('.task-body > [data-testid="task-submit"]')).toBeTruthy();
  });

  it('shows the built-in templates and yours, and a chip fills the name and prompt', async () => {
    const sheet = await open();
    const chips = [...sheet.querySelectorAll('.task-chip')].map((chip) => chip.textContent?.trim());
    expect(chips).toHaveLength(6);
    expect(chips.at(-1)).toBe('Docs');
    await touch(sheet, '.task-chip[data-id="builtin-tests"]');
    expect((sheet.querySelector('[data-testid="task-prompt"]') as HTMLTextAreaElement).value).toBe(
      'Review the tests and fix the ones that fail'
    );
    expect((sheet.querySelector('[data-testid="task-name"]') as HTMLInputElement).value).toBe(
      'Fix tests'
    );
  });

  it('a scroll of the form that starts on a chip or Run now does nothing', async () => {
    const sheet = await open();
    // iOS ends a scroll that began on a button with a pointerup on it.
    const drag = (selector: string) => {
      const el = sheet.querySelector(selector) as HTMLElement;
      const at = (y: number) => ({
        pointerType: 'touch',
        pointerId: 7,
        clientX: 40,
        clientY: y,
        bubbles: true,
      });
      el.dispatchEvent(new PointerEvent('pointerdown', at(400)));
      el.dispatchEvent(new PointerEvent('pointerup', at(300)));
    };
    const name = () => (sheet.querySelector('[data-testid="task-name"]') as HTMLInputElement).value;
    drag('.task-chip[data-id="builtin-tests"]');
    await sheet.updateComplete;
    expect(name()).toBe('');
    await touch(sheet, '.task-chip[data-id="builtin-tests"]');
    expect(name()).toBe('Fix tests');
    drag('[data-testid="task-submit"]');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('starts a task now with the Claude command, and opens its session', async () => {
    const onStarted = vi.fn();
    const sheet = await open(onStarted);
    expect(sheet.querySelector('[data-testid="task-agent"]')).toBeNull();
    expect(sheet.querySelector('[data-testid="task-shielded"]')).toBeNull();
    await touch(sheet, '.task-chip[data-id="builtin-lint"]');
    await touch(sheet, '[data-testid="task-submit"]');
    await vi.waitFor(() => expect(onStarted).toHaveBeenCalledWith('sess-9'));
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toEqual({
      name: 'Fix lint',
      prompt: 'Fix the lint errors',
      workingDir: '/home/user/app',
      command: ['claude', '--model', 'opus'],
      agent: 'claude',
      notify: true,
    });
    // One tap, one task: the click after the pointerup is swallowed.
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('schedules for tonight at 2:00 and shows the Scheduled tab', async () => {
    const sheet = await open();
    await touch(sheet, '.task-chip[data-id="builtin-summary"]');
    await touch(sheet, '[data-testid="task-when"] [data-value="tonight"]');
    await touch(sheet, '[data-testid="task-submit"]');
    await vi.waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body?.runAt).toBe(new Date(2030, 0, 16, 2, 0).toISOString());
  });

  it('offers a native datetime-local input for a custom time', async () => {
    const sheet = await open();
    await touch(sheet, '[data-testid="task-when"] [data-value="custom"]');
    const input = sheet.querySelector('[data-testid="task-time"]') as HTMLInputElement;
    expect(input.type).toBe('datetime-local');
    expect(input.value).toBe('2030-01-15T16:30');
  });

  it('ignores the click that opened it', async () => {
    const sheet = openTaskSheet({ folders: ['~'], command: ['claude'] });
    await sheet.updateComplete;
    (sheet.querySelector('.task-chip') as HTMLElement).click();
    await sheet.updateComplete;
    expect(sheet.querySelector('.task-chip.selected')).toBeNull();
  });

  it('lists scheduled tasks and cancels one', async () => {
    tasks = [
      {
        id: 'a',
        name: 'Nightly tests',
        prompt: 'p',
        workingDir: '/home/user/app',
        command: ['claude'],
        agent: 'claude',
        notify: true,
        runAt: new Date(2030, 0, 16, 2, 0).toISOString(),
        createdAt: new Date().toISOString(),
        state: 'scheduled',
      },
    ];
    window.confirm = vi.fn(() => true);
    const sheet = await open();
    await touch(sheet, '[data-testid="task-tab-scheduled"]');
    await vi.waitFor(() => expect(sheet.querySelector('.task-item')).toBeTruthy());
    expect(sheet.querySelector('.task-item-name')?.textContent).toBe('Nightly tests');
    await touch(sheet, '.task-item [data-action="remove"]');
    await vi.waitFor(() =>
      expect(calls.some((call) => call.method === 'DELETE' && call.url === '/api/tasks/a')).toBe(
        true
      )
    );
  });

  it("shows the server's error in the user's language, from its code", async () => {
    failWith = 'folderNotFound';
    const sheet = await open();
    await touch(sheet, '.task-chip[data-id="builtin-lint"]');
    await touch(sheet, '[data-testid="task-submit"]');
    await vi.waitFor(() => expect(sheet.querySelector('.task-error')).toBeTruthy());
    expect(sheet.querySelector('.task-error')?.textContent).toBe(
      'Could not create the task: That folder does not exist on the server.'
    );
  });

  it('labels a failed task by its code', async () => {
    tasks = [
      {
        id: 'b',
        name: 'Nightly lint',
        prompt: 'p',
        workingDir: '/home/user/app',
        command: ['claude'],
        agent: 'claude',
        notify: true,
        runAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        state: 'failed',
        error: 'Agent chat is off',
        errorCode: 'disabled',
      },
    ];
    const sheet = await open();
    await touch(sheet, '[data-testid="task-tab-scheduled"]');
    await vi.waitFor(() => expect(sheet.querySelector('.task-item')).toBeTruthy());
    expect(sheet.querySelector('.task-item-meta')?.textContent).toContain(
      'Failed: Tasks need agent chat, which is off on this server.'
    );
  });
});
