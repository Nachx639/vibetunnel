import { describe, expect, it, vi } from 'vitest';
import {
  MAX_FAILURES,
  plainForSpeech,
  type ReplyOutcome,
  replyAfter,
  spokenWords,
  VoiceLoop,
  type VoiceLoopDeps,
  type VoicePhase,
} from './voice-loop';

/** A controllable fake world: each step waits until the test lets it go on. */
function fakes(replies: ReplyOutcome[], heard: string[]) {
  const log: string[] = [];
  let speakRelease: (() => void) | null = null;
  const deps: VoiceLoopDeps = {
    listen: vi.fn(async (signal: AbortSignal) => {
      log.push('listen');
      if (heard.length === 0) {
        // Nothing more to say: wait until the loop ends.
        await new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        );
      }
      return new Blob([heard.shift() ?? '']);
    }),
    transcribe: vi.fn(async (audio: Blob) => {
      const text = await audio.text();
      log.push(`transcribe:${text}`);
      return text;
    }),
    mark: vi.fn(async (): Promise<{ waiting: boolean } | undefined> => {
      log.push('mark');
      return undefined;
    }),
    send: vi.fn(async (text: string) => {
      log.push(`send:${text}`);
    }),
    waitForReply: vi.fn(async () => {
      const reply = replies.shift() ?? { kind: 'timeout' as const };
      log.push(`reply:${reply.kind}`);
      return reply;
    }),
    speak: vi.fn(
      (text: string, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          log.push(`speak:${text}`);
          speakRelease = resolve;
          signal.addEventListener('abort', () => {
            log.push('speak-stopped');
            resolve();
          });
        })
    ),
    permissionText: () => 'Claude necesita tu permiso',
  };
  return { deps, log, finishSpeaking: () => speakRelease?.() };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await tick();
  expect(check()).toBe(true);
}

describe('VoiceLoop', () => {
  it('listens, transcribes, sends, waits, speaks, and listens again', async () => {
    const { deps, log, finishSpeaking } = fakes(
      [{ kind: 'reply', text: 'Done.' }],
      ['run the tests']
    );
    const phases: VoicePhase[] = [];
    const loop = new VoiceLoop(deps, { onPhase: (p) => phases.push(p) });
    void loop.start();
    await until(() => loop.phase === 'speaking');
    finishSpeaking();
    await until(() => log.filter((l) => l === 'listen').length === 2);
    expect(log).toEqual([
      'listen',
      'transcribe:run the tests',
      'mark',
      'send:run the tests',
      'reply:reply',
      'speak:Done.',
      'listen',
    ]);
    expect(phases).toEqual(['listening', 'transcribing', 'thinking', 'speaking', 'listening']);
    loop.end();
    expect(loop.phase).toBe('ended');
  });

  it('goes back to listening when nothing was understood', async () => {
    const { deps, log } = fakes([], ['', 'hello']);
    const loop = new VoiceLoop(deps);
    void loop.start();
    await until(() => log.includes('send:hello'));
    expect(log.slice(0, 3)).toEqual(['listen', 'transcribe:', 'listen']);
    loop.end();
  });

  it('interrupting stops the voice and listens at once', async () => {
    const { deps, log } = fakes([{ kind: 'reply', text: 'Una respuesta muy larga' }], ['pregunta']);
    const loop = new VoiceLoop(deps);
    void loop.start();
    await until(() => loop.phase === 'speaking');
    loop.interrupt();
    await until(() => loop.phase === 'listening');
    expect(log.slice(-2)).toEqual(['speak-stopped', 'listen']);
    loop.end();
  });

  it('stops after saying Claude needs permission, without answering it', async () => {
    const { deps, log, finishSpeaking } = fakes([{ kind: 'permission' }], ['borra la carpeta']);
    const loop = new VoiceLoop(deps);
    const done = loop.start();
    await until(() => log.includes('speak:Claude necesita tu permiso'));
    expect(loop.phase).toBe('permission');
    finishSpeaking();
    await done;
    expect(loop.phase).toBe('permission');
    expect(deps.send).toHaveBeenCalledTimes(1); // only the user's words, never an answer
    expect(log.filter((l) => l === 'listen')).toHaveLength(1);
    // Restartable once the user dealt with it.
    void loop.start();
    await until(() => loop.phase === 'listening');
    loop.end();
  });

  it('never sends into a prompt Claude already waits on, and says so', async () => {
    const { deps, log, finishSpeaking } = fakes([], ['yes, go ahead']);
    vi.mocked(deps.mark).mockResolvedValue({ waiting: true });
    const loop = new VoiceLoop(deps);
    const done = loop.start();
    await until(() => log.includes('speak:Claude necesita tu permiso'));
    finishSpeaking();
    await done;
    expect(deps.send).not.toHaveBeenCalled();
    expect(loop.phase).toBe('permission');
  });

  it('ending while Claude thinks drops the reply', async () => {
    const { deps, log } = fakes([], ['hello']);
    let release: (r: ReplyOutcome) => void = () => undefined;
    deps.waitForReply = () => new Promise((resolve) => (release = resolve));
    const loop = new VoiceLoop(deps);
    const done = loop.start();
    await until(() => loop.phase === 'thinking');
    loop.end();
    release({ kind: 'reply', text: 'tarde' });
    await done;
    expect(log.some((l) => l.startsWith('speak'))).toBe(false);
    expect(loop.phase).toBe('ended');
  });

  it('gives up after repeated failures', async () => {
    const { deps } = fakes([], ['a', 'b', 'c', 'd']);
    deps.transcribe = vi.fn(async () => {
      throw new Error('offline');
    });
    const onError = vi.fn();
    const loop = new VoiceLoop(deps, { onError });
    await loop.start();
    expect(loop.phase).toBe('error');
    expect(onError).toHaveBeenCalledTimes(MAX_FAILURES);
  });
});

