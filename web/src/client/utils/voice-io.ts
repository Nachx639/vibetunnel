/**
 * The browser side of voice mode: an always-open microphone cut into
 * utterances by the VAD, transcription and speech on the server, and polling Claude's chat
 * for the reply. The loop that drives them is utils/voice-loop.ts.
 */
import { chunkForSpeech } from '../../shared/tts-text.js';
import { encodeWav } from './dictation.js';
import { createLogger } from './logger.js';
import { BARGE_IN, NORMAL, VoiceActivityDetector } from './voice-activity.js';
import { type ChatSnapshot, type ReplyOutcome, replyAfter } from './voice-loop.js';

const logger = createLogger('voice-mode');

/** Audio kept from just before speech was detected, so the first syllable isn't cut. */
const PREROLL_MS = 400;
/** One utterance can't run longer than this (it is sent as it is). */
const MAX_UTTERANCE_MS = 60_000;

function newAudioContext(): AudioContext {
  const w = window as Window & { webkitAudioContext?: typeof AudioContext };
  const Context = window.AudioContext || (w.webkitAudioContext as typeof AudioContext);
  return new Context();
}

/**
 * The microphone for the whole conversation. Call `open()` inside the user's tap (iOS only
 * grants audio there). Frames go through the VAD all the time: `next()` resolves with the
 * next utterance, and `onSpeechStart` fires whenever speech begins (barge-in).
 */
export class VoiceCapture {
  onSpeechStart: (() => void) | null = null;
  /** Mic level 0..1 for the indicator. */
  onLevel: ((level: number) => void) | null = null;
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private vad: VoiceActivityDetector | null = null;
  private preroll: Float32Array[] = [];
  private utterance: Float32Array[] | null = null;
  private utteranceSamples = 0;
  private waiter: { resolve: (audio: Blob) => void; reject: (error: unknown) => void } | null =
    null;

  /** Creates the AudioContext synchronously (in the tap), then asks for the mic. */
  open(): Promise<void> {
    const context = newAudioContext();
    this.context = context;
    void context.resume().catch(() => undefined);
    return this.attach(context);
  }

  private async attach(context: AudioContext) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    if (this.context !== context) {
      stream.getTracks().forEach((track) => {
        track.stop();
      });
      return;
    }
    this.stream = stream;
    // resume() can stay pending forever outside a gesture (WebKit): don't wait on it.
    await Promise.race([
      context.resume().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(2048, 1, 1);
    const rate = context.sampleRate;
    this.vad = new VoiceActivityDetector({ sampleRate: rate });
    const prerollFrames = Math.ceil(((PREROLL_MS / 1000) * rate) / 2048);
    processor.onaudioprocess = (event) => {
      const frame = new Float32Array(event.inputBuffer.getChannelData(0));
      this.handleFrame(frame, rate, prerollFrames);
    };
    source.connect(processor);
    // WebKit only runs the processor while it's connected to the output (it writes silence).
    processor.connect(context.destination);
    this.source = source;
    this.processor = processor;
    logger.log(`voice capture at ${rate} Hz`);
  }

  private handleFrame(frame: Float32Array, rate: number, prerollFrames: number) {
    const vad = this.vad;
    if (!vad) return;
    const event = vad.push(frame);
    this.onLevel?.(Math.min(1, framePeak(frame) * 3));
    if (this.utterance) {
      this.utterance.push(frame);
      this.utteranceSamples += frame.length;
    } else {
      this.preroll.push(frame);
      if (this.preroll.length > prerollFrames) this.preroll.shift();
    }
    if (event === 'speech-start') {
      this.utterance = [...this.preroll];
      this.utteranceSamples = this.utterance.reduce((sum, f) => sum + f.length, 0);
      this.preroll = [];
      this.onSpeechStart?.();
    }
    const tooLong = this.utterance && (this.utteranceSamples / rate) * 1000 > MAX_UTTERANCE_MS;
    if ((event === 'speech-end' || tooLong) && this.utterance) {
      const chunks = this.utterance;
      this.utterance = null;
      if (tooLong) vad.reset();
      // Nobody listening (Claude is thinking or talking): that speech is dropped.
      const waiter = this.waiter;
      this.waiter = null;
      waiter?.resolve(encodeWav(chunks, rate));
    }
  }

  /** Thresholds for normal listening, or stricter ones while a reply plays (barge-in). */
  setBargeIn(on: boolean): void {
    this.vad?.setSensitivity(on ? BARGE_IN : NORMAL);
  }

  /** The next complete utterance. A speech already under way counts (barge-in). */
  next(signal: AbortSignal): Promise<Blob> {
    this.waiter?.reject(new DOMException('replaced', 'AbortError'));
    return new Promise<Blob>((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiter = waiter;
      signal.addEventListener(
        'abort',
        () => {
          if (this.waiter === waiter) this.waiter = null;
          reject(new DOMException('aborted', 'AbortError'));
        },
        { once: true }
      );
    });
  }

  close(): void {
    this.waiter?.reject(new DOMException('closed', 'AbortError'));
    this.waiter = null;
    if (this.processor) this.processor.onaudioprocess = null;
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => {
      track.stop();
    });
    void this.context?.close().catch(() => undefined);
    this.processor = null;
    this.source = null;
    this.stream = null;
    this.context = null;
    this.vad = null;
    this.utterance = null;
    this.preroll = [];
  }
}

function framePeak(frame: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < frame.length; i += 32) peak = Math.max(peak, Math.abs(frame[i]));
  return peak;
}

