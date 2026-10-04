import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as net from 'node:net';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  CANDIDATES_CACHE_MS,
  createPreviewCandidateFinder,
  listListeners,
  MAX_CANDIDATES,
  normalizeIgnoredProcesses,
  type PortListener,
  type ProbeAnswer,
  parseLsofListeners,
  probeHttp,
} from './preview-candidates.js';
import { extractTitle } from './preview-health.js';
import { parseDeniedPorts, previewPortError } from './preview-proxy.js';

// Synthetic `lsof -nP -iTCP -sTCP:LISTEN -a -u 501 -Fpcn` output: a system helper on an
// ephemeral port, dev servers, a second VibeTunnel, a LAN-only listener, a port below 1024 and
// a worker sharing its parent's socket.
const LSOF_LISTEN = `p952
csyshelper
f11
n*:49152
f12
n*:49152
p20336
cPython
f3
n127.0.0.1:5175
p30919
cnode
f78
n127.0.0.1:6006
f79
n[::1]:6006
p50214
cnode
f37
n127.0.0.1:7030
f38
n127.0.0.1:7031
p57475
cagent-cli
f9
n127.0.0.1:59535
p85871
cnode
f31
n127.0.0.1:7020
f32
n127.0.0.1:7021
p91854
cnode
f23
n127.0.0.1:5173
p91860
cnode
f23
n127.0.0.1:5173
p93001
cnode
f20
n[::1]:3000
p93100
cruby
f12
n192.168.1.20:7000
p93200
cnginx
f6
n*:80
`;

// `lsof -a -p <those pids> -d cwd -Fn`: 93200 is missing, it exited between the two calls
// (lsof then exits with status 1 but still prints the others).
const LSOF_CWD = `p952
fcwd
n/
p20336
fcwd
n/
p30919
fcwd
n/Users/me/tools/storybook
p50214
fcwd
n/Users/me/Projects/second-vt/web
p57475
fcwd
n/Users/me
p85871
fcwd
n/Users/me/Projects/vt/web
p91854
fcwd
n/Users/me/Projects/vite-app
p91860
fcwd
n/Users/me/Projects/vite-app
p93001
fcwd
n/Users/me/Projects/api
`;

const fakeLsof = () =>
  vi.fn(async (args: string[]) => (args.includes('-sTCP:LISTEN') ? LSOF_LISTEN : LSOF_CWD));

describe('servers listening on this computer (lsof)', () => {
  it('reads every loopback or wildcard listener with its process, never a LAN-only one', () => {
    const listeners = parseLsofListeners(LSOF_LISTEN);
    expect(listeners).toContainEqual({
      port: 5175,
      pid: 20336,
      command: 'Python',
      host: '127.0.0.1',
    });
    expect(listeners).toContainEqual({
      port: 59535,
      pid: 57475,
      command: 'agent-cli',
      host: '127.0.0.1',
    });
    // Vite on "localhost" can listen on ::1 only: the probe has to go there.
    expect(listeners).toContainEqual({ port: 3000, pid: 93001, command: 'node', host: '::1' });
    expect(listeners.filter((listener) => listener.port === 49152)).toHaveLength(2);
    expect(listeners.map((listener) => listener.port)).not.toContain(7000);
  });

  it('adds each process folder from one more lsof call, except "/" and the home folder', async () => {
    const run = fakeLsof();
    const listeners = await listListeners({ run, platform: 'darwin', uid: 501, home: '/Users/me' });
    expect(run.mock.calls[0][0]).toEqual([
      '-nP',
      '-iTCP',
      '-sTCP:LISTEN',
      '-a',
      '-u',
      '501',
      '-Fpcn',
    ]);
    // Only the pids with a listener that could be previewed (not ruby's LAN-only one).
    expect(run.mock.calls[1][0]).toEqual([
      '-a',
      '-p',
      '952,20336,30919,50214,57475,85871,91854,91860,93001,93200',
      '-d',
      'cwd',
      '-Fn',
    ]);
    const folderOf = (port: number) => listeners.find((listener) => listener.port === port)?.folder;
    expect(folderOf(5173)).toBe('vite-app');
    expect(folderOf(3000)).toBe('api');
    expect(folderOf(5175)).toBeUndefined(); // cwd "/"
    expect(folderOf(59535)).toBeUndefined(); // the home folder
    expect(folderOf(80)).toBeUndefined(); // gone before its folder was read
  });

  it('is empty when lsof fails, and anywhere but macOS', async () => {
    expect(await listListeners({ run: async () => '', platform: 'darwin', uid: 501 })).toEqual([]);
    const broken = vi.fn(async () => {
      throw new Error('spawn /usr/sbin/lsof ENOENT');
    });
    expect(await listListeners({ run: broken, platform: 'darwin', uid: 501 })).toEqual([]);
    const linux = fakeLsof();
    expect(await listListeners({ run: linux, platform: 'linux', uid: 1000 })).toEqual([]);
    expect(linux).not.toHaveBeenCalled();
  });
});

