/**
 * Stores the service worker's offline page in the user's language. The worker can't load
 * the i18n bundle, so the app renders the page while it's online and leaves it in Cache
 * Storage; the worker falls back to English if it never got one. Static text only. The
 * notification strings the worker needs (sw-notify-i18n.ts) are stored next to it.
 */
import { getLocale, isRtlLocale, LOCALE_CHANGED_EVENT, t } from '../i18n/index.js';
import { NOTIFY_STRINGS_URL, type NotifyStrings } from '../sw-notify-i18n.js';
import { OFFLINE_CACHE, OFFLINE_PAGE_URL, renderOfflinePage } from '../sw-offline.js';
import { createLogger } from './logger.js';

const logger = createLogger('offline-page');

async function store(): Promise<void> {
  if (typeof caches === 'undefined') return;
  const html = renderOfflinePage({
    lang: getLocale(),
    dir: isRtlLocale() ? 'rtl' : 'ltr',
    title: t('pwa.offlineTitle'),
    body: t('pwa.offlineBody'),
    retrying: t('pwa.offlineRetrying'),
    retryNow: t('pwa.offlineRetryNow'),
  });
  const cache = await caches.open(OFFLINE_CACHE);
  await cache.put(
    OFFLINE_PAGE_URL,
    new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  );
  const strings: NotifyStrings = {
    needsYou: t('notify.needsYou', { where: '{where}' }),
    finished: t('notify.finished', { where: '{where}' }),
    waiting: t('notify.waiting'),
    yourTurn: t('notify.yourTurn'),
    open: t('notify.open'),
    dismiss: t('notify.dismiss'),
    attention: t('notify.attention', { where: '{where}' }),
    bellBody: t('notify.bellBody'),
    commandFailed: t('notify.commandFailed', { where: '{where}' }),
    commandFailedBody: t('notify.commandFailedBody', { code: '{code}', duration: '{duration}' }),
  };
  await cache.put(
    NOTIFY_STRINGS_URL,
    new Response(JSON.stringify(strings), { headers: { 'Content-Type': 'application/json' } })
  );
}

let listening = false;

export function installOfflinePage(): void {
  const run = () => store().catch((error) => logger.debug('offline page not stored:', error));
  run();
  if (!listening && typeof window !== 'undefined') {
    listening = true;
    window.addEventListener(LOCALE_CHANGED_EVENT, run);
  }
}
