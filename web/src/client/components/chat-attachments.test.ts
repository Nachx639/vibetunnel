// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { AttachmentUploader } from './chat-attachments.js';
import './chat-attachments.js';
import { TerminalChatView } from './terminal-chat-view.js';

interface Upload {
  file: File;
  progress: (percent: number) => void;
  resolve: (path: string) => void;
  reject: (error: Error) => void;
}

function fakeUploader() {
  const uploads: Upload[] = [];
  const uploader: AttachmentUploader = (file, progress) =>
    new Promise((resolve, reject) => {
      uploads.push({ file, progress, resolve: (path) => resolve({ path }), reject });
    });
  return { uploads, uploader };
}

const png = (name = 'shot.png') =>
  new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
const flush = () => new Promise((r) => setTimeout(r, 0));
/** A finger down on `el` and up `dx` px to the side: iOS ends a scroll begun on it with a pointerup. */
const touch = (el: Element, dx: number) => {
  const at = (x: number) => ({
    pointerType: 'touch',
    pointerId: 7,
    clientX: x,
    clientY: 40,
    bubbles: true,
    composed: true,
  });
  el.dispatchEvent(new PointerEvent('pointerdown', at(300)));
  el.dispatchEvent(new PointerEvent('pointerup', at(300 + dx)));
};

describe('phone composer attachments', () => {
  let composer: TerminalChatView;
  let onSend: Mock<NonNullable<TerminalChatView['onSend']>>;
  let fake: ReturnType<typeof fakeUploader>;

  const strip = () => composer.shadowRoot?.querySelector('chat-attachment-strip');
  const items = () => [
    ...(strip()?.shadowRoot?.querySelectorAll('[data-testid="attachment"]') ?? []),
  ];
  const textarea = () => composer.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement;
  const sendButton = () => composer.shadowRoot?.querySelector('.send-button') as HTMLButtonElement;
  const settle = async () => {
    await flush();
    await composer.updateComplete;
    await strip()?.updateComplete;
  };

  beforeEach(async () => {
    vi.useRealTimers();
    fake = fakeUploader();
    onSend = vi.fn();
    composer = new TerminalChatView();
    composer.composerOnly = true;
    composer.active = true;
    composer.sessionId = 'sess-attach';
    composer.onSend = onSend;
    composer.attachmentUploader = fake.uploader;
    document.body.append(composer);
    await composer.updateComplete;
  });

  afterEach(() => {
    composer.remove();
    document.querySelector('image-lightbox')?.remove();
    vi.useRealTimers();
  });

  it('shows a thumbnail per image with upload progress, and types nothing yet', async () => {
    composer.addAttachments([png('a.png'), png('b.png')]);
    await settle();
    expect(items()).toHaveLength(2);
    expect(items()[0].querySelector('img.thumb')?.getAttribute('src')).toMatch(/^blob:/);

    fake.uploads[0].progress(40);
    await settle();
    const bar = items()[0].querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('40');
    expect(items()[0].textContent).toContain('40%');
    expect(sendButton().disabled).toBe(true);

    fake.uploads[0].resolve('/u/.vibetunnel/control/uploads/a.png');
    fake.uploads[1].resolve('/u/.vibetunnel/control/uploads/b.png');
    await settle();
    expect(items().map((i) => i.getAttribute('data-status'))).toEqual(['done', 'done']);
    expect(sendButton().disabled).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('removes an attachment with its ✕', async () => {
    composer.addAttachments([png('a.png'), png('b.png')]);
    await settle();
    (items()[0].querySelector('[data-action="remove"]') as HTMLButtonElement).click();
    await settle();
    expect(items()).toHaveLength(1);
    expect(items()[0].querySelector('img')?.getAttribute('alt')).toBe('b.png');
  });

  it('shows a failed upload with Retry, and retrying uploads it again', async () => {
    composer.addAttachments([png()]);
    await settle();
    fake.uploads[0].reject(new Error('HTTP 500'));
    await settle();
    expect(items()[0].getAttribute('data-status')).toBe('error');

    textarea().value = 'look';
    sendButton().click();
    expect(onSend).not.toHaveBeenCalled();

    (items()[0].querySelector('[data-action="retry"]') as HTMLButtonElement).click();
    await settle();
    expect(fake.uploads).toHaveLength(2);
    expect(items()[0].getAttribute('data-status')).toBe('uploading');
  });

  it('sends the text and the image paths together on Send, then clears the strip', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    composer.addAttachments([png('a.png'), png('b.png')]);
    fake.uploads[0].resolve('/u/.vibetunnel/control/uploads/a.png');
    fake.uploads[1].resolve('/u/.vibetunnel/control/uploads/b.png');
    await Promise.resolve();
    await Promise.resolve();
    await composer.updateComplete;

    textarea().value = 'which flowers are these?';
    expect(onSend).not.toHaveBeenCalled();
    sendButton().click();
    await vi.runAllTimersAsync();

    expect(onSend.mock.calls.map((c) => c[0])).toEqual([
      '/u/.vibetunnel/control/uploads/a.png /u/.vibetunnel/control/uploads/b.png',
      ' which flowers are these?',
      '\r',
    ]);
    await composer.updateComplete;
    expect(strip()).toBeFalsy();
  });

  it('does not send while an image is still uploading', async () => {
    composer.addAttachments([png()]);
    await settle();
    textarea().value = 'hello';
    (composer as unknown as { handleSend(): void }).handleSend();
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea().value).toBe('hello');
  });

  it('adds a pasted screenshot to the strip instead of the text', async () => {
    const file = png('Screenshot.png');
    const paste = new Event('paste', { bubbles: true, composed: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] },
    });
    const documentPaste = vi.fn();
    document.addEventListener('paste', documentPaste);
    textarea().dispatchEvent(paste);
    document.removeEventListener('paste', documentPaste);
    await settle();
    expect(paste.defaultPrevented).toBe(true);
    expect(documentPaste).not.toHaveBeenCalled();
    expect(fake.uploads.map((u) => u.file)).toEqual([file]);
    expect(items()).toHaveLength(1);
  });

  it('a scroll of the strip that starts on a thumbnail or its ✕ opens or removes nothing', async () => {
    composer.addAttachments([png('a.png'), png('b.png')]);
    await settle();
    const thumb = items()[0].querySelector('img.thumb') as HTMLImageElement;
    touch(items()[0].querySelector('[data-action="remove"]') as HTMLButtonElement, -100);
    touch(thumb, -100);
    await settle();
    expect(items()).toHaveLength(2);
    expect(document.querySelector('image-lightbox')).toBeNull();
    touch(thumb, 2);
    thumb.click();
    expect(document.querySelector('image-lightbox')).toBeTruthy();
  });

  it('opens a strip thumbnail full screen', async () => {
    composer.addAttachments([png()]);
    await settle();
    (items()[0].querySelector('img.thumb') as HTMLImageElement).click();
    const box = document.querySelector('image-lightbox');
    expect(box).toBeTruthy();
    expect(box?.src).toMatch(/^blob:/);
  });
});
