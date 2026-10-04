// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { type FileOperationsCallbacks, FileOperationsManager } from './file-operations-manager';

function setup(composer: { attach?: boolean; insert?: boolean }) {
  const uploadFile = vi.fn(async () => {});
  const sendInputText = vi.fn(async () => {});
  const attachToComposer = vi.fn(() => composer.attach ?? false);
  const insertIntoComposer = vi.fn(() => composer.insert ?? false);
  const callbacks: FileOperationsCallbacks = {
    getSession: () => ({ id: 's1' }) as never,
    getInputManager: () => ({ sendInputText }) as never,
    querySelector: (selector) => (selector === 'file-picker' ? ({ uploadFile } as never) : null),
    setIsDragOver: vi.fn(),
    setShowFileBrowser: vi.fn(),
    setShowImagePicker: vi.fn(),
    getIsMobile: () => true,
    getShowFileBrowser: () => false,
    getShowImagePicker: () => false,
    dispatchEvent: vi.fn(() => true),
    requestUpdate: vi.fn(),
    attachToComposer,
    insertIntoComposer,
  };
  const manager = new FileOperationsManager();
  manager.setCallbacks(callbacks);
  return { manager, uploadFile, sendInputText, attachToComposer, insertIntoComposer };
}

const dropOf = (files: File[]) =>
  ({
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: { files },
  }) as unknown as DragEvent;

const pasteOf = (files: File[]) =>
  ({
    preventDefault: vi.fn(),
    clipboardData: { items: files.map((file) => ({ kind: 'file', getAsFile: () => file })) },
  }) as unknown as ClipboardEvent;

describe('FileOperationsManager in phone chat mode', () => {
  const photo = new File(['x'], 'photo.png', { type: 'image/png' });

  it('hands dropped and pasted files to the composer instead of typing their paths now', async () => {
    const { manager, uploadFile, attachToComposer } = setup({ attach: true });
    await manager.handleDrop(dropOf([photo]));
    await manager.handlePaste(pasteOf([photo]));
    expect(attachToComposer).toHaveBeenCalledTimes(2);
    expect(attachToComposer).toHaveBeenCalledWith([photo]);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('uploads as before when no composer takes them', async () => {
    const { manager, uploadFile } = setup({ attach: false });
    await manager.handleDrop(dropOf([photo]));
    expect(uploadFile).toHaveBeenCalledWith(photo);
  });

  it('puts an inserted path in the composer, quoted, and not in the terminal', async () => {
    const { manager, insertIntoComposer, sendInputText } = setup({ insert: true });
    await manager.insertPath('/tmp/a b.txt', 'file');
    expect(insertIntoComposer).toHaveBeenCalledWith("'/tmp/a b.txt'");
    expect(sendInputText).not.toHaveBeenCalled();
  });

  it('types an inserted path into the terminal, quoted, outside chat mode', async () => {
    const { manager, sendInputText } = setup({ insert: false });
    await manager.insertPath('/tmp/x;rm -rf ~.txt', 'file');
    expect(sendInputText).toHaveBeenCalledWith("'/tmp/x;rm -rf ~.txt'");
  });
});
