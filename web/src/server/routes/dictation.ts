/**
 * Voice dictation that works in every phone browser: the browser records audio (Web Audio,
 * encoded to a 16 kHz WAV on the client) and the server transcribes it locally with
 * whisper.cpp. Nothing leaves the machine.
 *
 * On unless `~/.vibetunnel/config.json` has `"voice": false` (docs/features/voice-dictation.md);
 * the client offers it only when whisper.cpp and ffmpeg are installed here. Off, the status says
 * so, the transcribe endpoint answers 403 before reading the body, and no ffmpeg or whisper
 * process is ever started.
 *
 * Mounted behind the /api auth middleware like every other route. ffmpeg, whisper-cli and
 * whisper-server run with argument arrays, never through a shell; one transcription at a time.
 */
import { type ChildProcess, execFile, spawn } from 'child_process';
import express, { type NextFunction, type Request, type Response, Router } from 'express';
import { readdirSync, rmSync, writeFileSync } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import type { ConfigService } from '../services/config-service.js';
import {
  findBinary,
  helperPidFile,
  processArgs,
  stopRecordedHelper,
  usableFile,
} from '../utils/local-tools.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('dictation');
const execFileAsync = promisify(execFile);

// Two minutes of the 16 kHz mono WAV the client sends is about 3.8 MB.
export const MAX_DICTATION_BYTES = 8 * 1024 * 1024;
/** The longest recording transcribed; longer audio is refused (WAV) or cut (other formats). */
export const MAX_DICTATION_SECONDS = 130;
/** Recordings allowed to wait behind the one being transcribed. */
export const MAX_DICTATION_WAITING = 2;

// whisper's languages; anything else (e.g. "nb" from nb-NO) made whisper-cli print an error,
// exit 0 with no text, and the phone showed "nothing heard" every time. Only these values
// ever reach whisper's `-l`, so the query parameter can't inject an argument.
const WHISPER_LANGUAGES = new Set(
  (
    'en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no ' +
    'th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw ' +
    'gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl ' +
    'mg as tt haw ln ha ba jw su yue'
  ).split(' ')
);
const LANGUAGE_ALIASES: Record<string, string> = { nb: 'no', iw: 'he', in: 'id', fil: 'tl' };

/** The default folder searched for `ggml-*.bin` models. */
export function defaultModelDir(): string {
  return path.join(os.homedir(), '.local', 'share', 'whisper-cpp');
}

function findModel(): string | null {
  const fromEnv = process.env.VIBETUNNEL_WHISPER_MODEL;
  if (fromEnv) return usableFile(fromEnv, false);
  const dir = defaultModelDir();
  try {
    const models = readdirSync(dir).filter((name) => /^ggml-.*\.bin$/.test(name));
    // Prefer the multilingual turbo/large models; English-only ".en" ones can't transcribe
    // other languages.
    const ranked = models
      .filter((name) => !name.includes('.en.'))
      .sort((a, b) => score(b) - score(a));
    return ranked[0] ? usableFile(path.join(dir, ranked[0]), false) : null;
  } catch {
    return null;
  }
}

function score(model: string): number {
  if (model.includes('large-v3-turbo')) return 5;
  if (model.includes('large')) return 4;
  if (model.includes('medium')) return 3;
  if (model.includes('small')) return 2;
  return 1;
}

export interface DictationTools {
  ffmpeg: string;
  whisper: string;
  model: string;
  /** whisper-server, when installed: keeps the model loaded between dictations. */
  server?: string;
}

export function dictationTools(): DictationTools | null {
  const ffmpeg = findBinary('ffmpeg', 'VIBETUNNEL_FFMPEG');
  const whisper = findBinary('whisper-cli', 'VIBETUNNEL_WHISPER_CLI');
  const model = findModel();
  const server =
    process.env.VIBETUNNEL_WHISPER_SERVER === 'off'
      ? undefined
      : (findBinary('whisper-server', 'VIBETUNNEL_WHISPER_SERVER') ?? undefined);
  return ffmpeg && whisper && model ? { ffmpeg, whisper, model, server } : null;
}

