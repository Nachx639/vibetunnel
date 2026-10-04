/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../shared/types.js';
import { resetGhostClickGuard } from '../../utils/ghost-click.js';
import {
  closeSessionSwitcher,
  openSessionSwitcher,
  switcherSessions,
} from './session-switcher-sheet.js';

const session = (id: string, overrides: Partial<Session> = {}): Session =>
  ({
    id,
    name: `shell ${id}`,
    command: ['zsh'],
    workingDir: `/Users/test/${id}`,
    status: 'running',
    startedAt: '2025-05-02T10:00:00Z',
    lastModified: '2025-05-02T10:00:00Z',
    ...overrides,
  }) as Session;

describe('session switcher sheet', () => {
  afterEach(() => {
    closeSessionSwitcher();
    vi.restoreAllMocks();
  });

  it('lists the other running sessions, most recently active first', () => {
    const list = switcherSessions(
      [
        session('current'),
        session('old', { lastModified: '2025-05-02T09:00:00Z' }),
        session('new', { lastModified: '2025-05-02T11:00:00Z' }),
        session('done', { status: 'exited' }),
      ],
      'current'
    );
    expect(list.map((s) => s.id)).toEqual(['new', 'old']);
  });

  it('switches on a still tap, not at the end of a scroll, and offers Rename', () => {
    const onSelect = vi.fn();
    const onRename = vi.fn();
    openSessionSwitcher({
      current: session('a'),
      sessions: [session('a'), session('b')],
      onSelect,
      onRename,
    });
    const item = () =>
      document.body.querySelector('[data-testid="switcher-item"]') as HTMLButtonElement;
    expect(item().textContent).toContain('shell b');
    const at = (y: number) => ({ pointerType: 'touch', clientX: 40, clientY: y, bubbles: true });
    item().dispatchEvent(new PointerEvent('pointerdown', at(300)));
    item().dispatchEvent(new PointerEvent('pointerup', at(200)));
    expect(onSelect).not.toHaveBeenCalled();
    item().dispatchEvent(new PointerEvent('pointerdown', at(300)));
    item().dispatchEvent(new PointerEvent('pointerup', at(302)));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
    expect(document.body.querySelector('[data-testid="session-switcher"]')).toBeNull();

    // The tap above swallows the click that follows it; this is a new gesture.
    resetGhostClickGuard();
    openSessionSwitcher({ current: session('a'), sessions: [session('a')], onSelect, onRename });
    expect(document.body.textContent).toContain('No other sessions running');
    (document.body.querySelector('[data-testid="switcher-rename"]') as HTMLButtonElement).click();
    expect(onRename).toHaveBeenCalledTimes(1);
  });
});
