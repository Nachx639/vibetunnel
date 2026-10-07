import { describe, expect, it } from 'vitest';
import { compactStatusSegments, parseClaudeStatusLine } from './claude-status-line.js';

const box = (below: string[]) =>
  [
    '⏺ Done. The file is in the folder.',
    '',
    '✻ Baked for 4s · done 1:07 PM',
    '────────────────────────────── my-project ─',
    '❯ ',
    '────────────────────────────────────────────',
    ...below,
    '',
  ].join('\n');

describe('parseClaudeStatusLine', () => {
  it('reads the lines under the prompt box: a status line command and the mode line', () => {
    expect(
      parseClaudeStatusLine(
        box([
          '  Opus 5.5  ·  5h 5% (resets 22:30)  ·  week 16% …',
          '  ⏵⏵ bypass permissions on · 1 shell',
        ])
      )
    ).toEqual([
      'Opus 5.5  ·  5h 5% (resets 22:30)  ·  week 16% …',
      '⏵⏵ bypass permissions on · 1 shell',
    ]);
  });

  it('takes just the mode line when there is no status line command', () => {
    expect(parseClaudeStatusLine(box(['  ⏸ plan mode on (shift+tab to cycle)']))).toEqual([
      '⏸ plan mode on (shift+tab to cycle)',
    ]);
  });

  it('sees a prompt with text in it, over several lines', () => {
    const screen = [
      '─────────────────────────────',
      '❯ add a pricing section after',
      '  the features',
      '─────────────────────────────',
      '  Sonnet · ctx 40%',
    ].join('\n');
    expect(parseClaudeStatusLine(screen)).toEqual(['Sonnet · ctx 40%']);
  });

  it('finds nothing without a prompt box (a permission dialog, a plain shell)', () => {
    expect(
      parseClaudeStatusLine(
        [
          '──────────────────────────────',
          ' Do you want to proceed?',
          ' ❯ 1. Yes',
          '   2. No',
          ' Esc to cancel',
        ].join('\n')
      )
    ).toEqual([]);
    expect(parseClaudeStatusLine('ada@studio ~/nebula ❯ ls\nREADME.md\n')).toEqual([]);
    expect(parseClaudeStatusLine('')).toEqual([]);
  });

  it('keeps at most four lines', () => {
    expect(parseClaudeStatusLine(box(['a', 'b', 'c', 'd', 'e', 'f']))).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });
});

describe('compactStatusSegments', () => {
  it('splits a usage status line into chips and drops what the mode chip already shows', () => {
    expect(
      compactStatusSegments([
        'Opus 5.5 · 5h 7% (reinicia 22:30) · semana 17% (reinicia vie…',
        '►► bypass permissions on · 1 shell',
      ])
    ).toEqual([
      { text: 'Opus 5.5', reset: undefined },
      { text: '5h', percent: 7, reset: '22:30' },
      { text: 'semana', percent: 17, reset: undefined },
      { text: '1 shell', reset: undefined },
    ]);
  });

  it('drops pieces the terminal cut off and key hints', () => {
    expect(
      compactStatusSegments([
        'Opus 5.5 · week 16% (resets Fri 12:00) · cont…',
        '⏸ manual mode on · ← for agents',
      ])
    ).toEqual([
      { text: 'Opus 5.5', reset: undefined },
      { text: 'week', percent: 16, reset: 'Fri 12:00' },
    ]);
    expect(compactStatusSegments(['⏸ plan mode on (shift+tab to cycle)'])).toEqual([]);
  });
});