/** "es", "pt", "zh"… from a browser language ("es-ES"); "auto" when it doesn't look like one. */
export function whisperLanguage(lang: unknown): string {
  if (typeof lang !== 'string') return 'auto';
  const raw = lang.toLowerCase().split(/[-_]/)[0];
  const base = LANGUAGE_ALIASES[raw] ?? raw;
  return WHISPER_LANGUAGES.has(base) ? base : 'auto';
}

/**
 * whisper marks non-speech in brackets ("[BLANK_AUDIO]", "[Music]") and, in some languages,
 * in parentheses ("(silence)" in the spoken language). Bracketed tags are always dropped; a
 * transcript made only of parenthesized tags counts as nothing heard. Language-neutral.
 */
export function cleanTranscript(text: string): string {
  const cleaned = text
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return /^(\([^)]*\)\s*)+$/.test(cleaned) ? '' : cleaned;
}

/** The 16 kHz mono 16-bit PCM WAV the client sends: whisper reads it as is, no ffmpeg. */
export function isAppWav(audio: Buffer): boolean {
  return (
    audio.length > 44 &&
    audio.toString('ascii', 0, 4) === 'RIFF' &&
    audio.toString('ascii', 8, 12) === 'WAVE' &&
    audio.readUInt16LE(20) === 1 && // PCM
    audio.readUInt16LE(22) === 1 && // mono
    audio.readUInt32LE(24) === 16000 &&
    audio.readUInt16LE(34) === 16
  );
}

/** Seconds of audio in the client's WAV (16 kHz, 16-bit mono = 32000 bytes per second). */
export function appWavSeconds(audio: Buffer): number {
  return (audio.length - 44) / 32000;
}

/**
 * whisper-server kept running with the model loaded, started on first use and stopped after
 * 15 idle minutes. whisper-cli loads the model on every call (1-2 s for a short phrase);
 * resident it takes well under a second. Bound to 127.0.0.1 on a random port.
 */
export class ResidentWhisper {
  private child: ChildProcess | null = null;
  private port = 0;
  private starting: Promise<boolean> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly bin: string,
    private readonly model: string,
    private readonly idleMs = 15 * 60_000,
    // Next to this server's control dir, so two VibeTunnel servers (e.g. a dev copy on
    // another port) don't stop each other's whisper.
    private readonly pidFile = helperPidFile('whisper-server.pid'),
    private readonly readArgs: (pid: number) => string | null = processArgs
  ) {}

  /** The arguments this server is started with (bound to loopback only). */
  argsFor(port: number): string[] {
    return ['-m', this.model, '--host', '127.0.0.1', '--port', String(port)];
  }

  /**
   * A server restarted abruptly (dev watcher, crash) never ran its exit hook and can leave a
   * large whisper-server behind; the next one would start another. Stop the one we recorded,
   * but only after checking that the pid still runs our binary with our loopback arguments:
   * a stale file whose pid was reused by another program is removed, never signalled.
   */
  private stopOrphan() {
    stopRecordedHelper(
      this.pidFile,
      [this.bin, `-m ${this.model}`, '--host 127.0.0.1'],
      this.readArgs
    );
  }

  private start(): Promise<boolean> {
    if (this.starting) return this.starting;
    this.stopOrphan();
    this.port = 20000 + Math.floor(Math.random() * 40000);
    const child = spawn(this.bin, this.argsFor(this.port), { stdio: 'ignore' });
    this.child = child;
    child.unref();
    try {
      if (child.pid) writeFileSync(this.pidFile, String(child.pid), { mode: 0o600 });
    } catch {
      // Best effort: without the file an orphan just lives until the idle stop.
    }
    const reset = () => {
      if (this.child === child) {
        this.child = null;
        this.starting = null;
      }
    };
    child.on('exit', reset);
    child.on('error', reset);
    this.starting = (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && this.child === child) {
        try {
          await fetch(`http://127.0.0.1:${this.port}/`, { signal: AbortSignal.timeout(1000) });
          logger.log(`whisper-server ready on port ${this.port}`);
          return true;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      this.stop();
      return false;
    })();
    return this.starting;
  }

  /** Whether a whisper-server started by this instance is running. */
  get running(): boolean {
    return this.child !== null;
  }

  /** The text, or null when the resident server isn't usable (the caller uses whisper-cli). */
  async transcribe(wav: Buffer, language: string, signal?: AbortSignal): Promise<string | null> {
    if (!(await this.start())) return null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
    this.idleTimer.unref?.();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav');
    form.append('language', language);
    form.append('response_format', 'json');
    const timeout = AbortSignal.timeout(120_000);
    const response = await fetch(`http://127.0.0.1:${this.port}/inference`, {
      method: 'POST',
      body: form,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) return null;
    const { text } = (await response.json()) as { text?: unknown };
    return typeof text === 'string' ? cleanTranscript(text) : null;
  }

  /** Stops only the child this instance spawned. */
  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.child) rmSync(this.pidFile, { force: true });
    this.child?.kill();
    this.child = null;
    this.starting = null;
  }
}

