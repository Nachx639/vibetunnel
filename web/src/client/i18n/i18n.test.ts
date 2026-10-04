// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';

const STORAGE_KEY = 'vibetunnel_locale';

async function loadI18n() {
  vi.resetModules();
  return import('./index.js');
}

describe('i18n', () => {
  beforeEach(() => {
    setupLocalStorageMock();
    document.documentElement.removeAttribute('lang');
    document.documentElement.removeAttribute('dir');
  });

  afterEach(() => {
    restoreLocalStorage();
    vi.restoreAllMocks();
  });

  it('defaults to English and marks the document ltr', async () => {
    const i18n = await loadI18n();
    expect(i18n.getLocale()).toBe('en');
    expect(i18n.getLocalePreference()).toBe('en');
    expect(i18n.t('common.settings')).toBe('Settings');
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('stays in English on a device in another language until a language is picked', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['es-ES', 'en']);
    const i18n = await loadI18n();
    expect(i18n.getLocale()).toBe('en');
    expect(i18n.t('common.close')).toBe('Close');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('follows the device language only when "Automatic" was chosen', async () => {
    const languages = vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['es-ES', 'en']);
    let i18n = await loadI18n();
    await i18n.setLocale(i18n.AUTO_LOCALE);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('auto');
    expect(i18n.getLocalePreference()).toBe('auto');
    expect(i18n.getLocale()).toBe('es');
    expect(i18n.t('common.close')).toBe('Cerrar');

    // On reload it resolves again, from whatever the device says now.
    languages.mockReturnValue(['fr-FR']);
    i18n = await loadI18n();
    expect(i18n.getLocale()).toBe('fr');
    await i18n.whenLocaleReady();
    expect(i18n.t('common.close')).toBe('Fermer');

    // A device language we don't have: English.
    languages.mockReturnValue(['de-DE']);
    i18n = await loadI18n();
    expect(i18n.getLocale()).toBe('en');
  });

  it('re-resolves "Automatic" when the system language changes', async () => {
    const languages = vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US']);
    const i18n = await loadI18n();
    await i18n.setLocale(i18n.AUTO_LOCALE);
    expect(i18n.getLocale()).toBe('en');
    languages.mockReturnValue(['pt-BR']);
    window.dispatchEvent(new Event('languagechange'));
    await i18n.whenLocaleReady();
    expect(i18n.getLocale()).toBe('pt-BR');
  });

  it('maps device languages to ours, null when there is no match', async () => {
    const { deviceLocale } = await loadI18n();
    expect(deviceLocale(['de-DE', 'pt-PT'])).toBe('pt-BR');
    expect(deviceLocale(['zh-Hans-CN'])).toBe('zh-CN');
    expect(deviceLocale(['zh-TW'])).toBeNull();
    expect(deviceLocale(['ar-EG'])).toBe('ar');
    expect(deviceLocale(['de-DE', 'it'])).toBeNull();
  });

  it('interpolates parameters and leaves unknown placeholders intact', async () => {
    const { t } = await loadI18n();
    expect(t('login.welcomeBack', { user: 'alice' })).toBe('Welcome back, alice');
    expect(t('login.welcomeBack')).toBe('Welcome back, {user}');
  });

  it('persists the chosen locale, notifies listeners, and restores it on reload', async () => {
    const i18n = await loadI18n();
    const listener = vi.fn();
    window.addEventListener(i18n.LOCALE_CHANGED_EVENT, listener);

    await i18n.setLocale('es');
    window.removeEventListener(i18n.LOCALE_CHANGED_EVENT, listener);

    expect(listener).toHaveBeenCalledOnce();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('es');
    expect(i18n.t('common.settings')).toBe('Ajustes');

    const reloaded = await loadI18n();
    expect(reloaded.getLocale()).toBe('es');
    expect(document.documentElement.lang).toBe('es');
    // A stored non-English locale arrives as its own chunk; the app waits for it.
    await reloaded.whenLocaleReady();
    expect(reloaded.t('common.settings')).toBe('Ajustes');
  });

  it('ignores an invalid stored locale', async () => {
    localStorage.setItem(STORAGE_KEY, 'xx');
    const i18n = await loadI18n();
    expect(i18n.getLocale()).toBe('en');
  });

  it('sets rtl for Arabic and back to ltr for other languages', async () => {
    const i18n = await loadI18n();
    await i18n.setLocale('ar');
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');

    await i18n.setLocale('zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('picks the plural form by the language’s own rules', async () => {
    const i18n = await loadI18n();
    expect(i18n.t('title.sessions', { n: 1 })).toBe('VibeTunnel - 1 Session');
    expect(i18n.t('title.sessions', { n: 3 })).toBe('VibeTunnel - 3 Sessions');
    await i18n.setLocale('es');
    expect(i18n.t('sessions.runningCount', { n: 1 })).toBe('1 activa');
    expect(i18n.t('sessions.runningCount', { n: 2 })).toBe('2 activas');
    expect(i18n.t('sessions.runningCount', { n: 0 })).toBe('0 activas');
    // French uses the singular for 0 too.
    await i18n.setLocale('fr');
    expect(i18n.t('sessions.exitedCount', { n: 0 })).toBe('0 terminée');
    // No plural forms in Chinese: always the base text.
    await i18n.setLocale('zh-CN');
    expect(i18n.t('sessions.runningCount', { n: 1 })).toBe('1 个运行中');
  });

  it('never borrows another language’s plural form', async () => {
    const i18n = await loadI18n();
    const { es } = await import('./locales/es.js');
    delete (es as Partial<typeof es>)['sessions.runningCount.one'];
    await i18n.setLocale('es');
    expect(i18n.t('sessions.runningCount', { n: 1 })).toBe('1 activas');
  });

  it('falls back to English when a key is missing from the active locale', async () => {
    const i18n = await loadI18n();
    const { fr } = await import('./locales/fr.js');
    delete (fr as Partial<typeof fr>)['common.close'];

    await i18n.setLocale('fr');
    expect(i18n.t('common.close')).toBe('Close');
    expect(i18n.t('missing.key' as Parameters<typeof i18n.t>[0])).toBe('missing.key');
  });

  it('keeps working when storage throws', async () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const i18n = await loadI18n();
    expect(i18n.getLocale()).toBe('en');
    expect(() => i18n.setLocale('hi')).not.toThrow();
    expect(i18n.getLocale()).toBe('hi');
  });
});

describe('locale files', () => {
  async function allLocales() {
    vi.resetModules();
    const { en } = await import('./locales/en.js');
    const others = {
      'zh-CN': (await import('./locales/zh-CN.js')).zhCN,
      fr: (await import('./locales/fr.js')).fr,
      hi: (await import('./locales/hi.js')).hi,
      es: (await import('./locales/es.js')).es,
      ar: (await import('./locales/ar.js')).ar,
      bn: (await import('./locales/bn.js')).bn,
      'pt-BR': (await import('./locales/pt-BR.js')).ptBR,
    } as Record<string, Record<string, string>>;
    return { en: en as Record<string, string>, others };
  }

  const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();

  it('ships every supported locale except English as a lazily loaded file', async () => {
    const { SUPPORTED_LOCALES } = await import('./index.js');
    const { others } = await allLocales();
    expect(Object.keys(others).sort()).toEqual(SUPPORTED_LOCALES.filter((l) => l !== 'en').sort());
  });

  it('gives every locale exactly the English keys, non-empty, with the same placeholders', async () => {
    const { en, others } = await allLocales();
    const englishKeys = Object.keys(en).sort();
    for (const [locale, dictionary] of Object.entries(others)) {
      expect(Object.keys(dictionary).sort(), locale).toEqual(englishKeys);
      for (const key of englishKeys) {
        expect(dictionary[key].trim(), `${locale} ${key}`).not.toBe('');
        expect(placeholders(dictionary[key]), `${locale} ${key}`).toEqual(placeholders(en[key]));
      }
    }
  });

  it('has a base form for every plural form', async () => {
    const { en } = await allLocales();
    for (const key of Object.keys(en).filter((k) => k.endsWith('.one'))) {
      expect(en[key.slice(0, -'.one'.length)], key).toBeDefined();
    }
  });
});
