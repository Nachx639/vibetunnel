// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';
import { resetDictationForTests } from '../utils/dictation.js';
import { VoicePlayer } from '../utils/voice-io.js';
import { setVoicePreference } from '../utils/voice-preferences.js';
import {
  type ClaudeChatView,
  resetServerVoiceCheck,
  speechLang,
  speechText,
} from './claude-chat-view.js';

/**
 * The chat and the server's voice status (`voice` = what /api/tts/status answers,
 * `dictation` = /api/dictation/status; by default the server transcribes).
 */
function stub(
  messages: unknown[],
  voice: unknown,
  dictation: unknown = { enabled: true, available: true }
) {
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    json: async () =>
      url.includes('/api/tts/status')
        ? voice
        : url.includes('/api/dictation/status')
          ? dictation
          : { available: true, status: 'idle', messages },
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function mountChat() {
  const view = document.createElement('claude-chat-view') as ClaudeChatView;
  view.sessionId = 's1';
  document.body.appendChild(view);
  await vi.waitFor(() => expect(view.shadowRoot?.querySelector('.row')).toBeTruthy());
  // Let the voice status resolve and the view re-render.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await view.updateComplete;
  return view;
}

function stubSpeechSynthesis() {
  const spoken: Array<{ text: string; lang: string }> = [];
  const synth = {
    speak: vi.fn((u: { text: string; lang: string }) => spoken.push(u)),
    cancel: vi.fn(),
    getVoices: () => [],
  };
  vi.stubGlobal('speechSynthesis', synth);
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      lang = '';
      constructor(public text: string) {}
    }
  );
  return { synth, spoken };
}

const OFF = { enabled: false, available: false, engine: null, engines: [] };