let resident: ResidentWhisper | null = null;
let residentKey = '';

function residentFor(tools: DictationTools): ResidentWhisper | null {
  if (!tools.server) return null;
  const key = `${tools.server}|${tools.model}`;
  if (!resident || residentKey !== key) {
    resident?.stop();
    resident = new ResidentWhisper(tools.server, tools.model);
    residentKey = key;
  }
  return resident;
}

/** Stop the resident whisper-server, if one was started (server shutdown, voice turned off). */
export function stopResidentWhisper(): void {
  resident?.stop();
  resident = null;
  residentKey = '';
}

process.on('exit', () => resident?.stop());

let queue: Promise<unknown> = Promise.resolve();
/** Jobs not finished yet: the one running plus those waiting. */
let pending = 0;

export class DictationBusyError extends Error {}

/** Transcribe one recording (any format ffmpeg reads) to plain text. */
export async function transcribe(
  audio: Buffer,
  lang: string,
  tools: DictationTools,
  run = execFileAsync,
  signal?: AbortSignal,
  server: ResidentWhisper | null = residentFor(tools)
): Promise<string> {
  // A logged-in client can't pile up work: a small queue, and abandoned requests are skipped
  // or killed.
  if (pending >= 1 + MAX_DICTATION_WAITING) throw new DictationBusyError('busy');
  pending++;
  const job = queue.then(async () => {
    if (signal?.aborted) throw new Error('aborted');
    // A private (0700) directory per job with fixed file names: nothing from the request is
    // used in a path, and the directory is removed whatever happens.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vt-dictation-'));
    try {
      const wav = path.join(dir, 'audio.wav');
      if (isAppWav(audio)) {
        await fs.writeFile(wav, audio, { mode: 0o600 });
      } else {
        const input = path.join(dir, 'input');
        await fs.writeFile(input, audio, { mode: 0o600 });
        await run(
          tools.ffmpeg,
          [
            '-loglevel',
            'error',
            '-y',
            // Only WAV and only local files: a probed format could be a playlist/concat
            // file that makes ffmpeg read other paths or URLs.
            '-f',
            'wav',
            '-protocol_whitelist',
            'file',
            '-i',
            input,
            '-t',
            String(MAX_DICTATION_SECONDS),
            '-ar',
            '16000',
            '-ac',
            '1',
            '-c:a',
            'pcm_s16le',
            wav,
          ],
          { timeout: 30_000, signal }
        );
      }
      const wavBytes = server ? await fs.readFile(wav) : null;
      const whisper = async (language: string) => {
        if (server && wavBytes) {
          const fast = await server.transcribe(wavBytes, language, signal).catch((error) => {
            if (signal?.aborted) throw error;
            logger.warn('whisper-server failed, using whisper-cli:', error);
            return null;
          });
          if (fast !== null) return fast;
        }
        const { stdout } = await run(
          tools.whisper,
          ['-m', tools.model, '-l', language, '-nt', '-np', '-f', wav],
          { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, signal }
        );
        return cleanTranscript(String(stdout));
      };
      const text = await whisper(lang);
      // Nothing in the chosen language: let whisper detect it before saying "nothing heard".
      return text || lang === 'auto' ? text : whisper('auto');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  queue = job.catch(() => undefined);
  return job.finally(() => {
    pending--;
  });
}

export interface DictationRouteOptions {
  configService: Pick<ConfigService, 'getConfig'>;
}

/** Voice is on unless config.json has `"voice": false` (read on every request). */
export function voiceEnabled(configService: Pick<ConfigService, 'getConfig'>): boolean {
  try {
    return configService.getConfig().voice !== false;
  } catch {
    return false;
  }
}

export function createDictationRoutes(options: DictationRouteOptions): Router {
  const router = Router();
  const { configService } = options;

  /**
   * GET /api/dictation/status → { enabled, available }. `enabled` is the config switch; the
   * client shows its mic only when it is true. `available` says whether whisper.cpp and
   * ffmpeg are installed here (looked up only when enabled); without them the client falls
   * back to the browser's own speech recognizer.
   */
  router.get('/dictation/status', (_req: Request, res: Response) => {
    const enabled = voiceEnabled(configService);
    if (!enabled) stopResidentWhisper();
    res.json({ enabled, available: enabled && dictationTools() !== null });
  });

  // Refuse before the body is read: with voice off nothing is buffered or started.
  const requireVoice = (_req: Request, res: Response, next: NextFunction) => {
    if (!voiceEnabled(configService)) {
      stopResidentWhisper();
      res.status(403).json({ error: 'disabled' });
      return;
    }
    next();
  };

  router.post(
    '/dictation/transcribe',
    requireVoice,
    express.raw({ type: () => true, limit: MAX_DICTATION_BYTES }),
    async (req: Request, res: Response) => {
      const tools = dictationTools();
      if (!tools) {
        return res.status(503).json({ error: 'Transcription is not installed on this server' });
      }
      const audio = req.body;
      if (!Buffer.isBuffer(audio) || audio.length === 0) {
        return res.status(400).json({ error: 'No audio received' });
      }
      if (isAppWav(audio) && appWavSeconds(audio) > MAX_DICTATION_SECONDS) {
        return res.status(413).json({ error: 'Recording too long' });
      }
      const started = Date.now();
      const abort = new AbortController();
      // The RESPONSE closing before we answered means the client gave up. (req's 'close'
      // fires as soon as the body has been read in current Node: listening to it would abort
      // every transcription.)
      res.on('close', () => {
        if (!res.writableFinished) abort.abort();
      });
      try {
        const text = await transcribe(
          audio,
          whisperLanguage(req.query.lang),
          tools,
          execFileAsync,
          abort.signal
        );
        logger.log(
          `transcribed ${Math.round(audio.length / 1024)} KB in ${Date.now() - started} ms (${text.length} chars)`
        );
        res.json({ text });
      } catch (error) {
        if (error instanceof DictationBusyError) {
          return res.status(429).json({ error: 'Busy transcribing, try again in a moment' });
        }
        if (abort.signal.aborted) return; // the client gave up; nobody is listening
        logger.error('transcription failed:', error);
        res.status(500).json({ error: 'Transcription failed' });
      }
    }
  );

  // express.raw's limit error (413) as JSON, like the rest of the API.
  router.use(
    '/dictation',
    (error: Error & { type?: string }, _req: Request, res: Response, next: NextFunction) => {
      if (error?.type === 'entity.too.large') {
        res.status(413).json({ error: 'Recording too large' });
        return;
      }
      next(error);
    }
  );

  return router;
}
