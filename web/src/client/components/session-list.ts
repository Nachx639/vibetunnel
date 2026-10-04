/**
 * Session List Component
 *
 * Displays a grid of session cards and manages the session creation modal.
 * Handles session filtering (hide/show exited) and cleanup operations.
 *
 * @fires navigate-to-session - When a session is selected (detail: { sessionId: string })
 * @fires refresh - When session list needs refreshing
 * @fires error - When an error occurs (detail: string)
 * @fires session-created - When a new session is created (detail: { sessionId: string, message?: string })
 * @fires create-modal-close - When create modal should close
 * @fires hide-exited-change - When hide exited state changes (detail: boolean)
 * @fires kill-all-sessions - When all sessions should be killed
 *
 * @listens session-killed - From session-card when a session is killed
 * @listens session-kill-error - From session-card when kill fails
 * @listens clean-exited-sessions - To trigger cleanup of exited sessions
 */
import { html, LitElement, nothing, render } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import type { Session } from '../../shared/types.js';
import { HttpMethod } from '../../shared/types.js';
import { LocaleController, t } from '../i18n/index.js';
import type { AuthClient } from '../services/auth-client.js';
import type { Worktree } from '../services/git-service.js';
import './phone-session-row.js';
import './preview-row.js';
import './session-card.js';
import './inline-edit.js';
import './session-list/compact-session-card.js';
import './session-list/repository-header.js';
import './clickable-path.js';
import './git-status-badge.js';
import { getBaseRepoName } from '../../shared/utils/git.js';
import type { QuickStartCommand } from '../../types/config.js';
import { serverConfigService } from '../services/server-config-service.js';
import { parseCommand } from '../utils/command-utils.js';
import { Z_INDEX } from '../utils/constants.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { createLogger } from '../utils/logger.js';
import { formatPathForDisplay } from '../utils/path-utils.js';
import { PHONE_UI_CHANGED_EVENT, usesCompactPhoneUi } from '../utils/phone-ui.js';
import { loadPinned, pinnedFirst, setPinned } from '../utils/pinned-sessions.js';
import { endsADrag } from '../utils/pointer-drag.js';
import {
  addPreview,
  announcePreviewsChanged,
  fetchPreviewCandidates,
  isPreviewRowHighlighted,
  PREVIEW_HIGHLIGHT_MS,
  type PreviewCandidate,
  type PreviewItem,
  previewCandidateLabel,
  previewLabel,
  sortPreviews,
} from '../utils/preview-rows.js';
import { holdSheetFocus } from '../utils/sheet-a11y.js';

const logger = createLogger('session-list');

/** After a repository's worktrees fail to load, ask again at most this often. */
const WORKTREE_RETRY_MS = 60_000;

/**
 * What the phone "new session" flow remembers between visits: the last tool you started and
 * the folders you worked in, so they survive clearing the sessions they came from.
 */
const PHONE_STARTS_KEY = 'vt-phone-recent-starts';
const MAX_RECENT_FOLDERS = 6;

interface PhoneStarts {
  tool?: string;
  folders?: string[];
}

