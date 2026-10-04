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
    const rename = { value: 'shell a', save: vi.fn(async () => undefined) };
    openSessionSwitcher({
      current: session('a'),
      sessions: [session('a'), session('b')],
      onSelect,
      rename,
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
    openSessionSwitcher({ current: session('a'), sessions: [session('a')], onSelect, rename });
    expect(document.body.textContent).toContain('No other sessions running');
    expect(document.body.querySelector('[data-testid="switcher-rename"]')).not.toBeNull();
  });

  describe('inline rename', () => {
    const renameInput = () =>
      document.body.querySelector<HTMLInputElement>(
        '[data-testid="rename-input"]'
      ) as HTMLInputElement;
    const start = async (save: (name: string) => Promise<string | undefined>) => {
      resetGhostClickGuard();
      const prompt = vi.fn();
      vi.stubGlobal('prompt', prompt);
      openSessionSwitcher({
        current: session('a'),
        sessions: [session('a'), session('b')],
        onSelect: vi.fn(),
        rename: { value: 'shell a', save },
      });
      document.body.querySelector<HTMLButtonElement>('[data-testid="switcher-rename"]')?.click();
      await vi.waitFor(() => expect(renameInput()).not.toBeNull());
      return prompt;
    };
    afterEach(() => vi.unstubAllGlobals());

    it('the row becomes a field that starts with the name; Enter saves and closes', async () => {
      const save = vi.fn(async () => undefined);
      const prompt = await start(save);
      expect(document.body.querySelector('[data-testid="switcher-rename"]')).toBeNull();
      expect(renameInput().value).toBe('shell a');
      expect(document.activeElement).toBe(renameInput());

      renameInput().value = 'api server';
      renameInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await vi.waitFor(() =>
        expect(document.body.querySelector('[data-testid="session-switcher"]')).toBeNull()
      );
      expect(save).toHaveBeenCalledWith('api server');
      expect(prompt).not.toHaveBeenCalled();
    });

    it('Cancel and Escape turn the field back into the Rename row, the sheet still open', async () => {
      const save = vi.fn(async () => undefined);
      await start(save);
      document.body.querySelector<HTMLButtonElement>('[data-testid="rename-cancel"]')?.click();
      expect(document.body.querySelector('[data-testid="switcher-rename-field"]')).toBeNull();
      expect(document.body.querySelector('[data-testid="switcher-rename"]')).not.toBeNull();

      document.body.querySelector<HTMLButtonElement>('[data-testid="switcher-rename"]')?.click();
      await vi.waitFor(() => expect(renameInput()).not.toBeNull());
      // Escape belongs to the field (sheet-a11y lets it through): only the rename ends.
      renameInput().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
      expect(document.body.querySelector('[data-testid="switcher-rename"]')).not.toBeNull();
      expect(document.body.querySelector('[data-testid="session-switcher"]')).not.toBeNull();
      expect(save).not.toHaveBeenCalled();
    });

    it('a failed rename says why in the field and keeps the sheet open', async () => {
      await start(async () => 'Failed to rename session: Rename failed: 500');
      renameInput().value = 'api server';
      document.body.querySelector<HTMLButtonElement>('[data-testid="rename-ok"]')?.click();
      await vi.waitFor(() =>
        expect(
          document.body.querySelector('[data-testid="rename-error"]')?.textContent?.trim()
        ).toBe('Failed to rename session: Rename failed: 500')
      );
      expect(document.body.querySelector('[data-testid="switcher-rename-field"]')).not.toBeNull();
    });
  });
});
