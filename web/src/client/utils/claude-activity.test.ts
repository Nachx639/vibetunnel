/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../shared/types.js';
import { setLocale } from '../i18n/index.js';
import { es } from '../i18n/locales/es.js';
import { formatActivity, formatElapsed, sessionActivity } from './claude-activity.js';

describe('claude activity', () => {
  afterEach(() => {
    setLocale('en');
    vi.useRealTimers();
  });

  it('words each step in the app language', async () => {
    expect(formatActivity({ kind: 'tool', tool: 'Bash', target: 'pnpm test' })).toBe(
      'Running: pnpm test'
    );
    expect(formatActivity({ kind: 'tool', tool: 'Edit', target: 'app.ts' })).toBe('Editing app.ts');
    expect(formatActivity({ kind: 'tool', tool: 'Read' })).toBe('Reading a file');
    expect(formatActivity({ kind: 'tool', tool: 'Glob', target: '*.ts' })).toBe('Searching *.ts');
    expect(formatActivity({ kind: 'tool', tool: 'WebFetch', target: 'lit.dev' })).toBe(
      'Browsing lit.dev'
    );
    expect(formatActivity({ kind: 'tool', tool: 'Task', target: 'Explore' })).toBe(
      'Agent: Explore'
    );
    expect(formatActivity({ kind: 'tool', tool: 'TodoWrite' })).toBe('Updating todo list');
    expect(formatActivity({ kind: 'tool', tool: 'mcp__github__get_issue' })).toBe(
      'Using get_issue'
    );
    expect(formatActivity({ kind: 'thinking' })).toBe('Thinking…');
    expect(formatActivity({ kind: 'writing' })).toBe('Writing…');
    await setLocale('es');
    expect(formatActivity({ kind: 'tool', tool: 'Edit', target: 'app.ts' })).toBe(
      es['activity.editing'].replace('{target}', 'app.ts')
    );
  });

  it('formats elapsed time compactly', () => {
    expect(formatElapsed(45_000)).toBe('45s');
    expect(formatElapsed(80_000)).toBe('1m 20s');
    expect(formatElapsed(3_900_000)).toBe('1h 5m');
    expect(formatElapsed(-5)).toBe('0s');
  });

  it('only shows activity while Claude is working in a running session', () => {
    const activity = { kind: 'thinking' as const };
    const session = (status: string, claude: string) =>
      ({ status, claudeStatus: { status: claude, activity } }) as Session;
    expect(sessionActivity(session('running', 'busy'))).toBe(activity);
    expect(sessionActivity(session('running', 'idle'))).toBeUndefined();
    expect(sessionActivity(session('exited', 'busy'))).toBeUndefined();
  });

  it('ticks the elapsed element by itself', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const element = document.createElement('claude-activity-elapsed');
    element.setAttribute('since', String(100_000 - 59_000));
    document.body.append(element);
    expect(element.textContent).toBe('59s');
    vi.advanceTimersByTime(1000);
    expect(element.textContent).toBe('1m 0s');
    element.remove();
  });
});
