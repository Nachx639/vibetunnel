/**
 * Text to speech on the server for the chat's read-aloud and voice mode: Claude's replies are
 * read with a natural local voice instead of the browser's speech synthesis (which an iPhone
 * in silent mode mutes).
 *
 * Engines, best first: Kokoro-82M (kokoro-onnx in its own venv, kept resident and fed over a
 * stdin/stdout pipe, no network listener), Piper when it is installed with a voice model, and
 * macOS `say`. Every program runs with an argument array, never a shell; one synthesis at a
 * time behind a small queue. The routes (routes/tts.ts) only call into this file when the
 * `voice` switch is on. Setup: docs/features/voice-dictation.md.
 */
import { type ChildProcess, execFile, spawn } from 'child_process';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createInterface } from 'readline';
import { promisify } from 'util';
import {
  detectSpeechLanguage,
  MAX_TTS_CHARS,
  normalizeSpeechLanguage,
  type SpeechLanguage,
} from '../../shared/tts-text.js';
import {
  findBinary,
  helperPidFile,
  processArgs,
  stopRecordedHelper,
  usableFile,
} from '../utils/local-tools.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('tts');
const execFileAsync = promisify(execFile);

export { MAX_TTS_CHARS };
/** Requests allowed to wait behind the one being synthesized. */
export const MAX_TTS_WAITING = 4;
export const TTS_TIMEOUT_MS = 30_000;

export type TtsEngineName = 'kokoro' | 'piper' | 'say';
const ENGINE_NAMES: TtsEngineName[] = ['kokoro', 'piper', 'say'];

/** Kokoro voice + espeak language per language (espeak rejects "zh": it wants "cmn"). */
export const KOKORO_VOICES: Partial<Record<SpeechLanguage, { voice: string; lang: string }>> = {
  en: { voice: 'af_heart', lang: 'en-us' },
  es: { voice: 'ef_dora', lang: 'es' },
  fr: { voice: 'ff_siwis', lang: 'fr-fr' },
  pt: { voice: 'pf_dora', lang: 'pt-br' },
  it: { voice: 'if_sara', lang: 'it' },
  hi: { voice: 'hf_alpha', lang: 'hi' },
  zh: { voice: 'zf_xiaoxiao', lang: 'cmn' },
};

/** Where the Kokoro venv and models (and Piper voices) live. */
export function ttsHome(): string {
  const fromEnv = process.env.VIBETUNNEL_TTS_DIR;
  if (fromEnv && path.isAbsolute(fromEnv)) return fromEnv;
  return path.join(os.homedir(), '.vibetunnel', 'tts');
}

/** The env path when set (validated, never replaced by a default), else the first default. */
function fromEnvOr(envVar: string, defaults: string[], executable: boolean): string | null {
  const fromEnv = process.env[envVar];
  if (fromEnv) return usableFile(fromEnv, executable);
  for (const candidate of defaults) {
    const found = usableFile(candidate, executable);
    if (found) return found;
  }
  return null;
}

export interface KokoroSetup {
  python: string;
  model: string;
  voices: string;
}

export function kokoroSetup(): KokoroSetup | null {
  const home = ttsHome();
  const models = path.join(home, 'models');
  const python = fromEnvOr(
    'VIBETUNNEL_TTS_PYTHON',
    [path.join(home, 'venv', 'bin', 'python3')],
    true
  );
  // fp16 first: a little faster per sentence and half the size.
  const model = fromEnvOr(
    'VIBETUNNEL_KOKORO_MODEL',
    [path.join(models, 'kokoro-v1.0.fp16.onnx'), path.join(models, 'kokoro-v1.0.onnx')],
    false
  );
  const voices = fromEnvOr(
    'VIBETUNNEL_KOKORO_VOICES',
    [path.join(models, 'voices-v1.0.bin')],
    false
  );
  return python && model && voices ? { python, model, voices } : null;
}

/** Piper counts only when it's installed with a voice model (we never install it). */
export function piperSetup(): { bin: string; model: string } | null {
  const bin = findBinary('piper', 'VIBETUNNEL_PIPER');
  if (!bin) return null;
  if (process.env.VIBETUNNEL_PIPER_MODEL) {
    const model = usableFile(process.env.VIBETUNNEL_PIPER_MODEL, false);
    return model ? { bin, model } : null;
  }
  const dir = path.join(ttsHome(), 'piper');
  try {
    const model = readdirSync(dir).find((name) => name.endsWith('.onnx'));
    const found = model ? usableFile(path.join(dir, model), false) : null;
    return found ? { bin, model: found } : null;
  } catch {
    return null;
  }
}

