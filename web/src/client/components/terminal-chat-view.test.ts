// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('opens a conversation at its latest message without animating down to it', async () => {
    const container = component.shadowRoot?.querySelector<HTMLElement>('.chat-messages-container');
    expect(container).not.toBeNull();
    // A smooth scroll-behavior turned the first scroll to the bottom into a ride through the
    // whole conversation.
    expect(container && getComputedStyle(container).scrollBehavior).not.toBe('smooth');
    const styles = [TerminalChatView.styles].flat() as unknown as Array<{ cssText: string }>;
    expect(styles.map((sheet) => sheet.cssText).join('')).not.toMatch(/scroll-behavior:\s*smooth/);
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
});
