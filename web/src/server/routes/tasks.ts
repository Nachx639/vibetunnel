/**
 * Tasks and task templates (mounted under /api, behind auth). Every route answers 403
 * `{ code: "disabled" }` while agent chat is off: a task types its prompt once Claude Code
 * reports it is ready, which reads the state agent chat reads.
 *
 * Errors are `{ error, code }`: `error` in English, `code` a TaskErrorCode the app translates.
 *
 *   GET    /tasks                 scheduled, running and recent tasks
 *   POST   /tasks                 run now (no runAt / runAt now) or schedule
 *   PUT    /tasks/:id             change a task that has not run yet
 *   DELETE /tasks/:id             cancel it, or drop a finished one from the list
 *   GET    /task-templates        the user's templates (built-ins live in the client)
 *   POST   /task-templates        add one
 *   PUT    /task-templates/:id    edit one
 *   DELETE /task-templates/:id    delete one
 */
import { randomUUID } from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import {
  TASK_NAME_MAX,
  TASK_PROMPT_MAX,
  TaskError,
  type TaskErrorCode,
} from '../../shared/tasks.js';
import type { ConfigService } from '../services/config-service.js';
import { resolveTaskFolder } from '../services/task-launcher.js';
import type { TaskScheduler } from '../services/task-scheduler.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('tasks');

/** A time picked a moment ago on the phone is still "now"; older than this is a mistake. */
const PAST_TOLERANCE_MS = 60_000;
const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

const RunAtSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'runAt must be a date')
  .transform((value) => new Date(value));

const TaskFields = {
  name: z.string().trim().min(1).max(TASK_NAME_MAX),
  prompt: z.string().trim().min(1).max(TASK_PROMPT_MAX),
  workingDir: z.string().trim().min(1).max(4096),
  command: z.array(z.string().min(1).max(4096)).min(1).max(64),
  // Only Claude Code for now (TASK_AGENTS); anything else is refused, never guessed.
  agent: z.enum(['claude']),
  notify: z.boolean(),
};

const NewTaskSchema = z.object({
  ...TaskFields,
  agent: TaskFields.agent.default('claude'),
  notify: TaskFields.notify.default(true),
  runAt: RunAtSchema.nullish(),
});

const TaskPatchSchema = z.object(TaskFields).partial().extend({ runAt: RunAtSchema.optional() });

const TemplateInputSchema = z.object({
  name: z.string().trim().min(1).max(TASK_NAME_MAX),
  prompt: z.string().trim().min(1).max(TASK_PROMPT_MAX),
});

type Res = { status: (code: number) => { json: (body: unknown) => void } };

function fail(res: Res, status: number, code: TaskErrorCode, error: string): void {
  res.status(status).json({ error, code });
}

function checkRunAt(runAt: Date | null | undefined): TaskError | null {
  if (!runAt) return null;
  const now = Date.now();
  if (runAt.getTime() < now - PAST_TOLERANCE_MS) {
    return new TaskError('pastTime', 'runAt is in the past');
  }
  if (runAt.getTime() > now + MAX_AHEAD_MS)
    return new TaskError('tooFar', 'runAt is too far ahead');
  return null;
}

/** A folder that doesn't exist fails now, not when the task fires at night. */
function checkFolder(workingDir: string | undefined): TaskError | null {
  if (workingDir === undefined) return null;
  try {
    resolveTaskFolder(workingDir);
    return null;
  } catch (error) {
    return error instanceof TaskError
      ? error
      : new TaskError('folderNotFound', `Folder not found: ${workingDir}`);
  }
}

function issues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
    .join(', ');
}

export function createTaskRoutes(options: {
  configService: ConfigService;
  scheduler: () => TaskScheduler | null;
  /** Agent chat is on (asked on every request, so the switch applies without a restart). */
  enabled: () => boolean;
}): Router {
  const router = Router();
  const { configService } = options;

  router.use(['/tasks', '/task-templates'], (_req, res, next) => {
    if (!options.enabled()) return fail(res, 403, 'disabled', 'Agent chat is off');
    next();
  });

  const scheduler = (res: Res) => {
    const instance = options.scheduler();
    if (!instance) fail(res, 503, 'unavailable', 'Tasks are not available on this server');
    return instance;
  };

  router.get('/tasks', (_req, res) => {
    const tasks = scheduler(res);
    if (!tasks) return;
    res.json({ tasks: tasks.list() });
  });

  router.post('/tasks', async (req, res) => {
    const tasks = scheduler(res);
    if (!tasks) return;
    const parsed = NewTaskSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, 'invalid', issues(parsed.error));
    const invalid = checkRunAt(parsed.data.runAt) ?? checkFolder(parsed.data.workingDir);
    if (invalid) return fail(res, 400, invalid.code, invalid.message);
    try {
      const task = await tasks.create({ ...parsed.data, runAt: parsed.data.runAt ?? undefined });
      if (task.state === 'failed') {
        return res
          .status(500)
          .json({ error: task.error, code: task.errorCode ?? 'startFailed', task });
      }
      res.json({ task });
    } catch (error) {
      if (error instanceof TaskError) return fail(res, 409, error.code, error.message);
      logger.error('creating task failed:', error);
      fail(res, 500, 'startFailed', 'Failed to create task');
    }
  });

  router.put('/tasks/:id', (req, res) => {
    const tasks = scheduler(res);
    if (!tasks) return;
    const parsed = TaskPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, 'invalid', issues(parsed.error));
    const invalid = checkRunAt(parsed.data.runAt) ?? checkFolder(parsed.data.workingDir);
    if (invalid) return fail(res, 400, invalid.code, invalid.message);
    const task = tasks.update(req.params.id, parsed.data);
    if (!task) return fail(res, 404, 'notFound', 'No scheduled task with that id');
    res.json({ task });
  });

  router.delete('/tasks/:id', (req, res) => {
    const tasks = scheduler(res);
    if (!tasks) return;
    if (!tasks.remove(req.params.id)) return fail(res, 404, 'notFound', 'Task not found');
    res.json({ success: true });
  });

  router.get('/task-templates', (_req, res) => {
    res.json({ templates: configService.getTaskTemplates() });
  });

  const saveTemplates = (
    res: Res,
    next: ReturnType<ConfigService['getTaskTemplates']>
  ): boolean => {
    try {
      configService.updateTaskTemplates(next);
      return true;
    } catch (error) {
      fail(res, 400, 'templateInvalid', error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  router.post('/task-templates', (req, res) => {
    const parsed = TemplateInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, 'invalid', issues(parsed.error));
    const template = { id: randomUUID(), ...parsed.data };
    if (!saveTemplates(res, [...configService.getTaskTemplates(), template])) return;
    res.json({ template });
  });

  router.put('/task-templates/:id', (req, res) => {
    const parsed = TemplateInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, 'invalid', issues(parsed.error));
    const current = configService.getTaskTemplates();
    if (!current.some((tpl) => tpl.id === req.params.id)) {
      return fail(res, 404, 'templateNotFound', 'Template not found');
    }
    const template = { id: req.params.id, ...parsed.data };
    const next = current.map((tpl) => (tpl.id === template.id ? template : tpl));
    if (!saveTemplates(res, next)) return;
    res.json({ template });
  });

  router.delete('/task-templates/:id', (req, res) => {
    const current = configService.getTaskTemplates();
    const next = current.filter((tpl) => tpl.id !== req.params.id);
    if (next.length === current.length)
      return fail(res, 404, 'templateNotFound', 'Template not found');
    if (!saveTemplates(res, next)) return;
    res.json({ success: true });
  });

  return router;
}