describe('preview candidates', () => {
  /** What GET / on each port answers; null: not HTTP (or not in time). */
  const ANSWERS = new Map<number, ProbeAnswer | null>([
    [3000, {}],
    [7030, { vibeTunnel: true }],
    [5173, { title: 'Vite App' }],
    [49152, null],
    [59535, {}],
  ]);
  const setup = (
    over: {
      saved?: number[];
      listeners?: () => Promise<PortListener[]>;
      answers?: Map<number, ProbeAnswer | null>;
    } = {}
  ) => {
    const answers = over.answers ?? ANSWERS;
    const probe = vi.fn(async (port: number, _host: string) => answers.get(port) ?? null);
    const run = fakeLsof();
    const list = vi.fn(
      over.listeners ??
        (() => listListeners({ run, platform: 'darwin', uid: 501, home: '/Users/me' }))
    );
    const vibeTunnel = vi.fn();
    let clock = 1_000_000;
    const saved = over.saved ?? [5175];
    const find = createPreviewCandidateFinder({
      // As the routes build it: VibeTunnel's main and preview ports, the denied ones.
      portError: (port) => previewPortError(port, [7020, 7021], parseDeniedPorts('6006')),
      savedPorts: () => saved,
      onVibeTunnelPort: vibeTunnel,
      listListeners: list,
      probe,
      now: () => clock,
    });
    return { find, probe, list, vibeTunnel, saved, tick: (ms: number) => (clock += ms) };
  };

  it('leaves out ephemeral ports and the processes listed in previewIgnoreProcesses', async () => {
    // A tunnel's metrics endpoint and a tool's internal helper port, both answering HTTP.
    const listeners = async (): Promise<PortListener[]> => [
      { port: 3000, pid: 1, command: 'node', host: '127.0.0.1' },
      { port: 20241, pid: 2, command: 'tunneld', host: '127.0.0.1' },
      { port: 50002, pid: 3, command: 'node', host: '127.0.0.1' },
    ];
    const answers = new Map([
      [3000, { title: 'App' }],
      [20241, { title: 'metrics' }],
      [50002, { title: 'internal' }],
    ]);
    // Without the setting, only the ephemeral port is left out.
    const plain = setup({ listeners, answers });
    expect((await plain.find()).map((candidate) => candidate.port)).toEqual([3000, 20241]);
    const ignored = new Set(['tunneld']);
    const find = createPreviewCandidateFinder({
      portError: () => null,
      savedPorts: () => [],
      ignoredProcesses: () => ignored,
      listListeners: listeners,
      probe: async (port) => answers.get(port) ?? null,
    });
    expect((await find()).map((candidate) => candidate.port)).toEqual([3000]);
  });

  it('normalizes previewIgnoreProcesses like lsof cuts command names', () => {
    expect(normalizeIgnoredProcesses(undefined)).toEqual(new Set());
    expect(normalizeIgnoredProcesses('tunneld')).toEqual(new Set());
    const long = 'a-very-long-helper-process-name-that-lsof-cuts';
    expect(normalizeIgnoredProcesses([' tunneld ', 42, '', long])).toEqual(
      new Set(['tunneld', long.slice(0, 31)])
    );
  });

  it("offers the HTTP servers, never VibeTunnel's, denied, saved or system ports", async () => {
    const { find, probe, vibeTunnel } = setup();
    expect(await find()).toEqual([
      { port: 3000, process: 'node', folder: 'api' },
      { port: 5173, title: 'Vite App', process: 'node', folder: 'vite-app' },
    ]);
    // Each allowed port once (5173 has two processes); ::1 for the one listening only there.
    expect(probe.mock.calls.sort((a, b) => a[0] - b[0])).toEqual([
      [3000, '::1'],
      [5173, '127.0.0.1'],
      [7030, '127.0.0.1'],
      [7031, '127.0.0.1'],
    ]);
    // Another VibeTunnel server (on 7030) answered: reported, so it is refused from now on.
    expect(vibeTunnel).toHaveBeenCalledWith(7030);
  });

  it('offers at most 20, the lowest ports', async () => {
    const many: PortListener[] = Array.from({ length: 30 }, (_, i) => ({
      port: 4129 - i,
      pid: 100 + i,
      command: 'node',
      host: '127.0.0.1',
    }));
    const { find } = setup({
      listeners: async () => many,
      answers: new Map(many.map((listener) => [listener.port, {}])),
    });
    const found = await find();
    expect(found).toHaveLength(MAX_CANDIDATES);
    expect(found.map((candidate) => candidate.port)).toEqual(
      Array.from({ length: 20 }, (_, i) => 4100 + i)
    );
  });

  it('reuses a scan for a few seconds, but never offers a port saved meanwhile', async () => {
    const { find, list, probe, saved, tick } = setup({
      answers: new Map([
        [3000, {}],
        [5173, { title: 'Vite App' }],
      ]),
    });
    expect((await find()).map((candidate) => candidate.port)).toEqual([3000, 5173]);
    tick(1000);
    saved.push(5173); // tapped in the sheet
    expect((await find()).map((candidate) => candidate.port)).toEqual([3000]);
    expect(list).toHaveBeenCalledTimes(1);
    const probes = probe.mock.calls.length;
    tick(CANDIDATES_CACHE_MS);
    await find();
    expect(list).toHaveBeenCalledTimes(2);
    expect(probe.mock.calls.length).toBeGreaterThan(probes);
  });

  it('is empty when the listeners cannot be listed', async () => {
    const { find, probe } = setup({
      listeners: async () => {
        throw new Error('lsof timed out');
      },
    });
    expect(await find()).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
  });
});

