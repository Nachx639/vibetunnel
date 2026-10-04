import { describe, expect, it } from 'vitest';
import { BARGE_IN, rms, VoiceActivityDetector } from './voice-activity';

const RATE = 16000;
const FRAME = 1600; // 100 ms

/** 100 ms frames: `noise` amplitude random hiss, `tone` amplitude 220 Hz sine on top. */
function frames(count: number, tone: number, noise = 0.003): Float32Array[] {
  return Array.from({ length: count }, (_, f) => {
    const frame = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) {
      const t = (f * FRAME + i) / RATE;
      frame[i] = tone * Math.sin(2 * Math.PI * 220 * t) + noise * (Math.random() * 2 - 1);
    }
    return frame;
  });
}

function run(vad: VoiceActivityDetector, input: Float32Array[]) {
  return input.map((frame, index) => [index, vad.push(frame)] as const).filter(([, e]) => e);
}

describe('VoiceActivityDetector', () => {
  it('finds speech and ends it after ~1.2 s of quiet', () => {
    const vad = new VoiceActivityDetector({ sampleRate: RATE });
    const events = run(vad, [...frames(10, 0), ...frames(15, 0.2), ...frames(20, 0)]);
    // Speech starts at frame 10; 250 ms of it are needed → event on the 3rd loud frame.
    expect(events).toEqual([
      [12, 'speech-start'],
      [36, 'speech-end'], // 12 quiet frames after the last loud one (frame 24)
    ]);
  });

  it('keeps one utterance across short pauses between words', () => {
    const vad = new VoiceActivityDetector({ sampleRate: RATE });
    const events = run(vad, [
      ...frames(5, 0),
      ...frames(8, 0.2),
      ...frames(6, 0), // 600 ms pause
      ...frames(8, 0.2),
      ...frames(15, 0),
    ]).map(([, e]) => e);
    expect(events).toEqual(['speech-start', 'speech-end']);
  });

  it('ignores a click and steady background noise', () => {
    const vad = new VoiceActivityDetector({ sampleRate: RATE });
    const events = run(vad, [...frames(20, 0, 0.02), ...frames(1, 0.4), ...frames(20, 0, 0.02)]);
    expect(events).toEqual([]);
  });

  it('adapts to a noisy room: speech must stand out from it', () => {
    const vad = new VoiceActivityDetector({ sampleRate: RATE });
    // Loud fan: hiss at ~0.03 RMS. Speech at 0.035 amplitude barely above it doesn't count.
    expect(run(vad, [...frames(30, 0, 0.05), ...frames(10, 0.035, 0.05)])).toEqual([]);
    expect(run(vad, frames(10, 0.3, 0.05)).map(([, e]) => e)).toEqual(['speech-start']);
  });

  it('needs louder, longer speech to barge in while a reply plays', () => {
    const vad = new VoiceActivityDetector({ sampleRate: RATE });
    vad.setSensitivity(BARGE_IN);
    // Echo of the reply leaking in at a moderate level: not an interruption.
    expect(run(vad, [...frames(5, 0), ...frames(10, 0.06)])).toEqual([]);
    vad.reset();
    expect(run(vad, frames(10, 0.3)).map(([, e]) => e)).toEqual(['speech-start']);
  });

  it('measures RMS', () => {
    expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rms(new Float32Array(0))).toBe(0);
  });
});
