import { type ChildProcess, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthMiddleware } from '../middleware/auth';
import {
  cleanTranscript,
  createDictationRoutes,
  DictationBusyError,
  dictationTools,
  isAppWav,
  MAX_DICTATION_SECONDS,
  ResidentWhisper,
  transcribe,
  whisperLanguage,
} from './dictation';

const tools = { ffmpeg: '/bin/ffmpeg', whisper: '/bin/whisper-cli', model: '/m.bin' };

/** execFile double: ffmpeg succeeds; whisper answers per language. */
function fakeRun(byLanguage: Record<string, string>, delayMs = 0) {
  return vi.fn(async (file: string, args: string[]) => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (file === tools.ffmpeg) return { stdout: '', stderr: '' };
    const language = args[args.indexOf('-l') + 1];
    return { stdout: byLanguage[language] ?? '', stderr: '' };
  });
}

/** A 16 kHz mono 16-bit WAV with `samples` silent samples. */
function appWav(samples = 1600): Buffer {
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/**
 * Stand-in ffmpeg / whisper-cli scripts (the real binaries never run in tests). Each one
 * appends its name to `ran` when executed.
 */
function standInTools() {
  const dir = tempDir('vt-dictation-tools-');
  const ran = join(dir, 'ran');
  const script = (name: string, body: string) => {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\necho ${name} >> "${ran}"\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };
  const model = join(dir, 'ggml-test.bin');
  writeFileSync(model, '');
  vi.stubEnv('VIBETUNNEL_FFMPEG', script('ffmpeg', 'exit 0'));
  vi.stubEnv('VIBETUNNEL_WHISPER_CLI', script('whisper-cli', 'echo " hello world "'));
  vi.stubEnv('VIBETUNNEL_WHISPER_MODEL', model);
  vi.stubEnv('VIBETUNNEL_WHISPER_SERVER', 'off');
  return { dir, ranAnything: () => existsSync(ran), ran: () => readFileSync(ran, 'utf8') };
}

function config(voice: boolean | undefined) {
  return { getConfig: () => ({ version: 2, quickStartCommands: [], voice }) as never };
}

async function withApp<T>(
  build: (app: express.Express) => void,
  fn: (base: string) => Promise<T>
): Promise<T> {
  const app = express();
  build(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const voiceApp = (voice: boolean | undefined) => (app: express.Express) =>
  app.use('/api', createDictationRoutes({ configService: config(voice) }));

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('whisperLanguage', () => {
  it.each([
    ['es-ES', 'es'],
    ['nb-NO', 'no'],
    ['pt_BR', 'pt'],
    ['xx-YY', 'auto'],
    [undefined, 'auto'],
    ['-l', 'auto'],
    ['../../etc/passwd', 'auto'],
    ['en; rm -rf /', 'auto'],
  ])('%s -> %s', (input, expected) => {
    expect(whisperLanguage(input)).toBe(expected);
  });
});

describe('cleanTranscript', () => {
  it('drops non-speech tags in any language and keeps real text', () => {
    expect(cleanTranscript(' [BLANK_AUDIO] ')).toBe('');
    expect(cleanTranscript('[Music] hello  there')).toBe('hello there');
    expect(cleanTranscript('(silence)')).toBe('');
    expect(cleanTranscript('(Musik) (Stille)')).toBe('');
    expect(cleanTranscript('call foo (the helper) now')).toBe('call foo (the helper) now');
  });
});

describe('transcribe', () => {
  it('retries with auto-detection when the chosen language gives nothing', async () => {
    const run = fakeRun({ fr: '', auto: ' Hello there ' });
    await expect(
      transcribe(Buffer.from('x'), 'fr', tools, run as never, undefined, null)
    ).resolves.toBe('Hello there');
    const languages = run.mock.calls
      .filter(([file]) => file === tools.whisper)
      .map(([, args]) => (args as string[])[(args as string[]).indexOf('-l') + 1]);
    expect(languages).toEqual(['fr', 'auto']);
  });

  it('forces WAV from a local file for ffmpeg and caps the duration', async () => {
    const run = fakeRun({ en: 'hi' });
    await transcribe(Buffer.from('x'), 'en', tools, run as never, undefined, null);
    const ffmpegArgs = run.mock.calls.find(([file]) => file === tools.ffmpeg)?.[1] as string[];
    expect(ffmpegArgs.slice(ffmpegArgs.indexOf('-f'), ffmpegArgs.indexOf('-i'))).toEqual([
      '-f',
      'wav',
      '-protocol_whitelist',
      'file',
    ]);
    expect(ffmpegArgs[ffmpegArgs.indexOf('-t') + 1]).toBe(String(MAX_DICTATION_SECONDS));
  });

  it('writes the audio only into a private temp dir and removes it afterwards', async () => {
    let seen: { dir: string; mode: number; fileMode: number } | null = null;
    const run = vi.fn(async (file: string, args: string[]) => {
      if (file === tools.whisper) {
        const wav = args[args.indexOf('-f') + 1];
        const dir = join(wav, '..');
        seen = { dir, mode: statSync(dir).mode & 0o777, fileMode: statSync(wav).mode & 0o777 };
      }
      return { stdout: 'ok', stderr: '' };
    });
    await transcribe(appWav(), 'en', tools, run as never, undefined, null);
    expect(seen).not.toBeNull();
    const { dir, mode, fileMode } = seen as unknown as {
      dir: string;
      mode: number;
      fileMode: number;
    };
    expect(mode).toBe(0o700);
    expect(fileMode & 0o077).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  it('removes the temp dir when a tool fails too', async () => {
    let wavDir = '';
    const run = vi.fn(async (_file: string, args: string[]) => {
      wavDir = join(args[args.length - 1], '..');
      throw new Error('ffmpeg exploded');
    });
    await expect(
      transcribe(Buffer.from('x'), 'en', tools, run as never, undefined, null)
    ).rejects.toThrow('ffmpeg exploded');
    expect(wavDir).not.toBe('');
    expect(existsSync(wavDir)).toBe(false);
  });

  it('refuses more than two recordings waiting behind the current one', async () => {
    const run = fakeRun({ en: 'hi' }, 50);
    const jobs = [0, 1, 2].map(() =>
      transcribe(Buffer.from('x'), 'en', tools, run as never, undefined, null)
    );
    await expect(
      transcribe(Buffer.from('x'), 'en', tools, run as never, undefined, null)
    ).rejects.toBeInstanceOf(DictationBusyError);
    await Promise.all(jobs);
  });

  it('skips a queued recording whose request was abandoned', async () => {
    const run = fakeRun({ en: 'hi' }, 30);
    const first = transcribe(Buffer.from('x'), 'en', tools, run as never, undefined, null);
    const abort = new AbortController();
    const second = transcribe(Buffer.from('x'), 'en', tools, run as never, abort.signal, null);
    abort.abort();
    await first;
    await expect(second).rejects.toThrow('aborted');
    expect(run).toHaveBeenCalledTimes(2); // only the first job's ffmpeg + whisper
  });
});

describe('dictationTools (paths from the environment)', () => {
  it('finds the stand-ins given as absolute paths', () => {
    standInTools();
    expect(dictationTools()).not.toBeNull();
  });

  it('ignores a relative, missing or non-executable override and does not fall back to PATH', () => {
    const { dir } = standInTools();
    vi.stubEnv('VIBETUNNEL_FFMPEG', 'ffmpeg');
    expect(dictationTools()).toBeNull();
    vi.stubEnv('VIBETUNNEL_FFMPEG', join(dir, 'missing'));
    expect(dictationTools()).toBeNull();
    const plain = join(dir, 'not-executable');
    writeFileSync(plain, '#!/bin/sh\n');
    chmodSync(plain, 0o644);
    vi.stubEnv('VIBETUNNEL_FFMPEG', plain);
    expect(dictationTools()).toBeNull();
    vi.stubEnv('VIBETUNNEL_FFMPEG', dir); // a directory
    expect(dictationTools()).toBeNull();
  });

  it('accepts only an existing model file', () => {
    const { dir } = standInTools();
    vi.stubEnv('VIBETUNNEL_WHISPER_MODEL', join(dir, 'nope.bin'));
    expect(dictationTools()).toBeNull();
    vi.stubEnv('VIBETUNNEL_WHISPER_MODEL', 'relative.bin');
    expect(dictationTools()).toBeNull();
  });
});

describe('the "voice" switch', () => {
  it('voice=false: status is off and nothing is looked up', async () => {
    standInTools();
    await withApp(voiceApp(false), async (base) => {
      const response = await fetch(`${base}/api/dictation/status`);
      expect(await response.json()).toEqual({ enabled: false, available: false });
    });
  });

  it('voice=false: transcribe is refused and runs no tool', async () => {
    const stand = standInTools();
    await withApp(voiceApp(false), async (base) => {
      const response = await fetch(`${base}/api/dictation/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: new Uint8Array(appWav()),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'disabled' });
    });
    expect(stand.ranAnything()).toBe(false);
  });

  it.each([
    undefined,
    true,
  ])('voice=%s (on by default): status reports the tools', async (voice) => {
    standInTools();
    await withApp(voiceApp(voice), async (base) => {
      const response = await fetch(`${base}/api/dictation/status`);
      expect(await response.json()).toEqual({ enabled: true, available: true });
    });
  });
});

describe('POST /api/dictation/transcribe', () => {
  it('answers with the text', async () => {
    const stand = standInTools();
    await withApp(voiceApp(true), async (base) => {
      const response = await fetch(`${base}/api/dictation/transcribe?lang=en`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: Buffer.from('RIFF....WAVE'),
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ text: 'hello world' });
    });
    expect(stand.ran()).toBe('ffmpeg\nwhisper-cli\n');
  });

  it('refuses an upload over the size limit (413) without running anything', async () => {
    const stand = standInTools();
    await withApp(voiceApp(true), async (base) => {
      const response = await fetch(`${base}/api/dictation/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: Buffer.alloc(9 * 1024 * 1024),
      });
      expect(response.status).toBe(413);
    });
    expect(stand.ranAnything()).toBe(false);
  });

  it('refuses a WAV longer than the duration limit (413)', async () => {
    const stand = standInTools();
    await withApp(voiceApp(true), async (base) => {
      const response = await fetch(`${base}/api/dictation/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: new Uint8Array(appWav((MAX_DICTATION_SECONDS + 1) * 16000)),
      });
      expect(response.status).toBe(413);
    });
    expect(stand.ranAnything()).toBe(false);
  });

  it('needs a login when mounted behind the auth middleware, as server.ts does', async () => {
    const stand = standInTools();
    await withApp(
      (app) => {
        app.use(
          '/api',
          createAuthMiddleware({
            enableSSHKeys: false,
            disallowUserPassword: false,
            noAuth: false,
            isHQMode: false,
          })
        );
        voiceApp(true)(app);
      },
      async (base) => {
        const status = await fetch(`${base}/api/dictation/status`);
        expect(status.status).toBe(401);
        const upload = await fetch(`${base}/api/dictation/transcribe`, {
          method: 'POST',
          body: new Uint8Array(appWav()),
        });
        expect(upload.status).toBe(401);
      }
    );
    expect(stand.ranAnything()).toBe(false);
  });

  it('server.ts mounts the dictation routes after the /api auth middleware', () => {
    const source = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');
    const auth = source.indexOf("app.use('/api', authMiddleware)");
    const mount = source.indexOf('createDictationRoutes({');
    expect(auth).toBeGreaterThan(0);
    expect(mount).toBeGreaterThan(auth);
  });
});

describe('resident whisper-server', () => {
  /** Stand-in server: node listening on the --port it's given, counting how often it starts. */
  function standInServer() {
    const dir = tempDir('vt-whisper-server-');
    const bin = join(dir, 'whisper-server');
    const starts = join(dir, 'starts');
    const hosts = join(dir, 'hosts');
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
require('fs').appendFileSync(${JSON.stringify(starts)}, 'x');
require('fs').writeFileSync(${JSON.stringify(hosts)}, args[args.indexOf('--host') + 1]);
const port = Number(args[args.indexOf('--port') + 1]);
require('http').createServer((req, res) => {
  if (req.url === '/inference') { req.resume(); req.on('end', () => res.end(JSON.stringify({ text: ' quick one ' }))); return; }
  res.end('ok');
}).listen(port, args[args.indexOf('--host') + 1]);
`
    );
    chmodSync(bin, 0o755);
    return { dir, bin, starts, hosts };
  }

  it("recognizes the app's own WAV (no ffmpeg needed)", () => {
    expect(isAppWav(appWav())).toBe(true);
    expect(isAppWav(Buffer.from('#EXTM3U\nfile:///etc/hosts'))).toBe(false);
  });

  it('binds to loopback only', () => {
    const server = new ResidentWhisper('/bin/whisper-server', '/model.bin');
    const args = server.argsFor(12345);
    expect(args[args.indexOf('--host') + 1]).toBe('127.0.0.1');
  });

  it('starts once, keeps serving, and skips ffmpeg for the app WAV', async () => {
    const { dir, bin, starts, hosts } = standInServer();
    const server = new ResidentWhisper(bin, '/model.bin', 60_000, join(dir, 'pid'));
    const run = vi.fn(async () => ({ stdout: 'cli', stderr: '' }));
    try {
      const toolsWithServer = { ...tools, server: bin };
      for (let i = 0; i < 2; i++) {
        await expect(
          transcribe(appWav(), 'en', toolsWithServer, run as never, undefined, server)
        ).resolves.toBe('quick one');
      }
      expect(run).not.toHaveBeenCalled(); // neither ffmpeg nor whisper-cli
      expect(readFileSync(starts, 'utf8')).toBe('x');
      expect(readFileSync(hosts, 'utf8')).toBe('127.0.0.1');
      expect(statSync(join(dir, 'pid')).mode & 0o077).toBe(0);
    } finally {
      server.stop();
    }
  }, 20_000);

  it('stops itself after the idle time', async () => {
    const { dir, bin } = standInServer();
    const server = new ResidentWhisper(bin, '/model.bin', 200, join(dir, 'pid'));
    try {
      await expect(server.transcribe(appWav(), 'en')).resolves.toBe('quick one');
      expect(server.running).toBe(true);
      await vi.waitFor(() => expect(server.running).toBe(false), { timeout: 3000 });
      expect(existsSync(join(dir, 'pid'))).toBe(false);
    } finally {
      server.stop();
    }
  }, 20_000);

  describe('a pid file left behind', () => {
    const children: ChildProcess[] = [];
    afterEach(() => {
      for (const child of children.splice(0)) child.kill('SIGKILL');
    });
    const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

    it('never signals a pid that now belongs to another program', async () => {
      const { dir, bin } = standInServer();
      // A process this test started, standing in for an unrelated program that reused the pid.
      const other = spawn('sleep', ['30'], { stdio: 'ignore' });
      children.push(other);
      const pidFile = join(dir, 'pid');
      writeFileSync(pidFile, String(other.pid));
      const server = new ResidentWhisper(bin, '/model.bin', 60_000, pidFile);
      try {
        await server.transcribe(appWav(), 'en');
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(alive(other)).toBe(true);
      } finally {
        server.stop();
      }
    }, 20_000);

    it('stops an orphaned whisper-server it recognizes (same binary, model, loopback)', async () => {
      const { dir, bin } = standInServer();
      // An "orphan" started by this test with the exact arguments a previous run would use.
      const previous = new ResidentWhisper(bin, '/model.bin');
      const orphan = spawn(bin, previous.argsFor(20000 + Math.floor(Math.random() * 40000)), {
        stdio: 'ignore',
      });
      children.push(orphan);
      const pidFile = join(dir, 'pid');
      writeFileSync(pidFile, String(orphan.pid));
      await new Promise((resolve) => setTimeout(resolve, 300)); // let node exec the script
      const server = new ResidentWhisper(bin, '/model.bin', 60_000, pidFile);
      try {
        await server.transcribe(appWav(), 'en');
        await vi.waitFor(() => expect(alive(orphan)).toBe(false), { timeout: 3000 });
      } finally {
        server.stop();
      }
    }, 20_000);
  });
});