// Only servers these tests start themselves, on ports the OS picks: never a real one.
describe('probing a port', () => {
  const servers: Array<http.Server | net.Server> = [];
  const sockets: net.Socket[] = [];
  const listen = async (server: http.Server | net.Server) => {
    servers.push(server);
    server.on('connection', (socket: net.Socket) => sockets.push(socket));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  };
  const page = (headers: Record<string, string>, body: string) =>
    listen(
      http.createServer((_req, res) => {
        res.writeHead(200, headers);
        res.end(body);
      })
    );

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
  });

  it('reads the page title, tidied and at most 60 characters', async () => {
    const html = { 'content-type': 'text/html; charset=utf-8' };
    const app = await page(html, '<title>\n  Home &middot; Hello&#160;World &amp;lt;3 </title>');
    expect(await probeHttp(app)).toEqual({ title: 'Home · Hello World &lt;3' });
    const long = await page(html, `<title>${'Panel '.repeat(20)}</title>`);
    const title = (await probeHttp(long))?.title ?? '';
    expect(title).toHaveLength(59); // 60, then the trailing space trimmed
    expect(extractTitle('<title>&#x1F680; Launch</title>')).toBe('🚀 Launch');
  });

  it('an API without a page is offered without a title; a VibeTunnel server is told apart', async () => {
    expect(await probeHttp(await page({ 'content-type': 'application/json' }, '{}'))).toEqual({});
    // Not a page and not OK at `/` (a JSON API's 404, a metrics helper's 403): not offered.
    const notFound = await listen(
      http.createServer((_req, res) => {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not found"}');
      })
    );
    expect(await probeHttp(notFound)).toBeNull();
    expect(
      await probeHttp(await page({ 'content-type': 'text/html', 'x-vibetunnel-server': '1' }, ''))
    ).toEqual({ vibeTunnel: true });
  });

  it('a server that answered but is still sending its page counts, without a title', async () => {
    const slow = await listen(
      http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write('<html><head>');
      })
    );
    expect(await probeHttp(slow, '127.0.0.1', 150)).toEqual({});
  });

  it('something that is not HTTP, or says nothing in time, is not offered', async () => {
    const ssh = await listen(net.createServer((socket) => socket.end('SSH-2.0-OpenSSH_9.6\r\n')));
    expect(await probeHttp(ssh)).toBeNull();
    const silent = await listen(net.createServer(() => {}));
    const started = Date.now();
    expect(await probeHttp(silent, '127.0.0.1', 150)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
