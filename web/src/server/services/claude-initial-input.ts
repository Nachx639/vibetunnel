/**
 * Types a message into an agent session once the agent is ready at its prompt: a reply to
 * Claude waiting on a menu (Esc dismisses the menu, then the text is typed here), or the first
 * message of an "Ask Claude" / "Ask Codex" session from the phone home screen, typed by the
 * server so it is not lost while the agent starts up or the phone sleeps.
 *
 * The text goes to the PTY as keyboard input (never into a shell command line). Readiness is
 * per agent: Claude Code reports its status in a file, Codex is read off the screen, so an
 * Enter never lands on a dialog.
 */

export const INITIAL_INPUT_MAX_LENGTH = 20000;

export type InitialInputAgent = 'claude' | 'codex';

export interface InitialInputDeps {
  /** Claude Code's status for the session ('idle', 'busy', 'waiting'), if Claude runs yet. */
  claudeStatus: () => Promise<string | undefined>;
  /** True while a numbered dialog (trust folder, bypass-permissions warning, …) is on screen. */
  dialogOnScreen: () => Promise<boolean>;
  /** False once the session exited or disappeared. */
  isRunning: () => boolean;
  send: (input: { text: string } | { key: 'enter' }) => void;
  /** Called when the text could not be delivered (logged by the caller). */
  onGiveUp?: (reason: string) => void;
}

export interface InitialInputOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** Consecutive ready polls required (a screen-read agent may redraw between steps). */
  readyPolls?: number;
  /** Pause after Claude reports idle: its input box renders right after the status write. */
  settleMs?: number;
  /** Gap between the text and Enter, so Claude sees Enter as a key press of its own. */
  enterDelayMs?: number;
  /** Longest wait while a dialog keeps showing (the user may be answering it). */
  maxWaitMs?: number;
}

/** What typing the first message needs from the session, whatever the agent. */
export interface AgentInputDeps {
  /** True when the agent waits at its prompt with nothing else on screen. */
  isReady: () => Promise<boolean>;
  /** False once the session exited or disappeared. */
  isRunning: () => boolean;
  send: (input: { text: string } | { key: 'enter' }) => void;
  /** Called when the text could not be delivered (logged by the caller). */
  onGiveUp?: (reason: string) => void;
  /** Agent name for the give-up reason ("Claude", "Codex"). */
  agentName?: string;
  /**
   * True while a dialog the user has to answer is showing (update, trust folder). While it
   * is, the wait keeps extending (up to `maxWaitMs`): the user may be answering it.
   */
  dialogVisible?: () => Promise<boolean>;
  /** False while the typed text still sits in the agent's input, its Enter not taken. */
  submitted?: () => Promise<boolean>;
}

/** Claude Code is ready when it reports idle and no numbered dialog is on screen. */
export function claudeReadiness(
  deps: Pick<InitialInputDeps, 'claudeStatus' | 'dialogOnScreen'>
): () => Promise<boolean> {
  return async () => {
    let status: string | undefined;
    try {
      status = await deps.claudeStatus();
    } catch {
      return false;
    }
    if (status !== 'idle') return false;
    try {
      return !(await deps.dialogOnScreen());
    } catch {
      // A screen we can't read might be hiding a dialog: treat it as one.
      return false;
    }
  };
}

const NUMBERED = /^\s*(?:[›❯>▶]\s*)?(\d+)\.\s+\S/;

/**
 * Whether a Codex screen shows a choice the user must make: a numbered list ("› 1. Update
 * now / 2. Skip / 3. Skip until next version", "1. Yes, continue / 2. No, quit" when trusting
 * a folder, sign-in choices) or "Press enter to continue". Never answered for the user.
 */
export function codexDialogOnScreen(screenText: string): boolean {
  const lines = screenText.split('\n');
  if (lines.some((line) => /press enter to (continue|confirm)/i.test(line))) return true;
  for (let i = 0; i < lines.length; i++) {
    const first = lines[i].match(NUMBERED);
    if (first?.[1] !== '1') continue;
    // Option 2 follows within a few lines (wrapped labels and descriptions in between).
    for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
      const next = lines[j].match(NUMBERED);
      if (next) {
        if (next[1] === '2') return true;
        break;
      }
    }
  }
  return false;
}

/**
 * Whether Codex waits at its input prompt: its composer line ("› Ask Codex to do anything",
 * the placeholder shows as text) near the bottom of the screen, under which only the footer
 * ("100% context left · ? for shortcuts", the model…) follows, and no dialog anywhere.
 */
export function codexReadyOnScreen(screenText: string): boolean {
  if (codexDialogOnScreen(screenText)) return false;
  const lines = screenText.split('\n').filter((line) => line.trim());
  const tail = lines.slice(-8);
  return tail.some((line) => /^\s*[›▌](?:\s|$)/.test(line) && !NUMBERED.test(line));
}

