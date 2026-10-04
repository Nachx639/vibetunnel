/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseScreenChoices } from '../../shared/claude-screen.js';
import { setLocale } from '../i18n/index.js';
import { es } from '../i18n/locales/es.js';
import {
  ClaudeChatView,
  extractUploadedImages,
  modeSwitchBlocked,
  parseClaudeMode,
  renderChatMarkdown,
} from './claude-chat-view.js';
import './claude-chat-view.js';
import { resetAnnouncerForTests } from '../utils/announce.js';
import { resetGhostClickGuard, swallowNextClick } from '../utils/ghost-click.js';

describe('renderChatMarkdown', () => {
  it('escapes markup before formatting', () => {
    expect(renderChatMarkdown('<img src=x onerror=alert(1)> **ok**')).toBe(
      '&lt;img src=x onerror=alert(1)&gt; <strong>ok</strong>'
    );
  });

  it('links URLs without letting markup through', () => {
    expect(renderChatMarkdown('See https://example.com/a?b=1&c=2. And (https://x.io)')).toBe(
      'See <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">https://example.com/a?b=1&amp;c=2</a>. And (<a href="https://x.io" target="_blank" rel="noopener noreferrer">https://x.io</a>)'
    );
    expect(renderChatMarkdown('https://e.com/"onmouseover="x')).not.toContain('"onmouseover');
  });

  it('formats code, emphasis, headings and bullets', () => {
    expect(renderChatMarkdown('# Title\n- run `ls`\n```sh\necho <hi>\n```')).toBe(
      '<span class="h h1">Title</span><span class="li" style="margin-inline-start:0em">• run <code>ls</code></span><pre><code>echo &lt;hi&gt;</code></pre>'
    );
  });
});

describe('renderChatMarkdown lists', () => {
  it('renders bullets and numbered items as hanging-indent blocks', () => {
    const html = renderChatMarkdown('Steps:\n- first long\n  - nested\n2. two\nend');
    expect(html).toBe(
      'Steps:<span class="li" style="margin-inline-start:0em">• first long</span>' +
        '<span class="li" style="margin-inline-start:1em">• nested</span>' +
        '<span class="li" style="margin-inline-start:0em">2. two</span>end'
    );
  });
});

describe('renderChatMarkdown never injects markup', () => {
  // An autolink rule running over the markup of a markdown link would nest an <a> inside its
  // href, and the URL's tail would become attributes (onclick).
  it.each([
    '[a](http://x/(http://onclick=alert//)',
    'see https://a.com/(https://b.com/onclick=x//) now',
    '[x](https://a.com/"onmouseover="alert(1))',
    '[`code`](https://a.com/(https://b.com/onclick=y//)',
    '| h | y |\n|---|---|\n| [a](http://x/(http://onerror=x//) | y |',
    'trap \uE0010\uE002 [b](https://ok.com)',
  ])('%s', (text) => {
    const doc = new DOMParser().parseFromString(
      `<div>${renderChatMarkdown(text)}</div>`,
      'text/html'
    );
    for (const element of Array.from(doc.querySelectorAll('*'))) {
      for (const attribute of Array.from(element.attributes)) {
        expect(attribute.name.startsWith('on'), attribute.name).toBe(false);
      }
    }
    expect(doc.querySelectorAll('a a')).toHaveLength(0);
    for (const link of Array.from(doc.querySelectorAll('a'))) {
      expect(link.getAttribute('href') ?? '').toMatch(/^https?:\/\//);
    }
  });
});

describe('renderChatMarkdown links, quotes and rules', () => {
  it('turns [label](url) into a link, but only for web addresses', () => {
    expect(renderChatMarkdown('See [the **new** guide](https://x.io/a?b=1&c=2).')).toBe(
      'See <a href="https://x.io/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">the <strong>new</strong> guide</a>.'
    );
    expect(renderChatMarkdown('[x](javascript:alert(1)) [y](/etc/passwd)')).not.toContain('<a');
  });

  it('sets headings apart by level, deeper ones all alike', () => {
    expect(renderChatMarkdown('Intro\n## Changes\none\n#### Detail')).toBe(
      'Intro<span class="h h2">Changes</span>one<span class="h h3">Detail</span>'
    );
  });

  it('keeps no empty lines between a code block and the text around it', () => {
    expect(renderChatMarkdown('The code:\n\n```ts\nx = 1\n```\n\nDone')).toBe(
      'The code:<pre><code>x = 1</code></pre>Done'
    );
  });

  it('renders adversarial runs (blank lines, open brackets) in linear time', () => {
    const started = performance.now();
    renderChatMarkdown(`# T\n${'\n'.repeat(40_000)}x`);
    renderChatMarkdown('['.repeat(40_000));
    renderChatMarkdown(`[a${'b'.repeat(40_000)}`);
    expect(performance.now() - started).toBeLessThan(300);
  });

  it('keeps no empty lines around headings and rules', () => {
    expect(renderChatMarkdown('## Summary\n\nTwo sentences.\n\n---\n\n## Steps\n\n1. one')).toBe(
      '<span class="h h2">Summary</span>Two sentences.<span class="hr"></span>' +
        '<span class="h h2">Steps</span><span class="li" style="margin-inline-start:0em">1. one</span>'
    );
  });

  it('shows quotes, section rules and strikethrough', () => {
    expect(renderChatMarkdown('Said:\n> hello\n> bye\n---\nnow ~~no~~ yes')).toBe(
      'Said:<span class="quote">hello</span><span class="quote">bye</span>' +
        '<span class="hr"></span>now <del>no</del> yes'
    );
  });
});

describe('renderChatMarkdown tables', () => {
  it('renders a table with its formatting, alignment and the text around it', () => {
    const html = renderChatMarkdown(
      'Summary:\n\n| Step | State | Min |\n|---|:---:|---:|\n| `build` | **ok** | 3 |\n| tests \\| e2e | <b>no</b> | 12 |\n\nEnd'
    );
    expect(html).toBe(
      'Summary:<div class="table-wrap"><table><thead><tr><th>Step</th>' +
        '<th style="text-align:center">State</th><th style="text-align:right">Min</th></tr>' +
        '</thead><tbody><tr><td><code>build</code></td>' +
        '<td style="text-align:center"><strong>ok</strong></td>' +
        '<td style="text-align:right">3</td></tr><tr><td>tests | e2e</td>' +
        '<td style="text-align:center">&lt;b&gt;no&lt;/b&gt;</td>' +
        '<td style="text-align:right">12</td></tr></tbody></table></div>End'
    );
  });

  it('fills short rows, and leaves pipes alone when there is no delimiter row', () => {
    expect(renderChatMarkdown('| a | b |\n| --- | --- |\n| solo |')).toContain(
      '<tr><td>solo</td><td></td></tr>'
    );
    expect(renderChatMarkdown('a | b\n---')).toBe('a | b<span class="hr"></span>');
    expect(renderChatMarkdown('cat x | grep y')).toBe('cat x | grep y');
  });
});

describe('parseClaudeMode', () => {
  it.each([
    ['  ⏵⏵ bypass permissions on (shift+tab to cycle)', 'Bypass permissions'],
    ['  ⏸ plan mode on · ? for shortcuts', 'Plan mode'],
    ['  ⏸ manual mode on · ? for shortcuts · ← for agents', 'Manual mode'],
    ['  ⏵⏵ accept edits on', 'Accept edits'],
    ['  ? for shortcuts', 'Default mode'],
    ['$ ls', null],
  ])('reads %j', (line, mode) => {
    expect(parseClaudeMode(line)).toBe(mode);
  });
});

describe('modeSwitchBlocked', () => {
  it('blocks Shift+Tab while a permission dialog shows, even with the mode line visible', () => {
    const dialog = [
      ' Edit file src/app.ts?',
      ' Do you want to make this edit?',
      ' ❯ 1. Yes',
      '   2. Yes, allow all edits during this session (shift+tab)',
      '   3. No',
      '  ⏵⏵ accept edits on (shift+tab to cycle)',
    ].join('\n');
    expect(modeSwitchBlocked(dialog)).toBe(true);
    expect(modeSwitchBlocked('  ⏵⏵ accept edits on (shift+tab to cycle)')).toBe(false);
    expect(modeSwitchBlocked('$ ls')).toBe(true);
  });
});

describe('parseScreenChoices', () => {
  it('reads a permission prompt with wrapped options', () => {
    const screen = [
      ' Read(/tmp/a.jpeg)',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. Yes, allow reading from',
      '      /tmp during this session',
      '   3. No',
      ' Esc to cancel · Tab to amend',
    ].join('\n');
    expect(parseScreenChoices(screen)).toEqual({
      question: 'Do you want to proceed?',
      options: ['Yes', 'Yes, allow reading from /tmp during this session', 'No'],
      cursor: 0,
      navigate: true,
      numbered: true,
      key: expect.any(String),
    });
  });

  it('joins a label the terminal hard-wrapped mid-word', () => {
    const screen = [
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. Yes, and always allow access to /tmp/alexandra.m',
      '      ontgomery.jr from this project',
      '   3. No',
    ].join('\n');
    expect(parseScreenChoices(screen, 54)?.options[1]).toBe(
      'Yes, and always allow access to /tmp/alexandra.montgomery.jr from this project'
    );
  });

  it('ignores numbered lists that are not a question', () => {
    expect(parseScreenChoices('Ideas:\n1. Salt\n2. Pepper')).toBeNull();
  });
});

describe('extractUploadedImages', () => {
  it('turns uploaded image paths into attachments', () => {
    expect(
      extractUploadedImages('/Users/x/.vibetunnel/control/uploads/ab-1.jpeg which flowers?')
    ).toEqual({ text: 'which flowers?', images: ['ab-1.jpeg'] });
    expect(extractUploadedImages('see /tmp/photo.png')).toEqual({
      text: 'see /tmp/photo.png',
      images: [],
    });
  });
});

function stubChat(messages: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ available: true, status: 'idle', messages }),
    }))
  );
}

