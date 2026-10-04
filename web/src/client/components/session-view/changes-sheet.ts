/**
 * Changes (phones): what changed in the session's git repository since the last commit, so
 * the user can review an agent's edits without leaving the session. A list of changed files
 * (status, path, +/- lines); tapping one shows its unified diff, wrapped to the screen.
 *
 * Rendered into <body>: position:fixed inside a transformed ancestor (the session view) would
 * be fixed to that ancestor instead of the screen. All file content goes through Lit text
 * bindings, never innerHTML.
 */

import { html, nothing, render } from 'lit';
import { t } from '../../i18n/index.js';
import { authClient } from '../../services/auth-client.js';
import { Z_INDEX } from '../../utils/constants.js';
import { swallowNextClick } from '../../utils/ghost-click.js';
import { holdSheetFocus } from '../../utils/sheet-a11y.js';

/** The click that finishes the gesture that opened the sheet must not hit its buttons. */
const OPEN_GUARD_MS = 500;
const TAP_SLOP_PX = 10;

export type ChangeStatus = 'M' | 'A' | 'D' | 'R' | 'T' | '??';

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

interface ChangesResponse {
  isGitRepo: boolean;
  repoPath?: string;
  files: ChangedFile[];
  totals: { files: number; additions: number; deletions: number };
  untrackedTruncated?: boolean;
}

interface FileDiffResponse {
  file: string;
  diff: string;
  binary: boolean;
  truncated: boolean;
  untracked: boolean;
}

export type DiffLine =
  | { kind: 'hunk'; text: string }
  | { kind: 'add' | 'del' | 'ctx'; text: string; oldNo?: number; newNo?: number }
  | { kind: 'meta'; text: string };

/** Unified diff → display lines. File headers are dropped; hunks carry line numbers. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  const lines = diff.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      out.push({ kind: 'hunk', text: line });
    } else if (!inHunk || line.startsWith('diff --git ')) {
      inHunk = false;
    } else if (line.startsWith('+')) {
      out.push({ kind: 'add', text: line.slice(1), newNo: newNo++ });
    } else if (line.startsWith('-')) {
      out.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ });
    } else if (line.startsWith('\\')) {
      out.push({ kind: 'meta', text: line });
    } else {
      out.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return out;
}

/** "src/a/b.ts" → ["src/a/", "b.ts"] */
export function splitPath(p: string): [string, string] {
  const i = p.lastIndexOf('/');
  return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
}

const STATUS_LABEL: Record<ChangeStatus, string> = {
  M: 'M',
  A: 'A',
  D: 'D',
  R: 'R',
  T: 'T',
  '??': 'U',
};