/** Codex is ready when its screen shows the prompt and no dialog. */
export function codexReadiness(screenText: () => Promise<string>): () => Promise<boolean> {
  return async () => {
    try {
      return codexReadyOnScreen(await screenText());
    } catch {
      return false;
    }
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until the agent is ready at its prompt, then type `text` and press Enter.
 * Never types blind: an Enter landing on a dialog drawn late (trust this folder, bypass
 * warning, Codex's update prompt) would pick its default answer for the user, so when the
 * agent is not ready by the timeout the text is dropped and the user answers the dialog.
 * Resolves to true when the text was sent.
 */
export async function typeWhenAgentReady(
  text: string,
  deps: AgentInputDeps,
  {
    timeoutMs = 60000,
    pollMs = 500,
    settleMs = 400,
    enterDelayMs = 80,
    readyPolls = 1,
    maxWaitMs = 10 * 60_000,
  }: InitialInputOptions = {}
): Promise<boolean> {
  // The timeout only runs while no dialog is showing; a dialog keeps it waiting (the user
  // may be answering it, say Codex's update prompt).
  const hardDeadline = Date.now() + maxWaitMs;
  let deadline = Date.now() + timeoutMs;
  let ready = false;
  let streak = 0;
  while (Date.now() < deadline) {
    if (!deps.isRunning()) {
      // Not registered yet right after spawn is fine; keep waiting until the deadline.
      streak = 0;
    } else if (await deps.isReady().catch(() => false)) {
      streak++;
      if (streak >= readyPolls) {
        ready = true;
        break;
      }
    } else {
      streak = 0;
      if (await (deps.dialogVisible?.() ?? Promise.resolve(false)).catch(() => false)) {
        deadline = Math.min(hardDeadline, Date.now() + timeoutMs);
      }
    }
    await sleep(pollMs);
  }
  if (!deps.isRunning()) {
    deps.onGiveUp?.('session is not running');
    return false;
  }
  if (!ready) {
    deps.onGiveUp?.(`${deps.agentName ?? 'Claude'} never became ready`);
    return false;
  }
  await sleep(settleMs);
  // Multi-line text as a bracketed paste, so its newlines don't submit the first line early.
  deps.send({ text: text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text });
  await sleep(enterDelayMs);
  deps.send({ key: 'enter' });
  // An Enter the agent did not take (Codex can read it as part of the typed burst, and the
  // question stays in its input, unsent) is pressed once more.
  if (deps.submitted) {
    for (let waited = 0; waited < 1500; waited += pollMs) {
      await sleep(pollMs);
      if (await deps.submitted().catch(() => true)) return true;
    }
    if (deps.isRunning()) deps.send({ key: 'enter' });
  }
  return true;
}

/** Claude Code: wait until it is idle at its prompt, then type `text` and press Enter. */
export function typeWhenClaudeReady(
  text: string,
  deps: InitialInputDeps,
  options: InitialInputOptions = {}
): Promise<boolean> {
  return typeWhenAgentReady(
    text,
    {
      isReady: claudeReadiness(deps),
      isRunning: deps.isRunning,
      send: deps.send,
      onGiveUp: deps.onGiveUp,
      agentName: 'Claude',
      dialogVisible: deps.dialogOnScreen,
    },
    options
  );
}

export interface CodexInitialInputDeps {
  /** The session's screen as plain text. */
  screenText: () => Promise<string>;
  isRunning: () => boolean;
  send: (input: { text: string } | { key: 'enter' }) => void;
  onGiveUp?: (reason: string) => void;
}

/** Codex: wait until its prompt shows with no dialog (twice in a row), then type `text`. */
export function typeWhenCodexReady(
  text: string,
  deps: CodexInitialInputDeps,
  options: InitialInputOptions = {}
): Promise<boolean> {
  // Each poll asks isReady first and, when not ready, dialogVisible: both look at the same
  // screen read, so a dialog that stays up costs one read per poll instead of two.
  let pollScreen: Promise<string> | null = null;
  const readForPoll = () => {
    pollScreen = deps.screenText();
    return pollScreen;
  };
  return typeWhenAgentReady(
    text,
    {
      isReady: codexReadiness(readForPoll),
      isRunning: deps.isRunning,
      send: deps.send,
      onGiveUp: deps.onGiveUp,
      agentName: 'Codex',
      dialogVisible: async () => {
        const screen = pollScreen ?? deps.screenText();
        pollScreen = null;
        return codexDialogOnScreen(await screen);
      },
      submitted: async () => !codexInputHolds(await deps.screenText(), text),
    },
    // Its Enter after a moment: Codex takes keys typed in a burst for a paste, and an Enter
    // 80 ms after the text does not send it.
    { readyPolls: 2, enterDelayMs: 300, ...options }
  );
}

/** Whether Codex's input line (its last "›" line) starts with the text typed into it. */
export function codexInputHolds(screenText: string, text: string): boolean {
  const start = text.trim().slice(0, 20);
  const input = screenText
    .split('\n')
    .filter((line) => /^\s*[›▌]\s/.test(line))
    .pop();
  return !!start && !!input && input.replace(/^\s*[›▌]\s*/, '').startsWith(start);
}
