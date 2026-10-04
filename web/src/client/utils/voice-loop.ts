/**
 * The hands-free conversation loop of voice mode: listen until you stop
 * talking, transcribe on the server, send it to Claude, wait for the reply, read it aloud,
 * listen again. Everything that touches the browser or the server comes in as `deps`, so
 * the loop itself is plain logic (tested with fakes).
 */

export type VoicePhase =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'permission'
  | 'error'
  | 'ended';

export type ReplyOutcome =
  | { kind: 'reply'; text: string }
  | { kind: 'permission' }
  | { kind: 'timeout' };

export interface VoiceLoopDeps {
  /** Resolves with the next finished utterance (after ~1.2 s of quiet). */
  listen(signal: AbortSignal): Promise<Blob>;
  transcribe(audio: Blob, signal: AbortSignal): Promise<string>;
  /**
   * Remember where the conversation is, so the reply can be told apart from older ones; says
   * whether Claude already waits on a prompt (then nothing is sent).
   */
  mark(signal: AbortSignal): Promise<{ waiting: boolean } | undefined>;
  send(text: string): Promise<void>;
  waitForReply(signal: AbortSignal): Promise<ReplyOutcome>;
  /** Read `text` aloud; resolves when done or when `signal` aborts (an interruption). */
  speak(text: string, signal: AbortSignal): Promise<void>;
  /** The sentence spoken before stopping for a permission prompt. */
  permissionText: () => string;
}

export interface VoiceLoopEvents {
  onPhase?: (phase: VoicePhase) => void;
  onHeard?: (text: string) => void;
  onReply?: (text: string) => void;
  onError?: (error: unknown) => void;
}

/**
 * The words in a transcript, without what whisper writes for noise: "*noise*", "[Music]",
 * "(laughs)", "♪". A transcript left with no letters is nothing heard and never sent to
 * Claude. There is deliberately no phrase list (whisper's invented subtitle credits differ
 * per language); the voice-activity gate keeps most silence from reaching whisper at all.
 */
export function spokenWords(transcript: string): string {
  const words = transcript
    .trim()
    .replace(/\*[^*]*\*|\[[^\]]*\]|\([^)]*\)|[♪♫]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /\p{L}/u.test(words) ? words : '';
}

/** Transcriptions or sends failing in a row before the loop gives up. */
export const MAX_FAILURES = 3;

export class VoiceLoop {
  phase: VoicePhase = 'idle';
  private master: AbortController | null = null;
  private speaking: AbortController | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly deps: VoiceLoopDeps,
    private readonly events: VoiceLoopEvents = {}
  ) {}

  private setPhase(phase: VoicePhase) {
    if (this.phase === phase) return;
    this.phase = phase;
    this.events.onPhase?.(phase);
  }

  /** Start (or restart after a permission stop / an error). */
  start(): Promise<void> {
    if (this.running) return this.running;
    const master = new AbortController();
    this.master = master;
    this.running = this.loop(master.signal).finally(() => {
      if (this.master === master) {
        this.master = null;
        this.running = null;
      }
    });
    return this.running;
  }

  /** Stop talking now and listen (the Interrupt button, or speech while it talks). */
  interrupt(): void {
    this.speaking?.abort();
  }

  /** End the conversation. */
  end(): void {
    this.master?.abort();
    this.speaking?.abort();
    this.setPhase('ended');
  }

  private async loop(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        this.setPhase('listening');
        const audio = await this.deps.listen(signal);
        if (signal.aborted) return;
        this.setPhase('transcribing');
        const text = spokenWords(await this.deps.transcribe(audio, signal));
        if (signal.aborted) return;
        if (!text) continue; // a noise, not words: keep listening
        this.events.onHeard?.(text);
        this.setPhase('thinking');
        const before = await this.deps.mark(signal);
        if (signal.aborted) return;
        if (before?.waiting) {
          // Claude already waits on a menu (a permission, a plan to approve): words typed into
          // it would confirm its highlighted option.
          this.setPhase('permission');
          await this.speakInterruptibly(this.deps.permissionText(), signal);
          if (!signal.aborted) this.setPhase('permission');
          return;
        }
        await this.deps.send(text);
        const outcome = await this.deps.waitForReply(signal);
        if (signal.aborted) return;
        failures = 0;
        if (outcome.kind === 'permission') {
          // Never answer a permission prompt by voice: say so and stop.
          this.setPhase('permission');
          await this.speakInterruptibly(this.deps.permissionText(), signal);
          if (!signal.aborted) this.setPhase('permission');
          return;
        }
        if (outcome.kind === 'timeout' || !outcome.text.trim()) continue;
        this.events.onReply?.(outcome.text);
        this.setPhase('speaking');
        await this.speakInterruptibly(outcome.text, signal);
      } catch (error) {
        if (signal.aborted) return;
        this.events.onError?.(error);
        if (++failures >= MAX_FAILURES) {
          this.setPhase('error');
          return;
        }
      }
    }
  }

  private async speakInterruptibly(text: string, signal: AbortSignal) {
    const speaking = new AbortController();
    this.speaking = speaking;
    const stop = () => speaking.abort();
    signal.addEventListener('abort', stop, { once: true });
    try {
      await this.deps.speak(text, speaking.signal);
    } finally {
      signal.removeEventListener('abort', stop);
      if (this.speaking === speaking) this.speaking = null;
    }
  }
}

interface ChatMessageLike {
  id: string;
  role: string;
  text: string;
}

export interface ChatSnapshot {
  available: boolean;
  status?: string;
  /** Busy only because background agents run: the reply is over. */
  waitingForBackground?: boolean;
  messages: ChatMessageLike[];
}

/**
 * Claude's answer to the message sent after `baselineId` (the last message before sending),
 * or null while it isn't finished. `sawBusy` is whether Claude was seen working since: the
 * first poll after sending can still show the previous idle state.
 */
export function replyAfter(
  chat: ChatSnapshot,
  baselineId: string | null,
  sawBusy: boolean
): ReplyOutcome | null {
  if (chat.status === 'waiting') return { kind: 'permission' };
  // Background agents keep Claude "busy" after its reply: that reply is the answer.
  const replied = chat.status === 'busy' && chat.waitingForBackground === true;
  if (chat.status !== 'idle' && !replied) return null;
  const start = baselineId ? chat.messages.findIndex((m) => m.id === baselineId) + 1 : 0;
  const after = chat.messages.slice(start > 0 ? start : 0);
  const sentIndex = after.findIndex((m) => m.role === 'user');
  if (sentIndex < 0 && !sawBusy) return null;
  const answer = after
    .slice(sentIndex + 1)
    .filter((m) => m.role === 'assistant' && m.text.trim())
    .map((m) => m.text.trim());
  if (answer.length === 0 && !sawBusy) return null;
  return { kind: 'reply', text: answer.join('\n\n') };
}

/** Plain text worth reading: code blocks and tables left out, markdown markers removed. */
export function plainForSpeech(markdown: string, codeNote: string): string {
  return markdown
    .split(/```[^\n]*\n?/)
    .map((part, index) => (index % 2 === 1 ? ` ${codeNote}. ` : part))
    .join('')
    .split('\n')
    .filter((line) => !/^\s*\|.*\|\s*$/.test(line))
    .join('\n')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1$2')
    .replace(/^#{1,6} /gm, '')
    .replace(/^(\s*)[-*•] /gm, '$1')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .replace(/([.!?:])\s*\.\s/g, '$1 ')
    .trim();
}
