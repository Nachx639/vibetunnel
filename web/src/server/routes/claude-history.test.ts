import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveConversation } from '../services/mac-sessions/agents.js';
import { createClaudeHistoryRoutes } from './claude-history.js';

const json = (entry: Record<string, unknown>) => `${JSON.stringify(entry)}\n`;

describe('GET /api/claude/conversations', () => {
  let claudeDir: string;
  let app: express.Express;

  const write = (slug: string, id: string, lines: string[]) => {
    const dir = path.join(claudeDir, 'projects', slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.join(''));
  };

  const user = (cwd: string, text: string, timestamp: string) =>
    json({ type: 'user', cwd, timestamp, message: { role: 'user', content: text } });
  const assistant = (cwd: string, text: string, timestamp: string) =>
    json({ type: 'assistant', cwd, timestamp, message: { content: [{ type: 'text', text }] } });

  beforeEach(() => {
    claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-claude-history-'));
    app = express();
    app.use('/api', createClaudeHistoryRoutes({ claudeDir, blocked: () => null }));

    // Slug is lossy ("my-app" vs "my/app"): cwd must come from the transcript.
    write('-work-my-app', 'aaa-1', [
      json({ type: 'permission-mode', permissionMode: 'default', sessionId: 'aaa-1' }),
      user('/work/my-app', 'Fix the **login** bug', '2030-10-01T10:00:00.000Z'),
      assistant(
        '/work/my-app',
        'Done: the `token` check was inverted.',
        '2030-10-01T10:01:00.000Z'
      ),
      json({ type: 'ai-title', aiTitle: 'Login bug fix' }),
    ]);
    write('-work-other', 'bbb-2', [
      user('/work/other', '<command-name>/clear</command-name>', '2030-10-02T08:00:00.000Z'),
      user('/work/other', 'Write release notes', '2030-10-02T08:00:01.000Z'),
      assistant('/work/other', 'Here they are.', '2030-10-02T08:05:00.000Z'),
    ]);
    // Only metadata, no conversation: not resumable, not listed.
    write('-work-other', 'ccc-3', [json({ type: 'last-prompt', sessionId: 'ccc-3' })]);
    write('-work-other', 'ddd-4', ['{not json\n']);
    write('-work-other', 'agent-xyz', [
      user('/work/other', 'subagent', '2030-10-02T09:00:00.000Z'),
    ]);
  });

  afterEach(() => {
    fs.rmSync(claudeDir, { recursive: true, force: true });
  });

  it('lists conversations newest first with title, cwd, preview and counts only', async () => {
    const res = await request(app).get('/api/claude/conversations');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      hasMore: false,
      conversations: [
        {
          id: 'bbb-2',
          cwd: '/work/other',
          title: 'Write release notes',
          lastMessageAt: '2030-10-02T08:05:00.000Z',
          messageCount: 3,
          preview: 'Here they are.',
        },
        {
          id: 'aaa-1',
          cwd: '/work/my-app',
          title: 'Login bug fix',
          lastMessageAt: '2030-10-01T10:01:00.000Z',
          messageCount: 2,
          preview: 'Done: the token check was inverted.',
        },
      ],
    });
  });

  it('searches title, preview and folder case-insensitively, and pages', async () => {
    const ids = async (query: string) =>
      (await request(app).get('/api/claude/conversations').query({ query })).body.conversations.map(
        (c: { id: string }) => c.id
      );
    expect(await ids('LOGIN')).toEqual(['aaa-1']);
    expect(await ids('they are')).toEqual(['bbb-2']);
    expect(await ids('my-app')).toEqual(['aaa-1']);
    expect(await ids('nothing-matches')).toEqual([]);

    const first = await request(app).get('/api/claude/conversations').query({ limit: 1 });
    expect(first.body.conversations.map((c: { id: string }) => c.id)).toEqual(['bbb-2']);
    expect(first.body.hasMore).toBe(true);
    const second = await request(app)
      .get('/api/claude/conversations')
      .query({ limit: 1, offset: 1 });
    expect(second.body.conversations.map((c: { id: string }) => c.id)).toEqual(['aaa-1']);
    expect(second.body.hasMore).toBe(false);
  });

  it('reads only the ends of a large transcript and picks up changes', async () => {
    const filler = json({ type: 'progress', data: 'x'.repeat(200_000) });
    write('-work-big', 'big-5', [
      user('/work/big', 'Start the big job', '2030-10-02T11:00:00.000Z'),
      ...Array.from({ length: 10 }, () => filler),
      assistant('/work/big', 'Big job finished', '2030-10-02T12:00:00.000Z'),
    ]);
    let res = await request(app).get('/api/claude/conversations').query({ query: 'big' });
    expect(res.body.conversations[0]).toMatchObject({
      id: 'big-5',
      title: 'Start the big job',
      preview: 'Big job finished',
    });

    fs.appendFileSync(
      path.join(claudeDir, 'projects', '-work-big', 'big-5.jsonl'),
      json({ type: 'ai-title', aiTitle: 'Renamed big job' })
    );
    res = await request(app).get('/api/claude/conversations').query({ query: 'big' });
    expect(res.body.conversations[0].title).toBe('Renamed big job');
  });

  it('marks the conversations running outside VibeTunnel right now', async () => {
    const live: LiveConversation = {
      where: 'tmux',
      chatId: 'p-600-1759480000-0',
      tmuxId: 't-600-1759480000-0',
      tmuxName: 'work',
      windowIndex: 1,
    };
    const withLive = express();
    withLive.use(
      '/api',
      createClaudeHistoryRoutes({
        claudeDir,
        blocked: () => null,
        liveConversations: async () =>
          new Map<string, LiveConversation>([
            ['aaa-1', live],
            ['not-listed', { where: 'terminal', app: 'Terminal' }],
          ]),
      })
    );
    const res = await request(withLive).get('/api/claude/conversations');
    expect(
      Object.fromEntries(
        res.body.conversations.map((c: { id: string; live?: unknown }) => [c.id, c.live])
      )
    ).toEqual({ 'aaa-1': live, 'bbb-2': undefined });
  });

  it('still lists everything when it can’t tell what runs outside VibeTunnel', async () => {
    const failing = express();
    failing.use(
      '/api',
      createClaudeHistoryRoutes({
        claudeDir,
        blocked: () => null,
        liveConversations: async () => {
          throw new Error('ps failed');
        },
      })
    );
    const res = await request(failing).get('/api/claude/conversations');
    expect(res.status).toBe(200);
    expect(res.body.conversations.map((c: { id: string }) => c.id)).toEqual(['bbb-2', 'aaa-1']);
    expect(res.body.conversations.some((c: { live?: unknown }) => c.live)).toBe(false);
  });

  it('returns an empty list without a projects directory', async () => {
    fs.rmSync(path.join(claudeDir, 'projects'), { recursive: true });
    const res = await request(app).get('/api/claude/conversations');
    expect(res.body).toEqual({ conversations: [], hasMore: false });
  });

  it('reads nothing and answers 403 while the switch is off or the server has no login', async () => {
    let liveAsked = 0;
    for (const blocked of ['disabled', 'no-auth'] as const) {
      const off = express();
      off.use(
        '/api',
        createClaudeHistoryRoutes({
          // A folder that doesn't exist: listing it would still answer 200 with nothing.
          claudeDir: path.join(claudeDir, 'never-read'),
          blocked: () => blocked,
          liveConversations: async () => {
            liveAsked++;
            return new Map();
          },
        })
      );
      const res = await request(off).get('/api/claude/conversations');
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Claude history is off', code: blocked });
    }
    expect(liveAsked).toBe(0);
  });

  it('never follows a link out of the projects folder', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-claude-outside-'));
    try {
      const secret = path.join(outside, 'secret.jsonl');
      fs.writeFileSync(
        secret,
        user('/elsewhere', 'outside the projects folder', '2030-01-01T00:00:00.000Z')
      );
      // A linked transcript and a linked project folder: neither is listed.
      fs.symlinkSync(secret, path.join(claudeDir, 'projects', '-work-other', 'eee-5.jsonl'));
      fs.mkdirSync(path.join(outside, 'proj'));
      fs.writeFileSync(
        path.join(outside, 'proj', 'fff-6.jsonl'),
        user('/elsewhere', 'outside too', '2030-01-01T00:00:00.000Z')
      );
      fs.symlinkSync(path.join(outside, 'proj'), path.join(claudeDir, 'projects', '-linked'));
      const res = await request(app).get('/api/claude/conversations');
      expect(res.body.conversations.map((c: { id: string }) => c.id)).toEqual(['bbb-2', 'aaa-1']);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('bounds the page size and the search text', async () => {
    const res = await request(app).get('/api/claude/conversations?limit=100000&offset=-5');
    expect(res.status).toBe(200);
    expect(res.body.conversations).toHaveLength(2);
    const long = await request(app).get(`/api/claude/conversations?query=${'x'.repeat(5000)}`);
    expect(long.status).toBe(200);
  });
});