async function mountChat() {
  const view = document.createElement('claude-chat-view') as ClaudeChatView;
  view.sessionId = 's1';
  document.body.appendChild(view);
  await vi.waitFor(() => expect(view.shadowRoot?.querySelector('.row')).toBeTruthy());
  return view;
}

describe('ClaudeChatView', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('drops a slow answer for the previous session after switching sessions', async () => {
    let resolveOld: (value: unknown) => void = () => {};
    const fetchMock = vi.fn((url: string) =>
      url.includes('/old/')
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve({
            ok: true,
            json: async () => ({ available: true, status: 'idle', messages: [] }),
          })
    );
    vi.stubGlobal('fetch', fetchMock);
    // The chat's own requests.
    const chatCalls = () => fetchMock.mock.calls.filter(([url]) => url.includes('/claude-chat'));
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 'old';
    document.body.appendChild(view);
    await vi.waitFor(() => expect(chatCalls()).toHaveLength(1));

    view.sessionId = 'new';
    await vi.waitFor(() => expect(chatCalls()).toHaveLength(2));
    resolveOld({
      ok: true,
      json: async () => ({
        available: true,
        status: 'idle',
        messages: [{ id: 'x', role: 'user', text: 'from the old session' }],
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await view.updateComplete;

    expect(view.shadowRoot?.textContent).not.toContain('from the old session');
  });

  it('announces Claude starting, waiting and finishing once per change, not per poll', async () => {
    resetAnnouncerForTests();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ available: true, status: 'idle', messages: [] }),
      }))
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's';
    document.body.appendChild(view);
    const region = () => document.querySelector('[data-testid="a11y-live-region"]');
    const internals = view as unknown as { apply(chat: unknown): void; loaded: boolean };
    const said = async (status: string, waitingFor?: string) => {
      internals.apply({ available: true, status, waitingFor, messages: [] });
      await view.updateComplete;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return region()?.textContent ?? '';
    };
    await vi.waitFor(() => expect(internals.loaded).toBe(true));
    // The state a session already had when opened is not news.
    expect(region()?.textContent ?? '').toBe('');
    expect(await said('busy')).toBe('Claude is working');
    expect(region()?.getAttribute('aria-live')).toBe('polite');
    expect(await said('waiting', 'permission')).toBe('Claude is waiting for you · permission');
    expect(await said('busy')).toBe('Claude is working');
    expect(await said('idle')).toBe('Claude finished');
    view.remove();
  });

  it('shows the mode last read for a session before its screen has loaded', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    });
    stubChat([{ id: '1', role: 'user', text: 'hello' }]);
    let screen = '⏸ plan mode on';
    const first = document.createElement('claude-chat-view') as ClaudeChatView;
    first.sessionId = 's1';
    first.getScreenTail = () => screen;
    document.body.appendChild(first);
    await vi.waitFor(() =>
      expect(first.shadowRoot?.querySelector('[data-testid="mode-chip"]')).toBeTruthy()
    );
    first.remove();

    // Reopened: no screen yet, the chip is there at once with the remembered mode.
    screen = '';
    const view = await mountChat();
    const chip = view.shadowRoot?.querySelector('[data-testid="mode-chip"]');
    expect(chip?.textContent).toContain('Plan mode');
  });

  it('speaks of Codex and drops the Claude mode chip in a Codex session', async () => {
    resetAnnouncerForTests();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ available: true, agent: 'codex', status: 'idle', messages: [] }),
      }))
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's';
    // A Claude-like status line on screen must not bring the mode chip into a Codex chat.
    view.getScreenTail = () => '⏵⏵ bypass permissions on';
    document.body.appendChild(view);
    const internals = view as unknown as { apply(chat: unknown): void; loaded: boolean };
    await vi.waitFor(() => expect(internals.loaded).toBe(true));
    await view.updateComplete;
    expect(view.shadowRoot?.textContent).toContain('Send Codex a message below.');
    expect(view.shadowRoot?.querySelector('[data-testid="mode-chip"]')).toBeNull();

    internals.apply({
      available: true,
      agent: 'codex',
      status: 'busy',
      activity: { kind: 'tool', tool: 'Bash', target: 'npm test' },
      messages: [{ id: 'u', role: 'user', text: 'run the tests' }],
    });
    await view.updateComplete;
    const activity = view.shadowRoot?.querySelector('[data-testid="chat-activity"]');
    expect(activity?.textContent).toContain('Codex ·');
    expect(view.shadowRoot?.querySelector('.stop')?.getAttribute('aria-label')).toBe('Stop Codex');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(document.querySelector('[data-testid="a11y-live-region"]')?.textContent).toBe(
      'Codex is working'
    );
    view.remove();
  });

  it("names each file of a patch that touches several, in the tool chip's diff", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ available: true, agent: 'codex', status: 'idle', messages: [] }),
      }))
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's';
    document.body.appendChild(view);
    try {
      const internals = view as unknown as {
        apply(chat: unknown): void;
        loaded: boolean;
        toggleTool(id: string): void;
      };
      await vi.waitFor(() => expect(internals.loaded).toBe(true));
      internals.apply({
        available: true,
        agent: 'codex',
        status: 'idle',
        messages: [
          {
            id: 't',
            role: 'tool',
            tool: 'Edit',
            text: '2 files',
            diff: ['#a.ts', '-x', '+y', '#b.ts', '+z'],
          },
        ],
      });
      internals.toggleTool('t');
      await view.updateComplete;
      const files = [...(view.shadowRoot?.querySelectorAll('.diff .file') ?? [])].map(
        (el) => el.textContent
      );
      expect(files).toEqual(['a.ts', 'b.ts']);
    } finally {
      view.remove();
    }
  });

  it('shows an interruption in the page language', async () => {
    // The server words it in English; a chat in another language says it in its own.
    await setLocale('es');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ available: true, status: 'idle', messages: [] }),
      }))
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's';
    document.body.appendChild(view);
    try {
      const internals = view as unknown as { apply(chat: unknown): void; loaded: boolean };
      await vi.waitFor(() => expect(internals.loaded).toBe(true));
      internals.apply({
        available: true,
        status: 'idle',
        messages: [
          { id: 'u', role: 'user', text: 'do something' },
          { id: 'n', role: 'note', text: 'Interrupted' },
        ],
      });
      await view.updateComplete;
      expect(view.shadowRoot?.querySelector('.tool.note')?.textContent?.trim()).toBe(
        es['chat.interrupted']
      );
    } finally {
      view.remove();
      await setLocale('en');
    }
  });

  it('steps aside for the terminal when the chat endpoint answers with an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }))
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 'remote';
    document.body.appendChild(view);

    await vi.waitFor(() => expect(view.hasAttribute('unavailable')).toBe(true));
  });

  it('copies a code block and a whole answer to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          available: true,
          status: 'idle',
          messages: [{ id: 'a', role: 'assistant', text: 'Run:\n```sh\nnpm test\n```' }],
        }),
      }))
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    document.body.appendChild(view);
    await vi.waitFor(() => expect(view.shadowRoot?.querySelector('.copy-code')).toBeTruthy());

    view.shadowRoot?.querySelector<HTMLButtonElement>('.copy-code')?.click();
    expect(writeText).toHaveBeenLastCalledWith('npm test');
    view.shadowRoot?.querySelector<HTMLButtonElement>('.copy-msg')?.click();
    expect(writeText).toHaveBeenLastCalledWith('Run:\n```sh\nnpm test\n```');
  });

  it('asks with the fingerprint it shows and keeps its list when the server leaves it out', async () => {
    const urls: string[] = [];
    const first = [
      { id: '1', role: 'user', text: 'hello' },
      { id: '2', role: 'assistant', text: 'first answer' },
    ];
    let answer: Record<string, unknown> = {
      available: true,
      status: 'busy',
      messages: first,
      messagesVersion: 'v1',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return { ok: true, json: async () => structuredClone(answer) };
      })
    );
    const view = await mountChat();
    expect(view.shadowRoot?.textContent).toContain('first answer');
    expect(urls[0]).toBe('/api/sessions/s1/claude-chat');

    // Unchanged: no list in the answer, the bubbles stay.
    answer = { available: true, status: 'busy', messagesVersion: 'v1', messagesUnchanged: true };
    await vi.waitFor(() => expect(urls.length).toBeGreaterThanOrEqual(3), { timeout: 5000 });
    expect(urls[1]).toBe('/api/sessions/s1/claude-chat?have=v1');
    await view.updateComplete;
    expect(view.shadowRoot?.textContent).toContain('first answer');

    // An edit keeps the length and the last id: the new fingerprint still shows it.
    answer = {
      available: true,
      status: 'busy',
      messages: [first[0], { ...first[1], text: 'corrected answer' }],
      messagesVersion: 'v2',
    };
    await vi.waitFor(() => expect(view.shadowRoot?.textContent).toContain('corrected answer'), {
      timeout: 5000,
    });
    await vi.waitFor(() => expect(urls[urls.length - 1]).toContain('have=v2'), { timeout: 5000 });
  }, 20000);

  it('shows what an Edit changed, without the stock "file has been updated" line', async () => {
    const edit = {
      id: 'e',
      role: 'tool',
      tool: 'Edit',
      text: 'a.ts',
      detail: '/repo/a.ts',
      result: 'The file /repo/a.ts has been updated successfully.',
      diff: [' x = 1', '-y = 2', '+y = 3', '…', ' z'],
      diffMore: 3,
    };
    stubChat([{ id: '1', role: 'user', text: 'change y' }, edit]);
    const view = await mountChat();
    const root = view.shadowRoot;
    root?.querySelector<HTMLButtonElement>('button.tool')?.click();
    await view.updateComplete;
    expect(root?.querySelector('.diff .dl.del')?.textContent).toBe('-y = 2');
    expect(root?.querySelector('.diff .dl.add')?.textContent).toBe('+y = 3');
    expect(root?.querySelectorAll('.diff .dl.ctx')).toHaveLength(2);
    expect(root?.querySelector('.diff')?.textContent).toContain('3 more lines');
    expect(root?.querySelector('.tool-detail pre.out')).toBeNull();
  });

  it('still shows an Edit that failed, with its change', async () => {
    stubChat([
      { id: '1', role: 'user', text: 'change y' },
      {
        id: 'e',
        role: 'tool',
        tool: 'Edit',
        text: 'a.ts',
        result: 'String to replace not found in file.',
        isError: true,
        diff: ['-y = 2', '+y = 3'],
      },
    ]);
    const view = await mountChat();
    view.shadowRoot?.querySelector<HTMLButtonElement>('button.tool')?.click();
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector('.tool-detail pre.out.err')?.textContent).toContain(
      'not found'
    );
    expect(view.shadowRoot?.querySelector('.diff .dl.del')).toBeTruthy();
  });

  it('offers a jump back to the latest reply, counting new ones, while reading older ones', async () => {
    const messages = [
      { id: '1', role: 'user', text: 'hello' },
      { id: '2', role: 'assistant', text: 'hey' },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ available: true, status: 'idle', messages: [...messages] }),
      }))
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    document.body.appendChild(view);
    await vi.waitFor(() => expect(view.shadowRoot?.querySelector('.row.assistant')).toBeTruthy());
    const scroller = view.shadowRoot?.querySelector<HTMLElement>('.scroller');
    if (!scroller) throw new Error('no scroller');
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 500 });
    scroller.scrollTop = 100;
    scroller.dispatchEvent(new Event('wheel'));
    scroller.dispatchEvent(new Event('scroll'));
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector('.jump')).toBeTruthy();
    expect(view.shadowRoot?.querySelector('.jump .badge')).toBeNull();

    // The server sends a capped window (latest 400): the list slides instead of growing.
    messages.shift();
    messages.push({ id: '3', role: 'assistant', text: 'more' });
    await vi.waitFor(
      () => expect(view.shadowRoot?.querySelector('.jump .badge')?.textContent).toBe('1'),
      { timeout: 3000 }
    );
    view.shadowRoot?.querySelector<HTMLButtonElement>('.jump')?.click();
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector('.jump')).toBeNull();
  });

  it('separates the days of a long conversation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          available: true,
          status: 'idle',
          messages: [
            { id: '1', role: 'user', text: 'a', timestamp: '2025-03-01T10:00:00' },
            { id: '2', role: 'assistant', text: 'b', timestamp: '2025-03-01T10:01:00' },
            { id: '3', role: 'user', text: 'c', timestamp: '2025-03-04T09:00:00' },
            { id: '4', role: 'assistant', text: 'd', timestamp: new Date().toISOString() },
          ],
        }),
      }))
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    document.body.appendChild(view);
    await vi.waitFor(() => expect(view.shadowRoot?.querySelector('.row.assistant')).toBeTruthy());

    const days = [...(view.shadowRoot?.querySelectorAll('.day') ?? [])].map((d) => d.textContent);
    expect(days).toHaveLength(3);
    expect(days[2]).toBe('Today');
  });

  it('says when the server cannot be reached and recovers on the next poll', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Load failed'))
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          available: true,
          status: 'idle',
          messages: [{ id: '1', role: 'assistant', text: 'back' }],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    document.body.appendChild(view);
    await vi.waitFor(() => expect(view.shadowRoot?.querySelector('.offline')).toBeTruthy());
    expect(view.shadowRoot?.querySelector('.empty')?.textContent).toContain('Loading');

    await vi.waitFor(() => expect(view.shadowRoot?.querySelector('.row.assistant')).toBeTruthy(), {
      timeout: 3000,
    });
    expect(view.shadowRoot?.querySelector('.offline')).toBeNull();
  });

  it('keeps the time on one line under a one-character message', () => {
    const styles = ClaudeChatView.styles.toString();
    expect(styles).toMatch(/\.time \{[^}]*white-space: nowrap;/);
    expect(styles).toMatch(/\.row\.user \.bubble \{\s*min-width: 84px;/);
  });

  it('does not open the search when a tap that closed something above it ends on its field', async () => {
    // Closing something above the search field with its × could open the search under it:
    // the field under the finger takes the tap's focus.
    stubChat([{ id: '1', role: 'user', text: 'hello' }]);
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    document.body.appendChild(view);
    const proxy = await vi.waitFor(() => {
      const found = view.shadowRoot?.querySelector<HTMLInputElement>('.search-proxy');
      if (!found) throw new Error('no search field yet');
      return found;
    });
    const searching = () => (view as unknown as { searchOpen: boolean }).searchOpen;
    swallowNextClick();
    proxy.dispatchEvent(new FocusEvent('focus'));
    await view.updateComplete;
    expect(searching()).toBe(false);
    resetGhostClickGuard();
    proxy.dispatchEvent(new FocusEvent('focus'));
    await view.updateComplete;
    expect(searching()).toBe(true);
    view.remove();
  });

  it('leaves the search field out of iOS reach while the composer has the keyboard', async () => {
    // From the focused chat composer iOS offers ↑ ↓ arrows to the invisible search field over
    // the icon. It is there only while no field is focused.
    stubChat([{ id: '1', role: 'user', text: 'hello' }]);
    const view = await mountChat();
    const root = view.shadowRoot as ShadowRoot;
    const proxy = () => root.querySelector<HTMLInputElement>('.search-proxy');
    expect(proxy()).toBeTruthy();

    const composer = document.createElement('textarea');
    document.body.appendChild(composer);
    composer.focus();
    await vi.waitFor(() => expect(proxy()).toBeNull());

    // A tap on the icon reaches the search button, which opens the search with the keyboard up.
    root.querySelector<HTMLButtonElement>('.search-toggle')?.click();
    await vi.waitFor(() => expect(root.querySelector('.search-bar input')).toBeTruthy());
    root
      .querySelector<HTMLInputElement>('.search-bar input')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await view.updateComplete;

    // Keyboard down (nothing focused): the field is back, so a tap raises the keyboard.
    composer.focus();
    composer.blur();
    await vi.waitFor(() => expect(proxy()).toBeTruthy());
    composer.remove();
  });

  it('answers a pending single-choice question by option number', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          available: true,
          status: 'waiting',
          waitingFor: 'input needed',
          messages: [
            {
              id: 'q',
              role: 'tool',
              tool: 'AskUserQuestion',
              text: '',
              question: { text: 'Fruit?', options: ['Apple', 'Strawberry'] },
            },
          ],
        }),
      }))
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    const sent = vi.fn();
    view.addEventListener('claude-chat-input', (e) => sent((e as CustomEvent<string>).detail));
    document.body.appendChild(view);
    await vi.waitFor(() => expect(view.shadowRoot?.querySelector('.question')).toBeTruthy());

    const buttons = view.shadowRoot?.querySelectorAll<HTMLButtonElement>('.question button');
    expect([...(buttons ?? [])].map((b) => b.textContent?.trim())).toEqual(['Apple', 'Strawberry']);
    buttons?.[1].click();

    expect(sent).toHaveBeenCalledWith('2');
  });

  it('renders the transcript as bubbles and hides itself for non-Claude sessions', async () => {
    const respond = vi.fn().mockResolvedValue({
      available: true,
      status: 'busy',
      messages: [
        { id: '1', role: 'user', text: 'hello' },
        {
          id: '2',
          role: 'tool',
          tool: 'Bash',
          text: 'List files',
          detail: '$ ls',
          result: 'a.txt',
        },
        { id: '3', role: 'assistant', text: '**Hello**' },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: respond }))
    );

    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    document.body.appendChild(view);
    await vi.waitFor(() => expect(view.shadowRoot?.querySelector('.row.assistant')).toBeTruthy());

    const root = view.shadowRoot;
    expect(root?.querySelector('.row.user .bubble')?.textContent).toContain('hello');
    expect(root?.querySelector('.tool')?.textContent).toContain('Bash');
    expect(root?.querySelector('.row.assistant strong')?.textContent).toBe('Hello');
    expect(root?.querySelector('.tool-detail')).toBeNull();
    root?.querySelector<HTMLButtonElement>('button.tool')?.click();
    await view.updateComplete;
    expect(root?.querySelector('.tool-detail')?.textContent).toContain('$ ls');
    expect(root?.querySelector('.tool-detail')?.textContent).toContain('a.txt');
    expect(root?.querySelector('.typing')).toBeTruthy();
    const sent = vi.fn();
    view.addEventListener('claude-chat-input', (e) => sent((e as CustomEvent<string>).detail));
    root?.querySelector<HTMLButtonElement>('.stop')?.click();
    expect(sent).toHaveBeenCalledWith('\x1b');
    expect(view.hasAttribute('unavailable')).toBe(false);

    respond.mockResolvedValue({ available: false, messages: [] });
    view.sessionId = 's2';
    await vi.waitFor(() => expect(view.hasAttribute('unavailable')).toBe(true));
  });

  it('shares an answer as text where the phone can share', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, share: shareMock });
    stubChat([
      { id: 'u', role: 'user', text: 'hello' },
      { id: 'a', role: 'assistant', text: 'A **useful** answer' },
    ]);
    const view = await mountChat();
    const buttons = view.shadowRoot?.querySelectorAll<HTMLButtonElement>('.share-msg') ?? [];
    expect(buttons).toHaveLength(1);
    buttons[0].click();
    expect(shareMock).toHaveBeenCalledWith({ text: 'A **useful** answer' });
  });

  it('offers no share button without the share sheet', async () => {
    vi.stubGlobal('navigator', { ...navigator, share: undefined });
    stubChat([{ id: 'a', role: 'assistant', text: 'hello' }]);
    const view = await mountChat();
    expect(view.shadowRoot?.querySelector('.share-msg')).toBeNull();
  });

  it('finds words in the conversation and steps through the matches', async () => {
    stubChat([
      { id: '1', role: 'user', text: 'fix the <b>build</b> please' },
      { id: '2', role: 'assistant', text: 'The **build** passes.\n```sh\npnpm build\n```' },
      { id: '3', role: 'assistant', text: 'nothing here' },
    ]);
    const view = await mountChat();
    const root = view.shadowRoot as ShadowRoot;
    // A finger lands on the real field over the icon (iOS ignores a scripted focus()).
    root.querySelector<HTMLInputElement>('.search-proxy')?.focus();
    await view.updateComplete;
    const input = root.querySelector<HTMLInputElement>('.search-bar input');
    if (!input) throw new Error('no search field');
    input.value = 'BUILD';
    input.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(root.querySelector('.search-count')?.textContent).toBe('3/3'));

    const marks = [...root.querySelectorAll('mark.hit')];
    expect(marks.map((m) => m.textContent)).toEqual(['build', 'build', 'build']);
    expect(marks[2].classList.contains('current')).toBe(true);
    // The user's literal <b> stays text: matching never turns it into markup.
    expect(root.querySelector('.row.user .md')?.textContent).toBe('fix the <b>build</b> please');
    expect(root.querySelector('.row.user b')).toBeNull();

    root.querySelector<HTMLButtonElement>('.search-prev')?.click();
    await view.updateComplete;
    expect(root.querySelector('.search-count')?.textContent).toBe('2/3');
    expect(root.querySelectorAll('mark.hit')[1].classList.contains('current')).toBe(true);
    root.querySelector<HTMLButtonElement>('.search-next')?.click();
    root.querySelector<HTMLButtonElement>('.search-next')?.click();
    await view.updateComplete;
    expect(root.querySelector('.search-count')?.textContent).toBe('1/3');

    input.value = 'zzz';
    input.dispatchEvent(new Event('input'));
    await vi.waitFor(() =>
      expect(root.querySelector('.search-count')?.textContent).toBe('No results')
    );

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await view.updateComplete;
    expect(root.querySelector('.search-bar')).toBeNull();
    expect(root.querySelector('mark.hit')).toBeNull();
    expect(root.querySelector('.row.assistant .md')?.innerHTML).toContain('<strong>build</strong>');
  });

  it('says it waits for background agents instead of the typing dots, until a turn starts', async () => {
    await setLocale('es');
    resetAnnouncerForTests();
    let view: ClaudeChatView | undefined;
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          json: async () => ({ available: true, status: 'busy', messages: [] }),
        }))
      );
      view = document.createElement('claude-chat-view') as ClaudeChatView;
      view.sessionId = 's';
      document.body.appendChild(view);
      const internals = view as unknown as { apply(chat: unknown): void; loaded: boolean };
      await vi.waitFor(() => expect(internals.loaded).toBe(true));
      await view.updateComplete;
      // A turn in progress: the typing dots.
      expect(view.shadowRoot?.querySelector('.typing')).not.toBeNull();

      internals.apply({
        available: true,
        status: 'busy',
        waitingForBackground: true,
        messages: [
          { id: 'u', role: 'user', text: 'lanza un agente' },
          { id: 'a', role: 'assistant', text: 'Lanzado; te aviso.' },
        ],
      });
      await view.updateComplete;
      const row = view.shadowRoot?.querySelector('[data-testid="chat-background"]');
      expect(row?.textContent?.trim()).toBe('Esperando a agentes en segundo plano');
      expect(view.shadowRoot?.querySelector('.typing')).toBeNull();
      expect(view.shadowRoot?.querySelector('.stop')).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(document.querySelector('[data-testid="a11y-live-region"]')?.textContent).toBe(
        'Claude ha respondido; los agentes en segundo plano siguen en marcha'
      );

      // A task notification starts a real turn again.
      internals.apply({
        available: true,
        status: 'busy',
        activity: { kind: 'thinking' },
        messages: [
          { id: 'u', role: 'user', text: 'lanza un agente' },
          { id: 'a', role: 'assistant', text: 'Lanzado; te aviso.' },
        ],
      });
      await view.updateComplete;
      expect(view.shadowRoot?.querySelector('[data-testid="chat-background"]')).toBeNull();
      expect(view.shadowRoot?.querySelector('.typing')).not.toBeNull();
    } finally {
      view?.remove();
      await setLocale('en');
    }
  });

  it('tells the phone composer while it shows a question with its options', async () => {
    // Both showed the options as buttons, one set over the other.
    let status = 'waiting';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ available: true, status, waitingFor: 'permission', messages: [] }),
      }))
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    view.getScreenTail = () =>
      ' Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently (esc)';
    const asking = vi.fn();
    view.addEventListener('claude-chat-asking', (e) => asking((e as CustomEvent<boolean>).detail));
    document.body.appendChild(view);
    await vi.waitFor(() => expect(asking).toHaveBeenLastCalledWith(true));

    status = 'idle';
    (view as unknown as { apply(chat: unknown): void }).apply({
      available: true,
      status: 'idle',
      messages: [],
    });
    await vi.waitFor(() => expect(asking).toHaveBeenLastCalledWith(false));
    view.remove();

    // Mounted again (back to chat mode) with nothing to ask: it says so at once, or the
    // composer would keep leaving a menu to a view that no longer shows it.
    const again = document.createElement('claude-chat-view') as ClaudeChatView;
    again.sessionId = 's1';
    const told = vi.fn();
    again.addEventListener('claude-chat-asking', (e) => told((e as CustomEvent<boolean>).detail));
    document.body.appendChild(again);
    await vi.waitFor(() => expect(told).toHaveBeenCalledWith(false));
    again.remove();
  });

  it('answers a menu on screen through the server, which checks it and presses Enter', async () => {
    // A yes/no letter alone left a line-reading prompt waiting; the server adds Enter.
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      url.endsWith('/answer')
        ? new Response('{}', { status: 200 })
        : Response.json({
            available: true,
            status: 'waiting',
            waitingFor: 'input needed',
            messages: [],
          })
    );
    vi.stubGlobal('fetch', fetchMock);
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    view.getScreenTail = () => '⏺ Done.\n\nOverwrite it with the new defaults? (y/n)';
    const sent = vi.fn();
    view.addEventListener('claude-chat-input', (e) => sent((e as CustomEvent<string>).detail));
    document.body.appendChild(view);
    await vi.waitFor(() => expect(view.shadowRoot?.querySelector('.question')).toBeTruthy());

    const buttons = view.shadowRoot?.querySelectorAll<HTMLButtonElement>('.question button');
    expect([...(buttons ?? [])].map((b) => b.textContent?.trim()).slice(0, 2)).toEqual([
      'Yes',
      'No',
    ]);
    buttons?.[1].click();
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/answer', expect.anything())
    );
    const call = fetchMock.mock.calls.find(([url]) => url.endsWith('/answer'));
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ option: 2 });
    expect(sent).not.toHaveBeenCalled();
    view.remove();
  });

  it("shows at once the next command's prompt with the same options as the one answered", async () => {
    // Told apart from the answered one by its options alone, it stayed hidden for 4 s with no
    // buttons anywhere.
    const permission = (command: string) =>
      [
        '────────────────────────────────────────',
        ' Bash command',
        '',
        `   ${command}`,
        '',
        ' Do you want to proceed?',
        ' ❯ 1. Yes',
        '   2. No',
        ' Esc to cancel',
      ].join('\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/answer')
          ? new Response('{}', { status: 200 })
          : Response.json({ available: true, status: 'waiting', waitingFor: 'Bash', messages: [] })
      )
    );
    let screen = permission('rm -rf dist/');
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    view.getScreenTail = () => screen;
    view.getMenuScreen = () => screen;
    document.body.appendChild(view);
    const buttons = () => view.shadowRoot?.querySelectorAll<HTMLButtonElement>('.question button');
    await vi.waitFor(() => expect(buttons()?.length).toBeGreaterThan(0));
    buttons()?.[0].click();
    const internals = view as unknown as { apply(chat: unknown): void; answering: boolean };
    await vi.waitFor(() => expect(internals.answering).toBe(false));
    await view.updateComplete;

    screen = permission('rm -rf src/');
    internals.apply({ available: true, status: 'waiting', waitingFor: 'Bash', messages: [] });
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector('.question')?.textContent).toContain('rm -rf src/');
    expect(buttons()?.[0]?.textContent?.trim()).toBe('Yes');
    view.remove();
  });

  it("forgets the question card's answer in flight when another session opens", async () => {
    let finish: (response: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.endsWith('/answer')
          ? new Promise<Response>((resolve) => (finish = resolve))
          : Promise.resolve(
              Response.json({
                available: true,
                status: 'waiting',
                waitingFor: 'permission',
                messages: [],
              })
            )
      )
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 'a';
    view.getScreenTail = () =>
      ' Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently (esc)';
    document.body.appendChild(view);
    const buttons = () => [
      ...(view.shadowRoot?.querySelectorAll<HTMLButtonElement>('.question button') ?? []),
    ];
    await vi.waitFor(() => expect(buttons().length).toBeGreaterThan(0));
    buttons()[0].click();
    await view.updateComplete;
    view.sessionId = 'b';
    // B's card is not A's: its buttons work (A's answer is still on its way)...
    await vi.waitFor(() => expect(buttons()[0]?.disabled).toBe(false));
    // ...and A's refusal says nothing on it.
    finish(new Response(JSON.stringify({ error: 'The prompt changed' }), { status: 409 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector('.question-note')).toBeNull();
    view.remove();
  });

  it('shows on the card what an answer approves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          available: true,
          status: 'waiting',
          waitingFor: 'permission',
          messages: [],
        })
      )
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    view.getScreenTail = () =>
      [
        '─'.repeat(40),
        ' Bash command',
        '',
        '   rm -rf dist/',
        '',
        ' Do you want to proceed?',
        ' ❯ 1. Yes',
        '   2. No, and tell Claude what to do differently (esc)',
      ].join('\n');
    document.body.appendChild(view);
    await vi.waitFor(() =>
      expect(
        view.shadowRoot?.querySelector('[data-testid="question-detail"]')?.textContent
      ).toContain('rm -rf dist/')
    );
    view.remove();
  });

  it('says why a tap on the card did nothing, and keeps asking while it answers', async () => {
    let finish: (response: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.endsWith('/answer')
          ? new Promise<Response>((resolve) => (finish = resolve))
          : Promise.resolve(
              Response.json({
                available: true,
                status: 'waiting',
                waitingFor: 'permission',
                messages: [],
              })
            )
      )
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    view.getScreenTail = () =>
      ' Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently (esc)';
    const asking = vi.fn();
    view.addEventListener('claude-chat-asking', (e) => asking((e as CustomEvent<boolean>).detail));
    document.body.appendChild(view);
    await vi.waitFor(() => expect(asking).toHaveBeenLastCalledWith(true));
    const buttons = () => [
      ...(view.shadowRoot?.querySelectorAll<HTMLButtonElement>('.question button') ?? []),
    ];
    buttons()[0].click();
    await view.updateComplete;
    // While it answers: buttons off, and still asking (the composer would show them again).
    expect(buttons()[0].disabled).toBe(true);
    expect(asking).toHaveBeenLastCalledWith(true);

    finish(new Response(JSON.stringify({ error: 'The prompt changed' }), { status: 409 }));
    await vi.waitFor(() =>
      expect(view.shadowRoot?.querySelector('.question-note')?.textContent).toContain('changed')
    );
    expect(buttons()[0].disabled).toBe(false);
    view.remove();
  });
});