describe('ClaudeChatView voice', () => {
  beforeEach(() => {
    setupLocalStorageMock();
    resetServerVoiceCheck();
    resetDictationForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    resetServerVoiceCheck();
    resetDictationForTests();
    restoreLocalStorage();
  });

  it('offers no read aloud and no voice mode when the server has voice off', async () => {
    const { synth } = stubSpeechSynthesis();
    stub([{ id: 'a', role: 'assistant', text: 'Done.' }], OFF);
    const view = await mountChat();
    const root = view.shadowRoot;
    expect(root?.querySelector('.copy-msg')).toBeTruthy();
    expect(root?.querySelector('.speak-msg')).toBeNull();
    expect(root?.querySelector('.voice-toggle')).toBeNull();
    expect(synth.speak).not.toHaveBeenCalled();
  });

  it('treats an old or failed status answer as off', async () => {
    stubSpeechSynthesis();
    stub([{ id: 'a', role: 'assistant', text: 'Done.' }], { available: true, engine: 'say' });
    const view = await mountChat();
    expect(view.shadowRoot?.querySelector('.speak-msg')).toBeNull();
  });

  it('by default, a server without a voice engine gets no read aloud and no voice mode (no browser speech)', async () => {
    const { synth } = stubSpeechSynthesis();
    stub([{ id: 'a', role: 'assistant', text: 'Done.' }], {
      enabled: true,
      available: false,
      engine: null,
      engines: [],
    });
    const view = await mountChat();
    expect(view.shadowRoot?.querySelector('.speak-msg')).toBeNull();
    expect(view.shadowRoot?.querySelector('.voice-toggle')).toBeNull();
    expect(synth.speak).not.toHaveBeenCalled();
  });

  it('the Voice switch off in Settings hides read aloud and voice mode', async () => {
    setVoicePreference('voice', false);
    stubSpeechSynthesis();
    stub([{ id: 'a', role: 'assistant', text: 'Done.' }], {
      enabled: true,
      available: true,
      engine: 'say',
      engines: ['say'],
    });
    const view = await mountChat();
    expect(view.shadowRoot?.querySelector('.speak-msg')).toBeNull();
    expect(view.shadowRoot?.querySelector('.voice-toggle')).toBeNull();
  });

  it('with a server engine, voice mode needs the server to transcribe too', async () => {
    stubSpeechSynthesis();
    stub(
      [{ id: 'a', role: 'assistant', text: 'Done.' }],
      { enabled: true, available: true, engine: 'say', engines: ['say'] },
      { enabled: true, available: false }
    );
    const view = await mountChat();
    expect(view.shadowRoot?.querySelector('.speak-msg')).toBeTruthy();
    expect(view.shadowRoot?.querySelector('.voice-toggle')).toBeNull();
  });

  it('reads an answer with the browser voice when Browser speech is on and the server has no engine', async () => {
    setVoicePreference('browserSpeech', true);
    const { synth, spoken } = stubSpeechSynthesis();
    stub(
      [
        { id: 'a', role: 'assistant', text: 'Ready, **all** done.\n```js\nx()\n```' },
        { id: 'b', role: 'assistant', text: 'Another answer' },
      ],
      { enabled: true, available: false, engine: null, engines: [] }
    );
    const view = await mountChat();
    const buttons = () => view.shadowRoot?.querySelectorAll<HTMLButtonElement>('.speak-msg') ?? [];
    expect(buttons()).toHaveLength(2);
    expect(view.shadowRoot?.querySelector('.voice-toggle')).toBeTruthy();

    buttons()[0].click();
    await view.updateComplete;
    expect(spoken[0].text).toBe('Ready, all done. (code omitted).');
    expect(buttons()[0].getAttribute('aria-pressed')).toBe('true');

    buttons()[1].click();
    await view.updateComplete;
    expect(synth.cancel).toHaveBeenCalled();
    expect(spoken).toHaveLength(2);

    buttons()[1].click();
    await view.updateComplete;
    expect(spoken).toHaveLength(2);
    expect(buttons()[1].getAttribute('aria-pressed')).toBe('false');
  });

  it("reads with the server's voice when it has an engine", async () => {
    const unlock = vi.spyOn(VoicePlayer.prototype, 'unlock').mockImplementation(() => {});
    let finish: () => void = () => {};
    const speak = vi
      .spyOn(VoicePlayer.prototype, 'speak')
      .mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    const { synth } = stubSpeechSynthesis();
    stub([{ id: 'a', role: 'assistant', text: 'Done.' }], {
      enabled: true,
      available: true,
      engine: 'kokoro',
      engines: ['kokoro'],
    });
    const view = await mountChat();
    const button = () => view.shadowRoot?.querySelector<HTMLButtonElement>('.speak-msg');
    button()?.click();
    expect(unlock).toHaveBeenCalled();
    expect(speak).toHaveBeenCalledWith('Done.', 'en', expect.any(AbortSignal));
    expect(synth.speak).not.toHaveBeenCalled();
    await view.updateComplete;
    expect(button()?.getAttribute('aria-pressed')).toBe('true');
    finish();
    await vi.waitFor(() => expect(button()?.getAttribute('aria-pressed')).toBe('false'));
  });

  it('stops reading when the session changes', async () => {
    setVoicePreference('browserSpeech', true);
    const { synth } = stubSpeechSynthesis();
    stub([{ id: 'a', role: 'assistant', text: 'Done.' }], {
      enabled: true,
      available: false,
      engine: null,
    });
    const view = await mountChat();
    view.shadowRoot?.querySelector<HTMLButtonElement>('.speak-msg')?.click();
    view.sessionId = 's2';
    await view.updateComplete;
    expect(synth.cancel).toHaveBeenCalled();
  });
});

describe('speech helpers', () => {
  it('reads markdown as plain text and tables as lists', () => {
    expect(speechText('# Done\n- run **`ls`** now\n```sh\nrm -rf x\n```\nok', 'code omitted')).toBe(
      'Done run ls now (code omitted). ok'
    );
    expect(speechText('| A | B |\n|---|---|\n| 1 | 2 |', 'code')).toBe('A, B. 1, 2.');
  });

  it('survives a long line of dashes (no catastrophic backtracking)', () => {
    const started = performance.now();
    speechText(`${'-'.repeat(60)} x\n| a |`, 'code');
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('follows the UI language unless the text is clearly another one', () => {
    expect(speechLang('Done: the test passes and the build is fine', 'fr')).toBe('en');
    expect(speechLang('OK', 'fr-FR')).toBe('fr');
    expect(speechLang('OK', 'xx')).toBe('en');
  });
});
