/**
 * Notices when the app's code changed on the server. An installed web app stays in memory
 * for days and never reloads on its own, so a server update never reached the phone. The
 * client bundle, the stylesheet and index.html are served with an ETag (production builds);
 * when any of them differs from what this page loaded, the app offers "Reload". With
 * "Reload automatically after an update" on, it reloads by itself the next time it comes back
 * to the foreground, unless something is being typed.
 */
const WATCHED_URLS = ['/bundle/client-bundle.js', '/bundle/styles.css', '/'];
const POLL_MS = 120_000;

async function fileTag(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (!res.ok) return null;
    return res.headers.get('etag') || res.headers.get('last-modified');
  } catch {
    return null;
  }
}

/** One tag for the whole build; null when any file can't be checked right now. */
async function bundleTag(): Promise<string | null> {
  const tags = await Promise.all(WATCHED_URLS.map(fileTag));
  return tags.some((tag) => tag === null) ? null : tags.join(' ');
}

export interface VersionWatchOptions {
  /** A newer build is on the server and the page is on screen: offer a reload. */
  onStale: () => void;
  /** Reload by itself when coming back to the foreground (the user's opt-in). */
  autoReload?: () => boolean;
  /** Reload (default: location.reload). */
  reload?: () => void;
  /** Whether reloading now would lose something the user is typing. */
  isBusy?: () => boolean;
}

export function startVersionWatch(options: VersionWatchOptions): () => void {
  const reload = options.reload ?? (() => window.location.reload());
  let loadedTag: string | null = null;
  let stale = false;
  let stopped = false;
  let notified = false;

  const check = async () => {
    if (stopped || stale) return;
    const tag = await bundleTag();
    if (!tag) return;
    if (loadedTag === null) {
      loadedTag = tag;
      return;
    }
    if (tag !== loadedTag) stale = true;
  };

  const notify = () => {
    if (notified || stopped) return;
    notified = true;
    options.onStale();
  };

  const onVisibility = async () => {
    if (document.visibilityState !== 'visible') return;
    await check();
    if (!stale) return;
    if (options.autoReload?.() && !options.isBusy?.()) {
      reload();
      return;
    }
    notify();
  };

  void check();
  const timer = window.setInterval(async () => {
    // Nobody is looking: check again when the page comes back.
    if (document.visibilityState !== 'visible') return;
    await check();
    if (stale) notify();
  }, POLL_MS);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    stopped = true;
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/** Something is being typed (a draft would be lost by a reload). */
export function userIsTyping(): boolean {
  let el: Element | null = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    return el.value.trim().length > 0;
  }
  return false;
}

const PREFERENCES_KEY = 'vibetunnel_app_preferences';

/** "Reload automatically after an update" (Settings > Application). Off unless turned on. */
export function getAutoReloadOnUpdate(): boolean {
  try {
    const stored = localStorage.getItem(PREFERENCES_KEY);
    return stored ? JSON.parse(stored).autoReloadOnUpdate === true : false;
  } catch {
    return false;
  }
}

export function setAutoReloadOnUpdate(enabled: boolean): void {
  try {
    const stored = localStorage.getItem(PREFERENCES_KEY);
    const preferences = stored ? JSON.parse(stored) : {};
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ ...preferences, autoReloadOnUpdate: enabled })
    );
  } catch {
    // Storage unavailable (private mode): the toast keeps offering the reload.
  }
}
