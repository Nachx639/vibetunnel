/**
 * Session switcher sheet (compact phone layout)
 *
 * Opened from the session header's title: lists the other running sessions like the phone
 * list rows (avatar, name, folder), most recent first, so you can jump between sessions
 * without going back to the list. Also holds Rename for the current session.
 *
 * Rendered into <body>: position:fixed inside a transformed ancestor (the phone sidebar,
 * the session view) would be fixed to that ancestor instead of the screen.
 */

import { html, nothing, render } from 'lit';
import type { Session } from '../../../shared/types.js';
import { t } from '../../i18n/index.js';
import { swallowNextClick } from '../../utils/ghost-click.js';
import { formatPathForDisplay } from '../../utils/path-utils.js';
import { holdSheetFocus } from '../../utils/sheet-a11y.js';
import { renderToolAvatar } from '../phone-session-row.js';

/** Finger travel that makes a touch a scroll of the list, not a tap on an item. */
const TAP_SLOP_PX = 10;

export function sessionDisplayTitle(session: Session): string {
  const command = Array.isArray(session.command) ? session.command.join(' ') : '';
  return session.name || command;
}

/** Other running sessions, most recently active first. */
export function switcherSessions(sessions: Session[], currentId: string): Session[] {
  const time = (session: Session) => Date.parse(session.lastModified || session.startedAt) || 0;
  return sessions
    .filter((session) => session.id !== currentId && session.status === 'running')
    .sort((a, b) => time(b) - time(a));
}

export interface SessionSwitcherOptions {
  current: Session;
  sessions: Session[];
  onSelect: (session: Session) => void;
  onRename?: () => void;
}

let openHost: HTMLElement | null = null;
let releaseFocus: (() => void) | null = null;

export function closeSessionSwitcher(): void {
  if (!openHost) return;
  render(nothing, openHost);
  openHost.remove();
  openHost = null;
  releaseFocus?.();
  releaseFocus = null;
}

export function openSessionSwitcher(options: SessionSwitcherOptions): void {
  closeSessionSwitcher();
  const host = document.createElement('div');
  host.dataset.testid = 'session-switcher';
  document.body.appendChild(host);
  openHost = host;
  const openedAt = Date.now();

  // Touch acts on pointerup: on iOS the first tap on freshly shown buttons is often taken
  // as a hover and produces no click. The click that may still follow is ignored; mouse and
  // keyboard use the click. A touch that moved (scrolling the list) is not a tap.
  let touchActedAt = 0;
  let down: { x: number; y: number } | null = null;
  const act = (fn: () => void) => ({
    handleEvent: (e: Event) => {
      if (e.type === 'pointerdown') {
        const p = e as PointerEvent;
        down = { x: p.clientX, y: p.clientY };
        return;
      }
      if (e.type === 'pointerup') {
        const p = e as PointerEvent;
        if (p.pointerType === 'mouse') return;
        const moved = down && Math.hypot(p.clientX - down.x, p.clientY - down.y) > TAP_SLOP_PX;
        down = null;
        if (moved) return;
        touchActedAt = Date.now();
        swallowNextClick();
      } else if (Date.now() - touchActedAt < 700) {
        return;
      }
      closeSessionSwitcher();
      fn();
    },
  });

  const others = switcherSessions(options.sessions, options.current.id);
  const item = (session: Session) => {
    const handler = act(() => options.onSelect(session));
    return html`
      <button
        class="vt-switch-item"
        data-testid="switcher-item"
        data-session-id=${session.id}
        @pointerdown=${handler}
        @pointerup=${handler}
        @click=${handler}
      >
        ${renderToolAvatar(session, 40)}
        <span class="vt-switch-body">
          <span class="vt-switch-title"><bdi>${sessionDisplayTitle(session)}</bdi></span>
          <span class="vt-switch-detail"
            ><span class="psr-path" dir="ltr">${formatPathForDisplay(session.workingDir)}</span></span
          >
        </span>
      </button>
    `;
  };
  const rename = options.onRename ? act(options.onRename) : null;

  render(
    html`
      <div
        class="psr-sheet-backdrop"
        @click=${() => {
          // The click finishing the tap that opened the sheet can land on the new backdrop.
          if (Date.now() - openedAt > 400) closeSessionSwitcher();
        }}
      ></div>
      <div class="psr-sheet" role="dialog" aria-modal="true" aria-label=${t('switcher.title')}>
        <div class="psr-sheet-group">
          <div class="psr-sheet-title">${t('switcher.title')}</div>
          ${
            others.length
              ? html`<div class="vt-switch-list">${others.map(item)}</div>`
              : html`<div class="vt-switch-empty">${t('switcher.empty')}</div>`
          }
        </div>
        ${
          rename
            ? html`<div class="psr-sheet-group">
                <button
                  data-testid="switcher-rename"
                  @pointerdown=${rename}
                  @pointerup=${rename}
                  @click=${rename}
                >
                  ${t('switcher.renameCurrent')}
                </button>
              </div>`
            : nothing
        }
        <button class="psr-sheet-cancel" @click=${closeSessionSwitcher}>${t('common.cancel')}</button>
      </div>
    `,
    host
  );
  releaseFocus = holdSheetFocus(
    host.querySelector<HTMLElement>('.psr-sheet'),
    closeSessionSwitcher
  );
  requestAnimationFrame(() => host.querySelector('.psr-sheet')?.classList.add('open'));
}