function readPhoneStarts(): PhoneStarts {
  try {
    const value = JSON.parse(localStorage.getItem(PHONE_STARTS_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function writePhoneStarts(update: PhoneStarts) {
  try {
    localStorage.setItem(PHONE_STARTS_KEY, JSON.stringify({ ...readPhoneStarts(), ...update }));
  } catch {
    // Private mode or blocked storage: the sheet just falls back to current sessions.
  }
}

/**
 * The compact phone layout (Settings > Phone layout) on a phone: a chat-style list of rows
 * instead of cards, sidebar included. Off by default: phones keep the cards.
 */
export function isPhoneListLayout(): boolean {
  return usesCompactPhoneUi();
}

@customElement('session-list')
export class SessionList extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  @property({ type: Array }) sessions: Session[] = [];
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) hideExited = true;
  @property({ type: Object }) authClient!: AuthClient;
  @property({ type: String }) selectedSessionId: string | null = null;
  @property({ type: Boolean }) compactMode = false;
  @property({ type: String }) activeSessionId: string | null = null;
  /** Dev-server previews are on for this server (`--preview-port`): their section shows. */
  @property({ type: Boolean }) previewsEnabled = false;
  /** Persistent previews (GET /api/previews), fetched by the app with the sessions. */
  @property({ attribute: false }) previews: PreviewItem[] = [];

  @state() private cleaningExited = false;
  @state() private repoFollowMode = new Map<string, string | undefined>();
  @state() private loadingFollowMode = new Set<string>();
  @state() private showFollowDropdown = new Map<string, boolean>();
  @state() private repoWorktrees = new Map<string, Worktree[]>();
  /** When loading a repo's worktrees last failed (see WORKTREE_RETRY_MS). */
  private worktreeFailures = new Map<string, number>();
  @state() private loadingWorktrees = new Set<string>();
  @state() private showWorktreeDropdown = new Map<string, boolean>();

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('resize', this.placeFab);
    window.addEventListener(PHONE_UI_CHANGED_EVENT, this.handlePhoneUiChanged);
    // Make the component focusable
    this.tabIndex = 0;
    // Add keyboard listener only to this component
    this.addEventListener('keydown', this.handleKeyDown);
    // Add click outside listener for dropdowns
    document.addEventListener('click', this.handleClickOutside);
    window.addEventListener('vt-preview-highlight', this.handlePreviewHighlight);
  }

  private handlePhoneUiChanged = () => this.requestUpdate();

  /** `vt preview`: the row glows for a moment (and is already first: newest preview on top). */
  private handlePreviewHighlight = () => {
    this.requestUpdate();
    setTimeout(() => this.requestUpdate(), PREVIEW_HIGHLIGHT_MS + 50);
  };

  /** Rows deleted here, hidden until the next poll no longer lists them. */
  @state() private deletedPreviews = new Set<string>();

  private handlePreviewDeleted = (e: CustomEvent<{ id: string }>) => {
    this.deletedPreviews = new Set(this.deletedPreviews).add(e.detail.id);
  };

  private addingPreview = false;

  /**
   * "+ Add preview": the web servers listening on the server's computer, one tap each (so a
   * phone user doesn't have to remember the port), then "Other port or URL…" to type one.
   */
  private async openAddPreviewSheet() {
    if (this.addingPreview) return;
    this.addingPreview = true;
    let candidates: PreviewCandidate[] = [];
    try {
      candidates = (await fetchPreviewCandidates(this.authClient?.getAuthHeader() ?? {})) ?? [];
    } finally {
      this.addingPreview = false;
    }
    if (!this.isConnected) return;
    this.showSheet(t(candidates.length ? 'previewRows.serversTitle' : 'previewRows.noServers'), [
      ...candidates.map((candidate) => ({
        label: previewCandidateLabel(candidate),
        mono: true,
        run: () => void this.addPreviewTarget(String(candidate.port)),
      })),
      // An action, not a server: no `mono`, like "Other folder…" in the folder sheets.
      { label: t('previewRows.otherTarget'), run: () => this.promptAddPreview() },
    ]);
  }

  /** "Other port or URL…": a port or a localhost URL, typed, no session needed. */
  private promptAddPreview() {
    const target = window.prompt(t('previewRows.addPrompt'), '')?.trim();
    if (target) void this.addPreviewTarget(target);
  }

  private async addPreviewTarget(target: string) {
    if (this.addingPreview) return;
    this.addingPreview = true;
    try {
      const result = await addPreview(target, this.authClient?.getAuthHeader() ?? {});
      if (result.error) {
        this.dispatchEvent(
          new CustomEvent('error', {
            detail: t('previewRows.addFailed', { error: result.error }),
          })
        );
      }
      announcePreviewsChanged();
    } finally {
      this.addingPreview = false;
    }
  }

  private addTouchedAt = 0;

  /**
   * "Previews": one row per saved preview, above the sessions (they outlive the session that
   * opened them). Previews are few and a different kind of thing (a page, not a
   * conversation); mixed into the sessions' state order they'd move around. Pinned first,
   * then the newest. The heading's "+" offers the servers on the computer, or a port or
   * localhost URL typed; in the sidebar opened from a session the section shows only when
   * there is something in it. Nothing at all while the server has previews off.
   */
  private renderPreviewSection(query = '') {
    if (!this.previewsEnabled) return nothing;
    const q = query.trim().toLowerCase();
    const all = sortPreviews(this.previews ?? []).filter(
      (item) => !this.deletedPreviews.has(item.id)
    );
    const rows = all.filter(
      (item) =>
        !q ||
        `${previewLabel(item)} ${item.title ?? ''} ${item.sessionName ?? ''} ${item.port}`
          .toLowerCase()
          .includes(q)
    );
    if (!rows.length && (this.compactMode || q)) return nothing;
    const add = (e: Event) => {
      e.stopPropagation();
      if (e.type === 'pointerup') {
        if ((e as PointerEvent).pointerType === 'mouse') return;
        // A scroll that started on the button ends here too: not a tap.
        if (endsADrag(e as PointerEvent)) return;
        this.addTouchedAt = Date.now();
        swallowNextClick();
      } else if (Date.now() - this.addTouchedAt < 700) {
        return;
      }
      void this.openAddPreviewSheet();
    };
    return html`
      <div class="pvr-header">
        <h3 class="pvr-heading" data-testid="preview-rows-heading">${t('previewRows.heading')}</h3>
        <button
          class="pvr-add"
          type="button"
          data-testid="preview-add"
          @pointerup=${add}
          @click=${add}
        >
          ${t('previewRows.add')}
        </button>
      </div>
      ${
        rows.length
          ? html`<div
              class="psr-list pvr-list"
              data-testid="preview-rows"
              @preview-deleted=${this.handlePreviewDeleted}
            >
              ${repeat(
                rows,
                (item) => item.id,
                (item) => html`<preview-row
                  .item=${item}
                  .authClient=${this.authClient}
                  .highlighted=${isPreviewRowHighlighted(item.id)}
                ></preview-row>`
              )}
            </div>`
          : html`<div class="pvr-list"></div>`
      }
    `;
  }

  updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);
    this.placeFab();

    // Phone rows show no worktree/follow-mode UI: don't fetch it for them.
    if (changedProperties.has('sessions') && !this.usePhoneRows()) {
      // Load follow mode for all repositories
      this.loadFollowModeForAllRepos();
    }
  }

  private async loadFollowModeForAllRepos() {
    const repoGroups = this.groupSessionsByRepo(this.sessions);
    for (const [repoPath] of repoGroups) {
      if (repoPath && !this.repoWorktrees.has(repoPath)) {
        // loadWorktreesForRepo now also loads follow mode
        this.loadWorktreesForRepo(repoPath);
      }
    }
  }

  /**
   * The floating "+" of the phone list sits 14 px above the bar at the bottom of the list,
   * whatever its height. Without the bar (no sessions) the CSS default applies.
   */
  private placeFab = () => {
    const fab = this.querySelector<HTMLElement>('[data-testid="new-session-fab"]');
    if (!fab) return;
    const footer = this.querySelector<HTMLElement>('[data-testid="session-list-footer"]');
    const top = footer?.getBoundingClientRect().top ?? 0;
    if (!footer || top <= 0 || top >= window.innerHeight) {
      fab.style.removeProperty('bottom');
    } else {
      fab.style.bottom = `${Math.round(window.innerHeight - top + 14)}px`;
    }
    if (footer !== this.observedFooter) {
      this.footerObserver?.disconnect();
      this.observedFooter = footer;
      if (footer && typeof ResizeObserver !== 'undefined') {
        this.footerObserver ??= new ResizeObserver(() => this.placeFab());
        this.footerObserver.observe(footer);
      }
    }
  };
  private footerObserver: ResizeObserver | null = null;
  private observedFooter: HTMLElement | null = null;

  disconnectedCallback() {
    super.disconnectedCallback();
    this.footerObserver?.disconnect();
    this.observedFooter = null;
    window.removeEventListener('resize', this.placeFab);
    window.removeEventListener(PHONE_UI_CHANGED_EVENT, this.handlePhoneUiChanged);
    this.closeSheet();
    this.removeEventListener('keydown', this.handleKeyDown);
    document.removeEventListener('click', this.handleClickOutside);
    window.removeEventListener('vt-preview-highlight', this.handlePreviewHighlight);
  }

  private handleClickOutside = (e: MouseEvent) => {
    const target = e.target as HTMLElement;

    // Check if click is outside any selector
    const isInsideSelector =
      target.closest('[id^="branch-selector-"]') ||
      target.closest('.branch-dropdown') ||
      target.closest('[id^="follow-selector-"]') ||
      target.closest('.follow-dropdown') ||
      target.closest('[id^="worktree-selector-"]') ||
      target.closest('.worktree-dropdown');

    if (!isInsideSelector) {
      if (this.showFollowDropdown.size > 0 || this.showWorktreeDropdown.size > 0) {
        // Create new empty maps to close all dropdowns atomically
        this.showFollowDropdown = new Map<string, boolean>();
        this.showWorktreeDropdown = new Map<string, boolean>();
        this.requestUpdate();
      }
    }
  };

  private getVisibleSessions() {
    const running = this.sessions.filter((s) => s.status === 'running' || s.status === 'starting');
    const exited = this.sessions.filter((s) => s.status === 'exited');
    return this.hideExited ? running : running.concat(exited);
  }

  private getGridColumns(): number {
    // Get the grid container element
    const gridContainer = this.querySelector('.session-flex-responsive');
    if (!gridContainer || this.compactMode) return 1; // Compact mode is single column

    // Get the computed style to check the actual grid columns
    const computedStyle = window.getComputedStyle(gridContainer);
    const templateColumns = computedStyle.getPropertyValue('grid-template-columns');

    // Count the number of columns by splitting the template value
    const columns = templateColumns.split(' ').filter((col) => col && col !== '0px').length;

    // Fallback: calculate based on container width and minimum item width
    if (columns === 0 || columns === 1) {
      const containerWidth = gridContainer.clientWidth;
      const minItemWidth = 280; // From CSS: minmax(280px, 1fr)
      const gap = 20; // 1.25rem = 20px
      return Math.max(1, Math.floor((containerWidth + gap) / (minItemWidth + gap)));
    }

    return columns;
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    const { key } = e;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'].includes(key)) {
      return;
    }

    // Check if we're inside an input element - since we're now listening on the component
    // itself, we need to stop propagation for child inputs
    const target = e.target as HTMLElement;
    if (
      target !== this &&
      (target.closest('input, textarea, select') || target.isContentEditable)
    ) {
      return;
    }

    const sessions = this.getVisibleSessions();
    if (sessions.length === 0) return;

    e.preventDefault();
    e.stopPropagation(); // Prevent event from bubbling up

    let index = this.selectedSessionId
      ? sessions.findIndex((s) => s.id === this.selectedSessionId)
      : 0;
    if (index < 0) index = 0;

    if (key === 'Enter') {
      this.handleSessionSelect({ detail: sessions[index] } as CustomEvent);
      return;
    }

    const columns = this.getGridColumns();

    if (key === 'ArrowLeft') {
      // Move left, wrap to previous row
      index = (index - 1 + sessions.length) % sessions.length;
    } else if (key === 'ArrowRight') {
      // Move right, wrap to next row
      index = (index + 1) % sessions.length;
    } else if (key === 'ArrowUp') {
      // Move up one row
      index = index - columns;
      if (index < 0) {
        // Wrap to the bottom, trying to maintain column position
        const currentColumn = index + columns; // Original index
        const lastRowStart = Math.floor((sessions.length - 1) / columns) * columns;
        index = Math.min(lastRowStart + currentColumn, sessions.length - 1);
      }
    } else if (key === 'ArrowDown') {
      // Move down one row
      const oldIndex = index;
      index = index + columns;
      if (index >= sessions.length) {
        // Wrap to the top, maintaining column position
        const currentColumn = oldIndex % columns;
        index = currentColumn;
      }
    }

    this.selectedSessionId = sessions[index].id;
    this.requestUpdate();

    // Ensure the selected element is visible by scrolling it into view
    setTimeout(() => {
      const selectedCard =
        this.querySelector(`session-card[selected]`) ||
        this.querySelector(`div[class*="bg-bg-elevated"][class*="border-accent-primary"]`);
      if (selectedCard) {
        selectedCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 0);
  };

  private handleSessionSelect(e: CustomEvent) {
    const session = e.detail as Session;

    // Dispatch a custom event that the app can handle with view transitions
    this.dispatchEvent(
      new CustomEvent('navigate-to-session', {
        detail: { sessionId: session.id },
        bubbles: true,
        composed: true,
      })
    );
  }

  private async handleSessionKilled(e: CustomEvent) {
    // The card's event bubbles and is composed: without this the app saw every kill twice
    // (the original plus the re-dispatch below) and refreshed twice as often.
    e.stopPropagation();
    const { sessionId } = e.detail;
    logger.debug(`session ${sessionId} killed, updating session list`);

    // Remove the session from the local state
    this.sessions = this.sessions.filter((session) => session.id !== sessionId);

    // Re-dispatch the event for parent components
    this.dispatchEvent(
      new CustomEvent('session-killed', {
        detail: sessionId,
        bubbles: true,
        composed: true,
      })
    );

    // Then trigger a refresh to get the latest server state
    this.dispatchEvent(new CustomEvent('refresh'));
  }

  private handleSessionKillError(e: CustomEvent) {
    const { sessionId, error } = e.detail;
    logger.error(`failed to kill session ${sessionId}:`, error);

    // Dispatch error event to parent for user notification
    this.dispatchEvent(
      new CustomEvent('error', {
        detail: t('toast.killSessionFailed', { error }),
      })
    );
  }

  private handleSessionRenamed = (e: CustomEvent) => {
    const { sessionId, newName } = e.detail;
    // Update the local session object
    const sessionIndex = this.sessions.findIndex((s) => s.id === sessionId);
    if (sessionIndex >= 0) {
      this.sessions[sessionIndex] = { ...this.sessions[sessionIndex], name: newName };
      this.requestUpdate();
    }
  };

  private handleSessionRenameError = (e: CustomEvent) => {
    const { sessionId, error } = e.detail;
    logger.error(`failed to rename session ${sessionId}:`, error);

    // Dispatch error event to parent for user notification
    this.dispatchEvent(
      new CustomEvent('error', {
        detail: t('toast.renameFailed', { error }),
      })
    );
  };

  public async handleCleanupExited() {
    if (this.cleaningExited) return;

    this.cleaningExited = true;
    this.requestUpdate();

    try {
      const response = await fetch('/api/cleanup-exited', {
        method: HttpMethod.POST,
        headers: {
          ...this.authClient.getAuthHeader(),
        },
      });

      if (response.ok) {
        // Get the list of exited sessions before cleanup
        const exitedSessions = this.sessions.filter((s) => s.status === 'exited');

        // Apply black hole animation to all exited sessions
        if (exitedSessions.length > 0) {
          const sessionCards = this.querySelectorAll('session-card');
          const exitedCards: HTMLElement[] = [];

          sessionCards.forEach((card) => {
            const sessionCard = card as HTMLElement & { session?: { id: string; status: string } };
            if (sessionCard.session?.status === 'exited') {
              exitedCards.push(sessionCard);
            }
          });

          // Apply animation to all exited cards
          exitedCards.forEach((card) => {
            card.classList.add('black-hole-collapsing');
          });

          // Wait for animation to complete
          if (exitedCards.length > 0) {
            await new Promise((resolve) => setTimeout(resolve, 300));
          }

          // Remove all exited sessions at once
          this.sessions = this.sessions.filter((session) => session.status !== 'exited');
        }

        this.dispatchEvent(new CustomEvent('refresh'));
      } else {
        this.dispatchEvent(new CustomEvent('error', { detail: t('sessions.cleanupFailed') }));
      }
    } catch (error) {
      logger.error('error cleaning up exited sessions:', error);
      this.dispatchEvent(new CustomEvent('error', { detail: t('sessions.cleanupFailed') }));
    } finally {
      this.cleaningExited = false;
      this.requestUpdate();
    }
  }

  private groupSessionsByRepo(sessions: Session[]): Map<string | null, Session[]> {
    const groups = new Map<string | null, Session[]>();

    sessions.forEach((session) => {
      // Use gitMainRepoPath to group worktrees with their main repository
      const mainRepo =
        typeof session.gitMainRepoPath === 'string' && session.gitMainRepoPath.length > 0
          ? session.gitMainRepoPath
          : null;
      const repo =
        typeof session.gitRepoPath === 'string' && session.gitRepoPath.length > 0
          ? session.gitRepoPath
          : null;
      const groupKey = mainRepo || repo || null;
      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      const group = groups.get(groupKey);
      if (group) {
        group.push(session);
      }
    });

    // Sort groups: non-git sessions first, then git sessions
    const sortedGroups = new Map<string | null, Session[]>();

    // Add non-git sessions first
    if (groups.has(null)) {
      const nullGroup = groups.get(null);
      if (nullGroup) {
        sortedGroups.set(null, nullGroup);
      }
    }

    // Add git sessions sorted by repo name
    const gitRepos = Array.from(groups.keys()).filter(
      (key): key is string => typeof key === 'string' && key.length > 0
    );
    gitRepos.sort((a, b) => {
      const nameA = this.getRepoName(a);
      const nameB = this.getRepoName(b);
      return nameA.localeCompare(nameB);
    });

    gitRepos.forEach((repo) => {
      const repoGroup = groups.get(repo);
      if (repoGroup) {
        sortedGroups.set(repo, repoGroup);
      }
    });

    return sortedGroups;
  }

  private getRepoName(repoPath: string): string {
    return getBaseRepoName(repoPath);
  }

  private async handleFollowModeChange(repoPath: string, followBranch: string | undefined) {
    this.repoFollowMode.set(repoPath, followBranch);
    // Close all dropdowns for this repo (they might have different section keys)
    const newFollowDropdown = new Map(this.showFollowDropdown);
    for (const [key] of newFollowDropdown) {
      if (key.startsWith(`${repoPath}:`)) {
        newFollowDropdown.delete(key);
      }
    }
    this.showFollowDropdown = newFollowDropdown;
    this.requestUpdate();

    try {
      const response = await fetch('/api/worktrees/follow', {
        method: HttpMethod.POST,
        headers: {
          'Content-Type': 'application/json',
          ...this.authClient.getAuthHeader(),
        },
        body: JSON.stringify({
          repoPath,
          branch: followBranch,
          enable: !!followBranch,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to update follow mode');
      }

      const event = new CustomEvent('show-toast', {
        detail: {
          message: followBranch
            ? t('follow.following', { branch: followBranch.replace(/^refs\/heads\//, '') })
            : t('follow.disabled'),
          type: 'success',
        },
        bubbles: true,
        composed: true,
      });
      this.dispatchEvent(event);
    } catch (error) {
      logger.error('Error updating follow mode:', error);
      const event = new CustomEvent('show-toast', {
        detail: { message: t('follow.updateFailed'), type: 'error' },
        bubbles: true,
        composed: true,
      });
      this.dispatchEvent(event);
    }
  }

  private toggleFollowDropdown(dropdownKey: string) {
    const isOpen = this.showFollowDropdown.get(dropdownKey) || false;

    // Create new maps preserving existing state
    const newFollowDropdown = new Map(this.showFollowDropdown);
    const newWorktreeDropdown = new Map(this.showWorktreeDropdown);

    if (isOpen) {
      // Close this dropdown
      newFollowDropdown.delete(dropdownKey);
    } else {
      // Close all other dropdowns and open this one
      newFollowDropdown.clear();
      newFollowDropdown.set(dropdownKey, true);

      // Extract repo path from dropdown key for loading
      const repoPath = dropdownKey.split(':')[0];
      // Load worktrees and follow mode if not already loaded (the user asked: retry now)
      this.loadWorktreesForRepo(repoPath, true);
    }

    // Close all worktree dropdowns to avoid conflicts
    newWorktreeDropdown.clear();

    // Update state atomically
    this.showFollowDropdown = newFollowDropdown;
    this.showWorktreeDropdown = newWorktreeDropdown;

    this.requestUpdate();
  }

  private renderFollowModeSelector(repoPath: string, sectionType: string = '') {
    const worktrees = this.repoWorktrees.get(repoPath) || [];
    const followMode = this.repoFollowMode.get(repoPath);
    const isLoading = this.loadingFollowMode.has(repoPath);
    const dropdownKey = `${repoPath}:${sectionType}`;
    const isDropdownOpen = this.showFollowDropdown.get(dropdownKey) || false;

    // Get sessions in this repo group to determine current context
    const repoSessions = this.sessions.filter(
      (session) => (session.gitMainRepoPath || session.gitRepoPath) === repoPath
    );

    // The main repository is the one whose path matches the repoPath
    // All other worktrees are linked worktrees in separate directories
    const actualWorktrees = worktrees.filter((wt) => {
      // Normalize paths for comparison (handle macOS /private symlinks)
      const normalizedWorktreePath = wt.path.replace(/^\/private/, '');
      const normalizedRepoPath = repoPath.replace(/^\/private/, '');
      return normalizedWorktreePath !== normalizedRepoPath;
    });

    // Determine if any session in this group is in a worktree (not the main repo)
    const isInWorktree = repoSessions.some((session) => {
      if (!session.workingDir) return false;
      // Check if session is in any actual worktree path
      return actualWorktrees.some((wt) => session.workingDir?.startsWith(wt.path));
    });

    // Show follow mode dropdown if:
    // 1. We're currently in a worktree (affects main repository), OR
    // 2. We're in main repo AND there are actual worktrees to follow
    if (!isInWorktree && actualWorktrees.length === 0) {
      return html``;
    }

    const displayText = followMode
      ? followMode.replace(/^refs\/heads\//, '')
      : t('follow.standalone');

    return html`
      <div class="relative">
        <button
          class="flex items-center gap-1 px-2 py-1 text-xs bg-bg-secondary hover:bg-bg-tertiary rounded-md border border-border transition-colors"
          @click=${() => this.toggleFollowDropdown(dropdownKey)}
          id="follow-selector-${dropdownKey.replace(/[^a-zA-Z0-9]/g, '-')}"
        >
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
              d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
          </svg>
          <span class="font-mono text-xs">${displayText}</span>
          ${
            isLoading
              ? html`<span class="animate-spin">⟳</span>`
              : html`
              <svg class="w-3 h-3 transition-transform ${isDropdownOpen ? 'rotate-180' : ''}" 
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
              </svg>
            `
          }
        </button>
        
        ${
          isDropdownOpen
            ? html`
          <div class="follow-dropdown absolute right-0 mt-1 w-64 bg-bg-elevated border border-border rounded-md shadow-lg max-h-96 overflow-y-auto" style="z-index: ${Z_INDEX.BRANCH_SELECTOR_DROPDOWN}">
            <div class="py-1">
              <button
                class="w-full text-left px-3 py-2 text-xs hover:bg-bg-elevated transition-colors flex items-center justify-between"
                @click=${() => this.handleFollowModeChange(repoPath, undefined)}
              >
                <span class="font-mono ${!followMode ? 'text-accent-primary font-semibold' : ''}">${t('follow.standalone')}</span>
                ${!followMode ? html`<span class="text-accent-primary">✓</span>` : ''}
              </button>
              
              ${actualWorktrees.map(
                (worktree) => html`
                <button
                  class="w-full text-left px-3 py-2 text-xs hover:bg-bg-elevated transition-colors flex items-center justify-between"
                  @click=${() => this.handleFollowModeChange(repoPath, worktree.branch)}
                >
                  <div class="flex flex-col gap-1">
                    <span class="font-mono ${followMode === worktree.branch ? 'text-accent-primary font-semibold' : ''}">
                      ${t('follow.followBranch', { branch: worktree.branch.replace(/^refs\/heads\//, '') })}
                    </span>
                    <span class="text-[10px] text-text-muted">${formatPathForDisplay(worktree.path)}</span>
                  </div>
                  ${followMode === worktree.branch ? html`<span class="text-accent-primary">✓</span>` : ''}
                </button>
              `
              )}
            </div>
          </div>
        `
            : ''
        }
      </div>
    `;
  }

  private async loadWorktreesForRepo(repoPath: string, userRequested = false) {
    if (this.loadingWorktrees.has(repoPath) || this.repoWorktrees.has(repoPath)) {
      return;
    }
    // A repo whose worktrees failed to load was fetched again on every session-list change
    // (with several repos and a 1 s poll, several requests a second); retry once a minute.
    const failedAt = this.worktreeFailures.get(repoPath);
    if (!userRequested && failedAt !== undefined && Date.now() - failedAt < WORKTREE_RETRY_MS) {
      return;
    }

    this.loadingWorktrees.add(repoPath);
    this.requestUpdate();

    try {
      const response = await fetch(`/api/worktrees?${new URLSearchParams({ repoPath })}`, {
        headers: this.authClient.getAuthHeader(),
      });

      if (response.ok) {
        const data = await response.json();
        this.repoWorktrees.set(repoPath, data.worktrees || []);
        // Also set follow mode from the worktrees API response
        this.repoFollowMode.set(repoPath, data.followBranch);
        this.worktreeFailures.delete(repoPath);
      } else {
        this.worktreeFailures.set(repoPath, Date.now());
        logger.error(`Failed to load worktrees for ${repoPath}`);
      }
    } catch (error) {
      this.worktreeFailures.set(repoPath, Date.now());
      logger.error('Error loading worktrees:', error);
    } finally {
      this.loadingWorktrees.delete(repoPath);
      this.requestUpdate();
    }
  }

  private toggleWorktreeDropdown(dropdownKey: string) {
    const isOpen = this.showWorktreeDropdown.get(dropdownKey) || false;

    // Create new maps to avoid intermediate states during update
    const newFollowDropdown = new Map<string, boolean>();
    const newWorktreeDropdown = new Map<string, boolean>();

    // Only set the clicked dropdown if it wasn't already open
    if (!isOpen) {
      newWorktreeDropdown.set(dropdownKey, true);
      // Extract repo path from dropdown key for loading
      const repoPath = dropdownKey.split(':')[0];
      // Load worktrees if not already loaded (the user asked: retry now)
      this.loadWorktreesForRepo(repoPath, true);
    }

    // Update state atomically
    this.showFollowDropdown = newFollowDropdown;
    this.showWorktreeDropdown = newWorktreeDropdown;

    this.requestUpdate();
  }

  private createSessionInWorktree(worktreePath: string) {
    // Close all dropdowns atomically
    this.showWorktreeDropdown = new Map<string, boolean>();
    this.requestUpdate();

    // Dispatch event to open create session dialog with pre-filled path
    const event = new CustomEvent('open-create-dialog', {
      detail: { workingDir: worktreePath },
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);
  }

  private renderWorktreeSelector(repoPath: string, sectionType: string = '') {
    const worktrees = this.repoWorktrees.get(repoPath) || [];
    const isLoading = this.loadingWorktrees.has(repoPath);
    const dropdownKey = `${repoPath}:${sectionType}`;
    const isDropdownOpen = this.showWorktreeDropdown.get(dropdownKey) || false;

    return html`
      <div class="relative">
        <button
          class="flex items-center gap-1 px-2 py-1 text-xs bg-bg-secondary hover:bg-bg-tertiary rounded-md border border-border transition-colors"
          @click=${() => this.toggleWorktreeDropdown(dropdownKey)}
          id="worktree-selector-${dropdownKey.replace(/[^a-zA-Z0-9]/g, '-')}"
          title=${t('worktrees.button')}
        >
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
              d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          <span class="font-mono">${worktrees.length || 0}</span>
          ${
            isLoading
              ? html`<span class="animate-spin">⟳</span>`
              : html`
              <svg class="w-3 h-3 transition-transform ${isDropdownOpen ? 'rotate-180' : ''}" 
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
              </svg>
            `
          }
        </button>
        
        ${
          isDropdownOpen
            ? html`
          <div class="worktree-dropdown absolute right-0 mt-1 w-96 bg-bg-elevated border border-border rounded-md shadow-lg max-h-96 overflow-y-auto" style="z-index: ${Z_INDEX.BRANCH_SELECTOR_DROPDOWN}">
            ${
              worktrees.length === 0 && !isLoading
                ? html`<div class="px-3 py-2 text-xs text-text-muted">${t('worktrees.noneFound')}</div>`
                : html`
                <div class="py-1">
                  ${worktrees.map(
                    (worktree) => html`
                    <div class="border-b border-border last:border-b-0">
                      <div class="px-3 py-2">
                        <div class="flex items-center justify-between gap-2">
                          <div class="flex items-center gap-2 min-w-0 flex-1">
                            <svg class="w-3 h-3 text-text-muted flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
                                d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m9.632 4.684C18.114 15.938 18 15.482 18 15c0-.482.114-.938.316-1.342m0 2.684a3 3 0 110-2.684M15 9a3 3 0 11-6 0 3 3 0 016 0z" />
                            </svg>
                            <div class="font-mono text-sm truncate">
                              ${worktree.branch.replace(/^refs\/heads\//, '')}
                            </div>
                            ${
                              worktree.detached
                                ? html`
                              <span class="text-[10px] px-1.5 py-0.5 bg-status-warning/20 text-status-warning rounded flex-shrink-0">
                                ${t('worktrees.detached')}
                              </span>
                            `
                                : ''
                            }
                          </div>
                          <button
                            class="p-1 hover:bg-bg-elevated rounded transition-colors flex-shrink-0"
                            @click=${() => this.createSessionInWorktree(worktree.path)}
                            title=${t('worktrees.newSessionHere')}
                          >
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                            </svg>
                          </button>
                        </div>
                        <div class="text-[10px] text-text-muted truncate pl-5">${worktree.path}</div>
                      </div>
                    </div>
                  `
                  )}
                </div>
              `
            }
          </div>
        `
            : ''
        }
      </div>
    `;
  }

  render() {
    // Group sessions by status
    const runningSessions = this.sessions.filter(
      (session) => session.status === 'running' || session.status === 'starting'
    );
    const exitedSessions = this.sessions.filter((session) => session.status === 'exited');

    const hasRunningSessions = runningSessions.length > 0;
    const hasExitedSessions = exitedSessions.length > 0;
    const showExitedSection = !this.hideExited && hasExitedSessions;

    // Track session index for numbering
    let sessionIndex = 0;

    return html`
      <div class="font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary focus:ring-offset-2 focus:ring-offset-bg-primary rounded-lg" data-testid="session-list-container">
        ${this.renderActiveSessionInfo()}
        <div class="p-4 pt-5 ${this.usePhoneRows() && !this.compactMode ? 'phone-list-fab-room' : ''}">
        ${
          !hasRunningSessions && (!hasExitedSessions || this.hideExited)
            ? this.usePhoneRows() && !this.compactMode && !this.loading
              ? this.renderPhoneEmpty(exitedSessions.length)
              : html`
              <div class="text-text-muted text-center py-8">
                ${
                  this.loading
                    ? t('sessions.loadingList')
                    : this.hideExited && this.sessions.length > 0
                      ? html`
                        <div class="space-y-4 max-w-2xl mx-auto text-left">
                          <div class="text-lg font-semibold text-text">
                            ${t('sessions.empty.noRunning')}
                          </div>
                          <div class="text-sm text-text-muted">
                            ${t('sessions.empty.exitedHidden')}
                          </div>
                        </div>
                      `
                      : html`
                        <div class="space-y-6 max-w-2xl mx-auto text-left">
                          <div class="text-lg font-semibold text-text">
                            ${t('sessions.empty.title')}
                          </div>

                          <div class="space-y-3">
                            <div class="text-sm text-text-muted">
                              ${t('sessions.empty.getStartedBefore')}
                              <code class="bg-bg-secondary px-2 py-1 rounded">vt</code>
                              ${t('sessions.empty.getStartedAfter')}
                            </div>

                            <div
                              class="bg-bg-secondary p-4 rounded-lg font-mono text-xs space-y-2"
                              dir="ltr"
                            >
                              <div class="text-status-success">vt pnpm run dev</div>
                              <div class="text-text-muted pl-4"># ${t('sessions.empty.exampleDevServer')}</div>

                              <div class="text-status-success">vt claude --dangerously...</div>
                              <div class="text-text-muted pl-4">
                                # ${t('sessions.empty.exampleAgents')}
                              </div>

                              <div class="text-status-success">vt --shell</div>
                              <div class="text-text-muted pl-4">
                                # ${t('sessions.empty.exampleShell')}
                              </div>

                              <div class="text-status-success">vt python train.py</div>
                              <div class="text-text-muted pl-4">
                                # ${t('sessions.empty.exampleScripts')}
                              </div>
                            </div>
                          </div>

                          <div class="space-y-3 border-t border-border pt-4">
                            <div class="text-sm font-semibold text-text">
                              ${t('sessions.empty.cliMissing')}
                            </div>
                            <div class="text-sm text-text-muted space-y-1">
                              <div>→ ${t('sessions.empty.cliStep1')}</div>
                              <div>→ ${t('sessions.empty.cliStep2')}</div>
                            </div>
                          </div>

                          <div class="text-xs text-text-muted mt-4">
                            ${t('sessions.empty.onceInstalledBefore')}
                            <code class="bg-bg-secondary px-1 rounded">vt</code>
                            ${t('sessions.empty.onceInstalledAfter')}
                          </div>
                        </div>
                      `
                }
              </div>
            `
            : this.usePhoneRows()
              ? this.renderPhoneRows(runningSessions, showExitedSection ? exitedSessions : [])
              : html`
              <!-- Running Sessions -->
              ${
                hasRunningSessions
                  ? html`
                    <div class="mb-6 mt-2">
                      <h3 class="text-xs font-semibold text-text-muted uppercase tracking-wider mb-4">
                        ${t('sessions.running')} <span class="text-text-dim">(${runningSessions.length})</span>
                      </h3>
                      ${Array.from(this.groupSessionsByRepo(runningSessions)).map(
                        ([repoPath, repoSessions]) => html`
                          <div class="${repoPath ? 'mb-6 mt-6' : 'mb-4'}">
                            ${
                              repoPath
                                ? html`
                                  <repository-header
                                    .repoPath=${repoPath}
                                    .followMode=${this.repoFollowMode.get(repoPath)}
                                    .followModeSelector=${this.renderFollowModeSelector(repoPath, 'running')}
                                    .worktreeSelector=${this.renderWorktreeSelector(repoPath, 'running')}
                                  ></repository-header>
                                `
                                : ''
                            }
                            <div class="${this.compactMode ? '' : 'session-flex-responsive'} relative">
                              ${repeat(
                                repoSessions,
                                (session) => session.id,
                                (session) => {
                                  const currentIndex = ++sessionIndex;
                                  return html`
                    ${
                      this.compactMode
                        ? html`
                          <compact-session-card
                            .session=${session}
                            .authClient=${this.authClient}
                            .selected=${session.id === this.selectedSessionId}
                            .sessionType=${'running'}
                            .sessionNumber=${currentIndex}
                            @session-select=${this.handleSessionSelect}
                            @session-rename=${this.handleSessionRenamed}
                            @session-delete=${this.handleSessionKilled}
                          ></compact-session-card>
                        `
                        : html`
                          <!-- Full session card for main view -->
                          <session-card
                            .session=${session}
                            .authClient=${this.authClient}
                            .selected=${session.id === this.selectedSessionId}
                            @session-select=${this.handleSessionSelect}
                            @session-killed=${this.handleSessionKilled}
                            @session-kill-error=${this.handleSessionKillError}
                            @session-renamed=${this.handleSessionRenamed}
                            @session-rename-error=${this.handleSessionRenameError}
                          >
                          </session-card>
                        `
                    }
                  `;
                                }
                              )}
                            </div>
                          </div>
                        `
                      )}
                    </div>
                  `
                  : ''
              }
              
              <!-- Exited Sessions -->
              ${
                showExitedSection && hasExitedSessions
                  ? html`
                    <div class="${!hasRunningSessions ? 'mt-2' : ''}">
                      <h3 class="text-xs font-semibold text-text-muted uppercase tracking-wider mb-4">
                        ${t('sessions.exited')} <span class="text-text-dim">(${exitedSessions.length})</span>
                      </h3>
                      ${Array.from(this.groupSessionsByRepo(exitedSessions)).map(
                        ([repoPath, repoSessions]) => html`
                          <div class="${repoPath ? 'mb-6 mt-6' : 'mb-4'}">
                            ${
                              repoPath
                                ? html`
                                  <repository-header
                                    .repoPath=${repoPath}
                                    .followMode=${this.repoFollowMode.get(repoPath)}
                                    .followModeSelector=${this.renderFollowModeSelector(repoPath, 'exited')}
                                    .worktreeSelector=${this.renderWorktreeSelector(repoPath, 'exited')}
                                  ></repository-header>
                                `
                                : ''
                            }
                            <div class="${this.compactMode ? '' : 'session-flex-responsive'} relative">
                              ${repeat(
                                repoSessions,
                                (session) => session.id,
                                (session) => {
                                  const currentIndex = ++sessionIndex;
                                  return html`
                            ${
                              this.compactMode
                                ? html`
                                  <compact-session-card
                                    .session=${session}
                                    .authClient=${this.authClient}
                                    .selected=${session.id === this.selectedSessionId}
                                    .sessionType=${'exited'}
                                    .sessionNumber=${currentIndex}
                                    @session-select=${this.handleSessionSelect}
                                    @session-cleanup=${this.handleSessionKilled}
                                  ></compact-session-card>
                                `
                                : html`
                                  <!-- Full session card for main view -->
                                  <session-card
                                    .session=${session}
                                    .authClient=${this.authClient}
                                    .selected=${session.id === this.selectedSessionId}
                                    @session-select=${this.handleSessionSelect}
                                    @session-killed=${this.handleSessionKilled}
                                    @session-kill-error=${this.handleSessionKillError}
                                    @session-renamed=${this.handleSessionRenamed}
                                    @session-rename-error=${this.handleSessionRenameError}
                                          >
                                  </session-card>
                                `
                            }
                          `;
                                }
                              )}
                            </div>
                          </div>
                        `
                      )}
                    </div>
                  `
                  : ''
              }
            `
        }
        </div>

        ${this.renderExitedControls()}
      </div>
    `;
  }

  /** The compact phone layout: chat-style rows (phone-session-row) instead of cards. */
  private usePhoneRows(): boolean {
    return isPhoneListLayout();
  }

  @state() private phoneQuery = '';
  /** Sessions pinned on this device (utils/pinned-sessions.ts): first in the phone list. */
  @state() private pinnedIds = loadPinned();

  private handlePinToggle = (e: CustomEvent<{ sessionId: string; pinned: boolean }>) => {
    this.pinnedIds = setPinned(e.detail.sessionId, e.detail.pinned);
  };

  /** Search over what a row shows: name, folder and command. */
  private matchesQuery(session: Session, rawQuery: string): boolean {
    const query = rawQuery.trim().toLowerCase();
    if (!query) return true;
    return [session.name, session.workingDir, session.command?.join(' ')].some((field) =>
      field?.toLowerCase().includes(query)
    );
  }

  /**
   * Running sessions, newest first, pinned ones on top. By start time: lastModified changes
   * with every output burst and would shuffle rows under the user's finger on each poll.
   */
  private orderRunning(sessions: Session[]): Session[] {
    const started = (session: Session) => new Date(session.startedAt || 0).getTime();
    return pinnedFirst(
      [...sessions].sort((a, b) => started(b) - started(a)),
      this.pinnedIds
    );
  }

  private renderPhoneRow(session: Session) {
    return html`
      <phone-session-row
        .session=${session}
        .authClient=${this.authClient}
        .selected=${session.id === this.selectedSessionId}
        .pinned=${this.pinnedIds.has(session.id)}
        .stamp=${`${session.status}|${session.name}|${session.lastModified}`}
        @session-select=${this.handleSessionSelect}
        @session-killed=${this.handleSessionKilled}
        @session-kill-error=${this.handleSessionKillError}
        @session-renamed=${this.handleSessionRenamed}
        @session-rename-error=${this.handleSessionRenameError}
        @session-pin-toggle=${this.handlePinToggle}
      ></phone-session-row>
    `;
  }

  private renderPhoneRows(allRunning: Session[], allExited: Session[]) {
    // Count every session, hidden finished ones included (2 running + 30 finished needs search).
    const searchable = this.sessions.length > 6;
    // A query only filters while its box is visible; otherwise it could hide sessions with no
    // way to clear it.
    const query = searchable ? this.phoneQuery : '';
    const running = allRunning.filter((session) => this.matchesQuery(session, query));
    // While searching, finished sessions are searched too even if the list hides them.
    const exitedPool = query.trim()
      ? this.sessions.filter((session) => session.status === 'exited')
      : allExited;
    const exited = exitedPool.filter((session) => this.matchesQuery(session, query));
    const recency = (session: Session) =>
      new Date(session.lastModified || session.startedAt || 0).getTime();
    const row = (session: Session) => this.renderPhoneRow(session);
    return html`
      ${this.compactMode ? '' : this.renderNewChatButton()}
      ${
        searchable
          ? html`<div class="phone-search">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
              <input
                type="search"
                enterkeyhint="search"
                autocapitalize="off"
                autocorrect="off"
                autocomplete="off"
                placeholder=${t('sessions.search')}
                aria-label=${t('sessions.search')}
                .value=${this.phoneQuery}
                @input=${(e: Event) => {
                  this.phoneQuery = (e.target as HTMLInputElement).value;
                }}
              />
            </div>`
          : ''
      }
      ${
        // Also in the sidebar opened from inside a session (compact): that's where the user
        // looks while working.
        this.renderPreviewSection(query)
      }
      ${
        query.trim() && !running.length && !exited.length
          ? html`<div class="phone-search-empty">${t('sessions.searchEmpty')}</div>`
          : ''
      }
      ${
        running.length
          ? html`<div class="psr-list" data-testid="phone-session-list">
              ${repeat(this.orderRunning(running), (session) => session.id, row)}
            </div>`
          : ''
      }
      ${
        exited.length
          ? html`
            <div class="flex items-center justify-between mt-6 mb-2">
              <h3 class="text-xs font-semibold text-text-muted uppercase tracking-wider">
                ${t('sessions.exited')} <span class="text-text-dim">(${exited.length})</span>
              </h3>
              <button
                class="text-sm text-status-warning px-2 py-1 -mr-2 disabled:opacity-50"
                data-testid="phone-clear-finished"
                ?disabled=${this.cleaningExited}
                @click=${this.confirmClearFinished}
              >
                ${t('phoneList.clearFinished')}
              </button>
            </div>
            <div class="psr-list">
              ${repeat(
                pinnedFirst(
                  [...exited].sort((a, b) => recency(b) - recency(a)),
                  this.pinnedIds
                ),
                (session) => session.id,
                row
              )}
            </div>
          `
          : ''
      }
    `;
  }

  /** Clears every finished session (not only the ones a search shows), after asking. */
  private confirmClearFinished = () => {
    const count = this.sessions.filter((session) => session.status === 'exited').length;
    if (!count || !window.confirm(t('phoneList.clearFinishedConfirm', { n: count }))) return;
    void this.handleCleanupExited();
  };

  /** Quick starts from the server config, loaded on first use. */
  @state() private quickStarts: QuickStartCommand[] = [];
  private quickStartsLoaded = false;

  private loadQuickStarts() {
    if (this.quickStartsLoaded) return;
    this.quickStartsLoaded = true;
    serverConfigService
      .getQuickStartCommands()
      .then((commands) => {
        this.quickStarts = commands.filter((entry) => entry.command?.trim());
      })
      .catch(() => {});
  }

  /** Your quick starts, the one you started last first (it becomes the big button). */
  private quickStartList(): QuickStartCommand[] {
    const list = this.quickStarts.length ? this.quickStarts : [{ command: 'zsh' }];
    const last = readPhoneStarts().tool;
    const index = list.findIndex((entry) => entry.command.trim() === last);
    return index > 0 ? [list[index], ...list.slice(0, index), ...list.slice(index + 1)] : list;
  }

  private quickStartLabel(entry: QuickStartCommand): string {
    return (entry.name || entry.command).trim();
  }

  /** A quick start tapped: on to its folder. */
  private chooseQuickStart(entry: QuickStartCommand) {
    this.openFolderSheet(entry);
  }

  /** Phone home with nothing running: pick a tool (your quick starts), then a folder. */
  private renderPhoneEmpty(exitedCount: number) {
    this.loadQuickStarts();
    const tools = this.quickStartList();
    // Saved previews outlive their sessions: still there with no session running.
    return html`
      ${this.previews?.length ? this.renderPreviewSection() : nothing}
      <div class="phone-empty" data-testid="phone-empty">
        <h2>${t('empty.title')}</h2>
        <p>${t('empty.subtitle')}</p>
        <div class="phone-empty-tools">
          ${tools.map(
            (entry, index) => html`<button
              class="phone-tool ${index === 0 ? 'primary' : ''}"
              @click=${() => this.chooseQuickStart(entry)}
            >
              ${this.quickStartLabel(entry)}
            </button>`
          )}
          <button class="phone-tool" @click=${() => this.openCreateDialog()}>
            ${t('empty.custom')}
          </button>
        </div>
        ${
          exitedCount
            ? html`<button
                class="phone-empty-link"
                @click=${() => this.dispatchEvent(new CustomEvent('hide-exited-change', { detail: false }))}
              >
                ${t('empty.showExited', { n: exitedCount })}
              </button>`
            : ''
        }
      </div>
    `;
  }

  /** Phone: a new session in two taps: tool, then folder (like "new chat"). */
  private renderNewChatButton() {
    this.loadQuickStarts();
    return html`
      <button
        class="new-chat-fab"
        data-testid="new-session-fab"
        aria-label=${t('newChat.title')}
        @click=${this.openToolSheet}
      >
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor"
          stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    `;
  }

  private sheetHost: HTMLElement | null = null;

  /** Recent working directories, most recent first, then ones remembered from earlier. */
  private recentFolders(): string[] {
    const recency = (session: Session) =>
      new Date(session.lastModified || session.startedAt || 0).getTime();
    const folders: string[] = [];
    // Local folders only: a remote (HQ) session's folder doesn't exist on this machine.
    const local = this.sessions.filter(
      (session) => session.source !== 'remote' && !session.remoteId
    );
    for (const session of local.sort((a, b) => recency(b) - recency(a))) {
      if (session.workingDir && !folders.includes(session.workingDir)) {
        folders.push(session.workingDir);
      }
      if (folders.length === MAX_RECENT_FOLDERS) break;
    }
    for (const folder of readPhoneStarts().folders ?? []) {
      if (folders.length === MAX_RECENT_FOLDERS) break;
      if (typeof folder === 'string' && folder && !folders.includes(folder)) folders.push(folder);
    }
    // Remember them now: clearing finished sessions would otherwise take their folders along.
    if (folders.length) writePhoneStarts({ folders });
    else folders.push('~');
    return folders;
  }

  private sheetOpenedAt = 0;
  private sheetActionAt = 0;

  /**
   * Touch acts on pointerup (iOS can take the first tap on a fresh button as a hover) and the
   * click that may follow is swallowed; the click that finished the tap opening the sheet
   * (< 500 ms) is ignored. Mouse and keyboard use the click.
   */
  private sheetAction(fn: () => void) {
    return {
      handleEvent: (e: Event) => {
        if (Date.now() - this.sheetOpenedAt < 500) return;
        if (e.type === 'pointerup') {
          if ((e as PointerEvent).pointerType === 'mouse') return;
          // A scroll of the sheet that started on a button ends here too: not a tap.
          if (endsADrag(e as PointerEvent)) return;
          this.sheetActionAt = Date.now();
          swallowNextClick();
        } else if (Date.now() - this.sheetActionAt < 700) {
          return;
        }
        fn();
      },
    };
  }

  /** Action sheet in <body> (the phone sidebar's transform would trap position:fixed). */
  private showSheet(
    title: string,
    buttons: Array<{ label: string; mono?: boolean; run: () => void }>
  ) {
    this.closeSheet();
    // Closing a previous sheet (tool -> folder) already handed focus back to its opener.
    const opener = document.activeElement;
    const host = document.createElement('div');
    this.sheetHost = host;
    this.sheetOpenedAt = Date.now();
    document.body.appendChild(host);
    render(
      html`
        <div class="psr-sheet-backdrop" @click=${this.closeSheet}></div>
        <div class="psr-sheet" role="dialog" aria-modal="true" aria-label=${title}>
          <div class="psr-sheet-group">
            <div class="psr-sheet-title">${title}</div>
            ${buttons.map(
              (button) => html`<button
                class=${button.mono ? 'folder' : ''}
                @pointerup=${this.sheetAction(() => {
                  this.closeSheet();
                  button.run();
                })}
                @click=${this.sheetAction(() => {
                  this.closeSheet();
                  button.run();
                })}
              >
                <bdi>${button.label}</bdi>
              </button>`
            )}
          </div>
          <button class="psr-sheet-cancel" @click=${this.closeSheet}>${t('common.cancel')}</button>
        </div>
      `,
      host
    );
    this.releaseSheetFocus = holdSheetFocus(
      host.querySelector<HTMLElement>('.psr-sheet'),
      this.closeSheet,
      opener
    );
    requestAnimationFrame(() => host.querySelector('.psr-sheet')?.classList.add('open'));
  }

  private releaseSheetFocus: (() => void) | null = null;

  private closeSheet = () => {
    if (!this.sheetHost) return;
    render(nothing, this.sheetHost);
    this.sheetHost.remove();
    this.sheetHost = null;
    this.releaseSheetFocus?.();
    this.releaseSheetFocus = null;
  };

  private openCreateDialog() {
    this.dispatchEvent(new CustomEvent('open-create-dialog', { detail: {}, bubbles: true }));
  }

  private openToolSheet = () => {
    this.showSheet(t('newChat.which'), [
      ...this.quickStartList().map((entry) => ({
        label: this.quickStartLabel(entry),
        run: () => this.chooseQuickStart(entry),
      })),
      { label: t('empty.custom'), run: () => this.openCreateDialog() },
    ]);
  };

  private openFolderSheet(entry: QuickStartCommand) {
    this.showSheet(t('newChat.where', { tool: this.quickStartLabel(entry) }), [
      ...this.recentFolders().map((folder) => ({
        label: formatPathForDisplay(folder),
        mono: true,
        run: () => void this.startSession(entry, folder),
      })),
      { label: t('newChat.other'), run: () => this.openCreateDialog() },
    ]);
  }

  /** The same request as the create dialog, with the quick start's exact command. */
  private async startSession(entry: QuickStartCommand, workingDir: string): Promise<boolean> {
    const command = parseCommand(entry.command.trim());
    writePhoneStarts({
      tool: entry.command.trim(),
      folders: [
        workingDir,
        ...(readPhoneStarts().folders ?? []).filter((folder) => folder !== workingDir),
      ].slice(0, MAX_RECENT_FOLDERS),
    });
    try {
      const response = await fetch('/api/sessions', {
        method: HttpMethod.POST,
        headers: { 'Content-Type': 'application/json', ...this.authClient?.getAuthHeader() },
        body: JSON.stringify({
          command,
          workingDir,
          name: `${command[0]} (${formatPathForDisplay(workingDir)})`,
          spawn_terminal: false,
          cols: 120,
          rows: 30,
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.sessionId) throw new Error(result.error || response.statusText);
      // The app opens it once it shows up, as for the full create dialog.
      this.dispatchEvent(new CustomEvent('session-created', { detail: result, bubbles: true }));
      return true;
    } catch (error) {
      this.dispatchEvent(
        new CustomEvent('error', { detail: `${t('newChat.failed')}: ${error}`, bubbles: true })
      );
      return false;
    }
  }

  private renderExitedControls() {
    const exitedSessions = this.sessions.filter((session) => session.status === 'exited');
    const runningSessions = this.sessions.filter((session) => session.status === 'running');

    // If no sessions at all, don't show controls
    if (this.sessions.length === 0) return '';

    return html`
      <div class="sticky bottom-0 border-t border-border bg-bg-secondary shadow-lg" data-testid="session-list-footer" style="z-index: ${Z_INDEX.SESSION_LIST_BOTTOM_BAR};${
        // The home-screen app on a phone draws under the home indicator.
        this.usePhoneRows() ? ' padding-bottom: env(safe-area-inset-bottom, 0px);' : ''
      }">
        <div class="px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <!-- Status group (left side) -->
          <div class="flex flex-wrap items-center gap-3 sm:gap-4">
            <!-- Session counts -->
            <div class="flex items-center gap-2 sm:gap-3 font-mono text-xs">
              ${
                runningSessions.length > 0
                  ? html`
                <span class="text-status-success whitespace-nowrap">${t('sessions.runningCount', { n: runningSessions.length })}</span>
              `
                  : ''
              }
              ${
                exitedSessions.length > 0
                  ? html`
                <span class="text-text-dim whitespace-nowrap">${t('sessions.exitedCount', { n: exitedSessions.length })}</span>
              `
                  : ''
              }
            </div>

            <!-- Show exited toggle (only if there are exited sessions) -->
            ${
              exitedSessions.length > 0
                ? html`
              <label class="flex items-center gap-2 cursor-pointer group whitespace-nowrap">
                <input
                  type="checkbox"
                  class="session-toggle-checkbox"
                  ?checked=${!this.hideExited}
                  @change=${(e: Event) => {
                    const checked = (e.target as HTMLInputElement).checked;
                    this.dispatchEvent(new CustomEvent('hide-exited-change', { detail: !checked }));
                  }}
                  id="show-exited-toggle"
                  data-testid="show-exited-toggle"
                />
                <span class="text-xs text-text-muted group-hover:text-text font-mono select-none">
                  ${t('sessions.show')}
                </span>
              </label>
            `
                : ''
            }
          </div>

          <!-- Actions group (right side) -->
          <div class="flex items-center gap-2 ml-auto">
            <!-- Clean button (only visible when showing exited sessions). The phone list has
                 "Clear all" with a confirmation in the finished-sessions header instead. -->
            ${
              !this.hideExited && exitedSessions.length > 0 && !this.usePhoneRows()
                ? html`
              <button
                class="font-mono text-xs px-3 py-1.5 rounded-md border transition-all duration-200 border-status-warning bg-status-warning/10 text-status-warning hover:bg-status-warning/20 hover:shadow-glow-warning-sm active:scale-95 disabled:opacity-50"
                id="clean-exited-button"
                @click=${this.handleCleanupExited}
                ?disabled=${this.cleaningExited}
                data-testid="clean-exited-button"
              >
                ${
                  this.cleaningExited
                    ? html`
                  <span class="flex items-center gap-1">
                    <span class="animate-spin">⟳</span>
                    ${t('sessions.cleaning')}
                  </span>
                `
                    : t('sessions.clean')
                }
              </button>
            `
                : ''
            }
            
            <!-- Kill All button (always visible if there are running sessions) -->
            ${
              runningSessions.length > 0
                ? html`
              <button
                class="font-mono text-xs px-3 py-1.5 rounded-md border transition-all duration-200 border-status-error bg-status-error/10 text-status-error hover:bg-status-error/20 hover:shadow-glow-error-sm active:scale-95"
                id="kill-all-button"
                @click=${() => this.dispatchEvent(new CustomEvent('kill-all-sessions'))}
                data-testid="kill-all-button"
              >
                ${t('sessions.killAll')}
              </button>
            `
                : ''
            }
          </div>
        </div>
      </div>
    `;
  }

  private renderActiveSessionInfo() {
    // Only show in compact mode (mobile sidebar) when there's an active session.
    // Phone rows already highlight the active session.
    if (!this.compactMode || !this.activeSessionId || this.usePhoneRows()) {
      return '';
    }

    const activeSession = this.sessions.find((s) => s.id === this.activeSessionId);
    if (!activeSession) {
      return '';
    }

    return html`
      <div class="mb-4 mx-4 p-3 bg-primary/10 border border-primary/30 rounded-lg">
        <div class="flex items-center justify-between mb-2">
          <span class="text-xs font-semibold text-primary uppercase tracking-wider">${t('sessions.activeSession')}</span>
          <div class="flex items-center gap-2">
            <div class="relative">
              <div class="w-2 h-2 rounded-full bg-status-success"></div>
              ${
                activeSession.status === 'running'
                  ? html`
                <div class="absolute inset-0 w-2 h-2 rounded-full bg-status-success animate-ping opacity-50"></div>
              `
                  : ''
              }
            </div>
          </div>
        </div>
        
        <!-- Session Title -->
        <div class="mb-2">
          <inline-edit
            .value=${activeSession.name}
            .entityId=${activeSession.id}
            .entityType=${'session'}
            .authClient=${this.authClient}
            @value-changed=${(e: CustomEvent) => {
              // Update the session name in the list
              const updatedSession = this.sessions.find((s) => s.id === activeSession.id);
              if (updatedSession) {
                updatedSession.name = e.detail.value;
                this.requestUpdate();
              }
            }}
            class="text-sm font-medium text-text"
          ></inline-edit>
        </div>
        
        <!-- Path and Git Status -->
        <div class="space-y-1">
          <clickable-path
            .path=${activeSession.workingDir}
            .format=${'relative'}
            class="text-xs text-text-muted"
          ></clickable-path>
          
          ${
            activeSession.gitRepoPath
              ? html`
            <git-status-badge
              .session=${activeSession}
              class="text-xs"
            ></git-status-badge>
          `
              : ''
          }
        </div>
      </div>
    `;
  }
}
