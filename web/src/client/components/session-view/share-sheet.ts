/**
 * Read-only share links: a link that shows this session's screen, live, to whoever has it and
 * can reach this server, without the VibeTunnel login and without any way to type into it,
 * until it expires or is revoked (server: routes/share.ts). Off unless the server enables it
 * (`shareLinks` in config.json or `--share-links`); the session menus only offer it then
 * (shareLinksAvailable). The sheet lists the session's live links (copy, share, revoke) and
 * creates new ones for 15 min, 1 h or 8 h.
 *
 * Rendered into <body> like the other phone sheets: position:fixed inside the transformed
 * session view would be fixed to the view instead of the screen.
 */
import { html, nothing, render } from 'lit';
import { t } from '../../i18n/index.js';
import { authClient } from '../../services/auth-client.js';
import { swallowNextClick } from '../../utils/ghost-click.js';
import { endsADrag } from '../../utils/pointer-drag.js';
import { holdSheetFocus } from '../../utils/sheet-a11y.js';

/** The click that finishes the gesture that opened the sheet must not hit its buttons. */
const OPEN_GUARD_MS = 500;
export const SHARE_DURATIONS_MIN = [15, 60, 480] as const;

export interface ShareItem {
  token: string;
  path: string;
  createdAt: number;
  expiresAt: number;
}

let openHost: HTMLElement | null = null;
let releaseFocus: (() => void) | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;

let availability: { at: number; on: Promise<boolean> } | null = null;
const AVAILABILITY_TTL_MS = 60_000;

/**
 * Whether the server has share links turned on (`shareLinks` in GET /api/config). Asked at
 * most once a minute; any failure counts as off, so the menu entry stays hidden.
 */
export function shareLinksAvailable(): Promise<boolean> {
  const now = Date.now();
  if (availability && now - availability.at < AVAILABILITY_TTL_MS) return availability.on;
  const on = Promise.resolve()
    .then(() => fetch('/api/config', { headers: authClient.getAuthHeader() }))
    .then((response) => (response?.ok ? response.json() : null))
    .then((config: { shareLinks?: unknown } | null) => config?.shareLinks === true)
    .catch(() => false);
  availability = { at: now, on };
  return on;
}

/** Test hook: forget the cached answer of shareLinksAvailable(). */
export function resetShareLinksAvailability(): void {
  availability = null;
}

export function isShareSheetOpen(): boolean {
  return openHost !== null;
}

export function closeShareSheet(): void {
  if (ticker) clearInterval(ticker);
  ticker = null;
  releaseFocus?.();
  releaseFocus = null;
  if (!openHost) return;
  render(nothing, openHost);
  openHost.remove();
  openHost = null;
}

/** "58 min", "8 h": time left of a link. */
export function formatTimeLeft(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes >= 90
    ? t('share.hours', { n: Math.round(minutes / 60) })
    : t('share.minutes', { n: minutes });
}

/** The full link the other person opens: this page's origin plus the link's path. */
export function shareUrl(item: Pick<ShareItem, 'path'>): string {
  return `${window.location.origin}${item.path}`;
}

