import { APP_PREFERENCES_STORAGE_KEY } from './phone-ui.js';

/**
 * Per-browser voice switches (Settings > Application), stored in localStorage
 * `vibetunnel_app_preferences`:
 * - `voice` (default on): dictation, Read aloud and Voice mode with the server's local speech
 *   tools (whisper.cpp; Kokoro, Piper or macOS `say`). Each control shows only when the server
 *   has the tool it needs, and the server can turn them all off with `"voice": false`.
 * - `browserSpeech` (default off): when the server lacks a tool, fall back to the browser's own
 *   speech recognition and voices. Off by default because Chrome's recognizer (and its network
 *   voices) send the audio or the text to Google.
 */
export interface VoicePreferences {
  voice: boolean;
  browserSpeech: boolean;
}

export const VOICE_PREFERENCES_CHANGED_EVENT = 'vibetunnel-voice-preferences-changed';

function readPreferences(): Record<string, unknown> {
  try {
    const stored = localStorage.getItem(APP_PREFERENCES_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function getVoicePreferences(): VoicePreferences {
  const stored = readPreferences();
  return { voice: stored.voice !== false, browserSpeech: stored.browserSpeech === true };
}

export function setVoicePreference<K extends keyof VoicePreferences>(
  key: K,
  value: VoicePreferences[K]
): void {
  try {
    localStorage.setItem(
      APP_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ ...readPreferences(), [key]: value })
    );
  } catch {
    // Storage can be unavailable in private browsing; the choice then lasts for this page.
  }
  window.dispatchEvent(new CustomEvent(VOICE_PREFERENCES_CHANGED_EVENT));
}

/** Calls `listener` whenever a voice switch changes; returns the unsubscribe. */
export function subscribeToVoicePreferences(listener: () => void): () => void {
  window.addEventListener(VOICE_PREFERENCES_CHANGED_EVENT, listener);
  return () => window.removeEventListener(VOICE_PREFERENCES_CHANGED_EVENT, listener);
}
