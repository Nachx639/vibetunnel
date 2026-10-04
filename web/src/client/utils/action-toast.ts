/**
 * A small notice at the bottom of the screen with one action ("Reload"), for things that need
 * a tap but must not interrupt, such as a new app version.
 */
import { t } from '../i18n/index.js';

export interface ActionToastOptions {
  text: string;
  action: string;
  onAction: () => void;
  /** 0 keeps it until dismissed. */
  timeoutMs?: number;
  /** A second notice with the same key replaces the first. */
  key?: string;
}

const open = new Map<string, HTMLElement>();

export function showActionToast(options: ActionToastOptions): () => void {
  const key = options.key ?? options.text;
  open.get(key)?.remove();
  const el = document.createElement('div');
  el.className = 'vt-action-toast';
  el.setAttribute('role', 'status');
  const label = document.createElement('span');
  label.textContent = options.text;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = options.action;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'vt-action-toast-close';
  close.setAttribute('aria-label', t('common.close'));
  close.textContent = '×';
  el.append(label, button, close);

  let timer: number | undefined;
  const dismiss = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    el.remove();
    if (open.get(key) === el) open.delete(key);
  };
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    dismiss();
    options.onAction();
  });
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    dismiss();
  });
  document.body.appendChild(el);
  open.set(key, el);
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (timeoutMs > 0) timer = window.setTimeout(dismiss, timeoutMs);
  return dismiss;
}
