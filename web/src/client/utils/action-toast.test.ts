// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { showActionToast } from './action-toast.js';

describe('showActionToast', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('runs the action once and goes away', () => {
    const onAction = vi.fn();
    showActionToast({ text: 'New version', action: 'Reload', onAction, timeoutMs: 0 });
    const toast = document.querySelector('.vt-action-toast');
    expect(toast?.getAttribute('role')).toBe('status');
    (document.querySelector('.vt-action-toast button') as HTMLButtonElement).click();
    expect(onAction).toHaveBeenCalledOnce();
    expect(document.querySelector('.vt-action-toast')).toBeNull();
  });

  it('the close button dismisses without acting; a second toast with the key replaces it', () => {
    const onAction = vi.fn();
    showActionToast({ key: 'k', text: 'one', action: 'Go', onAction, timeoutMs: 0 });
    showActionToast({ key: 'k', text: 'two', action: 'Go', onAction, timeoutMs: 0 });
    expect(document.querySelectorAll('.vt-action-toast')).toHaveLength(1);
    (document.querySelector('.vt-action-toast-close') as HTMLButtonElement).click();
    expect(onAction).not.toHaveBeenCalled();
    expect(document.querySelector('.vt-action-toast')).toBeNull();
  });

  it('times out unless told to stay', () => {
    vi.useFakeTimers();
    showActionToast({ text: 't', action: 'a', onAction: () => {} });
    vi.advanceTimersByTime(10_000);
    expect(document.querySelector('.vt-action-toast')).toBeNull();
  });
});
