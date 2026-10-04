// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';
import {
  getVoicePreferences,
  setVoicePreference,
  subscribeToVoicePreferences,
} from './voice-preferences.js';

describe('voice preferences', () => {
  beforeEach(() => setupLocalStorageMock());
  afterEach(() => restoreLocalStorage());

  it('default: voice on, browser speech off', () => {
    expect(getVoicePreferences()).toEqual({ voice: true, browserSpeech: false });
  });

  it('stores each switch next to the other app preferences and tells listeners', () => {
    localStorage.setItem('vibetunnel_app_preferences', JSON.stringify({ phoneUi: 'compact' }));
    const listener = vi.fn();
    const stop = subscribeToVoicePreferences(listener);
    setVoicePreference('voice', false);
    setVoicePreference('browserSpeech', true);
    expect(getVoicePreferences()).toEqual({ voice: false, browserSpeech: true });
    expect(JSON.parse(localStorage.getItem('vibetunnel_app_preferences') ?? '{}')).toEqual({
      phoneUi: 'compact',
      voice: false,
      browserSpeech: true,
    });
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });

  it('unreadable storage means the defaults', () => {
    localStorage.setItem('vibetunnel_app_preferences', '{not json');
    expect(getVoicePreferences()).toEqual({ voice: true, browserSpeech: false });
  });
});
