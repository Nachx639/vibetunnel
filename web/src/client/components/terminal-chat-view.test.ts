// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { SentChatMessage, SentChatMessageRef } from './claude-chat-view.js';
import { TerminalChatView } from './terminal-chat-view.js';

describe('TerminalChatView', () => {
  let component: TerminalChatView;

  beforeEach(async () => {
    component = new TerminalChatView();
    document.body.append(component);
    await component.updateComplete;
  });

  afterEach(() => {
    component.remove();
    vi.useRealTimers();
  });

  it('enables native autocorrect for its delta-reconciling input', () => {
    const input = component.shadowRoot?.querySelector<HTMLInputElement>('#chat-input-field');

    expect(input?.getAttribute('autocorrect')).toBe('on');
    expect(input?.getAttribute('spellcheck')).toBe('false');
    expect(input?.getAttribute('autocapitalize')).toBe('off');
  });

  it('reconciles a corrected word with terminal backspaces', () => {
    const onSend = vi.fn();
    component.onSend = onSend;
    const input = component.shadowRoot?.querySelector<HTMLInputElement>('#chat-input-field');
    expect(input).not.toBeNull();

    if (!input) return;
    input.value = 'git chek';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    input.value = 'git check';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));

    expect(onSend).toHaveBeenNthCalledWith(1, 'git chek');
    expect(onSend).toHaveBeenNthCalledWith(2, '\x7fck');
  });

  it('preserves identical repeated output lines', () => {
    const testComponent = component as unknown as {
      processTerminalOutput(data: string): void;
      messages: Array<{ content: string }>;
    };

    testComponent.processTerminalOutput('same line\nsame line');

    expect(testComponent.messages).toHaveLength(1);
    expect(testComponent.messages[0].content).toBe('same line\nsame line');
  });

  it('replaces the terminal output subscription when its source changes', async () => {
    const firstUnsubscribe = vi.fn();
    const secondUnsubscribe = vi.fn();
    const firstSubscribe = vi.fn(() => firstUnsubscribe);
    const secondSubscribe = vi.fn(() => secondUnsubscribe);

    component.active = true;
    component.subscribeToOutput = firstSubscribe;
    await component.updateComplete;
    component.subscribeToOutput = secondSubscribe;
    await component.updateComplete;

    expect(firstSubscribe).toHaveBeenCalledOnce();
    expect(firstUnsubscribe).toHaveBeenCalledOnce();
    expect(secondSubscribe).toHaveBeenCalledOnce();

    component.remove();
    expect(secondUnsubscribe).toHaveBeenCalledOnce();
  });

  it('only listens to terminal output while chat mode is active', async () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    component.subscribeToOutput = subscribe;
    await component.updateComplete;

    expect(subscribe).not.toHaveBeenCalled();

    component.active = true;
    await component.updateComplete;
    expect(subscribe).toHaveBeenCalledOnce();

    component.active = false;
    await component.updateComplete;
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('keeps only the tail of very long output in a message', () => {
    const testComponent = component as unknown as {
      processTerminalOutput(data: string): void;
      messages: Array<{ content: string }>;
    };

    for (let i = 0; i < 3000; i++)
      testComponent.processTerminalOutput(`line ${i} ${'x'.repeat(20)}`);

    expect(testComponent.messages).toHaveLength(1);
    expect(testComponent.messages[0].content.length).toBeLessThanOrEqual(20_000);
    expect(testComponent.messages[0].content.endsWith(`line 2999 ${'x'.repeat(20)}`)).toBe(true);
  });

  it('renders only the input bar and ignores output as a composer', async () => {
    const subscribe = vi.fn(() => vi.fn());
    component.composerOnly = true;
    component.subscribeToOutput = subscribe;
    component.active = true;
    await component.updateComplete;

    expect(component.shadowRoot?.querySelector('.chat-messages-container')).toBeNull();
    expect(component.shadowRoot?.querySelector('#chat-input-field')).not.toBeNull();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('suggests Claude Code slash commands in the composer', async () => {
    component.composerOnly = true;
    component.active = true;
    await component.updateComplete;
    const input = component.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field');
    if (!input) throw new Error('composer not rendered');

    input.value = '/co';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await component.updateComplete;
    const options = [...(component.shadowRoot?.querySelectorAll('.slash-list strong') ?? [])].map(
      (el) => el.textContent
    );
    expect(options).toEqual(['/compact', '/context', '/cost', '/config']);

    component.shadowRoot?.querySelector<HTMLButtonElement>('.slash-list button')?.click();
    await component.updateComplete;
    expect(input.value).toBe('/compact ');
    expect(component.shadowRoot?.querySelector('.slash-list')).toBeNull();
  });

  it('keeps IME confirmations and other sessions out of a composer send', async () => {
    const onSend = vi.fn();
    component.onSend = onSend;
    component.composerOnly = true;
    component.sessionId = 'a';
    component.active = true;
    await component.updateComplete;
    const input = component.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field');
    if (!input) throw new Error('composer not rendered');

    input.value = 'にほん';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }));
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe('にほん');

    component.sessionId = 'b';
    await component.updateComplete;
    expect(input.value).toBe('');
  });

  it('keeps each session its own unsent draft and forgets it once sent', async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    });
    const onSend = vi.fn();
    component.onSend = onSend;
    component.composerOnly = true;
    component.sessionId = 'draft-a';
    component.active = true;
    await component.updateComplete;
    const input = component.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field');
    if (!input) throw new Error('composer not rendered');

    input.value = 'half a thought';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    component.sessionId = 'draft-b';
    await component.updateComplete;
    expect(input.value).toBe('');

    component.sessionId = 'draft-a';
    await component.updateComplete;
    expect(input.value).toBe('half a thought');

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    component.sessionId = 'draft-b';
    await component.updateComplete;
    component.sessionId = 'draft-a';
    await component.updateComplete;
    expect(onSend).toHaveBeenCalledWith('half a thought');
    expect(input.value).toBe('');
    vi.unstubAllGlobals();
  });

  it('tells the chat view about a message the moment it is sent, before typing it', async () => {
    vi.useFakeTimers();
    const onSend = vi.fn();
    component.onSend = onSend;
    component.composerOnly = true;
    component.active = true;
    component.sessionId = 's1';
    await component.updateComplete;
    const sent = vi.fn();
    component.addEventListener('chat-message-sent', (e) => sent((e as CustomEvent).detail));
    const input = component.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field');
    if (!input) throw new Error('composer not rendered');

    input.value = 'fix the login';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(sent).toHaveBeenCalledOnce();
    expect(sent.mock.calls[0][0]).toEqual({
      sessionId: 's1',
      id: expect.any(String),
      text: 'fix the login',
      at: expect.any(Number),
      startedAt: expect.any(Number),
    });
    // Its Enter is still to come.
    expect(onSend.mock.calls).toEqual([['fix the login']]);
    await vi.advanceTimersByTimeAsync(100);
    expect(onSend.mock.calls).toEqual([['fix the login'], ['\r']]);
  });

  it('cancels delayed terminal sync when chat mode is deactivated', async () => {
    vi.useFakeTimers();
    const getTerminalInputLine = vi.fn(() => '');
    component.getTerminalInputLine = getTerminalInputLine;
    component.active = true;
    await component.updateComplete;

    const callsBeforeDeactivation = getTerminalInputLine.mock.calls.length;
    component.active = false;
    await component.updateComplete;
    await vi.advanceTimersByTimeAsync(500);

    expect(getTerminalInputLine).toHaveBeenCalledTimes(callsBeforeDeactivation);
  });
  it("takes a hardware key's character when nothing had the focus, and the focus with it", async () => {
    component.composerOnly = true;
    component.active = true;
    component.sessionId = 's1';
    await component.updateComplete;
    expect(component.typeFromKeyboard('h')).toBe(true);
    component.typeFromKeyboard('i');
    const input = component.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field');
    expect(input?.value).toBe('hi');
    expect(component.shadowRoot?.activeElement).toBe(input);
  });

  it('writes the keys that follow until they pause, which iOS would drop meanwhile', async () => {
    // Without this, "Reply" typed with nothing focused reached the composer as "R".
    vi.useFakeTimers();
    component.composerOnly = true;
    component.active = true;
    component.sessionId = 's1';
    await component.updateComplete;
    const input = component.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field');
    if (!input) throw new Error('no composer');
    const key = (k: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', {
        key: k,
        bubbles: true,
        cancelable: true,
        ...init,
      });
      input.dispatchEvent(event);
      return event.defaultPrevented;
    };
    component.typeFromKeyboard('R');
    for (const k of 'esx') expect(key(k)).toBe(true);
    expect(key('Backspace')).toBe(true);
    expect(input.value).toBe('Res');
    // Option makes characters ("@" on some layouts); Cmd makes shortcuts.
    expect(key('@', { altKey: true })).toBe(true);
    expect(key('a', { metaKey: true })).toBe(false);
    expect(key('Backspace')).toBe(true);
    expect(input.value).toBe('Res');
    await vi.advanceTimersByTimeAsync(1500);
    expect(key('p')).toBe(true);
    expect(input.value).toBe('Resp');
    // A pause: iOS writes again, the composer leaves it.
    await vi.advanceTimersByTimeAsync(2500);
    expect(key('o')).toBe(false);
    expect(input.value).toBe('Resp');
    vi.useRealTimers();
  });

  describe('sending from the composer', () => {
    let onSend: Mock<(data: string) => unknown>;
    let sent: Mock<(detail: SentChatMessage) => void>;
    let failed: Mock<(detail: SentChatMessageRef) => void>;
    const input = () =>
      component.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field') as
        | HTMLTextAreaElement
        | undefined;

    beforeEach(async () => {
      vi.useFakeTimers();
      onSend = vi.fn();
      sent = vi.fn();
      failed = vi.fn();
      component.onSend = onSend as (data: string) => void;
      component.composerOnly = true;
      component.active = true;
      component.sessionId = 's1';
      component.addEventListener('chat-message-sent', (e) => sent((e as CustomEvent).detail));
      component.addEventListener('chat-message-failed', (e) => failed((e as CustomEvent).detail));
      await component.updateComplete;
    });

    it('types image paths shell-quoted in a write of their own, then the text, then Enter', async () => {
      component.attachmentUploader = (file) =>
        Promise.resolve({ path: `/tmp/up loads/${file.name}` });
      component.addAttachments([new File([new Uint8Array([1])], 'a;b.png', { type: 'image/png' })]);
      await vi.advanceTimersByTimeAsync(0);
      await component.updateComplete;
      const box = input();
      if (!box) throw new Error('composer not rendered');
      box.value = 'what is this?';
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await vi.advanceTimersByTimeAsync(200);
      expect(onSend.mock.calls).toEqual([["'/tmp/up loads/a;b.png'"], [' what is this?'], ['\r']]);
      expect(sent.mock.calls[0][0].text).toBe("'/tmp/up loads/a;b.png' what is this?");
    });

    it('says a message did not go when its write fails, and Retry sends it again', async () => {
      onSend.mockImplementationOnce(() => Promise.reject(new Error('offline')));
      const box = input();
      if (!box) throw new Error('composer not rendered');
      box.value = 'use pnpm';
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await vi.advanceTimersByTimeAsync(200);
      const id = sent.mock.calls[0][0].id;
      expect(failed).toHaveBeenCalledWith({ sessionId: 's1', id });

      box.value = 'next message';
      component.resendMessage({ sessionId: 's2', id });
      expect(sent).toHaveBeenCalledOnce();
      component.resendMessage({ sessionId: 's1', id });
      await vi.advanceTimersByTimeAsync(200);
      // The same bubble, sent again; what is being written stays in the box.
      expect(sent).toHaveBeenCalledTimes(2);
      expect(sent.mock.calls[1][0].id).toBe(id);
      expect(onSend.mock.calls.slice(-2)).toEqual([['use pnpm'], ['\r']]);
      expect(box.value).toBe('next message');
    });

    it('sends nothing while an image is still uploading, and says why', async () => {
      component.attachmentUploader = () => new Promise(() => {});
      component.addAttachments([new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })]);
      await component.updateComplete;
      const box = input();
      if (!box) throw new Error('composer not rendered');
      box.value = 'look';
      (component as unknown as { handleSend(): void }).handleSend();
      await component.updateComplete;
      expect(onSend).not.toHaveBeenCalled();
      expect(
        component.shadowRoot?.querySelector('[data-testid="composer-note"]')?.textContent
      ).toBeTruthy();
    });
  });

  describe('quick prompts', () => {
    const chips = () => [
      ...(component.shadowRoot?.querySelectorAll<HTMLButtonElement>('.quick-prompt:not(.edit)') ??
        []),
    ];
    const chip = (label: string) => {
      const found = chips().find((el) => el.textContent?.trim() === label);
      if (!found) throw new Error(`no chip ${label}`);
      return found;
    };
    const touchTap = (el: HTMLElement) => {
      const down = new PointerEvent('pointerdown', { pointerType: 'touch', cancelable: true });
      el.dispatchEvent(down);
      el.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true }));
      el.click();
      return down;
    };

    afterEach(() => vi.unstubAllGlobals());

    beforeEach(async () => {
      component.composerOnly = true;
      component.active = true;
      await component.updateComplete;
    });

    it('sends a prompt on the first touch, once, like typing it and pressing send', async () => {
      vi.useFakeTimers();
      const onSend = vi.fn();
      component.onSend = onSend;
      expect(chips().map((el) => el.textContent?.trim())).toEqual([
        'Continue',
        'Yes',
        'Explain that',
        'Run the tests',
        'Fix…',
        '/compact',
      ]);

      const down = touchTap(chip('/compact'));
      await vi.advanceTimersByTimeAsync(100);

      expect(down.defaultPrevented).toBe(true);
      expect(onSend.mock.calls).toEqual([['/compact'], ['\r']]);
    });

    it('puts a template prompt in the field to finish instead of sending it', async () => {
      const onSend = vi.fn();
      component.onSend = onSend;
      const input = component.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field');

      touchTap(chip('Fix…'));
      await component.updateComplete;

      expect(onSend).not.toHaveBeenCalled();
      expect(input?.value).toBe('Fix ');
      expect(chips()).toHaveLength(0);
    });

    it('stays out of the way while typing and for sessions that are not Claude Code', async () => {
      const input = component.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field');
      if (!input) throw new Error('composer not rendered');
      input.value = 'hello';
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await component.updateComplete;
      expect(chips()).toHaveLength(0);

      input.value = '';
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await component.updateComplete;
      expect(chips().length).toBeGreaterThan(0);

      component.claudeSession = false;
      await component.updateComplete;
      expect(chips()).toHaveLength(0);
    });

    it('edits, reorders and keeps a custom list per device after a long press', async () => {
      vi.useFakeTimers();
      const stored = new Map<string, string>();
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
      });
      const onSend = vi.fn();
      component.onSend = onSend;
      const held = chip('Yes');
      held.dispatchEvent(
        new PointerEvent('pointerdown', { pointerType: 'touch', cancelable: true })
      );
      await vi.advanceTimersByTimeAsync(600);
      held.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch' }));
      held.click();
      await vi.advanceTimersByTimeAsync(100);
      expect(onSend).not.toHaveBeenCalled();

      const editor = () => component.shadowRoot?.querySelector('.prompt-editor');
      const rows = () => [...(editor()?.querySelectorAll('li') ?? [])];
      expect(rows()).toHaveLength(6);
      rows()[0].querySelector<HTMLButtonElement>('.prompt-remove')?.click();
      await component.updateComplete;
      editor()?.querySelector<HTMLButtonElement>('.prompt-add')?.click();
      await component.updateComplete;
      const added = rows()[rows().length - 1];
      const [label, text] = [...added.querySelectorAll('input')];
      label.value = 'Commit';
      label.dispatchEvent(new InputEvent('input'));
      text.value = 'Commit the changes';
      text.dispatchEvent(new InputEvent('input'));
      added.querySelector<HTMLButtonElement>('[aria-label="Move up"]')?.click();
      await component.updateComplete;
      editor()?.querySelector<HTMLButtonElement>('.save')?.click();
      await component.updateComplete;

      expect(editor()).toBeNull();
      const expected = ['Yes', 'Explain that', 'Run the tests', 'Fix…', 'Commit', '/compact'];
      expect(chips().map((el) => el.textContent?.trim())).toEqual(expected);
      const reloaded = new TerminalChatView();
      reloaded.composerOnly = true;
      document.body.append(reloaded);
      await reloaded.updateComplete;
      const reloadedLabels = [
        ...(reloaded.shadowRoot?.querySelectorAll('.quick-prompt:not(.edit)') ?? []),
      ].map((el) => el.textContent?.trim());
      expect(reloadedLabels).toEqual(expected);
      reloaded.remove();

      chip('Commit').dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch' }));
      await vi.advanceTimersByTimeAsync(100);
      expect(onSend.mock.calls).toEqual([['Commit the changes'], ['\r']]);
      await vi.advanceTimersByTimeAsync(1000);

      component.shadowRoot
        ?.querySelector<HTMLButtonElement>('[data-testid="edit-quick-prompts"]')
        ?.click();
      await component.updateComplete;
      editor()?.querySelector<HTMLButtonElement>('.prompt-reset')?.click();
      await component.updateComplete;
      expect(chips()).toHaveLength(6);
      expect([...stored.keys()]).toEqual([]);
    });

    it('ignores a touch that scrolled the row, from a chip or the pencil', async () => {
      const onSend = vi.fn();
      component.onSend = onSend;
      const pencil = component.shadowRoot?.querySelector(
        '[data-testid="edit-quick-prompts"]'
      ) as HTMLElement;
      // Composed, as a browser's: the document sees where the finger went down.
      const touch = (el: Element, toX: number) => {
        const at = (x: number) => ({
          pointerType: 'touch',
          pointerId: 7,
          clientX: x,
          bubbles: true,
          cancelable: true,
          composed: true,
        });
        el.dispatchEvent(new PointerEvent('pointerdown', at(100)));
        el.dispatchEvent(new PointerEvent('pointerup', at(toX)));
      };
      touch(chip('Continue'), 40);
      touch(pencil, 40);
      await component.updateComplete;
      expect(onSend).not.toHaveBeenCalled();
      expect(component.shadowRoot?.querySelector('.prompt-editor')).toBeNull();

      touch(pencil, 102);
      await component.updateComplete;
      expect(component.shadowRoot?.querySelector('.prompt-editor')).not.toBeNull();
    });
  });
});
