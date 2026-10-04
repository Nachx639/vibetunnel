/**
 * @vitest-environment happy-dom
 */
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { render } from 'lit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../shared/types.js';
import { sessionActionService } from '../services/session-action-service.js';
import { formatRowTime, type PhoneSessionRow, sessionTool } from './phone-session-row.js';
import './phone-session-row.js';

const session = (overrides: Partial<Session> = {}): Session =>
  ({
    id: 's1',
    name: 'build (~/Projects/app)',
    command: ['zsh'],
    workingDir: '/Users/test/Projects/app',
    status: 'running',
    startedAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
    ...overrides,
  }) as Session;

async function renderRow(value: Session) {
  return fixture<PhoneSessionRow>(html`<phone-session-row .session=${value}></phone-session-row>`);
}

/** A finger down on `el` and up `dy` px away: iOS ends a scroll that began on it with a pointerup. */
function touch(el: Element, dy: number) {
  const at = (y: number) => ({
    pointerType: 'touch',
    pointerId: 7,
    clientX: 40,
    clientY: y,
    bubbles: true,
  });
  el.dispatchEvent(new PointerEvent('pointerdown', at(300)));
  el.dispatchEvent(new PointerEvent('pointerup', at(300 + dy)));
}

describe('PhoneSessionRow', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.querySelector('.psr-sheet-cancel')?.dispatchEvent(new Event('click'));
    for (const host of document.body.querySelectorAll('.psr-sheet')) host.parentElement?.remove();
  });

  it('reads as one named button whose ⋯ button stays outside it', async () => {
    const row = await renderRow(session());
    const main = row.querySelector('[role="button"]') as HTMLElement;
    expect(main.getAttribute('aria-label')).toMatch(
      /^zsh, build \(~\/Projects\/app\), now, .*Projects\/app$/
    );
    expect(main.querySelector('button')).toBeNull();
    expect(row.querySelector('.psr-menu')?.getAttribute('aria-label')).toBe(
      'Actions for build (~/Projects/app)'
    );
  });

  it('opens the action sheet as a modal and gives focus back to the ⋯ button', async () => {
    const row = await renderRow(session());
    const menu = row.querySelector('.psr-menu') as HTMLButtonElement;
    menu.focus();
    menu.click();
    const sheet = document.body.querySelector('.psr-sheet') as HTMLElement;
    expect(sheet.getAttribute('aria-modal')).toBe('true');
    expect(sheet.contains(document.activeElement) || document.activeElement === sheet).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.body.querySelector('.psr-sheet')).toBeNull();
    expect(document.activeElement).toBe(menu);
  });

  it('opens on tap; a long press offers actions instead of opening', async () => {
    vi.useFakeTimers();
    const row = await renderRow(session());
    const select = vi.fn();
    row.addEventListener('session-select', select);
    const target = row.querySelector('.psr') as HTMLElement;

    target.dispatchEvent(new Event('pointerdown'));
    target.click();
    expect(select).toHaveBeenCalledTimes(1);

    target.dispatchEvent(new Event('pointerdown'));
    vi.advanceTimersByTime(600);
    target.click();
    expect(select).toHaveBeenCalledTimes(1);

    const sheet = document.body.querySelector('.psr-sheet');
    expect(sheet?.textContent).toContain('Kill session');
    vi.advanceTimersByTime(600); // past the guard against the tap that opened the sheet
    (sheet?.querySelector('button') as HTMLButtonElement | null)?.click(); // "Open"
    expect(select).toHaveBeenCalledTimes(2);
    expect(document.body.querySelector('.psr-sheet')).toBeNull();
  });

  it('asks before killing a running session from the action sheet', async () => {
    const del = vi
      .spyOn(sessionActionService, 'deleteSession')
      .mockResolvedValue({ success: true } as never);
    const row = await renderRow(session({ name: 'Fix login' }));
    vi.useFakeTimers();
    (row.querySelector('.psr-menu') as HTMLButtonElement).click();
    vi.advanceTimersByTime(600);
    const kill = [...document.body.querySelectorAll('.psr-sheet button')].find((b) =>
      b.textContent?.includes('Kill session')
    ) as HTMLButtonElement;
    kill.click();
    expect(del).not.toHaveBeenCalled();
    const confirm = document.body.querySelector('[data-testid="psr-kill-confirm"]');
    expect(document.body.querySelector('.psr-sheet-title')?.textContent).toContain(
      'Kill “Fix login”?'
    );
    // The tap that opened the confirm step can't also confirm it.
    (confirm as HTMLButtonElement).click();
    expect(del).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    (confirm as HTMLButtonElement).click();
    expect(del).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('.psr-sheet')).toBeNull();
    del.mockRestore();
  });

  it('clears an exited session from the sheet without a confirm step', async () => {
    const del = vi
      .spyOn(sessionActionService, 'deleteSession')
      .mockResolvedValue({ success: true } as never);
    const row = await renderRow(session({ status: 'exited' }));
    vi.useFakeTimers();
    (row.querySelector('.psr-menu') as HTMLButtonElement).click();
    vi.advanceTimersByTime(600);
    const buttons = [...document.body.querySelectorAll('.psr-sheet-group button')];
    expect(buttons.map((b) => b.textContent?.trim())).toEqual([
      'Open',
      'Pin to top',
      'Clear session',
    ]);
    (buttons[2] as HTMLButtonElement).click();
    expect(del).toHaveBeenCalledTimes(1);
    del.mockRestore();
  });

  it('pins from the action sheet on a touch pointerup, ignoring the trailing click', async () => {
    const row = await renderRow(session());
    const toggle = vi.fn();
    row.addEventListener('session-pin-toggle', toggle);
    vi.useFakeTimers();
    (row.querySelector('.psr-menu') as HTMLButtonElement).click();
    const pin = () => document.body.querySelector('[data-testid="psr-pin"]') as HTMLButtonElement;
    // The tap that opened the sheet can't pin.
    pin().dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch' }));
    expect(toggle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(pin().textContent?.trim()).toBe('Pin to top');
    // A scroll of the sheet that started on the button is no tap.
    touch(pin(), -100);
    expect(toggle).not.toHaveBeenCalled();
    const button = pin();
    button.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch' }));
    button.click();
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(toggle.mock.calls[0][0].detail).toEqual({ sessionId: 's1', pinned: true });
    expect(document.body.querySelector('.psr-sheet')).toBeNull();

    row.pinned = true;
    await row.updateComplete;
    expect(row.querySelector('.psr-flag')?.textContent).toBe('📌');
    vi.advanceTimersByTime(1000);
    (row.querySelector('.psr-menu') as HTMLButtonElement).click();
    vi.advanceTimersByTime(600);
    expect(pin().textContent?.trim()).toBe('Unpin');
    pin().click();
    expect(toggle.mock.calls[1][0].detail).toEqual({ sessionId: 's1', pinned: false });
  });

  it("a sheet action's trailing click doesn't open the row that was under the sheet", async () => {
    const row = await renderRow(session());
    const select = vi.fn();
    row.addEventListener('session-select', select);
    vi.useFakeTimers();
    (row.querySelector('.psr-menu') as HTMLButtonElement).click();
    vi.advanceTimersByTime(600);
    (document.body.querySelector('[data-testid="psr-pin"]') as HTMLButtonElement).dispatchEvent(
      new PointerEvent('pointerup', { pointerType: 'touch' })
    );
    // iOS's click lands where the finger was: now the row under the closed sheet.
    (row.querySelector('.psr') as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true })
    );
    expect(select).not.toHaveBeenCalled();
  });

  it('renames the session from a prompt that starts with its name', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const prompt = vi.fn(() => 'release build');
    vi.stubGlobal('prompt', prompt);
    try {
      const row = await renderRow(session());
      row.authClient = { getAuthHeader: () => ({}) } as never;
      const renamed = vi.fn();
      row.addEventListener('session-renamed', renamed);
      vi.useFakeTimers();
      (row.querySelector('.psr-menu') as HTMLButtonElement).click();
      vi.advanceTimersByTime(600);
      (document.body.querySelector('[data-testid="psr-rename"]') as HTMLButtonElement).click();
      vi.useRealTimers();
      await vi.waitFor(() => expect(renamed).toHaveBeenCalled());
      expect(prompt).toHaveBeenCalledWith('New name', 'build (~/Projects/app)');
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('/api/sessions/s1');
      expect(JSON.parse(String(init.body))).toEqual({ name: 'release build' });
      expect(renamed.mock.calls[0][0].detail).toEqual({
        sessionId: 's1',
        newName: 'release build',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a sideways swipe reveals Kill (still confirmed) without opening; a vertical drag does not', async () => {
    const row = await renderRow(session());
    vi.useFakeTimers();
    const select = vi.fn();
    row.addEventListener('session-select', select);
    const target = row.querySelector('.psr') as HTMLElement;
    const drag = async (dx: number, dy: number) => {
      const at = (x: number, y: number) => ({
        clientX: x,
        clientY: y,
        pointerId: 1,
        bubbles: true,
      });
      target.dispatchEvent(new PointerEvent('pointerdown', at(300, 100)));
      target.dispatchEvent(new PointerEvent('pointermove', at(300 + dx / 2, 100 + dy / 2)));
      target.dispatchEvent(new PointerEvent('pointermove', at(300 + dx, 100 + dy)));
      target.dispatchEvent(new PointerEvent('pointerup', at(300 + dx, 100 + dy)));
      target.click();
      await row.updateComplete;
    };

    await drag(-10, -120); // a scroll
    expect(target.style.transform).toBe('');
    expect(select).toHaveBeenCalledTimes(1);

    await drag(-150, 8);
    expect(target.style.transform).toBe('translateX(-168px)');
    expect(select).toHaveBeenCalledTimes(1);

    // A touch acts on pointerup (iOS may never send the click); the click that follows,
    // landing on the new sheet's backdrop, neither repeats the action nor closes the sheet.
    const kill = row.querySelector('[data-testid="psr-swipe-kill"]') as HTMLButtonElement;
    touch(kill, -100);
    expect(document.body.querySelector('.psr-sheet')).toBeNull();
    kill.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true }));
    kill.click();
    (document.body.querySelector('.psr-sheet-backdrop') as HTMLElement).click();
    expect(document.body.querySelector('[data-testid="psr-kill-confirm"]')).toBeTruthy();
    expect(document.body.querySelectorAll('.psr-sheet')).toHaveLength(1);
    vi.advanceTimersByTime(600);
    (document.body.querySelector('.psr-sheet-cancel') as HTMLButtonElement).click();
  });

  it('knows which program a session runs, through shell wrappers and paths', () => {
    expect(sessionTool({ command: ['zsh', '-lic', 'claude --resume x'] })).toBe('claude');
    expect(sessionTool({ command: ['/opt/homebrew/bin/gemini'] })).toBe('gemini');
    expect(sessionTool({ command: ['zsh'] })).toBe('zsh');
    // `codex` typed in a shell, as the server reports with agent chat on.
    expect(sessionTool({ command: ['zsh'], codexActive: true })).toBe('codex');
  });

  it('keeps its time current without new session data, on one shared timer', async () => {
    fixtureCleanup(); // rows left by earlier tests would own the (real) shared timer
    vi.useFakeTimers({ now: new Date('2025-05-02T10:30:00') });
    const value = session({ lastModified: new Date('2025-05-02T10:30:00').toISOString() });
    const rows = document.createElement('div');
    document.body.append(rows);
    render(
      html`<phone-session-row .session=${value}></phone-session-row>
        <phone-session-row .session=${session({ id: 's2' })}></phone-session-row>`,
      rows
    );
    const row = rows.querySelector('phone-session-row') as PhoneSessionRow;
    await row.updateComplete;
    const time = () => row.querySelector('.psr-time')?.textContent?.trim();
    const rowRender = vi.spyOn(row, 'render');
    expect(time()).toBe('now');
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(5 * 60_000);
    expect(time()).toBe('5 min');
    expect(rowRender).not.toHaveBeenCalled();

    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    vi.advanceTimersByTime(5 * 60_000);
    expect(time()).toBe('5 min'); // paused while the page is hidden
    delete (document as { hidden?: boolean }).hidden;
    vi.advanceTimersByTime(30_000);
    expect(time()).toBe('10 min');

    rows.remove();
    vi.runOnlyPendingTimers(); // each row's one-shot sheet check after disconnecting
    expect(vi.getTimerCount()).toBe(0);
  });

  it('formats times like a chat list', () => {
    const now = new Date('2025-05-02T10:30:00');
    expect(formatRowTime('2025-05-02T10:29:40', now)).toBe('now');
    expect(formatRowTime('2025-05-02T10:05:00', now)).toBe('25 min');
    expect(formatRowTime(undefined, now)).toBe('');
  });
});