describe('ClaudeChatView messages sent from the phone', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetGhostClickGuard();
    document.body.innerHTML = '';
  });

  type Internals = { apply(chat: unknown): void };
  const sent = (text: string, id: string, at = Date.now()) => ({
    sessionId: 's1',
    id,
    text,
    at,
    startedAt: performance.now(),
  });
  const now = () => new Date().toISOString();
  const earlier = { id: 'u0', role: 'user', text: 'ok', timestamp: '2025-10-03T08:00:00Z' };
  /** Mounted on a conversation that already has an "ok"; the server answers nothing more. */
  const mountQuiet = async () => {
    stubChat([
      earlier,
      { id: 'a0', role: 'assistant', text: 'done', timestamp: earlier.timestamp },
    ]);
    const view = await mountChat();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {}))
    );
    return view;
  };
  const sending = (view: ClaudeChatView) => [
    ...(view.shadowRoot?.querySelectorAll('.row.user[data-send]') ?? []),
  ];
  const userTexts = (view: ClaudeChatView) =>
    [...(view.shadowRoot?.querySelectorAll('.row.user .md') ?? [])].map((md) => md.textContent);

  it('shows a message the moment it is sent, before any poll answers', async () => {
    const view = await mountQuiet();
    view.addSentMessage(sent('fix the login', 'p1'));
    // Lit's render (a microtask): no fetch has answered, no timer has run.
    await view.updateComplete;
    const [row] = sending(view);
    expect(row?.getAttribute('data-send')).toBe('sending');
    expect(row?.querySelector('.md')?.textContent).toBe('fix the login');
    expect(row?.querySelector('.visually-hidden')?.textContent).toBe('Sending…');
    expect(row?.querySelector('.sending-icon')).toBeTruthy();
  });

  it("gives way to the transcript's message, each identical text to one of its own", async () => {
    const view = await mountQuiet();
    const internals = view as unknown as Internals;
    view.addSentMessage(sent('ok', 'p1'));
    view.addSentMessage(sent('ok', 'p2'));
    await view.updateComplete;
    // The "ok" shown before the sends is neither of them.
    expect(sending(view)).toHaveLength(2);
    expect(userTexts(view)).toEqual(['ok', 'ok', 'ok']);

    const first = { id: 'u1', role: 'user', text: ' ok\n', timestamp: now() };
    internals.apply({ available: true, status: 'busy', messages: [earlier, first] });
    await view.updateComplete;
    // Replaced in the same render: as many bubbles as before, the second still sending.
    expect(userTexts(view)).toEqual(['ok', 'ok', 'ok']);
    expect(sending(view)).toHaveLength(1);

    // The first one's message stands for it only, at the next polls too.
    const reply = { id: 'a1', role: 'assistant', text: 'ok then', timestamp: now() };
    internals.apply({ available: true, status: 'busy', messages: [earlier, first, reply] });
    await view.updateComplete;
    expect(sending(view)).toHaveLength(1);

    const second = { id: 'u2', role: 'user', text: 'ok', timestamp: now() };
    internals.apply({ available: true, status: 'busy', messages: [earlier, first, reply, second] });
    await view.updateComplete;
    expect(sending(view)).toHaveLength(0);
    expect(userTexts(view)).toEqual(['ok', 'ok', 'ok']);
  });

  it('matches a message sent with an image, whether or not its image is logged yet', async () => {
    const view = await mountQuiet();
    const path = '/Users/me/.vibetunnel/control/uploads/0b5e-photo.jpg';
    view.addSentMessage(sent(`${path} which flowers are these?`, 'p1'));
    (view as unknown as Internals).apply({
      available: true,
      status: 'busy',
      messages: [
        earlier,
        { id: 'u1', role: 'user', text: 'which flowers are these?', timestamp: now() },
      ],
    });
    await view.updateComplete;
    expect(sending(view)).toHaveLength(0);
  });

  it('takes no older message for it, give or take the clocks', async () => {
    const view = await mountQuiet();
    view.addSentMessage(sent('go on', 'p1'));
    const old = new Date(Date.now() - 60_000).toISOString();
    const internals = view as unknown as Internals;
    internals.apply({
      available: true,
      status: 'idle',
      messages: [earlier, { id: 'u1', role: 'user', text: 'go on', timestamp: old }],
    });
    await view.updateComplete;
    expect(sending(view)).toHaveLength(1);
    // The server's clock a few seconds behind the phone's.
    const skewed = new Date(Date.now() - 4_000).toISOString();
    internals.apply({
      available: true,
      status: 'busy',
      messages: [earlier, { id: 'u2', role: 'user', text: 'go on', timestamp: skewed }],
    });
    await view.updateComplete;
    expect(sending(view)).toHaveLength(0);
  });

  it('says when it could not be sent; a tap on Retry asks for it again, a drag does not', async () => {
    resetAnnouncerForTests();
    const view = await mountQuiet();
    const retries = vi.fn();
    view.addEventListener('chat-message-retry', (e) => retries((e as CustomEvent).detail));
    view.addSentMessage(sent('use pnpm', 'p1'));
    view.markSendFailed({ sessionId: 's1', id: 'p1' });
    await view.updateComplete;
    expect(sending(view)[0]?.getAttribute('data-send')).toBe('failed');
    expect(view.shadowRoot?.querySelector('[data-testid="send-note"]')?.textContent).toContain(
      "Couldn't send"
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(document.querySelector('[data-testid="a11y-live-region"]')?.textContent).toBe(
      "Couldn't send"
    );

    const retry = view.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="send-retry"]');
    if (!retry) throw new Error('no Retry button');
    expect(retry.textContent?.trim()).toBe('Retry');
    const touch = (dy: number) => {
      const at = (y: number) => ({
        pointerType: 'touch',
        pointerId: 7,
        clientX: 200,
        clientY: y,
        bubbles: true,
        composed: true,
      });
      retry.dispatchEvent(new PointerEvent('pointerdown', at(600)));
      retry.dispatchEvent(new PointerEvent('pointerup', at(600 + dy)));
    };
    touch(-80);
    expect(retries).not.toHaveBeenCalled();
    touch(2);
    // The click that follows the tap does not ask a second time.
    retry.click();
    expect(retries).toHaveBeenCalledTimes(1);
    expect(retries).toHaveBeenCalledWith({ sessionId: 's1', id: 'p1' });
    // From the keyboard.
    resetGhostClickGuard();
    retry.click();
    expect(retries).toHaveBeenCalledTimes(2);

    // The composer sends it again: sending, under the same id, no Retry.
    view.addSentMessage(sent('use pnpm', 'p1'));
    await view.updateComplete;
    expect(sending(view).map((row) => row.getAttribute('data-send'))).toEqual(['sending']);
    expect(view.shadowRoot?.querySelector('[data-testid="send-retry"]')).toBeNull();
  });

  it('says "not confirmed" after 30 s without word, with no Retry, until it comes', async () => {
    const view = await mountQuiet();
    vi.useFakeTimers();
    view.addSentMessage(sent('and the temperature?', 'p1'));
    await vi.advanceTimersByTimeAsync(29_000);
    expect(sending(view)[0]?.getAttribute('data-send')).toBe('sending');
    await vi.advanceTimersByTimeAsync(1_000);
    await view.updateComplete;
    expect(sending(view)[0]?.getAttribute('data-send')).toBe('unconfirmed');
    expect(view.shadowRoot?.querySelector('[data-testid="send-note"]')?.textContent?.trim()).toBe(
      'Not confirmed yet'
    );
    expect(view.shadowRoot?.querySelector('[data-testid="send-retry"]')).toBeNull();

    // Claude Code took it once done with what it was doing (a queued message).
    (view as unknown as Internals).apply({
      available: true,
      status: 'busy',
      messages: [
        earlier,
        { id: 'u1', role: 'user', text: 'and the temperature?', timestamp: now() },
      ],
    });
    await view.updateComplete;
    expect(sending(view)).toHaveLength(0);
    expect(view.shadowRoot?.querySelector('[data-testid="send-note"]')).toBeNull();
  });

  it('keeps a message that never came before the one sent after it, not below it', async () => {
    const view = await mountQuiet();
    view.addSentMessage(sent('!ls', 'p1'));
    view.addSentMessage(sent('hello', 'p2'));
    (view as unknown as Internals).apply({
      available: true,
      status: 'idle',
      messages: [
        earlier,
        { id: 'u2', role: 'user', text: 'hello', timestamp: now() },
        { id: 'a2', role: 'assistant', text: 'hey', timestamp: now() },
      ],
    });
    await view.updateComplete;
    const rows = [...(view.shadowRoot?.querySelectorAll('.row') ?? [])].map(
      (row) => `${row.getAttribute('data-send') ?? ''}${row.querySelector('.md')?.textContent}`
    );
    expect(rows).toEqual(['ok', 'sending!ls', 'hello', 'hey']);
  });

  it("logs one timing line per send: its bubble, then Claude's thinking", async () => {
    const view = await mountQuiet();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const lines = () =>
        log.mock.calls.map((args) => args.join(' ')).filter((line) => line.includes('chat timing'));
      view.addSentMessage(sent('hello', 'p1'));
      await view.updateComplete;
      expect(lines()).toEqual([]);
      const internals = view as unknown as Internals;
      internals.apply({ available: true, status: 'busy', messages: [earlier] });
      await view.updateComplete;
      expect(lines()).toHaveLength(1);
      expect(lines()[0]).toMatch(/chat timing: bubble \d+ ms, thinking \d+ ms$/);
      // Later polls while Claude works add nothing.
      internals.apply({
        available: true,
        status: 'busy',
        messages: [earlier, { ...earlier, id: 'x' }],
      });
      await view.updateComplete;
      expect(lines()).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  it('keeps sent messages to their session', async () => {
    const view = await mountQuiet();
    view.addSentMessage(sent('hello', 'p1'));
    view.addSentMessage({ ...sent('another', 'p2'), sessionId: 's2' });
    await view.updateComplete;
    expect(userTexts(view)).toEqual(['ok', 'hello']);

    view.sessionId = 's2';
    await view.updateComplete;
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector('[data-send]')).toBeNull();
    view.sessionId = 's1';
    await view.updateComplete;
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector('[data-send]')).toBeNull();
  });

  it('shows nothing for a session that is not an agent chat (a shell)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ available: false, messages: [] }) }))
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    document.body.appendChild(view);
    await vi.waitFor(() => expect(view.hasAttribute('unavailable')).toBe(true));
    view.addSentMessage(sent('ls', 'p1'));
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector('[data-send]')).toBeNull();
  });
});

