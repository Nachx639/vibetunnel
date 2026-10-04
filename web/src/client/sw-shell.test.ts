import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SHELL_PATHS, type ShellManifest } from '../shared/shell-version';
import {
  ASSET_CACHE,
  CHUNK_CACHE,
  ShellCache,
  type ShellRequestContext,
  type ShellRule,
  ShellSetting,
  shellCacheName,
  shellRule,
} from './sw-shell';

const origin = 'https://vt.example.com';

function request(path: string, init: { mode?: string; method?: string; cache?: string } = {}) {
  return {
    url: path.startsWith('http') ? path : `${origin}${path}`,
    mode: init.mode ?? 'cors',
    method: init.method ?? 'GET',
    cache: init.cache ?? 'default',
  } as Request;
}

const keyPath = (key: string | Request) =>
  new URL(typeof key === 'string' ? key : key.url, origin).pathname;

/** One cache, keyed by path. */
class FakeCache {
  entries = new Map<string, Response>();
  async match(key: string | Request) {
    return this.entries.get(keyPath(key))?.clone();
  }
  async put(key: string | Request, response: Response) {
    this.entries.set(keyPath(key), response);
  }
  async keys() {
    return [...this.entries.keys()].map((key) => ({ url: `${origin}${key}` }) as Request);
  }
  async delete(key: string | Request) {
    return this.entries.delete(keyPath(key));
  }
}

class FakeCacheStorage {
  stores = new Map<string, FakeCache>();
  async open(name: string) {
    let cache = this.stores.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.stores.set(name, cache);
    }
    return cache as unknown as Cache;
  }
  async has(name: string) {
    return this.stores.has(name);
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
}

const sha = (body: string) => createHash('sha256').update(body).digest('hex');

/** The server's disk: shell files, chunks, fonts. */
let disk: Map<string, string>;
let storage: FakeCacheStorage;
let fetchMock: ReturnType<typeof vi.fn<(path: string, init?: RequestInit) => Promise<Response>>>;
let clock: number;
let shell: ShellCache;
let pending: Promise<unknown>[];
let notified: number;
let context: ShellRequestContext;
/** Called after the manifest is served, before the files are (a write landing in between). */
let afterManifest: (() => void) | null;

/** What /bundle/version.json says about the disk now (server/utils/shell-version.ts). */
function manifest(): ShellManifest {
  const files: Record<string, string> = {};
  for (const path of SHELL_PATHS) files[path] = sha(disk.get(path) ?? '');
  const id = sha(SHELL_PATHS.map((path) => files[path]).join(' ')).slice(0, 16);
  const js = /js-build:(\w+)/.exec(disk.get('/bundle/client-bundle.js') ?? '')?.[1] ?? null;
  const css = /css-build:(\w+)/.exec(disk.get('/bundle/styles.css') ?? '')?.[1] ?? null;
  const chunks = [...(disk.get('/bundle/client-bundle.js') ?? '').matchAll(/import (\S+)/g)].map(
    (match) => match[1]
  );
  return {
    id,
    consistent: js === css && chunks.every((chunk) => disk.has(chunk)),
    build: { js, css },
    files,
    chunks,
    allChunks: chunks,
  };
}

/** One build: JS and CSS naming the build, and a chunk the bundle imports. */
function writeJs(build: string) {
  disk.set(`/bundle/chunks/chunk-${build}.js`, `chunk of ${build}`);
  disk.set('/bundle/client-bundle.js', `js-build:${build} import /bundle/chunks/chunk-${build}.js`);
}
function writeCss(build: string) {
  disk.set('/bundle/styles.css', `css-build:${build}`);
}
function deploy(build: string) {
  writeJs(build);
  writeCss(build);
}

/** A page load: every shell file of version `id`, as index.html asks for them. */
async function load(id: string): Promise<Record<string, string>> {
  const bodies: Record<string, string> = {};
  for (const path of SHELL_PATHS) bodies[path] = await get(`${path}?v=${id}`, 'shell');
  return bodies;
}

async function get(path: string, rule: ShellRule) {
  const response = await shell.respond(new URL(path, origin), rule, context);
  const body = await response.text();
  while (pending.length > 0) await Promise.all(pending.splice(0));
  return body;
}

