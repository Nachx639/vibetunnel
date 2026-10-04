/**
 * Starts a task's session: the agent's command, exactly as the user's quick start has it, in
 * the task's folder; then the prompt is typed once the agent is ready (the same wait as a
 * reply from the phone). The prompt only ever goes to the agent as keyboard input; it is never
 * part of the command line, and nothing is added to the command.
 */
import * as fs from 'fs';
import { TaskError, type TaskRecord } from '../../shared/tasks.js';
import type { PtyManager } from '../pty/index.js';
import { detectGitInfo } from '../utils/git-info.js';
import { resolveAbsolutePath } from '../utils/path-utils.js';

/** Types the first message into a session once its agent is ready. */
export type DeliverInitialInput = (sessionId: string, text: string) => void;

/**
 * The task's folder as an absolute path, or a `folderNotFound` error. `~` is expanded the way
 * the session routes expand it; the folder must exist and be a directory.
 */
export function resolveTaskFolder(workingDir: string): string {
  if (workingDir.includes('\0')) throw new TaskError('folderNotFound', 'Invalid folder');
  const cwd = resolveAbsolutePath(workingDir);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    throw new TaskError('folderNotFound', `Folder not found: ${workingDir}`);
  }
  if (!stat.isDirectory()) throw new TaskError('folderNotFound', `Not a folder: ${workingDir}`);
  return cwd;
}

export function createTaskLauncher(deps: {
  ptyManager: Pick<PtyManager, 'createSession'>;
  /** Types the first message once the agent is ready (set by the session routes). */
  deliverInitialInput: () => DeliverInitialInput | null;
  /** Agent chat is on (tasks read Claude Code's status to know when to type). */
  enabled: () => boolean;
}) {
  return async (task: TaskRecord, prompt: string): Promise<{ sessionId: string }> => {
    if (!deps.enabled()) throw new TaskError('disabled', 'Agent chat is off');
    const deliver = deps.deliverInitialInput();
    if (!deliver) throw new TaskError('unavailable', 'Session routes are not ready');
    const cwd = resolveTaskFolder(task.workingDir);
    const gitInfo = await detectGitInfo(cwd);
    const { sessionId } = await deps.ptyManager.createSession([...task.command], {
      name: task.name,
      workingDir: cwd,
      cols: 120,
      rows: 30,
      ...gitInfo,
    });
    deliver(sessionId, prompt);
    return { sessionId };
  };
}
