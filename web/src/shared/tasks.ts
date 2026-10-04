/**
 * Tasks: a prompt for Claude Code in a folder, run now or at a set time, with a push when it
 * finishes. Shared by the server (scheduler, API) and the phone sheet. Templates are prompts
 * with placeholders; built-ins live in the client's locales.
 */

export const TASK_NAME_MAX = 80;
export const TASK_PROMPT_MAX = 20000;
export const MAX_TASK_TEMPLATES = 50;
/** Tasks waiting for their time at once; more is refused (`tooMany`). */
export const MAX_SCHEDULED_TASKS = 50;
/**
 * With `runOverdueOnStart`, a task whose time passed while the server was down still runs on
 * start if it is at most this late. Without it, every overdue task is marked missed.
 */
export const TASK_LATE_GRACE_MS = 6 * 60 * 60 * 1000;

/** The agent a task types its prompt into. Only Claude Code for now. */
export type TaskAgent = 'claude';
export const TASK_AGENTS: readonly TaskAgent[] = ['claude'];

export interface TaskTemplate {
  id: string;
  name: string;
  prompt: string;
}

export type TaskState =
  /** Waiting for its time. */
  | 'scheduled'
  /** Its session is running; the agent has not finished the first reply yet. */
  | 'running'
  /** The agent finished (or the session ended); the push went out. */
  | 'finished'
  /** Its time passed while the server was down; not run. */
  | 'missed'
  /** Starting its session failed. */
  | 'failed';

/**
 * Why a request or a task failed. The API answers `{ error, code }` (error in English for
 * logs and scripts); the app shows its own text for the code (`tasks.error.<code>`).
 */
export type TaskErrorCode =
  /** Agent chat is off (`agentChat`), so tasks are too. */
  | 'disabled'
  /** The server is still starting, or this is an HQ server (no local sessions). */
  | 'unavailable'
  | 'invalid'
  | 'pastTime'
  | 'tooFar'
  | 'tooMany'
  | 'notFound'
  | 'templateNotFound'
  | 'templateInvalid'
  | 'folderNotFound'
  /** The session could not be started. */
  | 'startFailed'
  /** The server stopped while the task was starting. */
  | 'interrupted';

export const TASK_ERROR_CODES: readonly TaskErrorCode[] = [
  'disabled',
  'unavailable',
  'invalid',
  'pastTime',
  'tooFar',
  'tooMany',
  'notFound',
  'templateNotFound',
  'templateInvalid',
  'folderNotFound',
  'startFailed',
  'interrupted',
];

export function isTaskErrorCode(value: unknown): value is TaskErrorCode {
  return typeof value === 'string' && (TASK_ERROR_CODES as readonly string[]).includes(value);
}

/** An error with a code the app can show in the user's language. */
export class TaskError extends Error {
  constructor(
    readonly code: TaskErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'TaskError';
  }
}

export interface TaskRecord {
  id: string;
  name: string;
  prompt: string;
  workingDir: string;
  /** The agent's command line as argv (the user's quick start, e.g. ["claude", "--flag"]). */
  command: string[];
  agent: TaskAgent;
  notify: boolean;
  /** ISO time it should run. */
  runAt: string;
  createdAt: string;
  state: TaskState;
  sessionId?: string;
  startedAt?: string;
  finishedAt?: string;
  /** Why it failed, in English (logs). */
  error?: string;
  errorCode?: TaskErrorCode;
}

/** Fill `{folder}` (last path segment), `{path}` (full folder) and `{date}` in a prompt. */
export function fillTaskPlaceholders(text: string, values: { folder: string; now?: Date }): string {
  const trimmed = values.folder.replace(/\/+$/, '');
  const base = trimmed.split('/').pop() || trimmed || values.folder;
  const date = (values.now ?? new Date()).toISOString().slice(0, 10);
  return text
    .replace(/\{folder\}/g, base)
    .replace(/\{path\}/g, values.folder)
    .replace(/\{date\}/g, date);
}

/** The next 2:00 local time after `now` (tonight, or tomorrow if it is already past 2:00). */
export function nextNightAt2(now = new Date()): Date {
  const at = new Date(now);
  at.setHours(2, 0, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}