/** Transcribe on the server (whisper detects the language). */
export async function transcribeUtterance(
  audio: Blob,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch('/api/dictation/transcribe?lang=auto', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav', ...headers },
      body: audio,
      signal,
    });
    if (response.status === 429 && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      continue;
    }
    if (!response.ok) throw new Error(`transcription HTTP ${response.status}`);
    const { text } = (await response.json()) as { text?: string };
    return text ?? '';
  }
}

/**
 * Reads replies with the server's voice: sentence chunks fetched one ahead of playback, played
 * through one <audio> element unlocked in the opening tap (iOS refuses play() otherwise).
 */
export class VoicePlayer {
  private readonly audio: HTMLAudioElement;

  constructor(private readonly headers: () => Record<string, string>) {
    this.audio = new Audio();
    this.audio.setAttribute('playsinline', '');
  }

  /** Call synchronously inside the user's tap. */
  unlock(): void {
    // 0.1 s of silence played inside the tap: after that iOS lets this element play freely.
    this.audio.src = URL.createObjectURL(encodeWav([new Float32Array(1600)], 16000));
    void this.audio.play().catch(() => undefined);
  }

  private async fetchChunk(text: string, lang: string, signal: AbortSignal): Promise<Blob> {
    const response = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers() },
      body: JSON.stringify({ text, lang }),
      signal,
    });
    if (!response.ok) throw new Error(`tts HTTP ${response.status}`);
    return response.blob();
  }

  /** Speak `text`; resolves when finished or when `signal` aborts (stops at once). */
  async speak(text: string, lang: string, signal: AbortSignal): Promise<void> {
    const chunks = chunkForSpeech(text);
    if (chunks.length === 0 || signal.aborted) return;
    const started = performance.now();
    let next: Promise<Blob> | null = this.fetchChunk(chunks[0], lang, signal);
    for (let i = 0; i < chunks.length && next; i++) {
      let blob: Blob;
      try {
        blob = await next;
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      // Fetch the next sentence while this one plays.
      next = i + 1 < chunks.length ? this.fetchChunk(chunks[i + 1], lang, signal) : null;
      next?.catch(() => undefined);
      if (i === 0) logger.log(`first audio after ${Math.round(performance.now() - started)} ms`);
      await this.play(blob, signal);
      if (signal.aborted) return;
    }
  }

  private play(blob: Blob, signal: AbortSignal): Promise<void> {
    const url = URL.createObjectURL(blob);
    const audio = this.audio;
    return new Promise<void>((resolve) => {
      const done = () => {
        audio.removeEventListener('ended', done);
        audio.removeEventListener('error', done);
        signal.removeEventListener('abort', stop);
        URL.revokeObjectURL(url);
        resolve();
      };
      const stop = () => {
        audio.pause();
        done();
      };
      audio.addEventListener('ended', done);
      audio.addEventListener('error', done);
      signal.addEventListener('abort', stop, { once: true });
      audio.src = url;
      audio.play().catch((error) => {
        logger.warn('playback refused', error);
        done();
      });
    });
  }

  stop(): void {
    this.audio.pause();
  }
}

/** How often the chat is checked while waiting for Claude. */
const REPLY_POLL_MS = 900;
/** Claude working longer than this ends the wait (the reply is in the chat anyway). */
const REPLY_TIMEOUT_MS = 20 * 60_000;

async function fetchChat(
  sessionId: string,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<ChatSnapshot> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/claude-chat`, {
    headers,
    signal,
  });
  if (!response.ok) throw new Error(`chat HTTP ${response.status}`);
  return (await response.json()) as ChatSnapshot;
}

/** Remembers the last message before sending, then waits for Claude's answer after it. */
export class ReplyWatcher {
  private baselineId: string | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly headers: () => Record<string, string>
  ) {}

  async mark(signal: AbortSignal): Promise<{ waiting: boolean }> {
    const chat = await fetchChat(this.sessionId, this.headers(), signal);
    this.baselineId = chat.messages[chat.messages.length - 1]?.id ?? null;
    return { waiting: chat.status === 'waiting' };
  }

  async wait(signal: AbortSignal): Promise<ReplyOutcome> {
    const deadline = Date.now() + REPLY_TIMEOUT_MS;
    let sawBusy = false;
    let emptyPolls = 0;
    while (!signal.aborted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, REPLY_POLL_MS));
      if (signal.aborted) break;
      let chat: ChatSnapshot;
      try {
        chat = await fetchChat(this.sessionId, this.headers(), signal);
      } catch (error) {
        if (signal.aborted) break;
        logger.debug('chat poll failed', error);
        continue;
      }
      if (chat.status === 'busy' && !chat.waitingForBackground) sawBusy = true;
      const outcome = replyAfter(chat, this.baselineId, sawBusy);
      if (!outcome) continue;
      // Idle with no text yet: the transcript can lag Claude's status by a moment.
      if (outcome.kind === 'reply' && !outcome.text && ++emptyPolls < 3) continue;
      return outcome;
    }
    return { kind: 'timeout' };
  }
}

/** Keeps the screen on during the conversation where the Wake Lock API exists. */
export class ScreenAwake {
  private lock: { release(): Promise<void> } | null = null;
  private wanted = false;

  private readonly onVisible = () => {
    if (this.wanted && document.visibilityState === 'visible') void this.acquire();
  };

  async acquire(): Promise<void> {
    this.wanted = true;
    document.addEventListener('visibilitychange', this.onVisible);
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> };
      };
      this.lock = (await nav.wakeLock?.request('screen')) ?? null;
    } catch (error) {
      logger.debug('wake lock refused', error);
    }
  }

  release(): void {
    this.wanted = false;
    document.removeEventListener('visibilitychange', this.onVisible);
    void this.lock?.release().catch(() => undefined);
    this.lock = null;
  }
}