export function sayBinary(): string | null {
  return findBinary('say', 'VIBETUNNEL_SAY', ['/usr/bin']);
}

/** Which engines a request would try: VIBETUNNEL_TTS_ENGINE pins one (debugging). */
export function availableEngines(): TtsEngineName[] {
  const pinned = process.env.VIBETUNNEL_TTS_ENGINE;
  const engines: TtsEngineName[] = [];
  if (kokoroSetup()) engines.push('kokoro');
  if (piperSetup()) engines.push('piper');
  if (sayBinary()) engines.push('say');
  return pinned && (ENGINE_NAMES as string[]).includes(pinned)
    ? engines.filter((engine) => engine === pinned)
    : engines;
}

// ---------------------------------------------------------------------------------------
// macOS `say`: the voice for a language is chosen from what this Mac has installed.

export interface SayVoice {
  name: string;
  /** "en_US", "es_ES", "zh_CN"… */
  locale: string;
}

/** Apple's novelty voices (all en_US): never picked to read a reply. */
const NOVELTY_VOICES = new Set(
  (
    'Albert Bad News Bahh Bells Boing Bubbles Cellos Good News Jester Organ Superstar ' +
    'Trinoids Whisper Wobble Zarvox Fred Junior Kathy Ralph'
  )
    .split(' ')
    .concat(['Bad News', 'Good News'])
);

/** Parses `say -v '?'`: "Name   en_US    # Hello! My name is Name." per line. */
export function parseSayVoices(output: string): SayVoice[] {
  const voices: SayVoice[] = [];
  for (const line of output.split('\n')) {
    const match = /^(.+?)\s+([a-z]{2,3}[_-][A-Za-z0-9]+)\s+#/.exec(line);
    if (match) voices.push({ name: match[1].trim(), locale: match[2].replace('-', '_') });
  }
  return voices;
}

/**
 * The voice to read `lang` with: an enhanced/premium voice for that language first, then any
 * non-novelty one, in the order `say` lists them; null when the Mac has none (then `say`
 * runs without `-v`, with the system voice).
 */
export function pickSayVoice(voices: SayVoice[], lang: SpeechLanguage): string | null {
  const matching = voices.filter(
    (voice) => voice.locale.split('_')[0].toLowerCase() === lang && !NOVELTY_VOICES.has(voice.name)
  );
  const better = matching.find((voice) => /\((Enhanced|Premium)\)/.test(voice.name));
  return (better ?? matching[0])?.name ?? null;
}

const sayVoiceLists = new Map<string, Promise<SayVoice[]>>();

function sayVoices(say: string, run: Run): Promise<SayVoice[]> {
  let list = sayVoiceLists.get(say);
  if (!list) {
    list = run(say, ['-v', '?'], { timeout: 10_000, maxBuffer: 1024 * 1024 })
      .then(({ stdout }) => parseSayVoices(String(stdout)))
      .catch((error) => {
        logger.warn('could not list the say voices:', error);
        sayVoiceLists.delete(say);
        return [];
      });
    sayVoiceLists.set(say, list);
  }
  return list;
}

// ---------------------------------------------------------------------------------------
// Kokoro, resident.

/**
 * The resident Kokoro process. Newline-delimited JSON over stdin/stdout (no socket): it
 * prints {"ready":true} once the model is loaded, then answers each
 * {"id","text","voice","lang","out"} with {"id","ok"}.
 */
export const KOKORO_SIDECAR = `
import sys, json, argparse
def emit(o):
    sys.stdout.write(json.dumps(o) + "\\n"); sys.stdout.flush()
ap = argparse.ArgumentParser()
ap.add_argument("--model", required=True)
ap.add_argument("--voices", required=True)
args = ap.parse_args()
try:
    from kokoro_onnx import Kokoro
    import soundfile as sf
    k = Kokoro(args.model, args.voices)
except Exception as e:
    emit({"fatal": True, "error": str(e)}); sys.exit(1)
emit({"ready": True})
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    rid = None
    try:
        req = json.loads(line); rid = req.get("id")
        samples, sr = k.create(req["text"], voice=req["voice"], speed=req.get("speed", 1.0), lang=req["lang"])
        sf.write(req["out"], samples, sr, subtype="PCM_16")
        emit({"id": rid, "ok": True})
    except Exception as e:
        emit({"id": rid, "ok": False, "error": str(e)})
`;

/** Kokoro kept loaded between replies; stopped after 15 idle minutes. */
export class ResidentKokoro {
  private child: ChildProcess | null = null;
  private starting: Promise<boolean> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private waiting = new Map<number, (result: { ok: boolean; error?: string }) => void>();
  private warmed = new Set<string>();

