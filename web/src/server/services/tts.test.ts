import { type ChildProcess, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chunkForSpeech,
  detectSpeechLanguage,
  MAX_TTS_CHARS,
  splitSentences,
} from '../../shared/tts-text';
import { createAuthMiddleware } from '../middleware/auth';
import { createTtsRoutes } from '../routes/tts';
import {
  availableEngines,
  cleanForSpeech,
  KOKORO_SIDECAR,
  kokoroSetup,
  parseSayVoices,
  pickSayVoice,
  ResidentKokoro,
  resetSayVoicesForTests,
  sayBinary,
  stopResidentKokoro,
  synthesize,
} from './tts';

describe('chunkForSpeech', () => {
  it('starts with a short chunk and groups the rest by sentence', () => {
    const reply =
      'I reviewed the code. Everything compiles and the tests pass. ' +
      'I also removed two functions nobody used, and updated the documentation of the ' +
      'dictation module so it explains the new flow. Do you want me to push it?';
    const chunks = chunkForSpeech(reply);
    expect(chunks[0]).toBe('I reviewed the code. Everything compiles and the tests pass.');
    expect(chunks.join(' ')).toBe(reply);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(320);
  });

  it('cuts a sentence that has no punctuation for a long time', () => {
    const long = `${'word '.repeat(200)}end.`;
    const parts = splitSentences(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(320);
    expect(parts.join(' ')).toBe(long.trim());
    for (const chunk of chunkForSpeech(long))
      expect(chunk.length).toBeLessThanOrEqual(MAX_TTS_CHARS);
  });

  it('gives nothing for blank text', () => {
    expect(chunkForSpeech('  \n ')).toEqual([]);
  });
});

describe('detectSpeechLanguage', () => {
  it.each([
    ['I finished reviewing the code and everything is fine.', 'en'],
    ['He terminado de revisar el código y todo funciona para la entrega.', 'es'],
    ["J'ai fini de relire le code et tout est bon pour vous.", 'fr'],
    ['Eu terminei de revisar o código e não encontrei nada para corrigir.', 'pt'],
    ['我已经检查了代码，一切正常。', 'zh'],
  ])('%s -> %s', (text, lang) => {
    expect(detectSpeechLanguage(text)).toBe(lang);
  });

  it('uses the hint (the UI language) when the text is too short to tell', () => {
    expect(detectSpeechLanguage('OK.', 'fr')).toBe('fr');
    expect(detectSpeechLanguage('Done.', 'pt')).toBe('pt');
  });
});

it('drops code blocks, links and markdown before reading', () => {
  expect(cleanForSpeech('**Done**: see `app.ts` ```\nrm -rf\n``` at https://x.y/z 🎉')).toBe(
    'Done : see app.ts at'
  );
});

const SAY_LIST = [
  'Albert              en_US    # Hello! My name is Albert.',
  'Bad News            en_US    # Hello! My name is Bad News.',
  'Samantha            en_US    # Hello! My name is Samantha.',
  'Amélie              fr_CA    # Bonjour, je m’appelle Amélie.',
  'Paulina             es_MX    # Hello.',
  'Jorge (Enhanced)    es_ES    # Hello.',
  'Eddy (English (UK)) en_GB    # Hello! My name is Eddy.',
  'Tingting            zh_CN    # 你好',
].join('\n');

describe('say voices', () => {
  it('parses the list, including names with spaces and parentheses', () => {
    const voices = parseSayVoices(SAY_LIST);
    expect(voices).toContainEqual({ name: 'Bad News', locale: 'en_US' });
    expect(voices).toContainEqual({ name: 'Eddy (English (UK))', locale: 'en_GB' });
    expect(voices).toHaveLength(8);
  });

  it('picks an enhanced voice first, skips novelty voices, and gives null when none fits', () => {
    const voices = parseSayVoices(SAY_LIST);
    expect(pickSayVoice(voices, 'es')).toBe('Jorge (Enhanced)');
    expect(pickSayVoice(voices, 'en')).toBe('Samantha');
    expect(pickSayVoice(voices, 'fr')).toBe('Amélie');
    expect(pickSayVoice(voices, 'zh')).toBe('Tingting');
    expect(pickSayVoice(voices, 'hi')).toBeNull();
  });
});

describe('engines', () => {
  let dir: string;

  /**
   * A stand-in `say` (the real one never runs in tests): answers `-v ?` with SAY_LIST, writes
   * a tiny WAV to the -o path and logs its arguments.
   */
  function fakeSay(failVoice = false) {
    const bin = join(dir, 'say');
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '-v' && args[1] === '?') { process.stdout.write(${JSON.stringify(SAY_LIST)}); process.exit(0); }
require('fs').appendFileSync(${JSON.stringify(join(dir, 'say.log'))}, JSON.stringify(args) + '\\n');
if (${failVoice} && args[0] === '-v') process.exit(1);
const out = args[args.indexOf('-o') + 1];
require('fs').writeFileSync(out, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(96)]));
`
    );
    chmodSync(bin, 0o755);
    vi.stubEnv('VIBETUNNEL_SAY', bin);
    return bin;
  }

  const sayCalls = () =>
    existsSync(join(dir, 'say.log'))
      ? readFileSync(join(dir, 'say.log'), 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as string[])
      : [];

  /** A stand-in Kokoro "python": speaks the sidecar protocol and writes a WAV per request. */
  function fakeKokoro(failText?: string) {
    const python = join(dir, 'python3');
    writeFileSync(
      python,
      `#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(join(dir, 'kokoro.starts'))}, 'x');
const fs = require('fs');
console.log(JSON.stringify({ ready: true }));
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(join(dir, 'kokoro.log'))}, line + '\\n');
  if (req.text === ${JSON.stringify(failText ?? null)}) return console.log(JSON.stringify({ id: req.id, ok: false, error: 'boom' }));
  fs.writeFileSync(req.out, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(200)]));
  console.log(JSON.stringify({ id: req.id, ok: true }));
});
`
    );
    chmodSync(python, 0o755);
    const models = join(dir, 'tts', 'models');
    mkdirSync(models, { recursive: true });
    writeFileSync(join(models, 'kokoro-v1.0.fp16.onnx'), '');
    writeFileSync(join(models, 'voices-v1.0.bin'), '');
    vi.stubEnv('VIBETUNNEL_TTS_DIR', join(dir, 'tts'));
    vi.stubEnv('VIBETUNNEL_TTS_PYTHON', python);
    return python;
  }

  const kokoroRequests = () =>
    readFileSync(join(dir, 'kokoro.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { voice: string; lang: string; text: string; out: string });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vt-tts-test-'));
    mkdirSync(join(dir, 'control'), { recursive: true });
    // Nothing real is ever found: every engine path points into this empty folder.
    vi.stubEnv('VIBETUNNEL_TTS_DIR', join(dir, 'none'));
    vi.stubEnv('VIBETUNNEL_PIPER', join(dir, 'no-piper'));
    vi.stubEnv('VIBETUNNEL_SAY', join(dir, 'no-say'));
    vi.stubEnv('VIBETUNNEL_TTS_PYTHON', '');
    vi.stubEnv('VIBETUNNEL_KOKORO_MODEL', '');
    vi.stubEnv('VIBETUNNEL_KOKORO_VOICES', '');
    vi.stubEnv('VIBETUNNEL_TTS_ENGINE', '');
    vi.stubEnv('VIBETUNNEL_CONTROL_DIR', join(dir, 'control', 'x'));
    resetSayVoicesForTests();
  });

  afterEach(() => {
    stopResidentKokoro();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds no engine when every path points nowhere (the real say is never used)', () => {
    expect(availableEngines()).toEqual([]);
  });

  it('reads with `say`, the voice picked for the language, as an argument array', async () => {
    fakeSay();
    const speech = await synthesize(
      'He terminado de revisar el código y todo funciona para la entrega.',
      undefined,
      undefined,
      undefined,
      null
    );
    expect(speech.engine).toBe('say');
    expect(speech.lang).toBe('es');
    const [args] = sayCalls();
    expect(args.slice(0, 2)).toEqual(['-v', 'Jorge (Enhanced)']);
    expect(args.slice(-2)).toEqual([
      '--',
      'He terminado de revisar el código y todo funciona para la entrega.',
    ]);
  });

  it('falls back to the system voice when the picked voice fails, text still after "--"', async () => {
    fakeSay(true);
    const speech = await synthesize(
      '-v Hello there, this is the end of it.',
      'en',
      undefined,
      undefined,
      null
    );
    expect(speech.engine).toBe('say');
    const calls = sayCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toBe('-o');
    expect(calls[1].slice(-2)).toEqual(['--', '-v Hello there, this is the end of it.']);
  });

  it('runs say without -v for a language the Mac has no voice for', async () => {
    fakeSay();
    await synthesize('OK.', 'hi', undefined, undefined, null);
    expect(sayCalls()[0][0]).toBe('-o');
  });

  it('uses resident Kokoro first (started once) and falls back to say when it fails', async () => {
    fakeKokoro('This fails and say reads it instead.');
    fakeSay();
    const first = await synthesize("J'ai fini de relire le code et tout est bon pour vous.", 'en');
    const second = await synthesize('I finished the task, and it is fine.', 'fr');
    expect([first.engine, second.engine]).toEqual(['kokoro', 'kokoro']);
    expect(second.lang).toBe('en');
    expect(kokoroRequests().map((r) => [r.voice, r.lang])).toEqual([
      ['ff_siwis', 'fr-fr'],
      ['af_heart', 'en-us'],
    ]);
    expect(readFileSync(join(dir, 'kokoro.starts'), 'utf8')).toBe('x');
    const fallback = await synthesize('This fails and say reads it instead.', 'en');
    expect(fallback.engine).toBe('say');
  });

  it('warms Kokoro only for the language asked for (the UI language)', async () => {
    const python = fakeKokoro();
    const setup = kokoroSetup();
    expect(setup?.python).toBe(python);
    const kokoro = new ResidentKokoro(setup as never, 60_000, join(dir, 'kokoro.pid'));
    try {
      await kokoro.warm('pt');
      expect(kokoro.readyFor('pt')).toBe(true);
      expect(kokoro.readyFor('en')).toBe(false);
      const requests = kokoroRequests();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ voice: 'pf_dora', lang: 'pt-br', text: '1.' });
      // The warm-up wrote into a private temp dir that is gone again.
      expect(existsSync(join(requests[0].out, '..'))).toBe(false);
    } finally {
      kokoro.stop();
    }
  });

  it('removes its temporary files', async () => {
    fakeSay();
    const work = join(dir, 'tmp');
    mkdirSync(work);
    vi.stubEnv('TMPDIR', work);
    await synthesize('Hello there, all is good.', 'en', undefined, undefined, null);
    expect(readdirSync(work)).toEqual([]);
  });

  describe('paths from the environment', () => {
    it('ignores a relative or non-executable say and does not fall back to PATH', () => {
      vi.stubEnv('VIBETUNNEL_SAY', 'say');
      expect(sayBinary()).toBeNull();
      const plain = join(dir, 'plain-say');
      writeFileSync(plain, '#!/bin/sh\n');
      chmodSync(plain, 0o644);
      vi.stubEnv('VIBETUNNEL_SAY', plain);
      expect(sayBinary()).toBeNull();
    });

    it('needs an absolute executable python and existing model files for Kokoro', () => {
      fakeKokoro();
      expect(kokoroSetup()).not.toBeNull();
      vi.stubEnv('VIBETUNNEL_TTS_PYTHON', 'python3');
      expect(kokoroSetup()).toBeNull();
      fakeKokoro();
      vi.stubEnv('VIBETUNNEL_KOKORO_MODEL', join(dir, 'missing.onnx'));
      expect(kokoroSetup()).toBeNull();
    });

    it('ignores an unknown VIBETUNNEL_TTS_ENGINE instead of disabling every engine', () => {
      fakeSay();
      vi.stubEnv('VIBETUNNEL_TTS_ENGINE', 'espeak; rm -rf /');
      expect(availableEngines()).toEqual(['say']);
      vi.stubEnv('VIBETUNNEL_TTS_ENGINE', 'kokoro');
      expect(availableEngines()).toEqual([]);
    });
  });

  describe('resident Kokoro process', () => {
    const children: ChildProcess[] = [];
    afterEach(() => {
      for (const child of children.splice(0)) child.kill('SIGKILL');
    });

    it('talks over a stdin/stdout pipe only: no host, port or socket', () => {
      fakeKokoro();
      const kokoro = new ResidentKokoro(kokoroSetup() as never);
      const args = kokoro.argsFor();
      expect(args).not.toContain('--host');
      expect(args).not.toContain('--port');
      expect(KOKORO_SIDECAR).not.toMatch(/socket|listen|bind|http/i);
    });

    it('never signals a recorded pid that now belongs to another program', async () => {
      fakeKokoro();
      const other = spawn('sleep', ['30'], { stdio: 'ignore' });
      children.push(other);
      const pidFile = join(dir, 'kokoro.pid');
      writeFileSync(pidFile, String(other.pid));
      const kokoro = new ResidentKokoro(kokoroSetup() as never, 60_000, pidFile);
      try {
        expect(await kokoro.start()).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(other.exitCode === null && other.signalCode === null).toBe(true);
        expect(readFileSync(pidFile, 'utf8')).not.toBe(String(other.pid));
      } finally {
        kokoro.stop();
      }
    }, 20_000);
  });

  describe('routes', () => {
    function config(voice: boolean | undefined) {
      return { getConfig: () => ({ version: 2, quickStartCommands: [], voice }) as never };
    }

    async function withServer(
      voice: boolean | undefined,
      fn: (base: string) => Promise<void>,
      auth = false
    ) {
      const app = express();
      if (auth) {
        app.use(
          '/api',
          createAuthMiddleware({
            enableSSHKeys: false,
            disallowUserPassword: false,
            noAuth: false,
            isHQMode: false,
          })
        );
      }
      app.use('/api', createTtsRoutes({ configService: config(voice) }));
      const server = app.listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      try {
        const { port } = server.address() as AddressInfo;
        await fn(`http://127.0.0.1:${port}/api`);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }

    const post = (base: string, body: unknown) =>
      fetch(`${base}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });

    it.each([
      undefined,
      false,
    ])('voice=%s: status is off, nothing probed, POST refused', async (voice) => {
      fakeSay();
      fakeKokoro();
      await withServer(voice, async (base) => {
        const status = await (await fetch(`${base}/tts/status?warm=1`)).json();
        expect(status).toMatchObject({
          enabled: false,
          available: false,
          engine: null,
          engines: [],
        });
        const response = await post(base, { text: 'Hello there.' });
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'disabled' });
      });
      expect(sayCalls()).toEqual([]);
      expect(existsSync(join(dir, 'kokoro.starts'))).toBe(false);
    });

    it('POST /api/tts answers WAV audio and names the engine', async () => {
      fakeSay();
      await withServer(true, async (base) => {
        const response = await post(base, { text: 'All done, it works.', lang: 'en-GB' });
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('audio/wav');
        expect(response.headers.get('x-tts-engine')).toBe('say');
        expect(Buffer.from(await response.arrayBuffer()).toString('ascii', 0, 4)).toBe('RIFF');
      });
    });

    it('refuses empty and overlong text, an oversized body, and reports no engine', async () => {
      await withServer(true, async (base) => {
        expect((await post(base, { text: ' ' })).status).toBe(400);
        expect((await post(base, { text: 'x'.repeat(MAX_TTS_CHARS + 1) })).status).toBe(413);
        expect((await post(base, { text: 'y', pad: 'z'.repeat(20 * 1024) })).status).toBe(413);
        expect((await post(base, { text: 'hello' })).status).toBe(503);
        const status = await (await fetch(`${base}/tts/status`)).json();
        expect(status).toMatchObject({ enabled: true, available: false, engine: null });
      });
    });

    it('needs a login behind the auth middleware', async () => {
      fakeSay();
      await withServer(
        true,
        async (base) => {
          expect((await fetch(`${base}/tts/status`)).status).toBe(401);
          expect((await post(base, { text: 'Hello.' })).status).toBe(401);
        },
        true
      );
      expect(sayCalls()).toEqual([]);
    });

    it('GET /api/tts/status names Kokoro when it is set up and warms the asked language', async () => {
      fakeKokoro();
      fakeSay();
      await withServer(true, async (base) => {
        const status = await (await fetch(`${base}/tts/status?warm=1&lang=fr-FR`)).json();
        expect(status).toMatchObject({
          enabled: true,
          available: true,
          engine: 'kokoro',
          engines: ['kokoro', 'say'],
        });
        await vi.waitFor(() =>
          expect(kokoroRequests()[0]).toMatchObject({ voice: 'ff_siwis', text: '1.' })
        );
      });
    });

    it('server.ts mounts the read-aloud routes after the /api auth middleware', () => {
      const source = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');
      const auth = source.indexOf("app.use('/api', authMiddleware)");
      const mount = source.indexOf('createTtsRoutes({');
      expect(auth).toBeGreaterThan(0);
      expect(mount).toBeGreaterThan(auth);
    });
  });
});
