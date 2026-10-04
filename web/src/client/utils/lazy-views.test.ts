/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lazyModule } from './lazy-views.js';

describe('lazy views', () => {
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      reload,
    } as Location);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fetches a chunk once, and again after a failed fetch', async () => {
    const importer = vi
      .fn<() => Promise<{ name: string }>>()
      .mockRejectedValueOnce(new TypeError('Importing a module script failed.'))
      .mockResolvedValue({ name: 'view' });
    const lazy = lazyModule(importer);

    await expect(lazy.load()).rejects.toThrow(TypeError);
    expect(lazy.module).toBeUndefined();
    await expect(lazy.load()).resolves.toEqual({ name: 'view' });
    await lazy.load();
    expect(importer).toHaveBeenCalledTimes(2);
    expect(lazy.module).toEqual({ name: 'view' });
  });

  it('a view the user opens survives one failed fetch without reloading', async () => {
    const importer = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new TypeError('Load failed'))
      .mockResolvedValue('view');
    const opened = lazyModule(importer).require();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(opened).resolves.toBe('view');
    expect(reload).not.toHaveBeenCalled();
  });

  it('a chunk that stays missing (older build) reloads the page, once a minute at most', async () => {
    const gone = () => lazyModule(() => Promise.reject(new TypeError('404')));
    const first = gone().require();
    const firstDone = expect(first).rejects.toThrow('404');
    await vi.advanceTimersByTimeAsync(1000);
    await firstDone;
    expect(reload).toHaveBeenCalledTimes(1);

    // The reloaded page still can't load it: no reload loop.
    const second = gone().require();
    const secondDone = expect(second).rejects.toThrow('404');
    await vi.advanceTimersByTimeAsync(1000);
    await secondDone;
    expect(reload).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 61_000);
    const later = gone().require();
    const laterDone = expect(later).rejects.toThrow('404');
    await vi.advanceTimersByTimeAsync(1000);
    await laterDone;
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('use() runs right away once the module is loaded, as when it was in the bundle', async () => {
    const lazy = lazyModule(() => Promise.resolve({ open: vi.fn() }));
    const before = vi.fn();
    lazy.use(before);
    expect(before).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(before).toHaveBeenCalledTimes(1);

    const after = vi.fn();
    lazy.use(after);
    expect(after).toHaveBeenCalledTimes(1);
  });
});
