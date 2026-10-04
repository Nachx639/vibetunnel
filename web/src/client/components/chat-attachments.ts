/**
 * Phone chat mode: images waiting to go out with the next message, shown as a strip of
 * thumbnails above the composer (like iMessage/WhatsApp). Uploads start right away in the
 * background, but nothing reaches the terminal until Send, so a path is never typed into the
 * agent before the message is written.
 */
import { css, html, LitElement, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { LocaleController, t } from '../i18n/index.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { prepareImageForUpload } from '../utils/image-downscale.js';
import { endsADrag } from '../utils/pointer-drag.js';
import { openImageLightbox } from './image-lightbox.js';
import { type UploadResult, uploadWithProgress } from './session-view/file-operations-manager.js';

export type AttachmentStatus = 'uploading' | 'done' | 'error';

export interface PendingAttachment {
  id: string;
  name: string;
  /** Object URL of the original file, for the thumbnail. */
  previewUrl: string;
  status: AttachmentStatus;
  percent: number;
  /** Absolute path on the server, once uploaded. */
  path?: string;
  error?: string;
}

export type AttachmentUploader = (
  file: File,
  onProgress: (percent: number) => void,
  signal: AbortSignal
) => Promise<Pick<UploadResult, 'path'>>;

/** Downscale big photos, then upload with progress. */
export const uploadAttachment: AttachmentUploader = async (file, onProgress, signal) => {
  const prepared = await prepareImageForUpload(file);
  if (signal.aborted) throw new Error('aborted');
  return uploadWithProgress(prepared, onProgress, signal);
};

let nextId = 0;

/** The attachments' state; the composer owns one and renders it with <chat-attachment-strip>. */
export class AttachmentQueue {
  items: PendingAttachment[] = [];
  private files = new Map<string, File>();
  private controllers = new Map<string, AbortController>();

  constructor(
    private readonly onChange: () => void,
    private readonly upload: AttachmentUploader = uploadAttachment
  ) {}

  add(files: File[]): void {
    for (const file of files) {
      const id = `att-${++nextId}`;
      this.files.set(id, file);
      this.items = [
        ...this.items,
        {
          id,
          name: file.name || t('attach.image'),
          previewUrl: createObjectUrl(file),
          status: 'uploading',
          percent: 0,
        },
      ];
      void this.start(id);
    }
    this.onChange();
  }

  remove(id: string): void {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    this.controllers.get(id)?.abort();
    this.controllers.delete(id);
    this.files.delete(id);
    revokeObjectUrl(item.previewUrl);
    this.items = this.items.filter((i) => i.id !== id);
    this.onChange();
  }

  retry(id: string): void {
    if (!this.items.some((i) => i.id === id && i.status === 'error')) return;
    void this.start(id);
  }

  /** Some upload still running: the message cannot go yet. */
  get busy(): boolean {
    return this.items.some((i) => i.status === 'uploading');
  }

  get hasErrors(): boolean {
    return this.items.some((i) => i.status === 'error');
  }

  /** Server paths of the uploaded attachments, in the order they were added. */
  get paths(): string[] {
    return this.items.flatMap((i) => (i.status === 'done' && i.path ? [i.path] : []));
  }

  /** After sending: forget the attachments (the sent bubble loads its own copy). */
  clear(): void {
    for (const id of [...this.items.map((i) => i.id)]) this.remove(id);
  }

  private patch(id: string, change: Partial<PendingAttachment>) {
    this.items = this.items.map((i) => (i.id === id ? { ...i, ...change } : i));
    this.onChange();
  }

  private async start(id: string): Promise<void> {
    const file = this.files.get(id);
    if (!file) return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    this.patch(id, { status: 'uploading', percent: 0, error: undefined });
    try {
      const result = await this.upload(
        file,
        (percent) => {
          if (!controller.signal.aborted) this.patch(id, { percent });
        },
        controller.signal
      );
      if (controller.signal.aborted) return;
      this.patch(id, { status: 'done', percent: 100, path: result.path });
    } catch (error) {
      if (controller.signal.aborted) return;
      this.patch(id, {
        status: 'error',
        error: error instanceof Error ? error.message : t('toast.uploadFailed'),
      });
    } finally {
      if (this.controllers.get(id) === controller) this.controllers.delete(id);
    }
  }
}

function createObjectUrl(file: File): string {
  try {
    return URL.createObjectURL(file);
  } catch {
    return '';
  }
}

function revokeObjectUrl(url: string) {
  if (!url) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // Nothing to free.
  }
}

/** Act on pointerup (first taps on iOS can be eaten as hover) and eat the ghost click. */
function tap(action: () => void) {
  return (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'pointerup') {
      // A scroll of the strip that started on it ends here too: not a tap.
      if (endsADrag(e as PointerEvent)) return;
      swallowNextClick();
    }
    action();
  };
}

