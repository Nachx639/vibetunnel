// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_MARKS_BELOW_PX, type AskClaudeBox } from './ask-claude-box';

describe('ask-claude-box', () => {
  const store = new Map<string, string>();

  beforeAll(async () => {
    await import('./ask-claude-box');
  });

  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockImplementation((key) => store.get(key) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
      store.set(key, value);
    });
    vi.mocked(localStorage.removeItem).mockImplementation((key) => {
      store.delete(key);
    });
  });

  afterEach(() => {
    store.clear();
    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.setItem).mockReset();
    vi.mocked(localStorage.removeItem).mockReset();
  });

  const type = (box: AskClaudeBox, text: string) => {
    const input = box.querySelector('textarea') as HTMLTextAreaElement;
    input.value = text;
    input.dispatchEvent(new Event('input'));
  };

  it('keeps an unsent question as a draft for the next visit', async () => {
    const box = await fixture<AskClaudeBox>(html`<ask-claude-box></ask-claude-box>`);
    type(box, 'half a question');
    box.remove();

    const again = await fixture<AskClaudeBox>(html`<ask-claude-box></ask-claude-box>`);
    expect((again.querySelector('textarea') as HTMLTextAreaElement).value).toBe('half a question');
  });

  it("shows the folder's own name, keeping the whole path for its label", async () => {
    const box = await fixture<AskClaudeBox>(
      html`<ask-claude-box folder="~/projects/web-app"></ask-claude-box>`
    );
    const chip = box.querySelector('[data-testid="ask-claude-folder"]') as HTMLButtonElement;
    expect(chip.querySelector('bdi')?.textContent).toBe('web-app');
    expect(chip.getAttribute('aria-label')).toContain('~/projects/web-app');
    const { folderName } = await import('./ask-claude-box');
    expect([
      folderName('~'),
      folderName('/'),
      folderName('~/Projects/'),
      folderName('/opt/x'),
    ]).toEqual(['~', '/', 'Projects', 'x']);
  });

  it('sends on a touch pointerup once, ignoring the trailing click, and clears the field', async () => {
    const box = await fixture<AskClaudeBox>(html`<ask-claude-box folder="/work"></ask-claude-box>`);
    const asked = vi.fn();
    box.addEventListener('ask-claude', (e) => asked((e as CustomEvent).detail.text));
    type(box, '  fix the build  ');
    await box.updateComplete;

    const send = box.querySelector('[data-testid="ask-claude-send"]') as HTMLButtonElement;
    send.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true }));
    send.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(asked.mock.calls).toEqual([['fix the build']]);
    expect((box.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
    expect(store.has('vt-ask-claude-draft')).toBe(false);
  });

  it('sends nothing at the end of a scroll that started on Send; a still tap sends', async () => {
    const box = await fixture<AskClaudeBox>(html`<ask-claude-box folder="/work"></ask-claude-box>`);
    const asked = vi.fn();
    box.addEventListener('ask-claude', (e) => asked((e as CustomEvent).detail.text));
    type(box, 'fix the build');
    await box.updateComplete;

    const send = box.querySelector('[data-testid="ask-claude-send"]') as HTMLButtonElement;
    // iOS ends a scroll of the list that began on the button with a pointerup on it.
    const touch = (dy: number) => {
      const at = (y: number) => ({
        pointerType: 'touch',
        pointerId: 7,
        clientX: 40,
        clientY: y,
        bubbles: true,
      });
      send.dispatchEvent(new PointerEvent('pointerdown', at(300)));
      send.dispatchEvent(new PointerEvent('pointerup', at(300 + dy)));
    };
    touch(-100);
    expect(asked).not.toHaveBeenCalled();
    touch(2);
    send.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(asked.mock.calls).toEqual([['fix the build']]);
  });

  it('grows to the text without counting its padding twice (no blank line)', async () => {
    const box = await fixture<AskClaudeBox>(html`<ask-claude-box></ask-claude-box>`);
    const input = box.querySelector('textarea') as HTMLTextAreaElement;
    input.style.boxSizing = 'content-box';
    input.style.padding = '12px';
    // One line of text: 22 px of content + 24 px of padding.
    Object.defineProperty(input, 'scrollHeight', { configurable: true, get: () => 46 });
    type(box, 'h');
    expect(input.style.height).toBe('22px');
  });

  it('asks Codex once picked, and remembers the pick', async () => {
    const box = await fixture<AskClaudeBox>(html`<ask-claude-box></ask-claude-box>`);
    const textarea = () => box.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea().placeholder).toBe('Ask Claude…');
    const codex = box.querySelector('[data-testid="ask-agent-codex"]') as HTMLButtonElement;
    codex.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await box.updateComplete;
    expect(codex.getAttribute('aria-checked')).toBe('true');
    expect(textarea().placeholder).toBe('Ask Codex…');
    expect(store.get('vt-ask-agent')).toBe('codex');

    const asked = vi.fn();
    box.addEventListener('ask-claude', (e) => asked((e as CustomEvent).detail));
    type(box, 'hello');
    box.send();
    expect(asked).toHaveBeenCalledWith({ text: 'hello', agent: 'codex' });

    box.remove();
    const again = await fixture<AskClaudeBox>(html`<ask-claude-box></ask-claude-box>`);
    expect((again.querySelector('textarea') as HTMLTextAreaElement).placeholder).toBe('Ask Codex…');
  });

  // A short row (a 320 pt phone) shows the agents' marks so the folder chip keeps its name
  // readable. One or the other is rendered, never both: with a stylesheet from another build a
  // CSS-only swap showed the mark stacked over the name.
  const setRoom = async (box: AskClaudeBox, width: number) => {
    (box as unknown as { applyStartWidth(width: number): void }).applyStartWidth(width);
    await box.updateComplete;
  };

  it('names each agent, and only names, when the row has room', async () => {
    const box = await fixture<AskClaudeBox>(html`<ask-claude-box></ask-claude-box>`);
    for (const width of [AGENT_MARKS_BELOW_PX, 244, 294]) {
      await setRoom(box, width);
      expect(box.querySelector('.ask-claude-agent')?.classList.contains('marks')).toBe(false);
      for (const [agent, name] of [
        ['claude', 'Claude'],
        ['codex', 'Codex'],
      ]) {
        const button = box.querySelector(`[data-testid="ask-agent-${agent}"]`) as HTMLElement;
        expect(button.getAttribute('role')).toBe('radio');
        expect(button.getAttribute('aria-label')).toBe(name);
        expect(button.querySelector('.ask-agent-name')?.textContent).toBe(name);
        expect(button.querySelector('.ask-agent-mark')).toBeNull();
      }
    }
  });

  it('shows only the marks when the row leaves the folder chip too little', async () => {
    const box = await fixture<AskClaudeBox>(html`<ask-claude-box></ask-claude-box>`);
    await setRoom(box, 191);
    expect(box.querySelector('.ask-claude-agent')?.classList.contains('marks')).toBe(true);
    for (const [agent, name] of [
      ['claude', 'Claude'],
      ['codex', 'Codex'],
    ]) {
      const button = box.querySelector(`[data-testid="ask-agent-${agent}"]`) as HTMLElement;
      expect(button.getAttribute('aria-label')).toBe(name);
      expect(button.querySelector('.ask-agent-mark svg')).not.toBeNull();
      expect(button.querySelector('.ask-agent-mark')?.getAttribute('aria-hidden')).toBe('true');
      expect(button.querySelector('.ask-agent-name')).toBeNull();
      expect(button.textContent?.trim()).toBe('');
    }
    // And back when the row widens (a rotation).
    await setRoom(box, 300);
    expect(box.querySelectorAll('.ask-agent-mark').length).toBe(0);
    expect(box.querySelectorAll('.ask-agent-name').length).toBe(2);
  });

  it('leaves the choice to the markup, not to the stylesheet', () => {
    const css = readFileSync(join(__dirname, '../styles.css'), 'utf8');
    expect(css).not.toMatch(/@container ask-start/);
    expect(css).not.toMatch(/\.ask-agent-(mark|name) \{\s*display: none;/);
  });

  it('tightens its spacing only inside the tight phone list', () => {
    const css = readFileSync(join(__dirname, '../styles.css'), 'utf8');
    expect(css).toMatch(/\.phone-list-tight \.ask-claude \{[^}]*margin-bottom: 8px/);
    // The box's own rule keeps its spacing everywhere else.
    expect(css).not.toMatch(/(^|\n)\.ask-claude \{[^}]*margin-bottom: 8px/);
  });

  it('gives the question back when the session could not start', async () => {
    const box = await fixture<AskClaudeBox>(html`<ask-claude-box></ask-claude-box>`);
    type(box, 'hello');
    box.send();
    box.restore('hello');
    await box.updateComplete;
    expect((box.querySelector('textarea') as HTMLTextAreaElement).value).toBe('hello');
  });
});
