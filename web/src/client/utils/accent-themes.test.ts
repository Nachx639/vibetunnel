/**
 * @vitest-environment happy-dom
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCENT_STORAGE_KEY, ACCENT_THEMES, applyAccent, getAccent } from './accent-themes.js';

describe('accent themes', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute('data-accent');
  });

  it('applies and remembers a color theme, falling back to emerald for unknown ids', () => {
    expect(getAccent()).toBe('emerald');

    applyAccent('violet');
    expect(document.documentElement.getAttribute('data-accent')).toBe('violet');
    expect(getAccent()).toBe('violet');

    localStorage.setItem(ACCENT_STORAGE_KEY, 'neon-pink');
    expect(getAccent()).toBe('emerald');
    applyAccent('neon-pink');
    expect(document.documentElement.getAttribute('data-accent')).toBe('emerald');
  });
});

describe('accent theme contrast (WCAG AA, 4.5:1 for text)', () => {
  const css = readFileSync(join(dirname(__filename), '..', 'styles.css'), 'utf8');
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    expect(start, selector).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf('}', start));
  };
  const token = (text: string, name: string) =>
    new RegExp(`--color-${name}:\\s*([^;]+);`).exec(text)?.[1].trim() ?? '';
  const channels = (color: string): number[] =>
    color.startsWith('#')
      ? [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16))
      : (color.match(/\d+/g) ?? []).map(Number);
  const luminance = (color: string) => {
    const [r, g, b] = channels(color).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it('every color theme is at least as readable as the default one', () => {
    const root = block(':root');
    const dark = block('[data-theme="dark"]');
    for (const { id } of ACCENT_THEMES) {
      // Emerald is the default: upstream's own variables, no override block.
      const accent = id === 'emerald' ? root : block(`[data-accent="${id}"]`);
      const tinted = id === 'emerald' ? dark : block(`[data-theme="dark"][data-accent="${id}"]`);
      expect(contrast(token(accent, 'primary-dark'), token(root, 'bg')), id).toBeGreaterThanOrEqual(
        4.5
      );
      expect(
        contrast(token(accent, 'primary-light'), token(tinted, 'bg-elevated')),
        id
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('has no override for the default theme', () => {
    expect(css).not.toContain('[data-accent="emerald"]');
  });
});