describe('ClaudeChatView with the phone keyboard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  const scrolledUp = async () => {
    stubChat([
      { id: '1', role: 'user', text: 'hi' },
      { id: '2', role: 'assistant', text: 'hello' },
    ]);
    const view = await mountChat();
    const scroller = view.shadowRoot?.querySelector<HTMLElement>('.scroller');
    if (!scroller) throw new Error('no scroller');
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 500 });
    scroller.scrollTop = 100;
    scroller.dispatchEvent(new Event('wheel'));
    scroller.dispatchEvent(new Event('scroll'));
    await view.updateComplete;
    return { view, scroller };
  };

  it('followLatest (the composer was focused) brings a scrolled-up conversation to its end', async () => {
    const { view, scroller } = await scrolledUp();
    expect(view.shadowRoot?.querySelector('.jump')).toBeTruthy();

    view.followLatest();
    await view.updateComplete;
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(scroller.scrollTop).toBe(2000);
    expect(view.shadowRoot?.querySelector('.jump')).toBeNull();
  });

  it('stays on the latest message within the same frame when the keyboard resizes it', async () => {
    let onResize: () => void = () => {};
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          onResize = callback;
        }
        observe() {}
        disconnect() {}
      }
    );
    stubChat([{ id: '1', role: 'assistant', text: 'hello' }]);
    const view = await mountChat();
    const scroller = view.shadowRoot?.querySelector<HTMLElement>('.scroller');
    if (!scroller) throw new Error('no scroller');
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1200 });
    scroller.scrollTop = 0;

    onResize();

    // No frame painted with the conversation shifted: followed before the next paint.
    expect(scroller.scrollTop).toBe(1200);
  });
});

