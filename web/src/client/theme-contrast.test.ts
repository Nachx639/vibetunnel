import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACCENTS, block, contrast, type Mode, themeVars } from './test/theme-tokens.js';

/**
 * WCAG contrast of the theme's text/background token pairs, in both themes and every accent
 * (emerald, amber and gold text on white were 1.6–2.5:1, white labels on the accent
 * 1.8–4.2:1, placeholders 3.3:1). Body text needs 4.5:1; icons, focus rings and UI
 * borders 3:1. A token change that drops a pair under its minimum fails here.
 */
const css = readFileSync(join(__dirname, 'styles.css'), 'utf8');

const SURFACES = [
  'bg',
  'bg-secondary',
  'bg-tertiary',
  'bg-elevated',
  'surface',
  'surface-hover',
].map((name) => `var(--color-${name})`);

const v = (name: string) => `var(--color-${name})`;
const tint = (fill: string, pct: number) => `color-mix(in srgb, ${fill} ${pct}%, transparent)`;

interface Pair {
  what: string;
  fg: string;
  bg: string | string[];
  min: number;
}

/** `fg` on every plain surface. */
const onSurfaces = (what: string, fg: string, min = 4.5): Pair[] =>
  SURFACES.map((bg) => ({ what: `${what} on ${bg}`, fg, bg, min }));

const PAIRS: Pair[] = [
  // Body text and its greys: titles, folder names, times, counts.
  ...onSurfaces('text', v('text')),
  ...onSurfaces('text-muted', v('text-muted')),
  ...onSurfaces('text-dim', v('text-dim')),
  ...onSurfaces('placeholder', v('placeholder')),
  // Accent and status words as text: Tailwind's text-primary / text-status-* read these.
  ...onSurfaces('text-primary', 'var(--text-color-primary)'),
  ...onSurfaces('text-status-warning', 'var(--text-color-status-warning)'),
  ...onSurfaces('text-status-error', 'var(--text-color-status-error)'),
  ...onSurfaces('text-status-success', 'var(--text-color-status-success)'),
  ...onSurfaces('text-status-info', 'var(--text-color-status-info)'),
  // On the accent tint (bg-primary-muted: selected items, highlighted rows).
  ...['bg', 'bg-secondary'].flatMap((base) => [
    {
      what: `text-muted on ${base} + accent tint`,
      fg: v('text-muted'),
      bg: [v(base), v('primary-muted')],
      min: 4.5,
    },
    {
      what: `text-primary on ${base} + accent tint`,
      fg: v('primary-text'),
      bg: [v(base), v('primary-muted')],
      min: 4.5,
    },
    {
      what: `success text on ${base} + accent tint`,
      fg: v('status-success-text'),
      bg: [v(base), v('primary-muted')],
      min: 4.5,
    },
    {
      what: `error text on ${base} + accent tint`,
      fg: v('status-error-text'),
      bg: [v(base), v('primary-muted')],
      min: 4.5,
    },
  ]),
  // Warning boxes and red tints (error notes).
  ...[v('primary-text'), v('status-warning-text'), v('status-info-text'), v('text')].map((fg) => ({
    what: `${fg} on a warning tint`,
    fg,
    bg: [v('bg-secondary'), tint(v('status-warning'), 10)],
    min: 4.5,
  })),
  ...[v('bg-secondary'), v('bg-tertiary'), v('bg-elevated')].map((base) => ({
    what: `error text on ${base} + red tint`,
    fg: v('status-error-text'),
    bg: [base, tint(v('status-error'), 10)],
    min: 4.5,
  })),
  // Labels and icons on fills: accent buttons and their hover, success and warning toasts
  // and badges; white on the red fill (error toasts).
  ...['primary', 'primary-light', 'status-success', 'status-warning', 'status-info'].map(
    (fill) => ({ what: `on-fill ink on ${fill}`, fg: v('on-fill'), bg: v(fill), min: 4.5 })
  ),
  { what: 'white on the red fill', fg: 'white', bg: v('status-error'), min: 4.5 },
];

const THEMES: [Mode, string][] = (['light', 'dark'] as Mode[]).flatMap((mode) =>
  ACCENTS.map((accent): [Mode, string] => [mode, accent])
);

describe('theme contrast (WCAG)', () => {
  it.each(THEMES)('%s theme, %s accent: every pair reaches its minimum', (mode, accent) => {
    const vars = themeVars(css, mode, accent);
    const failures = PAIRS.flatMap(({ what, fg, bg, min }) => {
      const ratio = contrast(fg, bg, vars);
      return ratio + 1e-9 >= min ? [] : [`${what}: ${ratio.toFixed(2)} < ${min}`];
    });
    expect(failures).toEqual([]);
  });

  it('text-primary and text-status-* read the text shades, not the fills', () => {
    const theme = block(css, '@theme');
    expect(theme.get('--text-color-primary')).toBe('var(--color-primary-text)');
    for (const status of ['warning', 'error', 'success', 'info']) {
      expect(theme.get(`--text-color-status-${status}`)).toBe(`var(--color-status-${status}-text)`);
    }
  });

  // The system-dark block repeats [data-theme="dark"]; the two drifting apart would give
  // users of the System theme other colors than users of the Dark one.
  it('the system-dark palette matches the dark one', () => {
    const dark = block(css, '[data-theme="dark"]');
    const media = css.match(
      /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([^}]*)\}/
    );
    expect(media).not.toBeNull();
    const system = block(`x {${media?.[1]}}`, 'x');
    expect(Object.fromEntries(system)).toEqual(
      Object.fromEntries([...dark].filter(([name]) => system.has(name)))
    );
    expect([...dark.keys()].filter((name) => !system.has(name))).toEqual([]);
  });
});
