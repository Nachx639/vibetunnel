/**
 * Types a message into a session once Claude Code is ready at its prompt (a reply to Claude
 * waiting on a menu: Esc dismisses the menu, then the text is typed here). The text goes to
 * the PTY as keyboard input (never into a shell command line); readiness comes from Claude
 * Code's status file and the screen, so an Enter never lands on a dialog.
 */

export const INITIAL_INPUT_MAX_LENGTH = 20000;

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
  /** Agent name for the give-up reason ("Claude"). */
  agentName?: string;
  /**
   * True while a dialog the user has to answer is showing (update, trust folder). While it
   * is, the wait keeps extending (up to `maxWaitMs`): the user may be answering it.
   */
  dialogVisible?: () => Promise<boolean>;
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until the agent is ready at its prompt, then type `text` and press Enter.
 * Never types blind: an Enter landing on a dialog drawn late (trust this folder, bypass
 * warning) would pick its default answer for the user, so when the
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
  // may be answering it).
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