const shellCaches = () =>
  [...storage.stores.keys()].filter((name) => name.startsWith('vibetunnel-shell-')).sort();

beforeEach(() => {
  disk = new Map();
  storage = new FakeCacheStorage();
  pending = [];
  notified = 0;
  clock = 1_000_000;
  afterManifest = null;
  fetchMock = vi.fn(async (input: string) => {
    const path = new URL(input, origin).pathname;
    if (path === '/bundle/version.json') {
      const body = JSON.stringify(manifest());
      afterManifest?.();
      afterManifest = null;
      return new Response(body, { status: 200 });
    }
    const body = disk.get(path);
    if (body === undefined) return new Response('missing', { status: 404 });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
  });
  shell = new ShellCache({
    caches: storage as unknown as CacheStorage,
    fetch: fetchMock,
    now: () => clock,
  });
  context = {
    waitUntil: (work) => pending.push(work),
    notifyUpdated: async () => {
      notified++;
    },
  };
});

describe('service worker shell: one version, never mixed', () => {
  it('answers versioned shell files, chunks and icons; everything else goes to the network', () => {
    const v = '0123456789abcdef';
    expect(shellRule(request(`/bundle/client-bundle.js?v=${v}`), origin)).toBe('shell');
    expect(shellRule(request(`/bundle/styles.css?v=${v}`), origin)).toBe('shell');
    expect(shellRule(request('/bundle/chunks/deferred-views-CI45QLPT.js'), origin)).toBe('chunk');
    expect(shellRule(request('/fonts/HackNerdFontMono-Regular.ttf'), origin)).toBe('static');
    expect(shellRule(request('/apple-touch-icon.png'), origin)).toBe('static');

    // Unversioned (logs.html, curl, the version watch): the network.
    expect(shellRule(request('/bundle/client-bundle.js'), origin)).toBeNull();
    expect(shellRule(request('/bundle/client-bundle.js?v=nothex'), origin)).toBeNull();
    expect(shellRule(request(`/bundle/client-bundle.js?v=${v}&x=1`), origin)).toBeNull();
    expect(shellRule(request('/bundle/version.json'), origin)).toBeNull();
    expect(shellRule(request('/api/sessions'), origin)).toBeNull();
    expect(shellRule(request('/', { mode: 'navigate' }), origin)).toBeNull();
    expect(shellRule(request('/sw.js'), origin)).toBeNull();
    expect(shellRule(request('/splash/750x1334-light.png'), origin)).toBeNull();
    expect(shellRule(request('/ghostty-vt.wasm'), origin)).toBeNull();
    expect(shellRule(request('/manifest.json'), origin)).toBeNull();
    expect(
      shellRule(request(`/bundle/client-bundle.js?v=${v}`, { method: 'HEAD' }), origin)
    ).toBeNull();
    expect(
      shellRule(request(`/bundle/client-bundle.js?v=${v}`, { cache: 'no-store' }), origin)
    ).toBeNull();
    expect(
      shellRule(request(`https://cdn.example/bundle/client-bundle.js?v=${v}`), origin)
    ).toBeNull();
  });

  it('installs a version whole before serving it, then serves it with no network', async () => {
    deploy('b1');
    const v1 = manifest().id;
    const page = await load(v1);
    expect(page['/bundle/client-bundle.js']).toContain('js-build:b1');
    expect(page['/bundle/styles.css']).toBe('css-build:b1');
    const cache = storage.stores.get(shellCacheName(v1));
    expect([...(cache?.entries.keys() ?? [])].sort()).toEqual(
      [...SHELL_PATHS, '/__vt-shell-complete.json'].sort()
    );
    // The chunk the bundle imports came with it.
    expect(storage.stores.get(CHUNK_CACHE)?.entries.has('/bundle/chunks/chunk-b1.js')).toBe(true);

    fetchMock.mockClear();
    fetchMock.mockRejectedValue(new TypeError('Load failed')); // Mac unreachable
    expect(await load(v1)).toEqual(page);
    expect(await get('/bundle/chunks/chunk-b1.js', 'chunk')).toBe('chunk of b1');
    expect(notified).toBe(0);
  });

  it('a deploy swaps to the new version for all files at once', async () => {
    deploy('b1');
    const v1 = manifest().id;
    await load(v1);
    deploy('b2');
    const v2 = manifest().id;
    expect(v2).not.toBe(v1);

    const page = await load(v2);
    expect(page['/bundle/client-bundle.js']).toContain('js-build:b2');
    expect(page['/bundle/styles.css']).toBe('css-build:b2');
    // The page still open on b1 keeps its version (two are kept).
    expect((await load(v1))['/bundle/styles.css']).toBe('css-build:b1');
  });

  it('never pairs a new JS with an old CSS while the stylesheet is still being written', async () => {
    deploy('b1');
    const v1 = manifest().id;
    await load(v1);

    // Dev mode: esbuild wrote b2's bundle, postcss hasn't written b2's stylesheet yet.
    writeJs('b2');
    const half = manifest();
    expect(half.consistent).toBe(false);
    const page = await load(half.id);
    // The whole previous version, not new JS with old CSS.
    expect(page['/bundle/client-bundle.js']).toContain('js-build:b1');
    expect(page['/bundle/styles.css']).toBe('css-build:b1');
    expect(storage.stores.has(shellCacheName(half.id))).toBe(false);

    // The stylesheet lands: the next load gets b2 whole, and the page above is told.
    writeCss('b2');
    const v2 = manifest().id;
    clock += 20_000;
    await load(half.id); // a later file request of that page kicks the check behind it
    expect(notified).toBeGreaterThanOrEqual(1);
    const fresh = await load(v2);
    expect(fresh['/bundle/client-bundle.js']).toContain('js-build:b2');
    expect(fresh['/bundle/styles.css']).toBe('css-build:b2');
  });

  it('keeps giving one page the same substitute even when a newer version comes in meanwhile', async () => {
    deploy('b1');
    const v1 = manifest().id;
    await load(v1);
    writeJs('b2');
    const half = manifest().id;
    expect(await get(`/bundle/client-bundle.js?v=${half}`, 'shell')).toContain('js-build:b1');
    // b2's stylesheet lands and b2 is installed before this page's next file is asked for.
    writeCss('b2');
    await load(manifest().id);
    expect(await get(`/bundle/styles.css?v=${half}`, 'shell')).toBe('css-build:b1');
  });

  it('stores nothing of a version whose files change while it is fetched', async () => {
    deploy('b1');
    const v1 = manifest().id;
    await load(v1);
    deploy('b2');
    const v2 = manifest().id;
    afterManifest = () => writeCss('b3'); // the CSS changes under the install
    const page = await load(v2);
    expect(page['/bundle/client-bundle.js']).toContain('js-build:b1');
    expect(page['/bundle/styles.css']).toBe('css-build:b1');
    expect(storage.stores.get(shellCacheName(v2))?.entries.size ?? 0).toBe(0);
  });

  it('a version whose bundle needs a chunk the server lacks is not served', async () => {
    deploy('b1');
    disk.delete('/bundle/chunks/chunk-b1.js');
    const v1 = manifest().id;
    const page = await load(v1);
    // No complete version yet: the network, as before the worker.
    expect(page['/bundle/client-bundle.js']).toContain('js-build:b1');
    expect(await shell.versions()).toEqual([]);
  });

  it('keeps two versions and deletes older ones, earlier layouts and their unused chunks', async () => {
    await storage.open('vibetunnel-shell-v1');
    const ids: string[] = [];
    for (const build of ['b1', 'b2', 'b3']) {
      deploy(build);
      ids.push(manifest().id);
      clock += 1000;
      await load(manifest().id);
    }
    expect(shellCaches()).toEqual([shellCacheName(ids[1]), shellCacheName(ids[2])].sort());
    expect([...(storage.stores.get(CHUNK_CACHE)?.entries.keys() ?? [])].sort()).toEqual([
      '/bundle/chunks/chunk-b2.js',
      '/bundle/chunks/chunk-b3.js',
    ]);
  });

  it('prune drops a half-installed version left by a worker that died', async () => {
    const orphan = await storage.open(shellCacheName('feedfacefeedface'));
    await orphan.put('/bundle/client-bundle.js', new Response('half'));
    deploy('b1');
    await load(manifest().id);
    expect(shellCaches()).toEqual([shellCacheName(manifest().id)]);
  });

  it('install event: the current version, so the next cold start is offline-proof', async () => {
    deploy('b1');
    await shell.precache();
    expect((await shell.versions()).map((v) => v.id)).toEqual([manifest().id]);
    fetchMock.mockRejectedValue(new TypeError('Load failed'));
    expect((await load(manifest().id))['/bundle/styles.css']).toBe('css-build:b1');
  });

  it('turned off: every cache it kept is deleted, other caches stay', async () => {
    deploy('b1');
    await load(manifest().id);
    disk.set('/icon-192.png', 'icon');
    await get('/icon-192.png', 'static');
    await Promise.all(pending);
    await storage.open('vibetunnel-offline-v1');
    expect(shellCaches()).toHaveLength(1);
    await shell.clear();
    expect(await storage.keys()).toEqual(['vibetunnel-offline-v1']);
    expect(storage.stores.has(ASSET_CACHE)).toBe(false);
  });

  it('a chunk is fetched once: its name is its content', async () => {
    disk.set('/bundle/chunks/deferred-views-CI45QLPT.js', 'views');
    expect(await get('/bundle/chunks/deferred-views-CI45QLPT.js', 'chunk')).toBe('views');
    expect(await get('/bundle/chunks/deferred-views-CI45QLPT.js', 'chunk')).toBe('views');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('error answers are passed through and never cached', async () => {
    const response = await shell.respond(
      new URL('/bundle/chunks/gone-0000.js', origin),
      'chunk',
      context
    );
    expect(response.status).toBe(404);
    expect(storage.stores.get(CHUNK_CACHE)?.entries.size ?? 0).toBe(0);
  });

  it('a changed font or icon is picked up without telling the page', async () => {
    disk.set('/apple-touch-icon.png', 'icon1');
    await get('/apple-touch-icon.png', 'static');
    disk.set('/apple-touch-icon.png', 'icon2');
    expect(await get('/apple-touch-icon.png', 'static')).toBe('icon1');
    expect(await get('/apple-touch-icon.png', 'static')).toBe('icon2');
    expect(notified).toBe(0);
  });
});

describe('the shell cache setting (on by default; Settings per device, config.json per server)', () => {
  const page = (value?: string) =>
    new Response('<!doctype html>', {
      headers: value ? { 'X-VibeTunnel-Shell-Cache': value } : {},
    });

  it('is on until a switch says otherwise', async () => {
    const setting = new ShellSetting(new FakeCacheStorage(), async () => {});
    expect(setting.known).toBeNull();
    expect(await setting.read()).toBe(true);
    // A response without the header (a file opened in a tab, the offline page) changes nothing.
    await setting.note(page());
    expect(await setting.read()).toBe(true);
  });

  it("the server's off (config.json pwaShellCache: false) deletes the caches, once", async () => {
    const caches = new FakeCacheStorage();
    const cleared = vi.fn(async () => {});
    const setting = new ShellSetting(caches, cleared);
    await setting.note(page('off'));
    expect(await setting.read()).toBe(false);
    expect(cleared).toHaveBeenCalledTimes(1);
    await setting.note(page('off'));
    expect(cleared).toHaveBeenCalledTimes(1);
    // Remembered by a restarted worker.
    expect(await new ShellSetting(caches, cleared).read()).toBe(false);
    await setting.note(page('on'));
    expect(await setting.read()).toBe(true);
  });

  it("the device's switch turns it off on its own, and back on", async () => {
    const caches = new FakeCacheStorage();
    const cleared = vi.fn(async () => {});
    const setting = new ShellSetting(caches, cleared);
    await setting.note(page('on'));
    await setting.setDevice(false);
    expect(await setting.read()).toBe(false);
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(await new ShellSetting(caches, cleared).read()).toBe(false);
    await setting.setDevice(true);
    expect(await setting.read()).toBe(true);
  });
});
