// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../shared/types.js';
import type { PhoneSessionRow } from './phone-session-row.js';
import './phone-session-row.js';

const session = (overrides: Partial<Session> = {}): Session =>
  ({
    id: 's1',
    name: 'claude (~/app)',
    command: ['claude'],
    workingDir: '/Users/test/app',
    status: 'running',
    startedAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
    ...overrides,
  }) as Session;

async function renderRow(value: Session, shieldAvailable = true) {
  return fixture<PhoneSessionRow>(
    html`<phone-session-row .session=${value} .shieldAvailable=${shieldAvailable}></phone-session-row>`
  );
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

describe('PhoneSessionRow shielding', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.querySelector('.psr-sheet-cancel')?.dispatchEvent(new Event('click'));
    for (const host of document.body.querySelectorAll('.psr-sheet')) host.parentElement?.remove();
  });

  it('shields a running Claude session after a confirm step, and marks shielded rows', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ sessionId: 's2', replaced: true }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const row = await renderRow(session({ claudeSessionId: 'c1' }));
    const created = vi.fn();
    row.addEventListener('session-created', created);
    vi.useFakeTimers();
    (row.querySelector('.psr-menu') as HTMLButtonElement).click();
    vi.advanceTimersByTime(600);
    const shield = document.body.querySelector('[data-testid="psr-shield"]') as HTMLButtonElement;
    // A scroll that ends on the button is not a tap.
    touch(shield, -100);
    expect(document.body.querySelector('[data-testid="psr-shield-confirm"]')).toBeNull();
    shield.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch' }));
    shield.click();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.body.querySelector('.psr-sheet-title')?.textContent).toContain(
      'Claude restarts in a shielded session'
    );
    const confirm = document.body.querySelector(
      '[data-testid="psr-shield-confirm"]'
    ) as HTMLButtonElement;
    // The tap that opened the confirm step can't also confirm it.
    confirm.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch' }));
    expect(fetchMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    confirm.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch' }));
    confirm.click();
    vi.useRealTimers();
    await vi.waitFor(() => expect(created).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/sessions/s1/shield');

    row.session = session({ shielded: true });
    await row.updateComplete;
    expect(row.querySelector('[data-testid="psr-shield-badge"]')?.textContent).toBe('🛡');
    expect(row.querySelector('[role="button"]')?.getAttribute('aria-label')).toContain('Shielded');
    vi.useFakeTimers();
    vi.advanceTimersByTime(3000);
    (row.querySelector('.psr-menu') as HTMLButtonElement).click();
    vi.advanceTimersByTime(600);
    // Already shielded: no Shield action, just what it means.
    expect(document.body.querySelector('[data-testid="psr-shield"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="psr-shield-info"]')).not.toBeNull();
  });

  it('offers no Shield action without tmux on the server, nor for a vt terminal session', async () => {
    for (const [value, available] of [
      [session(), false],
      [session({ id: 'fwd_1700000000000_42' }), true],
      [session({ name: 'tmux: main', command: ['tmux', 'attach', '-t', 'main'] }), true],
    ] as const) {
      const row = await renderRow(value, available);
      vi.useFakeTimers();
      (row.querySelector('.psr-menu') as HTMLButtonElement).click();
      vi.advanceTimersByTime(600);
      expect(document.body.querySelector('[data-testid="psr-shield"]')).toBeNull();
      document.body.querySelector('.psr-sheet-cancel')?.dispatchEvent(new Event('click'));
      vi.useRealTimers();
    }
  });

  it('flags a shielded session restored after a restart, for a day while it runs', async () => {
    const row = await renderRow(
      session({ shielded: true, restoredAt: new Date(Date.now() - 60_000).toISOString() })
    );
    expect(row.querySelector('[data-testid="psr-restored-badge"]')).not.toBeNull();
    expect(row.querySelector('[role="button"]')?.getAttribute('aria-label')).toContain(
      'Restored after a restart'
    );
    row.session = session({
      shielded: true,
      restoredAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await row.updateComplete;
    expect(row.querySelector('[data-testid="psr-restored-badge"]')).toBeNull();
  });
});