describe('ClaudeChatView polling', () => {
  let visibility: DocumentVisibilityState = 'visible';
  const setVisibility = (state: DocumentVisibilityState) => {
    visibility = state;
    document.dispatchEvent(new Event('visibilitychange'));
  };
  const answer = (status: string) =>
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        available: true,
        status,
        messages: [{ id: 'a', role: 'assistant', text: 'hello' }],
      }),
    }));

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function mount() {
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    document.body.appendChild(view);
    return view;
  }

  it('stops while the page is hidden and fetches at once when it is shown', async () => {
    const fetchMock = answer('busy');
    vi.stubGlobal('fetch', fetchMock);
    mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // No poll timer wakes the phone while hidden (it used to every 1.5 s).
    expect(setTimeoutSpy.mock.calls.filter(([, delay]) => delay === 1500)).toHaveLength(0);

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps 1.5 s while Claude works: 40 requests per minute', async () => {
    const fetchMock = answer('busy');
    vi.stubGlobal('fetch', fetchMock);
    mount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(41); // first fetch at 0 s, then every 1.5 s
  });

  it('checks a non-Claude session (a shell in chat mode) only every 5 s', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ available: false, messages: [] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    mount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(13);
  });

  it('polls at once after a send, again at about 300 ms and 800 ms, then at the usual pace', async () => {
    // Otherwise Claude's "thinking" shows a poll after it started: up to 1.5 s late.
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      json: async () => ({ available: true, status: 'idle', messages: [] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const polls = () => fetchMock.mock.calls.filter(([url]) => url.includes('/claude-chat')).length;
    const view = mount();
    await vi.advanceTimersByTimeAsync(700);
    expect(polls()).toBe(1);

    view.addSentMessage({ sessionId: 's1', id: 'p1', text: 'hello', at: Date.now(), startedAt: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(polls()).toBe(2);
    await vi.advanceTimersByTimeAsync(299);
    expect(polls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls()).toBe(3);
    await vi.advanceTimersByTimeAsync(500);
    expect(polls()).toBe(4);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(polls()).toBe(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls()).toBe(5);
  });

  it('polls at once after an answer from the question card too', async () => {
    // Claude's next step should show right after the tap, not with the usual pace.
    const question = {
      id: 'q',
      role: 'tool',
      tool: 'AskUserQuestion',
      text: '',
      question: { text: 'Fruit?', options: ['Apple', 'Pear'] },
    };
    const fetchMock = vi.fn(async (_url: string) =>
      Response.json({
        available: true,
        status: 'waiting',
        waitingFor: 'input needed',
        messages: [question],
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const polls = () => fetchMock.mock.calls.filter(([url]) => url.includes('/claude-chat')).length;
    const view = mount();
    const sent = vi.fn();
    view.addEventListener('claude-chat-input', (e) => sent((e as CustomEvent<string>).detail));
    await vi.advanceTimersByTimeAsync(700);
    await view.updateComplete;
    const before = polls();
    view.shadowRoot?.querySelectorAll<HTMLButtonElement>('.question button')[1]?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveBeenCalledWith('2');
    expect(polls()).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(300);
    expect(polls()).toBe(before + 2);
  });

  it('makes up for the polls a slow answer let pass with one at once', async () => {
    let finish: () => void = () => {};
    let chatCalls = 0;
    const fetchMock = vi.fn((url: string) => {
      const answer = {
        ok: true,
        json: async () => ({ available: true, status: 'idle', messages: [] }),
      };
      return url.includes('/claude-chat') && ++chatCalls === 2
        ? new Promise((resolve) => (finish = () => resolve(answer)))
        : Promise.resolve(answer);
    });
    vi.stubGlobal('fetch', fetchMock);
    const polls = () => fetchMock.mock.calls.filter(([url]) => url.includes('/claude-chat')).length;
    const view = mount();
    await vi.advanceTimersByTimeAsync(100);
    view.addSentMessage({ sessionId: 's1', id: 'p1', text: 'hello', at: Date.now(), startedAt: 0 });
    // The poll sent at once takes 900 ms: both later ones fell due meanwhile.
    await vi.advanceTimersByTimeAsync(900);
    expect(polls()).toBe(2);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(polls()).toBe(3);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(polls()).toBe(3);
  });

  it('slows to 3 s on an idle conversation and comes back on a tap', async () => {
    const fetchMock = answer('idle');
    vi.stubGlobal('fetch', fetchMock);
    mount();
    await vi.advanceTimersByTimeAsync(60_000);
    const firstMinute = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock.mock.calls.length - firstMinute).toBe(20);
    expect(firstMinute).toBeLessThan(41);

    const before = fetchMock.mock.calls.length;
    document.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(before + 1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(before + 2);
  });
});

describe('ClaudeChatView errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('tells whoever shows it that the conversation is gone (404)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'gone' }, { status: 404 }))
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 'gone';
    const errors = vi.fn();
    view.addEventListener('claude-chat-error', (e) => errors((e as CustomEvent<number>).detail));
    document.body.appendChild(view);
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(404));
    expect(view.hasAttribute('unavailable')).toBe(true);
  });
});