export function openShareSheet(sessionId: string, sessionName: string): void {
  closeShareSheet();
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.matches('input, textarea, [contenteditable]')) {
    active.blur();
  }
  const host = document.createElement('div');
  host.dataset.testid = 'share-sheet';
  document.body.appendChild(host);
  openHost = host;
  const openedAt = Date.now();

  let shares: ShareItem[] | null = null;
  let busy = false;
  let error = '';
  let copied: string | null = null;
  const canNativeShare = typeof navigator.share === 'function';

  const api = (path: string, init: RequestInit = {}) =>
    fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...authClient.getAuthHeader() },
    });

  // Touch acts on pointerup (iOS takes the first tap on fresh buttons as a hover); the click
  // that follows is swallowed. Nothing acts in the first moments after opening.
  let touchActedAt = 0;
  const act = (fn: () => void) => ({
    handleEvent: (e: Event) => {
      if (Date.now() - openedAt < OPEN_GUARD_MS) return;
      if (e.type === 'pointerup') {
        if ((e as PointerEvent).pointerType === 'mouse') return;
        // A scroll of the sheet that started on a button ends here too: not a tap.
        if (endsADrag(e as PointerEvent)) return;
        touchActedAt = Date.now();
        swallowNextClick();
      } else if (e.type === 'click' && Date.now() - touchActedAt < 700) {
        return;
      }
      fn();
    },
  });

  const load = async () => {
    try {
      const response = await api(`/api/sessions/${encodeURIComponent(sessionId)}/shares`);
      const body = await response.json();
      shares = Array.isArray(body.shares) ? body.shares : [];
    } catch {
      shares = [];
    }
    draw();
  };

  const create = async (minutes: number) => {
    if (busy) return;
    busy = true;
    error = '';
    draw();
    try {
      const response = await api(`/api/sessions/${encodeURIComponent(sessionId)}/shares`, {
        method: 'POST',
        body: JSON.stringify({ minutes }),
      });
      const body = await response.json();
      if (!response.ok || !body.share) throw new Error(body.error || response.statusText);
      shares = [body.share as ShareItem, ...(shares ?? [])];
    } catch {
      error = t('share.error');
    } finally {
      busy = false;
      draw();
    }
  };

  const revoke = async (item: ShareItem) => {
    shares = (shares ?? []).filter((share) => share.token !== item.token);
    draw();
    await api(`/api/shares/${encodeURIComponent(item.token)}`, { method: 'DELETE' }).catch(
      () => {}
    );
  };

  const copy = async (item: ShareItem) => {
    try {
      await navigator.clipboard.writeText(shareUrl(item));
      copied = item.token;
      draw();
      setTimeout(() => {
        if (copied === item.token) {
          copied = null;
          draw();
        }
      }, 1800);
    } catch {
      // No clipboard (insecure origin): the link stays selectable on screen.
    }
  };

  const nativeShare = (item: ShareItem) => {
    void navigator.share({ title: sessionName, url: shareUrl(item) }).catch(() => {});
  };

  const close = act(() => closeShareSheet());

  const draw = () => {
    if (openHost !== host) return;
    const now = Date.now();
    render(
      html`
        <div class="psr-sheet-backdrop" @pointerup=${close} @click=${close}></div>
        <div class="psr-sheet open" role="dialog" aria-modal="true" aria-label=${t('share.title')}>
          <div class="psr-sheet-group">
            <div class="psr-sheet-title question">${t('share.explain')}</div>
            ${
              shares === null
                ? html`<div class="vt-share-row vt-share-muted">${t('share.loading')}</div>`
                : shares.map(
                    (item) => html`
                      <div class="vt-share-row" data-testid="share-link">
                        <div class="vt-share-url">${shareUrl(item)}</div>
                        <div class="vt-share-muted">
                          ${t('share.expiresIn', { time: formatTimeLeft(item.expiresAt - now) })}
                        </div>
                        <div class="vt-share-actions">
                          <button data-testid="share-copy" @pointerup=${act(() => void copy(item))} @click=${act(() => void copy(item))}>
                            ${copied === item.token ? t('share.copied') : t('share.copy')}
                          </button>
                          ${
                            canNativeShare
                              ? html`<button data-testid="share-native" @pointerup=${act(() => nativeShare(item))} @click=${act(() => nativeShare(item))}>
                                  ${t('share.share')}
                                </button>`
                              : nothing
                          }
                          <button class="vt-share-danger" data-testid="share-revoke" @pointerup=${act(() => void revoke(item))} @click=${act(() => void revoke(item))}>
                            ${t('share.revoke')}
                          </button>
                        </div>
                      </div>
                    `
                  )
            }
            <div class="vt-share-row">
              <div class="vt-share-muted">${t('share.newLink')}</div>
              <div class="vt-share-actions">
                ${SHARE_DURATIONS_MIN.map(
                  (minutes) => html`
                    <button data-testid="share-create-${minutes}" ?disabled=${busy} @pointerup=${act(() => void create(minutes))} @click=${act(() => void create(minutes))}>
                      ${t(minutes === 15 ? 'share.d15' : minutes === 60 ? 'share.d60' : 'share.d480')}
                    </button>
                  `
                )}
              </div>
              ${error ? html`<div class="vt-share-error" role="alert">${error}</div>` : nothing}
            </div>
          </div>
          <button class="psr-sheet-cancel" @pointerup=${close} @click=${close}>${t('common.close')}</button>
        </div>
      `,
      host
    );
  };

  draw();
  releaseFocus = holdSheetFocus(host.querySelector<HTMLElement>('.psr-sheet'), () =>
    closeShareSheet()
  );
  // "Expires in …" stays current while the sheet is open.
  ticker = setInterval(draw, 30_000);
  void load();
}
