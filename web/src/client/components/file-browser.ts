/**
 * File Browser Component
 *
 * Modal file browser for navigating the filesystem and selecting files/directories.
 * Supports Git status display, file preview with CodeMirror editor, and diff viewing.
 *
 * @fires insert-path - When inserting a file path into terminal (detail: { path: string, type: 'file' | 'directory' })
 * @fires directory-selected - When a directory is selected in 'select' mode (detail: string)
 * @fires browser-cancel - When the browser is cancelled or closed
 */
import { html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { createRef, ref } from 'lit/directives/ref.js';
import type { Session } from '../../shared/types.js';
import { LocaleController, t } from '../i18n/index.js';
import { authClient } from '../services/auth-client.js';
import { Z_INDEX } from '../utils/constants.js';
import {
  type GitStatus as GitStatusType,
  getFileIcon,
  getParentDirectoryIcon,
  renderGitStatusBadge,
  UIIcons,
} from '../utils/file-icons.js';
import { createLogger } from '../utils/logger.js';
import { copyToClipboard, formatPathForDisplay } from '../utils/path-utils.js';
import type { MonacoEditorOptions } from './monaco-editor.js';
import './monaco-editor.js';
import './modal-wrapper.js';

const logger = createLogger('file-browser');

// On a phone there's no room for horizontal scrolling or a folding gutter: wrap long lines so
// code and markdown read top to bottom.
const PHONE_EDITOR_OPTIONS: MonacoEditorOptions = {
  wordWrap: 'on',
  fontSize: 13,
  folding: false,
  lineNumbersMinChars: 3,
};

interface FileInfo {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modified: string;
  permissions?: string;
  isGitTracked?: boolean;
  gitStatus?: GitStatusType;
  isSymlink?: boolean;
}

interface DirectoryListing {
  path: string;
  fullPath: string;
  gitStatus: GitStatus | null;
  files: FileInfo[];
}

interface GitStatus {
  isGitRepo: boolean;
  branch?: string;
  modified: string[];
  added: string[];
  deleted: string[];
  untracked: string[];
}

interface FilePreview {
  type: 'image' | 'text' | 'binary';
  content?: string;
  language?: string;
  url?: string;
  mimeType?: string;
  size: number;
  humanSize?: string;
}

interface FileDiff {
  path: string;
  diff: string;
  hasDiff: boolean;
}

interface FileDiffContent {
  path: string;
  originalContent: string;
  modifiedContent: string;
  language?: string;
}

@customElement('file-browser')
export class FileBrowser extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  @property({ type: Boolean }) visible = false;
  @property({ type: String }) mode: 'browse' | 'select' = 'browse';
  @property({ type: Object }) session: Session | null = null;

  @state() private currentPath = '';
  @state() private currentFullPath = '';
  @state() private files: FileInfo[] = [];
  @state() private loading = false;
  @state() private selectedFile: FileInfo | null = null;
  @state() private preview: FilePreview | null = null;
  @state() private diff: FileDiff | null = null;
  @state() private diffContent: FileDiffContent | null = null;
  @state() private gitFilter: 'all' | 'changed' = 'all';
  @state() private showHidden = false;
  @state() private gitStatus: GitStatus | null = null;
  @state() private previewLoading = false;
  @state() private showDiff = false;
  @state() private errorMessage = '';
  @state() private mobileView: 'list' | 'preview' = 'list';
  @state() private isMobile = window.innerWidth < 768;
  @state() private editingPath = false;
  @state() private pathInputValue = '';
  // Object URL of the previewed image. `<img src>` can't carry the Bearer header, so behind
  // the login gate /api/fs/raw answers 401; fetch it with auth and show a blob URL instead.
  @state() private imageObjectUrl = '';
  @state() private copyFeedback: '' | 'copied' | 'failed' = '';
  private copyFeedbackTimer?: ReturnType<typeof setTimeout>;

  private editorRef = createRef<HTMLElement>();
  private breadcrumbsRef = createRef<HTMLElement>();
  private pathInputRef = createRef<HTMLInputElement>();
  private noAuthMode = false;

  async connectedCallback() {
    super.connectedCallback();

    // Check auth configuration
    await this.checkAuthConfig();

    if (this.visible) {
      this.currentPath = this.session?.workingDir || '.';
      await this.loadDirectory(this.currentPath);
    }
    document.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('resize', this.handleResize);
    this.setupTouchHandlers();
  }

  async updated(changedProperties: Map<string, unknown>) {
    super.updated(changedProperties);

    // Only load directory when the component becomes visible or when session's workingDir actually changes
    if (changedProperties.has('visible')) {
      if (this.visible) {
        // Component just became visible
        this.currentPath = this.session?.workingDir || '.';
        await this.loadDirectory(this.currentPath);
      }
    } else if (changedProperties.has('session') && this.visible) {
      // Check if the workingDir actually changed
      const oldSession = changedProperties.get('session') as Session | null;
      const oldWorkingDir = oldSession?.workingDir;
      const newWorkingDir = this.session?.workingDir;

      if (oldWorkingDir !== newWorkingDir) {
        // Working directory actually changed, reload
        this.currentPath = newWorkingDir || '.';
        await this.loadDirectory(this.currentPath);
      }
      // If only the session object reference changed but workingDir is the same, don't reload
    }

    // Keep the current folder in view: long paths overflow to the left
    if (changedProperties.has('currentFullPath') && this.breadcrumbsRef.value) {
      this.breadcrumbsRef.value.scrollLeft = this.breadcrumbsRef.value.scrollWidth;
    }

    // Monaco editor will handle its own updates through properties
  }

  private async loadDirectory(dirPath: string) {
    this.loading = true;
    try {
      const params = new URLSearchParams({
        path: dirPath,
        showHidden: this.showHidden.toString(),
        gitFilter: this.gitFilter,
      });

      const url = `/api/fs/browse?${params}`;
      logger.debug(`loading directory: ${dirPath}`);
      logger.debug(`fetching URL: ${url}`);

      const headers = this.noAuthMode ? {} : { ...authClient.getAuthHeader() };
      const response = await fetch(url, { headers });
      logger.debug(`response status: ${response.status}`);

      if (response.ok) {
        const data: DirectoryListing = await response.json();
        logger.debug(`received ${data.files?.length || 0} files`);
        // Use the absolute path (fullPath) instead of the potentially relative path
        this.currentPath = data.fullPath || data.path;
        this.currentFullPath = data.fullPath;
        this.files = data.files || [];
        this.gitStatus = data.gitStatus;
        // Clear any previous error message on successful load
        this.errorMessage = '';
      } else {
        let errorMessage = t('files.error.load');
        try {
          const errorData = await response.json();
          errorMessage = errorData.error || errorMessage;
        } catch {
          // If response isn't JSON, use default message
          errorMessage = t('files.error.loadStatus', { status: response.status });
        }

        logger.error(`failed to load directory: ${response.status}`, new Error(errorMessage));
        this.showErrorMessage(errorMessage);
      }
    } catch (error) {
      logger.error('error loading directory:', error);
      this.showErrorMessage(t('files.error.network'));
    } finally {
      this.loading = false;
    }
  }

  private async loadPreview(file: FileInfo) {
    if (file.type === 'directory') return;

    this.previewLoading = true;
    this.selectedFile = file;
    this.showDiff = false;

    try {
      logger.debug(`loading preview for file: ${file.name}`);
      logger.debug(`file path: ${file.path}`);

      const headers = this.noAuthMode ? {} : { ...authClient.getAuthHeader() };
      const response = await fetch(`/api/fs/preview?path=${encodeURIComponent(file.path)}`, {
        headers,
      });
      if (response.ok) {
        const preview: FilePreview = await response.json();
        const imageUrl =
          preview.type === 'image' && preview.url
            ? await this.loadImageObjectUrl(preview.url, headers)
            : '';
        // A newer tap may have selected another file while this one loaded: don't let this
        // (slower) image replace that file's preview.
        if (this.selectedFile?.path !== file.path) {
          if (imageUrl) URL.revokeObjectURL(imageUrl);
          return;
        }
        this.revokeImageObjectUrl();
        this.imageObjectUrl = imageUrl;
        this.preview = preview;
        this.requestUpdate(); // Trigger re-render to initialize Monaco if needed
      } else {
        logger.error(`preview failed: ${response.status}`, new Error(await response.text()));
      }
    } catch (error) {
      logger.error('error loading preview:', error);
    } finally {
      this.previewLoading = false;
    }
  }

  /** The image as a blob URL ('' on failure); the caller decides whether it's still wanted. */
  private async loadImageObjectUrl(url: string, headers: Record<string, string>): Promise<string> {
    try {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        logger.error(`image fetch failed: ${response.status}`);
        return '';
      }
      return URL.createObjectURL(await response.blob());
    } catch (error) {
      logger.error('error loading image:', error);
      return '';
    }
  }

  private revokeImageObjectUrl() {
    if (this.imageObjectUrl) {
      URL.revokeObjectURL(this.imageObjectUrl);
      this.imageObjectUrl = '';
    }
  }

  private async loadDiff(file: FileInfo) {
    if (file.type === 'directory' || !file.gitStatus || file.gitStatus === 'unchanged') return;

    this.previewLoading = true;
    this.showDiff = true;

    try {
      // Load both the unified diff and the full content for Monaco
      const headers = this.noAuthMode ? {} : { ...authClient.getAuthHeader() };
      const [diffResponse, contentResponse] = await Promise.all([
        fetch(`/api/fs/diff?path=${encodeURIComponent(file.path)}`, {
          headers,
        }),
        fetch(`/api/fs/diff-content?path=${encodeURIComponent(file.path)}`, {
          headers,
        }),
      ]);

      if (diffResponse.ok) {
        this.diff = await diffResponse.json();
      }

      if (contentResponse.ok) {
        this.diffContent = await contentResponse.json();
      }
    } catch (error) {
      logger.error('error loading diff:', error);
    } finally {
      this.previewLoading = false;
    }
  }

  private handleFileClick(file: FileInfo) {
    if (file.type === 'directory') {
      // Use the absolute path provided by the server
      this.loadDirectory(file.path);
    } else {
      // Clear previous state when selecting a new file
      if (this.selectedFile?.path !== file.path) {
        this.preview = null;
        this.diff = null;
        this.diffContent = null;
        this.showDiff = false;
      }
      // Set the selected file
      this.selectedFile = file;
      // On mobile, switch to preview view
      if (this.isMobile) {
        this.mobileView = 'preview';
      }
      // Always show file content by default, regardless of git filter
      this.loadPreview(file);
    }
  }

  private async handleCopyToClipboard(text: string) {
    const success = await copyToClipboard(text);
    if (success) {
      logger.debug(`copied to clipboard: ${text}`);
    } else {
      logger.error('failed to copy to clipboard');
    }
    // On a phone there's no other sign the tap did anything
    this.copyFeedback = success ? 'copied' : 'failed';
    clearTimeout(this.copyFeedbackTimer);
    this.copyFeedbackTimer = setTimeout(() => {
      this.copyFeedback = '';
    }, 1500);
  }

  /**
   * file.path is relative to the server's cwd (e.g. "../../Users/me/x.ts"), useless outside
   * the server; join the listed directory with the name.
   */
  private absolutePathOf(file: FileInfo): string {
    if (this.currentFullPath && file.name) {
      return this.currentFullPath.endsWith('/')
        ? this.currentFullPath + file.name
        : `${this.currentFullPath}/${file.name}`;
    }
    // Fallback to relative path if absolute path construction fails
    return file.path;
  }

  private insertPathIntoTerminal() {
    if (!this.selectedFile) return;

    const absolutePath = this.absolutePathOf(this.selectedFile);

    // Dispatch event with the absolute file path
    this.dispatchEvent(
      new CustomEvent('insert-path', {
        detail: {
          path: absolutePath,
          type: this.selectedFile.type,
        },
        bubbles: true,
        composed: true,
      })
    );

    // Close the file browser
    this.dispatchEvent(new CustomEvent('browser-cancel'));
  }

  private showErrorMessage(message: string) {
    this.errorMessage = message;
    // Clear error message after 5 seconds
    setTimeout(() => {
      this.errorMessage = '';
    }, 5000);
  }

  private handleParentClick() {
    // Handle navigation to parent directory
    let parentPath: string;

    if (this.currentFullPath === '/') {
      // Already at root, can't go higher
      return;
    }

    if (this.currentFullPath) {
      // Use full path for accurate parent calculation
      const parts = this.currentFullPath.split('/').filter((part) => part !== '');
      if (parts.length === 0) {
        // We're at root
        parentPath = '/';
      } else {
        // Remove last part to get parent
        parts.pop();
        parentPath = parts.length === 0 ? '/' : `/${parts.join('/')}`;
      }
    } else {
      // Fallback to current path logic
      const parts = this.currentPath.split('/').filter((part) => part !== '');
      if (parts.length <= 1) {
        parentPath = '/';
      } else {
        parts.pop();
        parentPath = `/${parts.join('/')}`;
      }
    }

    this.loadDirectory(parentPath);
  }

  private toggleGitFilter() {
    this.gitFilter = this.gitFilter === 'all' ? 'changed' : 'all';
    this.loadDirectory(this.currentPath);
  }

  private toggleHidden() {
    this.showHidden = !this.showHidden;
    this.loadDirectory(this.currentPath);
  }

  private toggleDiff() {
    if (this.selectedFile?.gitStatus && this.selectedFile.gitStatus !== 'unchanged') {
      if (this.showDiff) {
        this.loadPreview(this.selectedFile);
      } else {
        this.loadDiff(this.selectedFile);
      }
    }
  }

  private handleSelect() {
    if (this.mode === 'select' && this.currentPath) {
      this.dispatchEvent(
        new CustomEvent('directory-selected', {
          detail: this.currentFullPath || this.currentPath,
        })
      );
    }
  }

  private handleCancel() {
    this.dispatchEvent(new CustomEvent('browser-cancel'));
  }

  /** Ancestors of the current folder (home collapsed to ~), each with the path to jump to. */
  private get breadcrumbs(): Array<{ label: string; path: string }> {
    const fullPath = this.currentFullPath || this.currentPath;
    if (!fullPath) return [];
    const display = formatPathForDisplay(fullPath);
    const crumbs: Array<{ label: string; path: string }> = [];
    let base: string;
    let rest: string;
    if (display.startsWith('~') && fullPath.startsWith('/')) {
      base = fullPath.slice(0, fullPath.length - (display.length - 1)) || '/';
      rest = display.slice(1);
      crumbs.push({ label: '~', path: base });
    } else if (fullPath.startsWith('/')) {
      base = '';
      rest = fullPath;
      crumbs.push({ label: '/', path: '/' });
    } else {
      // Relative or Windows path: nothing reliable to split, show it whole
      return [{ label: display, path: fullPath }];
    }
    let current = base.replace(/\/$/, '');
    for (const part of rest.split('/').filter(Boolean)) {
      current = `${current}/${part}`;
      crumbs.push({ label: part, path: current });
    }
    return crumbs;
  }

  private renderBreadcrumbs(tap: string) {
    const crumbs = this.breadcrumbs;
    const fullPath = this.currentFullPath || this.currentPath || t('files.title');
    return html`
      <nav
        ${ref(this.breadcrumbsRef)}
        class="flex items-center min-w-0 overflow-x-auto whitespace-nowrap font-mono text-xs sm:text-sm text-status-info"
        style="scrollbar-width: none;"
        dir="ltr"
        aria-label=${fullPath}
      >
        ${
          crumbs.length === 0
            ? html`<span class="px-1">${t('files.title')}</span>`
            : crumbs.map((crumb, i) => {
                const last = i === crumbs.length - 1;
                return html`
                  ${i > 1 || (i === 1 && crumbs[0].label !== '/') ? html`<span class="text-text-muted">/</span>` : ''}
                  <button
                    class="flex-shrink-0 rounded px-1 py-1 hover:bg-light ${tap} ${
                      last ? 'font-semibold' : 'text-text-muted'
                    }"
                    title=${last ? t('files.clickToEdit', { path: fullPath }) : crumb.path}
                    @click=${() => (last ? this.handlePathClick() : this.loadDirectory(crumb.path))}
                  >
                    ${crumb.label}
                  </button>
                `;
              })
        }
      </nav>
    `;
  }

  private renderPreview() {
    if (this.previewLoading) {
      return html`
        <div class="flex items-center justify-center h-full text-text-muted">
          ${t('files.loadingPreview')}
        </div>
      `;
    }

    if (this.showDiff && (this.diff || this.diffContent)) {
      return this.renderDiff();
    }

    if (!this.preview) {
      return html`
        <div class="flex flex-col items-center justify-center h-full text-text-muted">
          ${UIIcons.preview}
          <div>${t('files.selectToPreview')}</div>
        </div>
      `;
    }

    switch (this.preview.type) {
      case 'image':
        return html`
          <div class="flex items-center justify-center p-4 h-full">
            <img
              src="${this.imageObjectUrl || this.preview.url}"
              alt="${this.selectedFile?.name}"
              class="max-w-full max-h-full object-contain rounded"
            />
          </div>
        `;

      case 'text':
        return html`
          <monaco-editor
            ${ref(this.editorRef)}
            .content=${this.preview.content || ''}
            .language=${this.preview.language || ''}
            .filename=${this.selectedFile?.name || ''}
            .readOnly=${true}
            .options=${this.isMobile ? PHONE_EDITOR_OPTIONS : {}}
            mode="normal"
            class="h-full w-full"
          ></monaco-editor>
        `;

      case 'binary':
        return html`
          <div class="flex flex-col items-center justify-center h-full text-text-muted">
            ${UIIcons.binary}
            <div class="text-lg mb-2">${t('files.binary')}</div>
            <div class="text-sm">${this.preview.humanSize || t('files.bytes', { size: this.preview.size })}</div>
            <div class="text-sm text-text-muted mt-2">
              ${this.preview.mimeType || t('files.unknownType')}
            </div>
          </div>
        `;
    }
  }

  private renderDiff() {
    // For new files (added or untracked), we might not have a diff but we have diffContent
    if (!this.diffContent && !this.diff?.diff) {
      return html`
        <div class="flex items-center justify-center h-full text-text-muted">
          ${t('files.noChanges')}
        </div>
      `;
    }

    // If we have diff content, show it in Monaco's diff editor
    if (this.diffContent) {
      return html`
        <monaco-editor
          ${ref(this.editorRef)}
          .originalContent=${this.diffContent.originalContent || ''}
          .modifiedContent=${this.diffContent.modifiedContent || ''}
          .language=${this.diffContent.language || ''}
          .filename=${this.selectedFile?.name || ''}
          .readOnly=${true}
          .options=${this.isMobile ? PHONE_EDITOR_OPTIONS : {}}
          mode="diff"
          .showModeToggle=${true}
          class="h-full w-full"
        ></monaco-editor>
      `;
    }

    // Fallback to simple diff display
    if (!this.diff) return html``;
    const lines = this.diff.diff.split('\n');
    return html`
      <div class="overflow-auto h-full p-4 font-mono text-xs">
        ${lines.map((line) => {
          let className = 'text-text-muted';
          if (line.startsWith('+')) className = 'text-status-success bg-status-success/10';
          else if (line.startsWith('-')) className = 'text-status-error bg-status-error/10';
          else if (line.startsWith('@@')) className = 'text-status-info font-semibold';

          return html`<div class="whitespace-pre ${className}">${line}</div>`;
        })}
      </div>
    `;
  }

  render() {
    if (!this.visible) {
      return html``;
    }

    // Phones get 44px-tall controls (Apple HIG minimum); desktop keeps the dense look
    const tap = this.isMobile ? 'min-h-[44px]' : '';

    return html`
      <div class="fixed inset-0 bg-bg/80 backdrop-blur-sm flex items-center justify-center" style="z-index: ${Z_INDEX.FILE_BROWSER};" @click=${this.handleCancel}>
        <div class="fixed inset-0 bg-bg flex flex-col" style="z-index: ${Z_INDEX.FILE_BROWSER};" @click=${(e: Event) => e.stopPropagation()}>
        ${
          this.isMobile && this.mobileView === 'preview'
            ? html`
              <div class="absolute top-1/2 left-2 -translate-y-1/2 text-text-muted opacity-50">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M11 19l-7-7 7-7m8 14l-7-7 7-7"
                  ></path>
                </svg>
              </div>
            `
            : ''
        }
        <div
          class="w-full h-full flex flex-col overflow-hidden"
          data-testid="file-browser"
        >
          <!-- Compact Header (like session-view) -->
          <div
            class="flex items-center justify-between px-3 py-2 border-b border-border/50 text-sm min-w-0 bg-bg-secondary"
            style="padding-top: max(0.5rem, env(safe-area-inset-top)); padding-left: max(0.75rem, env(safe-area-inset-left)); padding-right: max(0.75rem, env(safe-area-inset-right));"
          >
            <div class="flex items-center gap-3 min-w-0 flex-1">
              <button
                class="text-text-muted hover:text-primary font-mono text-xs px-2 py-1 flex-shrink-0 transition-colors flex items-center gap-1 ${tap}"
                @click=${this.handleCancel}
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M15 19l-7-7 7-7"
                  ></path>
                </svg>
                <span>${t('files.back')}</span>
              </button>
              <div class="text-primary min-w-0 flex-1 overflow-hidden flex items-center gap-2">
                ${
                  this.editingPath
                    ? html`
                      <input
                        ${ref(this.pathInputRef)}
                        type="text"
                        .value=${this.pathInputValue}
                        @input=${this.handlePathInput}
                        @keydown=${this.handlePathKeyDown}
                        @blur=${this.handlePathBlur}
                        class="bg-bg border border-border/50 rounded px-2 py-1 text-status-info ${
                          this.isMobile ? 'text-base' : 'text-xs sm:text-sm'
                        } font-mono w-full min-w-0 focus:outline-none focus:border-primary"
                        placeholder=${t('files.pathPlaceholder')}
                        dir="ltr"
                      />
                    `
                    : this.renderBreadcrumbs(tap)
                }
                ${
                  this.gitStatus?.branch
                    ? html`
                      <span
                        class="text-text-muted text-xs flex items-center gap-1 font-mono flex-shrink-0 max-w-[35%] min-w-0"
                        title=${this.gitStatus.branch}
                      >
                        ${UIIcons.git} <span class="truncate">${this.gitStatus.branch}</span>
                      </span>
                    `
                    : ''
                }
              </div>
            </div>
          </div>
          ${
            // Full-width row so a long error doesn't squeeze the path to nothing on a phone
            this.errorMessage
              ? html`
                <div
                  class="bg-status-error/20 border-b border-status-error text-status-error px-3 py-2 text-xs break-words"
                  role="alert"
                >
                  ${this.errorMessage}
                </div>
              `
              : ''
          }

          <!-- Main content -->
          <div class="flex-1 flex overflow-hidden">
            <!-- File list -->
            <div
              class="${this.isMobile && this.mobileView === 'preview' ? 'hidden' : ''} ${
                this.isMobile ? 'w-full' : 'w-80'
              } bg-bg-secondary border-r border-border/50 flex flex-col"
            >
              <!-- File list header with toggles -->
              <div
                class="bg-bg-secondary border-b border-border/50 p-3 flex items-center justify-between"
              >
                <div class="flex flex-wrap gap-2">
                  <button
                    class="btn-secondary text-xs px-2 py-1 font-mono ${tap} ${
                      this.gitFilter === 'changed' ? 'bg-primary text-bg' : ''
                    }"
                    @click=${this.toggleGitFilter}
                    title=${t('files.gitChanges.title')}
                  >
                    ${t('files.gitChanges')}
                  </button>
                  <button
                    class="btn-secondary text-xs px-2 py-1 font-mono ${tap} ${
                      this.showHidden ? 'bg-primary text-bg' : ''
                    }"
                    @click=${this.toggleHidden}
                    title=${t('files.hidden.title')}
                  >
                    ${t('files.hidden')}
                  </button>
                </div>
              </div>

              <!-- File list content -->
              <div
                class="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-thumb-white/20 scrollbar-track-transparent hover:scrollbar-thumb-white/30"
                style=${this.mode === 'browse' ? 'padding-bottom: env(safe-area-inset-bottom);' : ''}
              >
                ${
                  this.loading
                    ? html`
                      <div class="flex items-center justify-center h-full text-text-muted">
                        ${t('files.loading')}
                      </div>
                    `
                    : html`
                      ${
                        this.currentFullPath !== '/'
                          ? html`
                            <div
                              class="p-3 hover:bg-light cursor-pointer transition-colors flex items-center gap-2 border-b border-border/50 ${tap}"
                              @click=${this.handleParentClick}
                            >
                              ${getParentDirectoryIcon()}
                              <span class="text-text-muted">..</span>
                            </div>
                          `
                          : ''
                      }
                      ${this.files.map(
                        (file) => html`
                          <div
                            class="p-3 hover:bg-light cursor-pointer transition-colors flex items-center gap-2 min-w-0 ${tap}
                            ${
                              this.selectedFile?.path === file.path
                                ? 'bg-light border-l-2 border-primary'
                                : ''
                            }"
                            @click=${() => this.handleFileClick(file)}
                          >
                            <span class="flex-shrink-0 relative">
                              ${getFileIcon(file.name, file.type)}
                              ${
                                file.isSymlink
                                  ? html`
                                    <svg
                                      class="w-3 h-3 text-text-muted absolute -bottom-1 -right-1"
                                      fill="currentColor"
                                      viewBox="0 0 20 20"
                                    >
                                      <path
                                        fill-rule="evenodd"
                                        d="M12.586 4.586a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0 1 1 0 00-1.414 1.414 4 4 0 005.656 0l3-3a4 4 0 00-5.656-5.656l-1.5 1.5a1 1 0 101.414 1.414l1.5-1.5zm-5 5a2 2 0 012.828 0 1 1 0 101.414-1.414 4 4 0 00-5.656 0l-3 3a4 4 0 105.656 5.656l1.5-1.5a1 1 0 10-1.414-1.414l-1.5 1.5a2 2 0 11-2.828-2.828l3-3z"
                                        clip-rule="evenodd"
                                      />
                                    </svg>
                                  `
                                  : ''
                              }
                            </span>
                            <span
                              class="flex-1 min-w-0 truncate text-sm ${
                                file.type === 'directory' ? 'text-status-info' : 'text-text'
                              }"
                              title=${file.isSymlink ? t('files.symlinkTitle', { name: file.name }) : file.name}
                              >${file.name}</span
                            >
                            <span class="flex-shrink-0"
                              >${renderGitStatusBadge(file.gitStatus)}</span
                            >
                          </div>
                        `
                      )}
                    `
                }
              </div>
            </div>

            <!-- Preview pane -->
            <div
              class="${this.isMobile && this.mobileView === 'list' ? 'hidden' : ''} ${
                this.isMobile ? 'w-full' : 'flex-1'
              } bg-bg flex flex-col overflow-hidden"
            >
              ${
                this.selectedFile
                  ? html`
                    <div
                      class="bg-bg-secondary border-b border-border/50 p-3 ${
                        this.isMobile ? 'space-y-2' : 'flex items-center justify-between'
                      }"
                    >
                      <div class="flex items-center gap-2 ${this.isMobile ? 'min-w-0' : ''}">
                        ${
                          this.isMobile
                            ? html`
                              <button
                                @click=${() => {
                                  this.mobileView = 'list';
                                }}
                                class="text-text-muted hover:text-primary transition-colors flex-shrink-0 flex items-center justify-center min-w-[44px] min-h-[44px] -my-2 -ml-2"
                                title=${t('files.backToFiles')}
                                aria-label=${t('files.backToFiles')}
                              >
                                <svg
                                  class="w-5 h-5"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    stroke-width="2"
                                    d="M15 19l-7-7 7-7"
                                  ></path>
                                </svg>
                              </button>
                            `
                            : ''
                        }
                        <span class="flex-shrink-0 relative"
                          >${getFileIcon(this.selectedFile.name, this.selectedFile.type)}
                          ${
                            this.selectedFile.isSymlink
                              ? html`
                                <svg
                                  class="w-3 h-3 text-text-muted absolute -bottom-1 -right-1"
                                  fill="currentColor"
                                  viewBox="0 0 20 20"
                                >
                                  <path
                                    fill-rule="evenodd"
                                    d="M12.586 4.586a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0 1 1 0 00-1.414 1.414 4 4 0 005.656 0l3-3a4 4 0 00-5.656-5.656l-1.5 1.5a1 1 0 101.414 1.414l1.5-1.5zm-5 5a2 2 0 012.828 0 1 1 0 101.414-1.414 4 4 0 00-5.656 0l-3 3a4 4 0 105.656 5.656l1.5-1.5a1 1 0 10-1.414-1.414l-1.5 1.5a2 2 0 11-2.828-2.828l3-3z"
                                    clip-rule="evenodd"
                                  />
                                </svg>
                              `
                              : ''
                          }
                        </span>
                        <span class="font-mono text-sm ${this.isMobile ? 'truncate' : ''}"
                          >${this.selectedFile.name}${this.selectedFile.isSymlink ? ' →' : ''}</span
                        >
                        ${renderGitStatusBadge(this.selectedFile.gitStatus)}
                      </div>
                      <div
                        class="${
                          this.isMobile ? 'grid grid-cols-2 gap-2' : 'flex gap-2 flex-shrink-0'
                        }"
                      >
                        ${
                          this.selectedFile.type === 'file'
                            ? html`
                              <button
                                class="btn-secondary text-xs px-2 py-1 font-mono ${tap}"
                                @click=${() =>
                                  this.selectedFile &&
                                  this.handleCopyToClipboard(
                                    this.absolutePathOf(this.selectedFile)
                                  )}
                                title=${`${t('files.copyPath.title')} (⌘C)`}
                              >
                                ${
                                  this.copyFeedback === 'copied'
                                    ? t('files.copied')
                                    : this.copyFeedback === 'failed'
                                      ? t('files.copyFailed')
                                      : t('files.copyPath')
                                }
                              </button>
                              ${
                                this.mode === 'browse'
                                  ? html`
                                    <button
                                      class="btn-primary text-xs px-2 py-1 font-mono ${tap}"
                                      @click=${this.insertPathIntoTerminal}
                                      title=${`${t('files.insertPath.title')} (Enter)`}
                                    >
                                      ${t('files.insertPath')}
                                    </button>
                                  `
                                  : ''
                              }
                            `
                            : ''
                        }
                        ${
                          this.selectedFile.gitStatus && this.selectedFile.gitStatus !== 'unchanged'
                            ? html`
                              <button
                                class="btn-secondary text-xs px-2 py-1 font-mono ${tap} ${
                                  this.showDiff ? 'bg-primary text-bg' : ''
                                } ${
                                  this.isMobile &&
                                  this.selectedFile.type === 'file' &&
                                  this.mode === 'browse'
                                    ? ''
                                    : 'col-span-2'
                                }"
                                @click=${this.toggleDiff}
                              >
                                ${this.showDiff ? t('files.viewFile') : t('files.viewDiff')}
                              </button>
                            `
                            : ''
                        }
                      </div>
                    </div>
                  `
                  : ''
              }
              <div class="flex-1 overflow-hidden">${this.renderPreview()}</div>
            </div>
          </div>

          ${
            this.mode === 'select'
              ? html`
                <div
                  class="p-4 border-t border-border/50 flex gap-4"
                  style="padding-bottom: max(1rem, env(safe-area-inset-bottom));"
                >
                  <button class="btn-ghost font-mono flex-1" @click=${this.handleCancel}>
                    ${t('common.cancel')}
                  </button>
                  <button class="btn-primary font-mono flex-1" @click=${this.handleSelect}>
                    ${t('files.selectDirectory')}
                  </button>
                </div>
              `
              : ''
          }
        </div>
        </div>
      </div>
    `;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('resize', this.handleResize);
    this.removeTouchHandlers();
    this.revokeImageObjectUrl();
    clearTimeout(this.copyFeedbackTimer);
  }

  private async checkAuthConfig() {
    try {
      const response = await fetch('/api/auth/config');
      if (response.ok) {
        const config = await response.json();
        this.noAuthMode = config.noAuth === true;
        logger.debug('Auth config:', config);
      }
    } catch (error) {
      logger.error('Failed to fetch auth config:', error);
    }
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    if (!this.visible) return;

    if (e.key === 'Escape') {
      // Only handle escape when editing path - modal-wrapper handles the general escape
      if (this.editingPath) {
        e.preventDefault();
        e.stopImmediatePropagation(); // Prevent modal-wrapper from also handling it
        this.cancelPathEdit();
      }
      // Let modal-wrapper handle the escape for closing the modal
    } else if (
      e.key === 'Enter' &&
      this.selectedFile &&
      this.selectedFile.type === 'file' &&
      !this.editingPath
    ) {
      e.preventDefault();
      this.insertPathIntoTerminal();
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'c' && this.selectedFile) {
      e.preventDefault();
      this.handleCopyToClipboard(this.absolutePathOf(this.selectedFile));
    }
  };

  private handleResize = () => {
    this.isMobile = window.innerWidth < 768;
    if (!this.isMobile && this.mobileView === 'preview') {
      this.mobileView = 'list';
    }
  };

  private touchStartX = 0;
  private touchStartY = 0;

  private setupTouchHandlers() {
    if (!this.isMobile) return;

    const handleTouchStart = (e: TouchEvent) => {
      this.touchStartX = e.touches[0].clientX;
      this.touchStartY = e.touches[0].clientY;
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (!this.visible || !this.isMobile) return;

      const deltaX = e.changedTouches[0].clientX - this.touchStartX;
      const deltaY = Math.abs(e.changedTouches[0].clientY - this.touchStartY);

      // Only handle horizontal swipes
      if (Math.abs(deltaX) > 50 && deltaY < 50) {
        if (deltaX > 0) {
          // Swipe right
          if (this.mobileView === 'preview') {
            this.mobileView = 'list';
          } else {
            this.handleCancel();
          }
        }
      }
    };

    document.addEventListener('touchstart', handleTouchStart);
    document.addEventListener('touchend', handleTouchEnd);

    // Store handlers for removal
    interface TouchHandlers {
      handleTouchStart: (e: TouchEvent) => void;
      handleTouchEnd: (e: TouchEvent) => void;
    }
    (this as unknown as { _touchHandlers: TouchHandlers })._touchHandlers = {
      handleTouchStart,
      handleTouchEnd,
    };
  }

  private removeTouchHandlers() {
    interface TouchHandlers {
      handleTouchStart: (e: TouchEvent) => void;
      handleTouchEnd: (e: TouchEvent) => void;
    }
    const handlers = (this as unknown as { _touchHandlers?: TouchHandlers })._touchHandlers;
    if (handlers) {
      document.removeEventListener('touchstart', handlers.handleTouchStart);
      document.removeEventListener('touchend', handlers.handleTouchEnd);
    }
  }

  private handlePathClick() {
    this.editingPath = true;
    this.pathInputValue = this.currentFullPath || this.currentPath || '';
    this.requestUpdate();
    // Focus the input after render
    setTimeout(() => {
      if (this.pathInputRef.value) {
        this.pathInputRef.value.focus();
        this.pathInputRef.value.select();
      }
    }, 0);
  }

  private handlePathInput(e: Event) {
    const input = e.target as HTMLInputElement;
    this.pathInputValue = input.value;
  }

  private handlePathKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.navigateToPath();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.cancelPathEdit();
    }
  }

  private handlePathBlur() {
    // Don't cancel on blur, let user decide with Escape or Enter
    // this.cancelPathEdit();
  }

  private async navigateToPath() {
    const path = this.pathInputValue.trim();
    if (path) {
      this.editingPath = false;
      await this.loadDirectory(path);
    } else {
      this.cancelPathEdit();
    }
  }

  private cancelPathEdit() {
    this.editingPath = false;
    this.pathInputValue = '';
  }
}
