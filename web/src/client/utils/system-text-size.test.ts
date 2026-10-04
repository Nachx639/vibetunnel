// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';
import {
  applySystemTextSize,
  CHROME_MAX_SCALE,
  clampRootText,
  measureSystemBodyPx,
  ROOT_TEXT_MAX_PX,
  readSystemTextSize,
  SYSTEM_TEXT_SIZE_CHANGED_EVENT,
  SYSTEM_TEXT_SIZE_KEY,
  systemTextSizeSupported,
  writeSystemTextSize,
} from './system-text-size.js';

const clientDir = join(__dirname, '..');
const read = (path: string) => readFileSync(join(clientDir, path), 'utf8');

/** What WebKit reports for a `font: -apple-system-body` probe at a Dynamic Type size. */
function dynamicType(bodyPx: number) {
  const probes: Element[] = [];
  vi.stubGlobal('getComputedStyle', (el: Element) => {
    if (el.getAttribute('aria-hidden') === 'true' && el.tagName === 'SPAN') probes.push(el);
    return { fontSize: el.tagName === 'SPAN' ? `${bodyPx}px` : '16px' } as CSSStyleDeclaration;
  });
  return probes;
}

const rootVar = (name: string) => document.documentElement.style.getPropertyValue(name);

describe('"Use the system text size"', () => {
  beforeEach(() => {
    setupLocalStorageMock();
    document.documentElement.removeAttribute('data-text-size');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    restoreLocalStorage();
    applySystemTextSize(false);
  });

  describe('the cap', () => {
    it('keeps sizes from 16 to 22 px and clamps the rest', () => {
      expect(clampRootText(17)).toBe(17);
      expect(clampRootText(21)).toBe(21);
      expect(clampRootText(53)).toBe(ROOT_TEXT_MAX_PX);
      expect(clampRootText(14)).toBe(16);
      expect(clampRootText(Number.NaN)).toBe(16);
    });

    it('reads Dynamic Type from a -apple-system-body probe, then removes it', () => {
      const probes = dynamicType(33);
      expect(measureSystemBodyPx()).toBe(33);
      expect(probes).toHaveLength(1);
      expect(probes[0].isConnected).toBe(false);
    });

    it('17 px (the default "Large") is used as is; chrome grows 1.0625x', () => {
      dynamicType(17);
      applySystemTextSize(true);
      expect(rootVar('--vt-root-text')).toBe('17px');
      expect(Number(rootVar('--vt-chrome-scale'))).toBeCloseTo(17 / 16);
    });

    it('53 px (AX5) is capped at 22 px; chrome at 1.15x', () => {
      dynamicType(53);
      applySystemTextSize(true);
      expect(rootVar('--vt-root-text')).toBe('22px');
      expect(Number(rootVar('--vt-chrome-scale'))).toBe(CHROME_MAX_SCALE);
    });

    it('turning it off clears the size', () => {
      dynamicType(53);
      applySystemTextSize(true);
      applySystemTextSize(false);
      expect(rootVar('--vt-root-text')).toBe('');
      expect(rootVar('--vt-chrome-scale')).toBe('');
    });

    it('re-reads the size when the page becomes visible again', async () => {
      const { watchSystemTextSize } = await import('./system-text-size.js');
      localStorage.setItem(SYSTEM_TEXT_SIZE_KEY, 'on');
      dynamicType(17);
      applySystemTextSize(true);
      watchSystemTextSize();
      dynamicType(19);
      document.dispatchEvent(new Event('visibilitychange'));
      expect(rootVar('--vt-root-text')).toBe('19px');
    });
  });

  it('is off by default', () => {
    expect(readSystemTextSize()).toBe(false);
    expect(document.documentElement.hasAttribute('data-text-size')).toBe(false);
  });

  it('turning it on marks <html>, remembers it and says so; off undoes all three', () => {
    const changes: boolean[] = [];
    const listener = (e: Event) => changes.push((e as CustomEvent<boolean>).detail);
    window.addEventListener(SYSTEM_TEXT_SIZE_CHANGED_EVENT, listener);

    writeSystemTextSize(true);
    expect(document.documentElement.getAttribute('data-text-size')).toBe('system');
    expect(localStorage.getItem(SYSTEM_TEXT_SIZE_KEY)).toBe('on');
    expect(readSystemTextSize()).toBe(true);

    writeSystemTextSize(false);
    expect(document.documentElement.hasAttribute('data-text-size')).toBe(false);
    expect(localStorage.getItem(SYSTEM_TEXT_SIZE_KEY)).toBeNull();
    expect(changes).toEqual([true, false]);
    window.removeEventListener(SYSTEM_TEXT_SIZE_CHANGED_EVENT, listener);
  });

  it('still applies for this page when storage is blocked', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    writeSystemTextSize(true);
    expect(document.documentElement.getAttribute('data-text-size')).toBe('system');
  });

  it('is offered only where WebKit maps -apple-system-body to Dynamic Type (touch)', () => {
    const supports = vi.fn((property: string) => property === '-webkit-touch-callout');
    vi.stubGlobal('CSS', { supports });
    expect(systemTextSizeSupported()).toBe(true);
    vi.stubGlobal('CSS', { supports: () => false });
    expect(systemTextSizeSupported()).toBe(false);
  });

  // There is no script in <head> for it: the app applies the saved choice as soon as its
  // bundle runs (app.ts connectedCallback -> watchSystemTextSize).
  it('the saved choice is applied when the app starts, and nothing when it is off', async () => {
    vi.resetModules();
    const fresh = await import('./system-text-size.js');
    dynamicType(19);
    fresh.watchSystemTextSize();
    expect(document.documentElement.hasAttribute('data-text-size')).toBe(false);

    vi.resetModules();
    const again = await import('./system-text-size.js');
    localStorage.setItem(SYSTEM_TEXT_SIZE_KEY, 'on');
    again.watchSystemTextSize();
    expect(document.documentElement.getAttribute('data-text-size')).toBe('system');
    expect(rootVar('--vt-root-text')).toBe('19px');
  });
});

