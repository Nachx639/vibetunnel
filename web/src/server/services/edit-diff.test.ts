import { describe, expect, it } from 'vitest';
import { DIFF_GAP, diffForToolUse } from './edit-diff';

const edit = (old_string: string, new_string: string) =>
  diffForToolUse('Edit', { file_path: '/x.ts', old_string, new_string });

describe('the change an Edit shows in the phone chat', () => {
  it('marks the changed line with two unchanged lines around it', () => {
    expect(edit('a\nb\nc\nd\ne\nf\ng', 'a\nb\nc\nD\ne\nf\ng')).toEqual({
      lines: [' b', ' c', '-d', '+D', ' e', ' f'],
      more: 0,
    });
  });

  it('shows an insertion alone, and a long unchanged stretch between two changes as a gap', () => {
    expect(edit('x\ny', 'x\nnew\ny')?.lines).toEqual([' x', '+new', ' y']);
    const old = ['one', '1', '2', '3', '4', '5', '6', 'two'].join('\n');
    const changed = ['ONE', '1', '2', '3', '4', '5', '6', 'TWO'].join('\n');
    expect(edit(old, changed)?.lines).toEqual([
      '-one',
      '+ONE',
      ' 1',
      ' 2',
      DIFF_GAP,
      ' 5',
      ' 6',
      '-two',
      '+TWO',
    ]);
  });

  it('has nothing to show when nothing changed, or for tools that edit no file', () => {
    expect(edit('same\n', 'same\n')).toBeUndefined();
    expect(diffForToolUse('Bash', { command: 'ls' })).toBeUndefined();
    expect(diffForToolUse('Edit', { file_path: '/x.ts' })).toBeUndefined();
  });

  it('keeps a long change short: 40 lines, the rest counted, long lines clipped', () => {
    const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const written = diffForToolUse('Write', { file_path: '/new.ts', content });
    expect(written?.lines).toHaveLength(40);
    expect(written?.lines[0]).toBe('+line 0');
    expect(written?.more).toBe(60);
    const long = edit('short', 'y'.repeat(500))?.lines ?? [];
    expect(long[1]).toHaveLength(201);
    expect(long[1].endsWith('…')).toBe(true);
  });

  it('does not compare huge edits line by line, but still shows their start', () => {
    const many = (prefix: string) =>
      Array.from({ length: 400 }, (_, i) => `${prefix}${i}`).join('\n');
    const diff = edit(many('old'), many('new'));
    expect(diff?.lines[0]).toBe('-old0');
    expect(diff?.more).toBe(800 - 40);
  });

  it('joins the edits of a MultiEdit with a gap', () => {
    const diff = diffForToolUse('MultiEdit', {
      file_path: '/x.ts',
      edits: [
        { old_string: 'a', new_string: 'A' },
        { old_string: 'same', new_string: 'same' },
        { old_string: 'b', new_string: 'B' },
      ],
    });
    expect(diff?.lines).toEqual(['-a', '+A', DIFF_GAP, '-b', '+B']);
  });
});
