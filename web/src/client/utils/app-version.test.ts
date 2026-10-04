// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';
import { getAutoReloadOnUpdate, setAutoReloadOnUpdate, startVersionWatch } from './app-version.js';

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('startVersionWatch', () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    setVisibility('visible');
  });

  /** Each check reads the bundle first: the n-th check serves the n-th build for every file. */
  function serveTags(...tags: string[]) {
    let check = -1;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('client-bundle.js')) check++;
      const tag = tags[Math.min(Math.max(check, 0), tags.length - 1)];
      return new Response(null, { status: 200, headers: { etag: `${tag} ${url}` } });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('offers a reload, and does not reload by itself, when a new build is found', async () => {
    serveTags('"v1"', '"v2"');
    const reload = vi.fn();
    const onStale = vi.fn();
    stop = startVersionWatch({ reload, onStale, isBusy: () => false });
    await flush();
    setVisibility('hidden');
    setVisibility('visible');
    await flush();
    expect(reload).not.toHaveBeenCalled();
    expect(onStale).toHaveBeenCalledTimes(1);
    // Once is enough.
    setVisibility('hidden');
    setVisibility('visible');
    await flush();
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it('with auto-reload on, reloads when the app comes back to the foreground', async () => {
    serveTags('"v1"', '"v2"');
    const reload = vi.fn();
    const onStale = vi.fn();
    stop = startVersionWatch({ reload, onStale, isBusy: () => false, autoReload: () => true });
    await flush();
    setVisibility('hidden');
    setVisibility('visible');
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(onStale).not.toHaveBeenCalled();
  });

  it('with auto-reload on, still only offers it while something is being typed', async () => {
    serveTags('"v1"', '"v2"');
    const reload = vi.fn();
    const onStale = vi.fn();
    stop = startVersionWatch({ reload, onStale, isBusy: () => true, autoReload: () => true });
    await flush();
    setVisibility('visible');
    await flush();
    expect(reload).not.toHaveBeenCalled();
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it('also notices a style-only update (the bundle unchanged)', async () => {
    let check = -1;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('client-bundle.js')) check++;
        const etag = String(url).includes('styles.css') ? `"css${Math.min(check, 1)}"` : '"same"';
        return new Response(null, { status: 200, headers: { etag } });
      })
    );
    const onStale = vi.fn();
    stop = startVersionWatch({ reload: vi.fn(), onStale, isBusy: () => false });
    await flush();
    setVisibility('visible');
    await flush();
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it('does nothing while the build is unchanged, or when files have no ETag', async () => {
    serveTags('"v1"');
    const onStale = vi.fn();
    stop = startVersionWatch({ reload: vi.fn(), onStale, isBusy: () => false });
    await flush();
    setVisibility('visible');
    await flush();
    expect(onStale).not.toHaveBeenCalled();
    stop();

    // Development servers send no ETag or Last-Modified: never stale.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 }))
    );
    stop = startVersionWatch({ reload: vi.fn(), onStale, isBusy: () => false });
    await flush();
    setVisibility('visible');
    await flush();
    expect(onStale).not.toHaveBeenCalled();
  });

  it('notices a new build while on screen, and does not poll while hidden', async () => {
    vi.useFakeTimers();
    const fetchMock = serveTags('"v1"', '"v2"');
    const onStale = vi.fn();
    stop = startVersionWatch({ reload: vi.fn(), onStale, isBusy: () => false });
    await vi.advanceTimersByTimeAsync(0);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    const callsWhileVisible = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock.mock.calls.length).toBe(callsWhileVisible);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onStale).toHaveBeenCalledTimes(1);
  });
});

describe('auto-reload preference', () => {
  beforeEach(() => setupLocalStorageMock());
  afterEach(() => restoreLocalStorage());

  it('is off unless turned on, and keeps the other app preferences', () => {
    expect(getAutoReloadOnUpdate()).toBe(false);
    localStorage.setItem(
      'vibetunnel_app_preferences',
      JSON.stringify({ useDirectKeyboard: false })
    );
    setAutoReloadOnUpdate(true);
    expect(getAutoReloadOnUpdate()).toBe(true);
    expect(JSON.parse(localStorage.getItem('vibetunnel_app_preferences') ?? '{}')).toEqual({
      useDirectKeyboard: false,
      autoReloadOnUpdate: true,
    });
  });
});

describe('a page the service worker served an older build (sw-shell.ts)', () => {
  let stop: (() => void) | undefined;
  let worker: EventTarget;
  const workerSays = (type: string) =>
    worker.dispatchEvent(new MessageEvent('message', { data: { type } }));

  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200, headers: { etag: '"v2"' } }))
    );
    worker = new EventTarget();
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: worker });
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.unstubAllGlobals();
    setVisibility('visible');
    Reflect.deleteProperty(navigator, 'serviceWorker');
  });

  it('only offers a reload while "Reload automatically after an update" is off (the default)', async () => {
    const reload = vi.fn();
    const onStale = vi.fn();
    stop = startVersionWatch({ reload, onStale, isBusy: () => false });
    await flush();
    workerSays('vt-shell-updated');
    expect(reload).not.toHaveBeenCalled();
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it('with the switch on, reloads at once while nobody has touched it, once a minute at most', async () => {
    const reload = vi.fn();
    const onStale = vi.fn();
    stop = startVersionWatch({ reload, onStale, autoReload: () => true, isBusy: () => false });
    await flush();
    workerSays('vt-shell-updated');
    expect(reload).toHaveBeenCalledTimes(1);

    // The reloaded page is told the same (the worker got it wrong): no reload loop.
    stop();
    stop = startVersionWatch({ reload, onStale, autoReload: () => true, isBusy: () => false });
    workerSays('vt-shell-updated');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it('with the switch on, offers a reload instead once the page is in use', async () => {
    const reload = vi.fn();
    const onStale = vi.fn();
    stop = startVersionWatch({ reload, onStale, autoReload: () => true, isBusy: () => false });
    window.dispatchEvent(new Event('pointerdown'));
    workerSays('vt-shell-updated');
    expect(reload).not.toHaveBeenCalled();
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it("ignores the worker's other messages", async () => {
    const reload = vi.fn();
    const onStale = vi.fn();
    stop = startVersionWatch({ reload, onStale, autoReload: () => true, isBusy: () => false });
    workerSays('notification-action');
    expect(reload).not.toHaveBeenCalled();
    expect(onStale).not.toHaveBeenCalled();
  });
});
