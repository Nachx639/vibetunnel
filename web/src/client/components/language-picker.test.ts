// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';
import { getLocale, getLocalePreference, setLocale } from '../i18n/index.js';
import './language-picker.js';
import type { LanguagePicker } from './language-picker.js';

describe('language-picker', () => {
  beforeEach(async () => {
    setupLocalStorageMock();
    await setLocale('en');
    localStorage.removeItem('vibetunnel_locale');
  });

  afterEach(async () => {
    await setLocale('en');
    restoreLocalStorage();
    vi.restoreAllMocks();
  });

  it('offers Automatic plus the eight languages, each in its own name', async () => {
    const el = await fixture<LanguagePicker>(html`<language-picker></language-picker>`);
    const options = Array.from(el.querySelectorAll('option'));
    expect(options.map((o) => o.value)).toEqual([
      'auto',
      'en',
      'zh-CN',
      'hi',
      'es',
      'fr',
      'ar',
      'bn',
      'pt-BR',
    ]);
    expect(options[0].textContent?.trim()).toBe('Automatic (device language)');
    expect(options.find((o) => o.value === 'es')?.textContent?.trim()).toBe('Español');
    expect(el.querySelector('select')?.value).toBe('en');
  });

  it('switches and remembers the language picked', async () => {
    const el = await fixture<LanguagePicker>(html`<language-picker></language-picker>`);
    const select = el.querySelector('select') as HTMLSelectElement;
    select.value = 'fr';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(getLocale()).toBe('fr'));
    expect(localStorage.getItem('vibetunnel_locale')).toBe('fr');
  });

  it('stores "auto" when Automatic is picked', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['es-MX']);
    const el = await fixture<LanguagePicker>(html`<language-picker compact></language-picker>`);
    const select = el.querySelector('select') as HTMLSelectElement;
    select.value = 'auto';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(getLocale()).toBe('es'));
    expect(getLocalePreference()).toBe('auto');
    expect(localStorage.getItem('vibetunnel_locale')).toBe('auto');
  });
});
