// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// The boot screen has to paint from index.html alone: on a cold start of the home-screen app
// every other file of ours comes from the service worker, which has to boot first.
const html = readFileSync(join(__dirname, 'assets/index.html'), 'utf8').replace(
  /<!--[\s\S]*?-->/g,
  ''
);
const beforeBoot = html.slice(0, html.indexOf('<div id="vt-boot"'));
const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

describe('index.html critical render path', () => {
  it('has nothing render-blocking ahead of the boot screen', () => {
    const sheets = [...beforeBoot.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)];
    expect(sheets).toHaveLength(1);
    for (const [tag] of sheets) expect(tag).toContain('media="print"');
    for (const [tag] of beforeBoot.matchAll(/<script\b[^>]*\bsrc=[^>]*>/g)) {
      expect(tag).toMatch(/\b(defer|async)\b|type="module"/);
    }
  });

  it('draws the boot screen and its theme colours with inline CSS only', () => {
    const style = beforeBoot.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
    expect(style).toMatch(/#vt-boot \{[^}]*position: fixed;/);
    expect(style).toMatch(/html \{\s*background-color: #0a0a0a;/);
    expect(style).toMatch(/html\[data-theme='light'\] \{\s*background-color: #fafafa;/);
    // No fade-in delay: it shows from the first frame.
    expect(style).not.toMatch(/#vt-boot \{[^}]*animation/);
  });

  it('keeps the app hidden and the boot screen up until the styles apply', () => {
    const style = beforeBoot.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
    expect(style).toMatch(/html:not\(\[data-vt-styles\]\) vibetunnel-app \{\s*visibility: hidden;/);
    expect(style).toContain('html[data-vt-styles] vibetunnel-app:defined ~ #vt-boot');
  });
});

describe('the script that applies styles.css', () => {
  const applyStyles = inlineScripts.find((script) => script.includes('vt-styles')) ?? '';

  afterEach(() => {
    document.head.innerHTML = '';
    document.documentElement.removeAttribute('data-vt-styles');
  });

  const run = () => {
    document.head.innerHTML = '<link id="vt-styles" rel="stylesheet" media="print">';
    const link = document.getElementById('vt-styles') as HTMLLinkElement;
    Object.defineProperty(link, 'sheet', { value: null, configurable: true });
    new Function(applyStyles)();
    return link;
  };

  it.each(['load', 'error'])('applies them on %s, never leaving the boot screen up', (event) => {
    const link = run();
    expect(link.media).toBe('print');
    expect(document.documentElement.hasAttribute('data-vt-styles')).toBe(false);
    link.dispatchEvent(new Event(event));
    expect(link.media).toBe('all');
    expect(document.documentElement.hasAttribute('data-vt-styles')).toBe(true);
  });

  it('applies them at once when the sheet is already there', () => {
    document.head.innerHTML = '<link id="vt-styles" rel="stylesheet" media="print">';
    const link = document.getElementById('vt-styles') as HTMLLinkElement;
    Object.defineProperty(link, 'sheet', { value: {}, configurable: true });
    new Function(applyStyles)();
    expect(link.media).toBe('all');
    expect(document.documentElement.hasAttribute('data-vt-styles')).toBe(true);
  });
});

// iOS 26+ blurs about 40 pt under the status bar of a home-screen app (standalone-chrome.ts).
describe('the top of the home-screen app', () => {
  const css = readFileSync(join(__dirname, 'styles.css'), 'utf8');
  const flat = css.replace(/\s+/g, ' ');

  it('starts the list header and the session header below the blurred zone', () => {
    expect(flat).toContain(
      "html[data-standalone][data-header-clearance] app-header .app-header:not(.sidebar-header) { /* Over full-header.ts's inline padding-top (0.75rem + inset). */ padding-top: calc( env(safe-area-inset-top, 0px) + max(0.75rem, min(40px, calc(env(safe-area-inset-top, 0px) * 100))) ) !important; }"
    );
    expect(flat).toContain(
      'html[data-standalone][data-header-clearance] session-view .session-header-area { padding-top: min(40px, calc(env(safe-area-inset-top, 0px) * 100)) !important; }'
    );
  });

  it('every rule of the clearance needs the home-screen app and the switch mark', () => {
    const selectors = [...flat.matchAll(/([^{}]*data-standalone[^{}]*)\{/g)].map((m) => m[1]);
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector).toContain('html[data-standalone][data-header-clearance]');
    }
  });

  describe('the inline script that marks the home-screen app', () => {
    const viewport = inlineScripts.find((script) => script.includes('data-standalone')) ?? '';
    afterEach(() => {
      document.documentElement.removeAttribute('data-standalone');
      Reflect.deleteProperty(navigator, 'standalone');
    });

    it.each([
      [true, false, true],
      [undefined, true, true],
      [undefined, false, false],
    ])('standalone %s, display-mode %s: marked %s', (standalone, mode, expected) => {
      Object.defineProperty(navigator, 'standalone', { value: standalone, configurable: true });
      const matchMedia = window.matchMedia;
      window.matchMedia = ((query: string) => ({
        matches: query === '(display-mode: standalone)' && mode,
      })) as unknown as typeof window.matchMedia;
      try {
        new Function(viewport)();
      } finally {
        window.matchMedia = matchMedia;
      }
      expect(document.documentElement.hasAttribute('data-standalone')).toBe(expected);
    });
  });
});
