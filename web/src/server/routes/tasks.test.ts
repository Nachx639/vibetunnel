import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SCHEDULED_TASKS, TASK_PROMPT_MAX, type TaskRecord } from '../../shared/tasks.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { TaskScheduler } from '../services/task-scheduler.js';

const home = vi.hoisted(() => {
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'vt-task-routes-'));
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => home, default: { ...actual, homedir: () => home } };
});
vi.mock('chokidar', () => ({
  watch: vi.fn(() => ({ on: vi.fn(), close: vi.fn(async () => {}) })),
}));

const { ConfigService } = await import('../services/config-service.js');
const { createTaskRoutes } = await import('./tasks.js');

describe('task routes', () => {
  let app: express.Express;
  let configService: InstanceType<typeof ConfigService>;
  let launch: ReturnType<typeof vi.fn>;
  let scheduler: TaskScheduler;
  let enabled: boolean;

  beforeEach(async () => {
    enabled = true;
    fs.rmSync(path.join(home, '.vibetunnel'), { recursive: true, force: true });
    configService = new ConfigService();
    launch = vi.fn(async () => ({ sessionId: 'sess-1' }));
    scheduler?.stop();
    scheduler = new TaskScheduler({
      storePath: path.join(home, 'control', `tasks-${Math.random()}.json`),
      launch: launch as unknown as (t: TaskRecord, p: string) => Promise<{ sessionId: string }>,
      notify: vi.fn(),
      sessionStatus: () => 'running',
    });
    await scheduler.start(0);
    app = express();
    app.use(express.json());
    app.use(
      '/api',
      createTaskRoutes({ configService, scheduler: () => scheduler, enabled: () => enabled })
    );
  });

  afterAll(() => {
    scheduler?.stop();
    fs.rmSync(home, { recursive: true, force: true });
  });

  describe('templates', () => {
    it('creates, edits, lists and deletes templates, saved in the config file', async () => {
      const created = await request(app)
        .post('/api/task-templates')
        .send({ name: ' Docs ', prompt: 'Document {folder}' });
      expect(created.status).toBe(200);
      const id = created.body.template.id;
      expect(created.body.template).toMatchObject({ name: 'Docs', prompt: 'Document {folder}' });

      const saved = JSON.parse(
        fs.readFileSync(path.join(home, '.vibetunnel', 'config.json'), 'utf8')
      );
      expect(saved.taskTemplates).toEqual([{ id, name: 'Docs', prompt: 'Document {folder}' }]);

      const edited = await request(app)
        .put(`/api/task-templates/${id}`)
        .send({ name: 'Docs 2', prompt: 'Write the docs' });
      expect(edited.body.template).toEqual({ id, name: 'Docs 2', prompt: 'Write the docs' });

      const list = await request(app).get('/api/task-templates');
      expect(list.body.templates).toEqual([{ id, name: 'Docs 2', prompt: 'Write the docs' }]);

      expect((await request(app).delete(`/api/task-templates/${id}`)).status).toBe(200);
      expect((await request(app).get('/api/task-templates')).body.templates).toEqual([]);
      const gone = await request(app).delete(`/api/task-templates/${id}`);
      expect(gone.status).toBe(404);
      expect(gone.body.code).toBe('templateNotFound');
    });

    it('rejects an empty name or prompt and an unknown id', async () => {
      expect(
        (await request(app).post('/api/task-templates').send({ name: ' ', prompt: 'x' })).status
      ).toBe(400);
      expect(
        (await request(app).post('/api/task-templates').send({ name: 'x', prompt: '' })).status
      ).toBe(400);
      expect(
        (
          await request(app)
            .post('/api/task-templates')
            .send({ name: 'x'.repeat(81), prompt: 'y' })
        ).status
      ).toBe(400);
      expect(
        (await request(app).put('/api/task-templates/nope').send({ name: 'x', prompt: 'y' })).status
      ).toBe(404);
    });

    it('caps the number of templates', async () => {
      for (let i = 0; i < 50; i++) {
        await request(app)
          .post('/api/task-templates')
          .send({ name: `t${i}`, prompt: 'p' });
      }
      const over = await request(app).post('/api/task-templates').send({ name: 'x', prompt: 'p' });
      expect(over.status).toBe(400);
      expect(over.body.code).toBe('templateInvalid');
      expect(configService.getTaskTemplates()).toHaveLength(50);
    });

    it('a broken template in a hand-edited config drops the templates, not the config', () => {
      const file = path.join(home, '.vibetunnel', 'config.json');
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(
        file,
        JSON.stringify({ ...config, repositoryBasePath: '/keep/me', taskTemplates: [{ id: 1 }] })
      );
      const reloaded = new ConfigService();
      expect(reloaded.getConfig().repositoryBasePath).toBe('/keep/me');
      expect(reloaded.getTaskTemplates()).toEqual([]);
    });
  });

  describe('tasks', () => {
    const body = {
      name: 'Fix lint',
      prompt: 'Fix the lint errors in {folder}',
      workingDir: '/tmp',
      command: ['claude'],
    };

    it('runs a task now and returns its session', async () => {
      const res = await request(app).post('/api/tasks').send(body);
      expect(res.status).toBe(200);
      expect(res.body.task).toMatchObject({ state: 'running', sessionId: 'sess-1', notify: true });
      expect(launch.mock.calls[0][0]).toMatchObject({ agent: 'claude', command: ['claude'] });
      expect(launch.mock.calls[0][1]).toBe('Fix the lint errors in tmp');
    });

    it('schedules, lists, edits and cancels a task', async () => {
      const runAt = new Date(Date.now() + 3600_000).toISOString();
      const res = await request(app)
        .post('/api/tasks')
        .send({ ...body, runAt });
      expect(res.body.task.state).toBe('scheduled');
      expect(launch).not.toHaveBeenCalled();
      const id = res.body.task.id;

      const later = new Date(Date.now() + 7200_000).toISOString();
      const edited = await request(app).put(`/api/tasks/${id}`).send({ runAt: later });
      expect(edited.body.task.runAt).toBe(later);

      expect((await request(app).get('/api/tasks')).body.tasks).toHaveLength(1);
      expect((await request(app).delete(`/api/tasks/${id}`)).status).toBe(200);
      expect((await request(app).get('/api/tasks')).body.tasks).toHaveLength(0);
    });

    it('rejects bad input with a code the app translates', async () => {
      const past = new Date(Date.now() - 3600_000).toISOString();
      const farAhead = new Date(Date.now() + 400 * 24 * 3600_000).toISOString();
      for (const [bad, code] of [
        [{ ...body, prompt: '' }, 'invalid'],
        [{ ...body, prompt: 'x'.repeat(TASK_PROMPT_MAX + 1) }, 'invalid'],
        [{ ...body, name: 'x'.repeat(81) }, 'invalid'],
        [{ ...body, command: [] }, 'invalid'],
        [{ ...body, command: 'claude' }, 'invalid'],
        [{ ...body, command: ['claude', 7] }, 'invalid'],
        [{ ...body, agent: 'codex' }, 'invalid'],
        [{ ...body, agent: 'gemini' }, 'invalid'],
        [{ ...body, runAt: 'tomorrow-ish' }, 'invalid'],
        [{ ...body, runAt: past }, 'pastTime'],
        [{ ...body, runAt: farAhead }, 'tooFar'],
        [{ ...body, workingDir: path.join(home, 'no', 'such', 'folder') }, 'folderNotFound'],
        [{ ...body, workingDir: '/tmp/../tmp/\u0000' }, 'folderNotFound'],
      ] as const) {
        const res = await request(app).post('/api/tasks').send(bad);
        expect(res.status, JSON.stringify(bad).slice(0, 80)).toBe(400);
        expect(res.body.code).toBe(code);
      }
      expect(launch).not.toHaveBeenCalled();
    });

    it('checks the folder of an edited task too', async () => {
      const runAt = new Date(Date.now() + 3600_000).toISOString();
      const { id } = (
        await request(app)
          .post('/api/tasks')
          .send({ ...body, runAt })
      ).body.task;
      const res = await request(app)
        .put(`/api/tasks/${id}`)
        .send({ workingDir: path.join(home, 'missing') });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('folderNotFound');
      expect((await request(app).put('/api/tasks/nope').send({ name: 'x' })).body.code).toBe(
        'notFound'
      );
    });

    it(`refuses more than ${MAX_SCHEDULED_TASKS} scheduled tasks`, async () => {
      const runAt = new Date(Date.now() + 3600_000).toISOString();
      for (let i = 0; i < MAX_SCHEDULED_TASKS; i++) {
        expect(
          (
            await request(app)
              .post('/api/tasks')
              .send({ ...body, runAt })
          ).status
        ).toBe(200);
      }
      const over = await request(app)
        .post('/api/tasks')
        .send({ ...body, runAt });
      expect(over.status).toBe(409);
      expect(over.body.code).toBe('tooMany');
    });

    it('reports a task whose session could not start', async () => {
      launch.mockRejectedValueOnce(new Error('spawn failed'));
      const res = await request(app).post('/api/tasks').send(body);
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ error: 'spawn failed', code: 'startFailed' });
    });
  });

  describe('switch and access', () => {
    it('answers every route with 403 "disabled" while agent chat is off, and runs nothing', async () => {
      enabled = false;
      const calls = [
        request(app).get('/api/tasks'),
        request(app)
          .post('/api/tasks')
          .send({ name: 'x', prompt: 'y', workingDir: '/tmp', command: ['claude'] }),
        request(app).put('/api/tasks/x').send({ name: 'x' }),
        request(app).delete('/api/tasks/x'),
        request(app).get('/api/task-templates'),
        request(app).post('/api/task-templates').send({ name: 'x', prompt: 'y' }),
        request(app).put('/api/task-templates/x').send({ name: 'x', prompt: 'y' }),
        request(app).delete('/api/task-templates/x'),
      ];
      for (const res of await Promise.all(calls)) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('disabled');
      }
      expect(launch).not.toHaveBeenCalled();
      expect(configService.getTaskTemplates()).toEqual([]);
    });

    it('says tasks are unavailable where there is no scheduler (an HQ server)', async () => {
      const hq = express();
      hq.use(express.json());
      hq.use(
        '/api',
        createTaskRoutes({ configService, scheduler: () => null, enabled: () => true })
      );
      const res = await request(hq).get('/api/tasks');
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('unavailable');
    });

    it('needs a login when mounted behind the auth middleware, as server.ts does', async () => {
      const secured = express();
      secured.use(express.json());
      secured.use(
        '/api',
        createAuthMiddleware({
          enableSSHKeys: false,
          disallowUserPassword: false,
          noAuth: false,
          isHQMode: false,
        })
      );
      secured.use(
        '/api',
        createTaskRoutes({ configService, scheduler: () => scheduler, enabled: () => true })
      );
      expect((await request(secured).get('/api/tasks')).status).toBe(401);
      expect(
        (
          await request(secured)
            .post('/api/tasks')
            .send({ name: 'x', prompt: 'y', workingDir: '/tmp', command: ['claude'] })
        ).status
      ).toBe(401);
      expect((await request(secured).get('/api/task-templates')).status).toBe(401);
      expect(launch).not.toHaveBeenCalled();
    });

    it('server.ts mounts the task routes after the /api auth middleware', () => {
      const source = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8');
      const auth = source.indexOf("app.use('/api', authMiddleware)");
      const mount = source.indexOf('createTaskRoutes({');
      expect(auth).toBeGreaterThan(0);
      expect(mount).toBeGreaterThan(auth);
    });
  });
});
