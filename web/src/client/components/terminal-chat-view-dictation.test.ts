// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';
import { resetDictationForTests } from '../utils/dictation.js';
import { setVoicePreference } from '../utils/voice-preferences.js';
import { TerminalChatView } from './terminal-chat-view.js';

function stubStatus(body: unknown) {
  const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify(body)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function mount(active: boolean) {
  const component = new TerminalChatView();
  component.active = active;
  document.body.append(component);
  await component.updateComplete;
  // Let the status request resolve and the view re-render.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await component.updateComplete;
  return component;
}

const mic = (component: TerminalChatView) =>
  component.shadowRoot?.querySelector('[data-testid="dictate-button"]');

describe('TerminalChatView dictation', () => {
  let component: TerminalChatView | null = null;

  beforeEach(() => setupLocalStorageMock());
  afterEach(() => {
    component?.remove();
    component = null;
    resetDictationForTests();
    vi.unstubAllGlobals();
    restoreLocalStorage();
  });

  it('shows no mic when the server has "voice": false', async () => {
    stubStatus({ enabled: false, available: false });
    component = await mount(true);
    expect(mic(component)).toBeNull();
  });

  it('shows no mic when the status request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 }))
    );
    component = await mount(true);
    expect(mic(component)).toBeNull();
  });

  it('does not ask the server while chat mode is hidden', async () => {
    const fetchMock = stubStatus({ enabled: true, available: true });
    component = await mount(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mic(component)).toBeNull();
  });

  it('shows the mic by default when the server transcribes (whisper.cpp installed)', async () => {
    stubStatus({ enabled: true, available: true });
    component = await mount(true);
    expect(mic(component)?.getAttribute('aria-label')).toBe('Dictate (speech to text)');
  });

  it('shows no mic when the server cannot transcribe, unless Browser speech is on', async () => {
    vi.stubGlobal('webkitSpeechRecognition', class {});
    stubStatus({ enabled: true, available: false });
    component = await mount(true);
    expect(mic(component)).toBeNull();
    component.remove();

    setVoicePreference('browserSpeech', true);
    resetDictationForTests();
    component = await mount(true);
    expect(mic(component)).toBeTruthy();
  });

  it('shows no mic with the Voice switch off in Settings', async () => {
    setVoicePreference('voice', false);
    stubStatus({ enabled: true, available: true });
    component = await mount(true);
    expect(mic(component)).toBeNull();
  });

  it('types dictated text through the same delta path as the keyboard', async () => {
    stubStatus({ enabled: true, available: true });
    component = await mount(true);
    const onSend = vi.fn();
    const onPending = vi.fn();
    component.onSend = onSend;
    component.onPendingInputChange = onPending;
    const input = component.shadowRoot?.querySelector<HTMLInputElement>('#chat-input-field');
    if (!input) throw new Error('no input');
    input.value = 'git';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    const controller = (
      component as unknown as { dictationController: { options: { setText(v: string): void } } }
    ).dictationController;
    controller.options.setText('git status');
    expect(input.value).toBe('git status');
    expect(onSend).toHaveBeenLastCalledWith(' status');
    expect(onPending).toHaveBeenLastCalledWith('git status');
  });

  it('cancels a running dictation when the session changes or chat mode closes', async () => {
    stubStatus({ enabled: true, available: true });
    component = await mount(true);
    const controller = (component as unknown as { dictationController: { cancel(): void } })
      .dictationController;
    const cancel = vi.spyOn(controller, 'cancel');
    component.sessionId = 'two';
    await component.updateComplete;
    expect(cancel).toHaveBeenCalledTimes(1);
    component.active = false;
    await component.updateComplete;
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("in the agent composer the mic takes the hide-keyboard button's place", async () => {
    stubStatus({ enabled: true, available: true });
    const view = new TerminalChatView();
    view.composerOnly = true;
    view.active = true;
    component = view;
    document.body.append(view);
    await view.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await view.updateComplete;
    expect(mic(view)).toBeTruthy();
    expect(view.shadowRoot?.querySelector('.keyboard-dismiss-button:not(.mic-button)')).toBeNull();
    const onSend = vi.fn();
    view.onSend = onSend;
    const controller = (
      view as unknown as { dictationController: { options: { setText(v: string): void } } }
    ).dictationController;
    controller.options.setText('fix the failing test');
    const input = view.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field');
    expect(input?.value).toBe('fix the failing test');
    // The composer keeps the message local until send.
    expect(onSend).not.toHaveBeenCalled();
  });

  it('keeps the hide-keyboard button in the composer when voice is off', async () => {
    stubStatus({ enabled: false, available: false });
    const view = new TerminalChatView();
    view.composerOnly = true;
    view.active = true;
    component = view;
    document.body.append(view);
    await view.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await view.updateComplete;
    expect(mic(view)).toBeNull();
    expect(view.shadowRoot?.querySelector('.keyboard-dismiss-button')).toBeTruthy();
  });
});