@customElement('chat-attachment-strip')
export class ChatAttachmentStrip extends LitElement {
  static styles = css`
    :host {
      display: block;
    }
    .strip {
      display: flex;
      gap: 8px;
      overflow-x: auto;
      padding: 8px 10px 4px;
      scrollbar-width: none;
    }
    .item {
      position: relative;
      flex: 0 0 auto;
      width: 64px;
      height: 64px;
      border-radius: 10px;
      overflow: hidden;
      background: var(--color-bg-secondary);
      border: 1px solid var(--color-border);
    }
    .item.error {
      border-color: var(--color-status-error);
    }
    .thumb {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      cursor: pointer;
    }
    .file {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      width: 100%;
      height: 100%;
      padding: 4px;
      box-sizing: border-box;
      font-size: 9px;
      color: var(--color-text-muted);
      text-align: center;
      overflow-wrap: anywhere;
    }
    .file svg {
      flex: 0 0 auto;
    }
    .overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: color-mix(in srgb, var(--color-bg) 55%, transparent);
      color: var(--color-text);
      font-size: 12px;
      font-weight: 600;
      pointer-events: none;
    }
    .bar {
      position: absolute;
      left: 4px;
      right: 4px;
      bottom: 4px;
      height: 3px;
      border-radius: 2px;
      background: var(--color-bg-secondary);
      overflow: hidden;
    }
    .bar > div {
      height: 100%;
      background: var(--color-primary);
      transition: width 0.2s;
    }
    .retry {
      position: absolute;
      inset: 0;
      border: none;
      background: color-mix(in srgb, var(--color-bg) 60%, transparent);
      color: var(--color-status-error);
      font: inherit;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      touch-action: manipulation;
    }
    .remove {
      position: absolute;
      top: 2px;
      right: 2px;
      width: 22px;
      height: 22px;
      padding: 0;
      border-radius: 50%;
      border: none;
      display: flex;
      align-items: center;
      justify-content: center;
      background: color-mix(in srgb, var(--color-bg) 80%, transparent);
      color: var(--color-text);
      font-size: 13px;
      line-height: 1;
      cursor: pointer;
      touch-action: manipulation;
    }
  `;

  private locale = new LocaleController(this);

  @property({ attribute: false }) items: PendingAttachment[] = [];
  /** Thumbnails the browser could not decode (e.g. HEIC outside Safari): show a file icon. */
  private broken = new Set<string>();

  private emit(name: 'attachment-remove' | 'attachment-retry', id: string) {
    this.dispatchEvent(new CustomEvent(name, { detail: { id }, bubbles: true, composed: true }));
  }

  private renderPreview(item: PendingAttachment) {
    if (item.previewUrl && !this.broken.has(item.id)) {
      return html`<img
        class="thumb"
        src=${item.previewUrl}
        alt=${item.name}
        @error=${() => {
          this.broken.add(item.id);
          this.requestUpdate();
        }}
        @pointerup=${tap(() => openImageLightbox(item.previewUrl, item.name))}
        @click=${tap(() => openImageLightbox(item.previewUrl, item.name))}
      />`;
    }
    return html`<div class="file" data-testid="attachment-file">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
      <span>${item.name}</span>
    </div>`;
  }

  render() {
    void this.locale;
    if (this.items.length === 0) return nothing;
    return html`<div class="strip" role="list" aria-label=${t('attach.pending')}>
      ${this.items.map(
        (item) => html`<div
          class="item ${item.status}"
          role="listitem"
          data-testid="attachment"
          data-status=${item.status}
        >
          ${this.renderPreview(item)}
          ${
            item.status === 'uploading'
              ? html`<div class="overlay" role="progressbar" aria-valuenow=${item.percent}
                    aria-valuemin="0" aria-valuemax="100" aria-label=${t('attach.uploading', { percent: item.percent })}>
                    ${item.percent}%
                  </div>
                  <div class="bar"><div style="width:${item.percent}%"></div></div>`
              : nothing
          }
          ${
            item.status === 'error'
              ? html`<button
                  class="retry"
                  data-action="retry"
                  title=${item.error ?? ''}
                  @pointerup=${tap(() => this.emit('attachment-retry', item.id))}
                  @click=${tap(() => this.emit('attachment-retry', item.id))}
                >
                  ${t('attach.retry')}
                </button>`
              : nothing
          }
          <button
            class="remove"
            data-action="remove"
            aria-label=${t('attach.remove')}
            title=${t('attach.remove')}
            @pointerup=${tap(() => this.emit('attachment-remove', item.id))}
            @click=${tap(() => this.emit('attachment-remove', item.id))}
          >
            ✕
          </button>
        </div>`
      )}
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'chat-attachment-strip': ChatAttachmentStrip;
  }
}