function statusClass(status: ChangeStatus): string {
  if (status === 'A' || status === '??') return 'vt-chg-s-add';
  if (status === 'D') return 'vt-chg-s-del';
  if (status === 'R') return 'vt-chg-s-ren';
  return 'vt-chg-s-mod';
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { headers: authClient.getAuthHeader(), signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

let openHost: HTMLElement | null = null;
let releaseFocus: (() => void) | null = null;
let abort: AbortController | null = null;

export function closeChangesSheet(): void {
  if (!openHost) return;
  abort?.abort();
  abort = null;
  render(nothing, openHost);
  openHost.remove();
  openHost = null;
  releaseFocus?.();
  releaseFocus = null;
}

export function isChangesSheetOpen(): boolean {
  return openHost !== null;
}

/** Opens the Changes sheet for the git repository containing `dir`. */
export function openChangesSheet(dir: string): void {
  closeChangesSheet();
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.matches('input, textarea, [contenteditable]')) {
    active.blur();
  }

  const host = document.createElement('div');
  host.dataset.testid = 'changes-sheet';
  document.body.appendChild(host);
  openHost = host;
  const controller = new AbortController();
  abort = controller;
  const openedAt = Date.now();

  let list: ChangesResponse | null = null;
  let listState: 'loading' | 'ready' | 'error' = 'loading';
  let selected: ChangedFile | null = null;
  let diff: FileDiffResponse | null = null;
  let diffState: 'loading' | 'ready' | 'error' = 'loading';
  let listScroll = 0;
  let listSeq = 0;
  let diffSeq = 0;

  // Touch acts on pointerup: on iOS the first tap on freshly shown buttons is often taken
  // as a hover and produces no click. The click that may still follow is ignored; mouse and
  // keyboard use the click. Nothing acts in the first moments after opening.
  let touchActedAt = 0;
  let down: { x: number; y: number } | null = null;
  const act = (fn: () => void) => ({
    handleEvent: (e: Event) => {
      if (e.type === 'pointerdown') {
        const p = e as PointerEvent;
        down = { x: p.clientX, y: p.clientY };
        return;
      }
      if (Date.now() - openedAt < OPEN_GUARD_MS) return;
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
      fn();
    },
  });

  const loadList = async () => {
    const seq = ++listSeq;
    listState = 'loading';
    draw();
    try {
      const data = await getJson<ChangesResponse>(
        `/api/git/changes?path=${encodeURIComponent(dir)}`,
        controller.signal
      );
      if (seq !== listSeq) return;
      list = data;
      listState = 'ready';
    } catch {
      if (controller.signal.aborted || seq !== listSeq) return;
      listState = 'error';
    }
    draw();
  };

  const loadDiff = async (file: ChangedFile) => {
    const seq = ++diffSeq;
    diffState = 'loading';
    diff = null;
    draw();
    const params = new URLSearchParams({ path: dir, file: file.path });
    if (file.oldPath) params.set('oldFile', file.oldPath);
    try {
      const data = await getJson<FileDiffResponse>(
        `/api/git/changes/diff?${params}`,
        controller.signal
      );
      if (seq !== diffSeq || selected !== file) return;
      diff = data;
      diffState = 'ready';
    } catch {
      if (controller.signal.aborted || seq !== diffSeq) return;
      diffState = 'error';
    }
    draw();
  };

  const scroller = () => host.querySelector<HTMLElement>('.vt-chg-body');

  const openFile = (file: ChangedFile) =>
    act(() => {
      listScroll = scroller()?.scrollTop ?? 0;
      selected = file;
      void loadDiff(file);
      const body = scroller();
      if (body) body.scrollTop = 0;
    });

  const goBack = () => {
    selected = null;
    diff = null;
    diffSeq++;
    draw();
    const body = scroller();
    if (body) body.scrollTop = listScroll;
  };
  const back = act(goBack);
  const refresh = act(() => {
    if (selected) void loadDiff(selected);
    else void loadList();
  });
  const close = act(closeChangesSheet);
  const renderPath = (p: string) => {
    const [dirPart, base] = splitPath(p);
    return html`<span class="vt-chg-dir">${dirPart}</span><span class="vt-chg-base">${base}</span>`;
  };

  const renderCounts = (f: { additions: number; deletions: number; binary?: boolean }) =>
    f.binary
      ? html`<span class="vt-chg-bin">bin</span>`
      : html`<span class="vt-chg-plus">+${f.additions}</span>
          <span class="vt-chg-minus">−${f.deletions}</span>`;

  const renderList = () => {
    if (listState === 'loading' && !list) {
      return html`<div class="vt-chg-note">${t('changes.loading')}</div>`;
    }
    if (listState === 'error') {
      return html`<div class="vt-chg-note">${t('changes.error')}</div>`;
    }
    if (!list) return nothing;
    if (!list.isGitRepo) {
      return html`<div class="vt-chg-note" data-testid="changes-not-repo">
        ${t('changes.notRepo')}
      </div>`;
    }
    if (list.files.length === 0) {
      return html`<div class="vt-chg-note" data-testid="changes-empty">${t('changes.empty')}</div>`;
    }
    const { totals } = list;
    return html`
      <div class="vt-chg-summary" data-testid="changes-summary">
        <span>
          ${
            totals.files === 1
              ? t('changes.summaryOne')
              : t('changes.summaryMany', { count: totals.files })
          }
        </span>
        ${renderCounts(totals)}
      </div>
      <ul class="vt-chg-list" role="list">
        ${list.files.map(
          (f) => html`
            <li>
              <button
                class="vt-chg-row"
                data-testid="changes-file"
                @pointerdown=${openFile(f)}
                @pointerup=${openFile(f)}
                @click=${openFile(f)}
              >
                <span class="vt-chg-status ${statusClass(f.status)}">${STATUS_LABEL[f.status]}</span>
                <span class="vt-chg-path" dir="ltr">${renderPath(f.path)}</span>
                <span class="vt-chg-counts">${renderCounts(f)}</span>
              </button>
            </li>
          `
        )}
      </ul>
      ${
        list.untrackedTruncated
          ? html`<div class="vt-chg-note">${t('changes.untrackedMore')}</div>`
          : nothing
      }
    `;
  };

  const renderDiff = (file: ChangedFile) => {
    const header = html`
      <div class="vt-chg-summary">
        <span class="vt-chg-status ${statusClass(file.status)}">${STATUS_LABEL[file.status]}</span>
        <span class="vt-chg-path" dir="ltr">${renderPath(file.path)}</span>
        <span class="vt-chg-counts">${renderCounts(file)}</span>
      </div>
      ${
        file.oldPath
          ? html`<div class="vt-chg-note vt-chg-left" dir="ltr">
              ${t('changes.renamedFrom', { path: file.oldPath })}
            </div>`
          : nothing
      }
    `;
    if (diffState === 'loading') {
      return html`${header}<div class="vt-chg-note">${t('changes.loading')}</div>`;
    }
    if (diffState === 'error' || !diff) {
      return html`${header}<div class="vt-chg-note">${t('changes.error')}</div>`;
    }
    if (diff.binary) {
      return html`${header}<div class="vt-chg-note">${t('changes.binary')}</div>`;
    }
    const lines = parseUnifiedDiff(diff.diff);
    if (lines.length === 0) {
      return html`${header}<div class="vt-chg-note">${t('changes.noDiff')}</div>`;
    }
    return html`
      ${header}
      <div class="vt-chg-diff" dir="ltr" data-testid="changes-diff">
        ${lines.map((l) => {
          if (l.kind === 'hunk') return html`<div class="vt-dl vt-dl-hunk">${l.text}</div>`;
          if (l.kind === 'meta') return html`<div class="vt-dl vt-dl-meta">${l.text}</div>`;
          const no = l.kind === 'del' ? l.oldNo : l.newNo;
          const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ';
          return html`<div class="vt-dl vt-dl-${l.kind}"><span class="vt-dl-no">${no}</span><span class="vt-dl-sign">${sign}</span><span class="vt-dl-text">${l.text}</span></div>`;
        })}
      </div>
      ${diff.truncated ? html`<div class="vt-chg-note">${t('changes.truncated')}</div>` : nothing}
    `;
  };

  const draw = () => {
    if (openHost !== host) return;
    const loading = selected ? diffState === 'loading' : listState === 'loading';
    render(
      html`
        <style>
          .vt-chg {
            position: fixed;
            inset: 0;
            display: flex;
            flex-direction: column;
            background: var(--color-bg);
            color: var(--color-text);
            padding: env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);
            --vt-chg-add: var(--color-status-success);
            --vt-chg-del: var(--color-status-error);
            --vt-chg-add-text: color-mix(in srgb, var(--color-status-success) 65%, var(--color-text));
            --vt-chg-del-text: color-mix(in srgb, var(--color-status-error) 70%, var(--color-text));
          }
          .vt-chg-bar {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 12px;
            border-bottom: 1px solid var(--color-border);
            background: var(--color-bg-secondary);
          }
          .vt-chg-title {
            flex: 1;
            min-width: 0;
            font-weight: 600;
            font-size: 15px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .vt-chg-bar button {
            min-height: 40px;
            min-width: 40px;
            padding: 0 12px;
            border-radius: 8px;
            font-size: 14px;
            border: 1px solid var(--color-border);
            color: var(--color-text);
            background: var(--color-bg-tertiary);
            touch-action: manipulation;
          }
          .vt-chg-bar button:disabled {
            opacity: 0.5;
          }
          .vt-chg-body {
            flex: 1;
            overflow: auto;
            overscroll-behavior: contain;
            -webkit-overflow-scrolling: touch;
            padding-bottom: calc(16px + env(safe-area-inset-bottom));
          }
          .vt-chg-summary {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 10px 12px;
            font-size: 13px;
            color: var(--color-text-muted);
            border-bottom: 1px solid var(--color-border);
          }
          .vt-chg-summary > span:first-child {
            flex: 0 0 auto;
          }
          .vt-chg-list {
            list-style: none;
            margin: 0;
            padding: 0;
          }
          .vt-chg-row {
            display: flex;
            align-items: center;
            gap: 10px;
            width: 100%;
            min-height: 48px;
            padding: 8px 12px;
            text-align: left;
            border-bottom: 1px solid var(--color-border);
            color: var(--color-text);
            background: transparent;
            touch-action: manipulation;
          }
          .vt-chg-row:active {
            background: var(--color-surface-hover);
          }
          .vt-chg-status {
            flex: 0 0 auto;
            width: 22px;
            text-align: center;
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-weight: 700;
            font-size: 13px;
          }
          .vt-chg-s-add { color: var(--vt-chg-add-text); }
          .vt-chg-s-del { color: var(--vt-chg-del-text); }
          .vt-chg-s-mod { color: var(--color-status-warning-text, var(--color-status-warning)); }
          .vt-chg-s-ren { color: var(--color-status-info-text, var(--color-status-info)); }
          .vt-chg-path {
            flex: 1;
            min-width: 0;
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-size: 13px;
            overflow-wrap: anywhere;
            text-align: left;
          }
          .vt-chg-dir { color: var(--color-text-dim); }
          .vt-chg-base { color: var(--color-text); }
          .vt-chg-counts {
            flex: 0 0 auto;
            display: flex;
            gap: 6px;
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-size: 12px;
          }
          .vt-chg-plus { color: var(--vt-chg-add-text); }
          .vt-chg-minus { color: var(--vt-chg-del-text); }
          .vt-chg-bin { color: var(--color-text-dim); }
          .vt-chg-note {
            padding: 20px 16px;
            text-align: center;
            font-size: 14px;
            color: var(--color-text-dim);
          }
          .vt-chg-note.vt-chg-left {
            padding: 6px 12px;
            text-align: left;
            font-size: 12px;
            overflow-wrap: anywhere;
          }
          .vt-chg-diff {
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-size: 12px;
            line-height: 1.45;
            user-select: text;
            -webkit-user-select: text;
          }
          .vt-dl {
            display: flex;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            word-break: break-word;
            padding-right: 8px;
          }
          .vt-dl-add { background: color-mix(in srgb, var(--vt-chg-add) 20%, var(--color-bg)); }
          .vt-dl-del { background: color-mix(in srgb, var(--vt-chg-del) 20%, var(--color-bg)); }
          .vt-dl-hunk, .vt-dl-meta {
            padding: 4px 8px;
            color: var(--color-text-muted);
            background: var(--color-bg-secondary);
          }
          .vt-dl-hunk {
            margin-top: 6px;
            border-top: 1px solid var(--color-border);
            border-bottom: 1px solid var(--color-border);
          }
          .vt-dl-no {
            flex: 0 0 auto;
            min-width: 3.2em;
            padding: 0 6px 0 4px;
            text-align: right;
            color: var(--color-text-dim);
            user-select: none;
            -webkit-user-select: none;
          }
          .vt-dl-sign {
            flex: 0 0 auto;
            width: 1.2em;
            user-select: none;
            -webkit-user-select: none;
          }
          .vt-dl-add .vt-dl-sign { color: var(--vt-chg-add-text); }
          .vt-dl-del .vt-dl-sign { color: var(--vt-chg-del-text); }
          .vt-dl-text {
            flex: 1;
            min-width: 0;
          }
        </style>
        <div
          class="vt-chg"
          role="dialog"
          aria-modal="true"
          aria-label=${t('changes.title')}
          style="z-index: ${Z_INDEX.MODAL};"
        >
          <div class="vt-chg-bar">
            ${
              selected
                ? html`<button
                    data-testid="changes-back"
                    aria-label=${t('changes.back')}
                    @pointerdown=${back}
                    @pointerup=${back}
                    @click=${back}
                  >
                    ‹ ${t('changes.back')}
                  </button>`
                : nothing
            }
            <div class="vt-chg-title" dir="auto">
              ${selected ? splitPath(selected.path)[1] : t('changes.title')}
            </div>
            <button
              data-testid="changes-refresh"
              aria-label=${t('changes.refresh')}
              title=${t('changes.refresh')}
              ?disabled=${loading}
              @pointerdown=${refresh}
              @pointerup=${refresh}
              @click=${refresh}
            >
              ↻
            </button>
            <button
              data-testid="changes-close"
              @pointerdown=${close}
              @pointerup=${close}
              @click=${close}
            >
              ${t('changes.close')}
            </button>
          </div>
          <div class="vt-chg-body">${selected ? renderDiff(selected) : renderList()}</div>
        </div>
      `,
      host
    );
  };

  draw();
  // Escape steps back from a diff to the list, then closes.
  releaseFocus = holdSheetFocus(host.querySelector<HTMLElement>('.vt-chg'), () => {
    if (selected) goBack();
    else closeChangesSheet();
  });
  void loadList();
}