describe('system text size in the stylesheets', () => {
  const css = read('styles.css');

  it('sets the clamped root size on touch WebKit, spacing kept in px', () => {
    const rule = css.match(
      /@supports \(-webkit-touch-callout: none\) \{\s*html\[data-text-size='system'\] \{([^}]*)\}/
    )?.[1];
    expect(rule).toBeDefined();
    expect(rule).toMatch(/font-size: var\(--vt-root-text, 16px\);/);
    expect(rule).toMatch(/--spacing: 4px;/);
  });

  it('chrome text grows only by --vt-chrome-scale, menus opened from it excepted', () => {
    for (const [size, px] of [
      ['xs', 12],
      ['sm', 14],
      ['base', 16],
      ['lg', 18],
      ['xl', 20],
    ]) {
      expect(css).toContain(
        `html[data-text-size='system'] :is(.vt-chrome .text-${size}, .vt-chrome.text-${size}):not(.vt-content *) {\n      font-size: calc(${px}px * var(--vt-chrome-scale, 1));`
      );
    }
  });

  // At AX5 the bottom bar took half the screen, the header read "V…", the Settings title
  // and footer overflowed.
  it('the headers, the bottom bar and the Settings header and footer are chrome', () => {
    expect(read('components/full-header.ts')).toMatch(/class="app-header vt-chrome /);
    expect(read('components/sidebar-header.ts')).toMatch(/vt-chrome/);
    expect(read('components/session-view/session-header.ts')).toMatch(
      /session-header-container vt-chrome/
    );
    expect(read('components/session-list.ts')).toMatch(
      /class="vt-chrome sticky bottom-0[^"]*" data-testid="session-list-footer"/
    );
    expect(read('components/settings.ts').match(/class="vt-chrome /g)).toHaveLength(2);
    expect(read('components/session-view/compact-menu.ts')).toMatch(/class="vt-content /);
  });

  /**
   * Text in the phone UI is sized in rem so it follows the root. Allowed in px: glyphs that
   * act as icons inside fixed-size boxes (avatars, ⋯, ✕) and the hidden swipe actions.
   */
  const PX_ALLOWED = new Set([
    '.psr-avatar',
    '.psr-prompt',
    '.psr-initial',
    '.psr-menu',
    '.wn-icon',
    '.nb-icon',
    '.pvr-avatar',
    '.pvr-close',
    '.vt-shield-banner-close',
    '.vt-action-toast > button.vt-action-toast-close',
    '.pv-down-icon',
  ]);
  const PHONE_SELECTOR =
    /^\.(psr|pvr|msr|nb|ans|wn|ask-claude|phone|vt-shield|vt-share|vt-action-toast|vt-preview-chip|reconnecting-pill|appearance|task-entry)/;

  it('the phone list, sheets, banners, menus and answer cards size their text in rem', () => {
    const offenders: string[] = [];
    let selector = '';
    for (const line of css.split('\n')) {
      const open = /^(\S[^{]*?)\s*\{\s*$/.exec(line);
      if (open) selector = open[1].trim();
      if (!PHONE_SELECTOR.test(selector) || PX_ALLOWED.has(selector)) continue;
      if (/font-size:\s*\d+(\.\d+)?px|font:\s(\d{3}\s)?\d+(\.\d+)?px/.test(line)) {
        offenders.push(`${selector}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the chat, composer and mode picker size their text in rem', () => {
    const files = [
      'components/claude-chat-view.ts',
      'components/terminal-chat-view.ts',
      'components/claude-mode-picker.ts',
    ];
    const offenders = files.flatMap((file) =>
      read(file)
        .split('\n')
        .map((line, i) => ({ line, at: `${file}:${i + 1}` }))
        .filter(({ line }) => /font-size:\s*\d+px|font:\s\d+px/.test(line))
        // The attachment placeholder's emoji, in a fixed 140px box.
        .filter(({ line }) => !/font-size: 28px/.test(line))
        .map(({ at, line }) => `${at} ${line.trim()}`)
    );
    expect(offenders).toEqual([]);
  });

  // Under 16px iOS zooms into a focused field; the system size may only make them larger.
  it('text fields never go under 16px', () => {
    const sources = [
      css,
      read('components/claude-chat-view.ts'),
      read('components/terminal-chat-view.ts'),
    ];
    const fieldSizes = sources.flatMap(
      (text) => text.match(/font(-size)?: max\(16px, 1rem\)/g) ?? []
    );
    expect(fieldSizes.length).toBeGreaterThanOrEqual(5);
  });
});