describe('replyAfter', () => {
  const user = (id: string, text = 'hello') => ({ id, role: 'user', text });
  const said = (id: string, text: string) => ({ id, role: 'assistant', text });

  it('waits while Claude works or before our message shows up', () => {
    const before = [user('u0'), said('a0', 'old')];
    expect(
      replyAfter({ available: true, status: 'busy', messages: before }, 'a0', true)
    ).toBeNull();
    // Still idle from before the send, our message not in the transcript yet.
    expect(
      replyAfter({ available: true, status: 'idle', messages: before }, 'a0', false)
    ).toBeNull();
  });

  it('collects the assistant text after our message', () => {
    const messages = [
      said('a0', 'old'),
      user('u1'),
      said('a1', 'Let me look.'),
      { id: 't1', role: 'tool', text: '' },
      said('a2', 'Ready, all tests pass.'),
    ];
    expect(replyAfter({ available: true, status: 'idle', messages }, 'a0', true)).toEqual({
      kind: 'reply',
      text: 'Let me look.\n\nReady, all tests pass.',
    });
  });

  it('reports a permission prompt', () => {
    expect(replyAfter({ available: true, status: 'waiting', messages: [] }, null, true)).toEqual({
      kind: 'permission',
    });
  });

  it('takes the reply while background agents keep Claude busy', () => {
    const messages = [said('a0', 'old'), user('u1'), said('a1', 'Lanzado; te aviso.')];
    expect(
      replyAfter(
        { available: true, status: 'busy', waitingForBackground: true, messages },
        'a0',
        true
      )
    ).toEqual({ kind: 'reply', text: 'Lanzado; te aviso.' });
    // The previous reply, our message not in yet: still waiting.
    expect(
      replyAfter(
        {
          available: true,
          status: 'busy',
          waitingForBackground: true,
          messages: messages.slice(0, 1),
        },
        'a0',
        false
      )
    ).toBeNull();
  });
});

it('plainForSpeech drops code, tables and markdown', () => {
  expect(
    plainForSpeech(
      '## Done\n\nI changed **two** files:\n- `a.ts`\n- [b](http://x)\n\n| a | b |\n|---|---|\n\n```ts\nconst x = 1;\n```\nEnd.',
      'code omitted'
    )
  ).toBe('Done. I changed two files: a.ts b. code omitted. End.');
});

it('spokenWords drops what whisper invents for noise', () => {
  expect(spokenWords('*Bad music*')).toBe('');
  expect(spokenWords(' [Music] ♪ ')).toBe('');
  expect(spokenWords('(laughs) OK, run the tests')).toBe('OK, run the tests');
  expect(spokenWords(' ... ')).toBe('');
  // No phrase list: real words are always kept, whatever the language.
  expect(spokenWords('Thank you for watching')).toBe('Thank you for watching');
});
