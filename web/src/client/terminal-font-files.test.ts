import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Hack Nerd Font Mono as styles.css serves it: split per weight by
 * scripts/build-terminal-fonts.py into a core file (preloaded by index.html) and two icon files.
 */
const TERMINAL_FONT_NAME = 'Hack Nerd Font Mono';
const web = path.resolve(__dirname, '../..');

describe('the split font as served', () => {
  const css = readFileSync(path.join(web, 'src/client/styles.css'), 'utf8');
  const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)]
    .map(([, body]) => body)
    .filter((body) => body.includes(`'${TERMINAL_FONT_NAME}'`))
    .map((body) => ({
      weight: Number(/font-weight:\s*(\d+)/.exec(body)?.[1]),
      file: /url\('\/fonts\/([^']+)'\)/.exec(body)?.[1] ?? '',
      ranges: (/unicode-range:\s*([^;]+);/.exec(body)?.[1] ?? '').split(',').map((range) => {
        const [from, to = from] = range.trim().replace(/^U\+/i, '').split('-');
        return [Number.parseInt(from, 16), Number.parseInt(to, 16)] as [number, number];
      }),
    }));

  it.each([400, 700])('weight %i: three WOFF2 files that cover U+0-10FFFF once', (weight) => {
    const ranges = faces
      .filter((f) => f.weight === weight)
      .flatMap((f) => f.ranges)
      .sort((a, b) => a[0] - b[0]);
    expect(faces.filter((f) => f.weight === weight)).toHaveLength(3);
    let next = 0;
    for (const [from, to] of ranges) {
      expect(from, `gap or overlap at U+${next.toString(16)}`).toBe(next);
      expect(to).toBeGreaterThanOrEqual(from);
      next = to + 1;
    }
    expect(next).toBe(0x110000);
  });

  it('text, box drawing and Powerline come from the preloaded core file', () => {
    const core = faces.filter((f) => f.file.startsWith('hack-core-'));
    expect(core.map((f) => f.file).sort()).toEqual([
      'hack-core-bold.woff2',
      'hack-core-regular.woff2',
    ]);
    for (const cp of [0x41, 0x2502, 0x2588, 0xe0a0, 0xe0b0, 0xe0d4, 0xe0d7]) {
      for (const { ranges } of core) {
        expect(
          ranges.some(([a, b]) => a <= cp && cp <= b),
          `U+${cp.toString(16)}`
        ).toBe(true);
      }
    }
    const html = readFileSync(path.join(web, 'src/client/assets/index.html'), 'utf8');
    for (const { file } of core) {
      expect(html).toMatch(
        new RegExp(
          `<link rel="preload" href="/fonts/${file}" as="font" type="font/woff2" crossorigin`
        )
      );
    }
  });

  it('every file exists, and the ranges are the ones the build script cut', () => {
    for (const { file } of faces) {
      expect(() => readFileSync(path.join(web, 'src/client/assets/fonts', file))).not.toThrow();
    }
    const script = readFileSync(path.join(web, 'scripts/build-terminal-fonts.py'), 'utf8');
    for (const part of ['core', 'pua', 'spua']) {
      const line = new RegExp(`"${part}": \\[([^\\]]+)\\]`).exec(script)?.[1] ?? '';
      const cut = [...line.matchAll(/\(0x([0-9A-F]+), 0x([0-9A-F]+)\)/gi)].map(([, a, b]) => [
        Number.parseInt(a, 16),
        Number.parseInt(b, 16),
      ]);
      expect(cut.length).toBeGreaterThan(0);
      for (const f of faces.filter((x) => x.file.startsWith(`hack-${part}-`))) {
        expect(f.ranges).toEqual(cut);
      }
    }
  });
});
