/**
 * Energy-based voice activity detection for voice mode: decides when you
 * start talking and when you've finished (about 1.2 s of quiet), from the same Web Audio
 * PCM frames dictation records. No model, no network: RMS against an adaptive noise floor.
 */

export interface VadOptions {
  sampleRate: number;
  /** Quiet this long after speech ends the utterance. */
  silenceMs?: number;
  /** Speech must last this long to count (a cough or a click doesn't). */
  minSpeechMs?: number;
  /** Absolute RMS below which nothing is speech, however quiet the room. */
  minRms?: number;
  /** Speech is this many times louder than the noise floor. */
  ratio?: number;
  /** Time spent learning the background level before anything counts as speech. */
  calibrateMs?: number;
}

export type VadEvent = 'speech-start' | 'speech-end' | null;

/** Barge-in while Claude talks: louder and longer, so its own voice leaking in doesn't count. */
export const BARGE_IN = { minRms: 0.06, ratio: 4, minSpeechMs: 400 };
export const NORMAL = { minRms: 0.015, ratio: 3, minSpeechMs: 250 };

export function rms(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

export class VoiceActivityDetector {
  private readonly sampleRate: number;
  private readonly silenceMs: number;
  private minSpeechMs: number;
  private minRms: number;
  private ratio: number;
  /** Running estimate of the room's background level. */
  noiseFloor = 0.005;
  speaking = false;
  private loudMs = 0;
  private quietMs = 0;
  private calibratingMs: number;

  constructor(options: VadOptions) {
    this.sampleRate = options.sampleRate;
    this.silenceMs = options.silenceMs ?? 1200;
    this.minSpeechMs = options.minSpeechMs ?? NORMAL.minSpeechMs;
    this.minRms = options.minRms ?? NORMAL.minRms;
    this.ratio = options.ratio ?? NORMAL.ratio;
    this.calibratingMs = options.calibrateMs ?? 500;
  }

  /** Switch thresholds (normal listening vs barge-in while audio plays). */
  setSensitivity(settings: { minRms: number; ratio: number; minSpeechMs: number }): void {
    this.minRms = settings.minRms;
    this.ratio = settings.ratio;
    this.minSpeechMs = settings.minSpeechMs;
  }

  reset(): void {
    this.speaking = false;
    this.loudMs = 0;
    this.quietMs = 0;
  }

  /** Feed one frame; returns an event when speech starts or ends. */
  push(frame: Float32Array): VadEvent {
    const level = rms(frame);
    const ms = (frame.length / this.sampleRate) * 1000;
    if (this.calibratingMs > 0) {
      // The first half second only learns the room (a fan, traffic), it never counts as speech.
      this.calibratingMs -= ms;
      this.noiseFloor = Math.min(0.05, this.noiseFloor + (level - this.noiseFloor) * 0.5);
      return null;
    }
    const loud = level > Math.max(this.minRms, this.noiseFloor * this.ratio);
    if (!this.speaking) {
      // Fast down, slow up: steady noise is learned within seconds, a word barely moves it.
      const weight = level < this.noiseFloor ? 0.3 : loud ? 0.005 : 0.1;
      this.noiseFloor = Math.min(0.05, this.noiseFloor + (level - this.noiseFloor) * weight);
    }
    if (!this.speaking) {
      // Short gaps between syllables don't reset the count; a longer quiet does.
      if (loud) {
        this.loudMs += ms;
        this.quietMs = 0;
      } else {
        this.quietMs += ms;
        if (this.quietMs > 300) this.loudMs = 0;
      }
      if (this.loudMs >= this.minSpeechMs) {
        this.speaking = true;
        this.quietMs = 0;
        return 'speech-start';
      }
      return null;
    }
    this.quietMs = loud ? 0 : this.quietMs + ms;
    if (this.quietMs >= this.silenceMs) {
      this.reset();
      return 'speech-end';
    }
    return null;
  }
}
