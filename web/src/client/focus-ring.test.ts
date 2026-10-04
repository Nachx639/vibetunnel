import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { a11yBaseStyles } from './utils/a11y-base-styles.js';

// Keyboard focus was a 30% accent glow, 1.2:1 on the light theme, and Tailwind's
// focus:outline-none took the browser ring away. The ring's 3:1 against every
// surface is checked in theme-contrast.test.ts (--color-focus-ring).
const css = readFileSync(join(__dirname, 'styles.css'), 'utf8');
const RING =
  /:where\(:focus-visible\):where\(\s*:not\(\[tabindex='-1'\], input, textarea, select, \[contenteditable\]\)\s*\)\s*\{\s*outline: 2px solid var\(--color-focus-ring/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('keyboard focus ring', () => {
  it('the page draws it on controls, outside any cascade layer so focus:outline-none loses', () => {
    const match = RING.exec(css);
    expect(match).not.toBeNull();
    const before = css.slice(0, match?.index ?? 0).replace(/\/\*[\s\S]*?\*\//g, '');
    const depth = (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length;
    expect(depth).toBe(0);
  });

  it('shadow-DOM components with controls include the same rule', () => {
    expect(RING.test(a11yBaseStyles.cssText)).toBe(true);
    const missing = sources(__dirname).filter((file) => {
      const text = readFileSync(file, 'utf8');
      if (/createRenderRoot\s*\(/.test(text) || !/static (?:override )?styles\s*=/.test(text)) {
        return false;
      }
      if (!/<(button|input|textarea|select|a)\b|tabindex=/.test(text)) return false;
      return !text.includes('a11yBaseStyles');
    });
    expect(missing.map((file) => relative(__dirname, file))).toEqual([]);
  });
});