  constructor(
    private readonly setup: KokoroSetup,
    private readonly idleMs = 15 * 60_000,
    private readonly pidFile = helperPidFile('kokoro-tts.pid'),
    private readonly readArgs: (pid: number) => string | null = processArgs
  ) {}

  /** The sidecar's arguments (the script itself travels as one argv element). */
  argsFor(): string[] {
    return ['-u', '-c', KOKORO_SIDECAR, '--model', this.setup.model, '--voices', this.setup.voices];
  }

  get running(): boolean {
    return this.child !== null;
  }

  /** Loaded and warmed up for `lang`: the next reply in it gets the fast path. */
  readyFor(lang: SpeechLanguage): boolean {
    return this.child !== null && this.warmed.has(lang);
  }

  start(): Promise<boolean> {
    if (this.starting) return this.starting;
    // A server killed abruptly leaves its sidecar behind: stop it, if it is still ours.
    stopRecordedHelper(
      this.pidFile,
      [this.setup.python, `--model ${this.setup.model}`, `--voices ${this.setup.voices}`],
      this.readArgs
    );
    const child = spawn(this.setup.python, this.argsFor(), { stdio: ['pipe', 'pipe', 'ignore'] });
    this.child = child;
    try {
      if (child.pid) writeFileSync(this.pidFile, String(child.pid), { mode: 0o600 });
    } catch {
      // Best effort.
    }
    let ready: (ok: boolean) => void = () => undefined;
    const readyPromise = new Promise<boolean>((resolve) => {
      ready = resolve;
    });
    const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
    lines.on('line', (line) => {
      let message: { ready?: boolean; fatal?: boolean; id?: number; ok?: boolean; error?: string };
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.ready) ready(true);
      else if (message.fatal) {
        logger.warn(`kokoro could not start: ${message.error}`);
        ready(false);
      } else if (typeof message.id === 'number') {
        this.waiting.get(message.id)?.({ ok: Boolean(message.ok), error: message.error });
        this.waiting.delete(message.id);
      }
    });
    const reset = () => {
      ready(false);
      for (const done of this.waiting.values()) done({ ok: false, error: 'kokoro exited' });
      this.waiting.clear();
      if (this.child === child) {
        this.child = null;
        this.starting = null;
        this.warmed.clear();
      }
    };
    child.on('exit', reset);
    child.on('error', reset);
    const timer = setTimeout(() => ready(false), 60_000);
    this.starting = readyPromise.then((ok) => {
      clearTimeout(timer);
      if (ok) logger.log('kokoro ready');
      else if (this.child === child) this.stop();
      return ok;
    });
    return this.starting;
  }

  /**
   * Load the model and run one tiny synthesis in `lang` (the UI language): the first real
   * reply after a cold start is about twice as slow (onnxruntime and the language's
   * phonemizer warm up on their first run). The sample is a digit, read in that language.
   */
  async warm(lang: SpeechLanguage): Promise<void> {
    const voice = KOKORO_VOICES[lang];
    if (!voice || this.warmed.has(lang)) return;
    if (!(await this.start())) return;
    const child = this.child;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vt-tts-warm-'));
    try {
      const ok = await this.synthesize('1.', voice.voice, voice.lang, path.join(dir, 'warm.wav'));
      if (ok && this.child === child) this.warmed.add(lang);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  /** Writes a WAV to `out`; false when Kokoro isn't usable (the caller tries the next engine). */
  async synthesize(text: string, voice: string, lang: string, out: string, signal?: AbortSignal) {
    if (!(await this.start()) || !this.child?.stdin) return false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
    this.idleTimer.unref?.();
    const id = this.nextId++;
    const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve({ ok: false, error: 'timeout' });
        // A stuck sidecar would hold every later request: start a fresh one next time.
        this.stop();
      }, TTS_TIMEOUT_MS);
      const finish = (value: { ok: boolean; error?: string }) => {
        clearTimeout(timer);
        resolve(value);
      };
      this.waiting.set(id, finish);
      signal?.addEventListener('abort', () => finish({ ok: false, error: 'aborted' }), {
        once: true,
      });
      this.child?.stdin?.write(`${JSON.stringify({ id, text, voice, lang, out })}\n`);
    });
    if (!result.ok && result.error !== 'aborted') logger.warn(`kokoro failed: ${result.error}`);
    return result.ok;
  }

  /** Stops only the child this instance spawned. */
  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    try {
      if (this.child) rmSync(this.pidFile, { force: true });
    } catch {
      // Unwritable control dir: nothing recorded, nothing to remove.
    }
    this.child?.kill();
    this.child = null;
    this.starting = null;
    this.warmed.clear();
  }
}

