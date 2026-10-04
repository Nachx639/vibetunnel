import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The --color-* variables hold full colors (#10B981), so rgb(var(--color-x)) and
// rgba(var(--color-x), a) are invalid CSS: the browser drops the whole declaration.
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|css)$/.test(name) && !name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('theme colors', () => {
  it('never wraps a --color-* variable in rgb()', () => {
    const offenders = sources(__dirname).filter((file) =>
      /rgba?\(\s*var\(--color-/.test(readFileSync(file, 'utf8'))
    );
    expect(offenders).toEqual([]);
  });
});