let resident: ResidentKokoro | null = null;
let residentKey = '';

export function residentKokoro(): ResidentKokoro | null {
  const setup = kokoroSetup();
  if (!setup) return null;
  const key = `${setup.python}|${setup.model}|${setup.voices}`;
  if (!resident || residentKey !== key) {
    resident?.stop();
    resident = new ResidentKokoro(setup);
    residentKey = key;
  }
  return resident;
}

/** Stop the resident Kokoro, if one was started (shutdown, voice turned off, tests). */
export function stopResidentKokoro(): void {
  resident?.stop();
  resident = null;
  residentKey = '';
}

process.on('exit', () => resident?.stop());

/** Text a voice should read: no markdown, links shortened, emoji dropped. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_#>|~]+/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class TtsBusyError extends Error {}

export interface SpeechResult {
  audio: Buffer;
  contentType: string;
  engine: TtsEngineName;
  lang: SpeechLanguage;
}

type Run = typeof execFileAsync;

let queue: Promise<unknown> = Promise.resolve();
let pending = 0;

/**
 * Synthesize `text` with the best engine that works, falling back down the chain. `lang`
 * is a hint (the UI language or the language the user spoke); the text's own language wins
 * when it's clear.
 */
export async function synthesize(
  text: string,
  langHint: unknown,
  signal?: AbortSignal,
  run: Run = execFileAsync,
  kokoro: ResidentKokoro | null = residentKokoro()
): Promise<SpeechResult> {
  const spoken = cleanForSpeech(text).slice(0, MAX_TTS_CHARS);
  const lang = detectSpeechLanguage(spoken, normalizeSpeechLanguage(langHint) ?? 'en');
  if (pending >= 1 + MAX_TTS_WAITING) throw new TtsBusyError('busy');
  pending++;
  const job = queue.then(async () => {
    if (signal?.aborted) throw new Error('aborted');
    // A private (0700) directory per job with fixed file names, removed whatever happens.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vt-tts-'));
    try {
      for (const engine of availableEngines()) {
        const out = path.join(dir, `${engine}.wav`);
        let ok = false;
        try {
          ok = await runEngine(engine, spoken, lang, out, run, kokoro, signal);
        } catch (error) {
          if (signal?.aborted) throw error;
          logger.warn(`${engine} failed:`, error);
        }
        if (ok && existsSync(out)) {
          const audio = await fs.readFile(out);
          if (audio.length > 44) return { audio, contentType: 'audio/wav', engine, lang };
        }
        if (signal?.aborted) throw new Error('aborted');
      }
      throw new Error('no text-to-speech engine worked');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  queue = job.catch(() => undefined);
  return job.finally(() => {
    pending--;
  });
}

async function runEngine(
  engine: TtsEngineName,
  text: string,
  lang: SpeechLanguage,
  out: string,
  run: Run,
  kokoro: ResidentKokoro | null,
  signal?: AbortSignal
): Promise<boolean> {
  if (engine === 'kokoro') {
    const voice = KOKORO_VOICES[lang];
    if (!voice || !kokoro) return false;
    return kokoro.synthesize(text, voice.voice, voice.lang, out, signal);
  }
  if (engine === 'piper') {
    const piper = piperSetup();
    if (!piper) return false;
    // The text goes in on stdin, never on the command line.
    await runWithInput(piper.bin, ['--model', piper.model, '--output_file', out], text, signal);
    return true;
  }
  const say = sayBinary();
  if (!say) return false;
  // "--" ends the options: a reply starting with "-v" is read, not parsed.
  const args = ['-o', out, '--file-format=WAVE', '--data-format=LEI16@22050', '--', text];
  const voice = pickSayVoice(await sayVoices(say, run), lang);
  if (voice) {
    try {
      await run(say, ['-v', voice, ...args], { timeout: TTS_TIMEOUT_MS, signal });
      return true;
    } catch (error) {
      if (signal?.aborted) throw error;
      logger.warn(`say voice ${voice} failed, using the system voice`);
    }
  }
  await run(say, args, { timeout: TTS_TIMEOUT_MS, signal });
  return true;
}

function runWithInput(bin: string, args: string[], input: string, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'ignore'], signal });
    const timer = setTimeout(() => child.kill(), TTS_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`${path.basename(bin)} exited with ${code}`));
    });
    child.stdin?.end(input);
  });
}

/** For tests: forget the cached `say -v ?` lists. */
export function resetSayVoicesForTests(): void {
  sayVoiceLists.clear();
}
