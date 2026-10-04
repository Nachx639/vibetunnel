import { execFileSync } from 'child_process';
import express, { Router } from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthMiddleware } from '../middleware/auth';
import {
  getChanges,
  getFileDiff,
  MAX_DIFF_BYTES,
  registerGitChangesRoutes,
  resolveRepoFile,
  safeRepoRelative,
} from './git-changes';

vi.mock('../utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
}

describe('git changes', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vt-changes-')));
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'keep.txt'), 'a\nb\nc\n');
    fs.writeFileSync(path.join(repo, 'gone.txt'), 'x\ny\n');
    fs.writeFileSync(path.join(repo, 'old-name.txt'), 'one\ntwo\nthree\nfour\nfive\n');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'unchanged.ts'), 'export {};\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('lists modified, deleted, renamed, staged-added and untracked files with counts', async () => {
    fs.writeFileSync(path.join(repo, 'keep.txt'), 'a\nB\nc\nd\n');
    fs.rmSync(path.join(repo, 'gone.txt'));
    git(repo, 'mv', 'old-name.txt', 'new-name.txt');
    fs.writeFileSync(path.join(repo, 'staged.txt'), '1\n2\n');
    git(repo, 'add', 'staged.txt');
    fs.writeFileSync(path.join(repo, 'src', 'new file.ts'), 'l1\nl2\nl3');
    fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 0]));

    const result = await getChanges(path.join(repo, 'src'));
    expect(result.isGitRepo).toBe(true);
    expect(result.repoPath).toBe(repo);
    const byPath = Object.fromEntries(result.files.map((f) => [f.path, f]));
    expect(byPath['keep.txt']).toMatchObject({ status: 'M', additions: 2, deletions: 1 });
    expect(byPath['gone.txt']).toMatchObject({ status: 'D', additions: 0, deletions: 2 });
    expect(byPath['new-name.txt']).toMatchObject({ status: 'R', oldPath: 'old-name.txt' });
    expect(byPath['staged.txt']).toMatchObject({ status: 'A', additions: 2 });
    expect(byPath['src/new file.ts']).toMatchObject({ status: '??', additions: 3, binary: false });
    expect(byPath['blob.bin']).toMatchObject({ status: '??', binary: true, additions: 0 });
    expect(result.totals).toEqual({ files: 6, additions: 7, deletions: 3 });
  });

  it('lists a wholly untracked folder (a stray node_modules) as one entry', async () => {
    const deps = path.join(repo, 'node_modules', 'pkg');
    fs.mkdirSync(deps, { recursive: true });
    for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(deps, `f${i}.js`), 'x\n');

    const result = await getChanges(repo);
    const untracked = result.files.filter((f) => f.status === '??').map((f) => f.path);
    expect(untracked).toEqual(['node_modules/']);
  });

  it('accepts real files whose names start with two dots', () => {
    expect(safeRepoRelative(repo, '..env')).toBe('..env');
    expect(safeRepoRelative(repo, '../outside')).toBeNull();
  });

  it('reports a clean repo and a non-repo', async () => {
    expect((await getChanges(repo)).totals.files).toBe(0);
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-plain-'));
    try {
      expect((await getChanges(plain)).isGitRepo).toBe(false);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('returns a unified diff for a tracked file', async () => {
    fs.writeFileSync(path.join(repo, 'keep.txt'), 'a\nB\nc\n');
    const d = await getFileDiff(repo, 'keep.txt');
    expect(d).toMatchObject({
      file: 'keep.txt',
      binary: false,
      truncated: false,
      untracked: false,
    });
    expect(d.diff).toContain('@@ -1,3 +1,3 @@');
    expect(d.diff).toContain('-b\n+B\n');
  });

  it('shows an untracked file as all added and flags binaries', async () => {
    fs.writeFileSync(path.join(repo, 'fresh.txt'), 'x\n<script>y</script>\n');
    const d = await getFileDiff(repo, 'fresh.txt');
    expect(d.untracked).toBe(true);
    expect(d.diff).toContain('@@ -0,0 +1,2 @@\n+x\n+<script>y</script>\n');

    fs.writeFileSync(path.join(repo, 'img.bin'), Buffer.from([137, 0, 0, 1]));
    expect(await getFileDiff(repo, 'img.bin')).toMatchObject({ binary: true, diff: '' });
    fs.writeFileSync(path.join(repo, 'keep.txt'), Buffer.from([0, 1, 2]));
    expect(await getFileDiff(repo, 'keep.txt')).toMatchObject({ binary: true, diff: '' });
  });

  it('caps large diffs at a line boundary', async () => {
    const line = `${'z'.repeat(99)}\n`;
    fs.writeFileSync(path.join(repo, 'big.txt'), line.repeat(5000));
    const d = await getFileDiff(repo, 'big.txt');
    expect(d.truncated).toBe(true);
    expect(Buffer.byteLength(d.diff)).toBeLessThanOrEqual(MAX_DIFF_BYTES);
    expect(d.diff.endsWith('\n')).toBe(true);
  });

  it('refuses paths outside the repository', async () => {
    await expect(getFileDiff(repo, '../etc/passwd')).rejects.toThrow(/outside/);
    await expect(getFileDiff(repo, '/etc/passwd')).rejects.toThrow(/outside/);
    expect(safeRepoRelative(repo, 'src/../keep.txt')).toBe('keep.txt');
    expect(safeRepoRelative(repo, '')).toBeNull();
  });

  it('refuses a path that leaves the repository through a symlinked folder', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vt-outside-')));
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret\n');
      fs.symlinkSync(outside, path.join(repo, 'link'));
      expect(await resolveRepoFile(repo, 'link/secret.txt')).toBeNull();
      await expect(getFileDiff(repo, 'link/secret.txt')).rejects.toThrow(/outside/);
      await expect(getFileDiff(repo, 'keep.txt', 'link/secret.txt')).rejects.toThrow(/outside/);
      // The link itself is an untracked file: its diff is the link text, not the folder.
      const d = await getFileDiff(repo, 'link');
      expect(d.diff).not.toContain('top secret');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('shows a symlinked file as its link text, never the target content', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vt-outside-')));
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret\n');
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(repo, 'alias.txt'));
      const d = await getFileDiff(repo, 'alias.txt');
      expect(d.untracked).toBe(true);
      expect(d.diff).not.toContain('top secret');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  describe('routes', () => {
    function appWith(auth: boolean) {
      const app = express();
      if (auth) {
        app.use(
          '/api',
          createAuthMiddleware({
            enableSSHKeys: false,
            disallowUserPassword: false,
            noAuth: false,
            isHQMode: false,
          })
        );
      }
      const router = Router();
      registerGitChangesRoutes(router);
      app.use('/api', router);
      return app;
    }

    it('require authentication', async () => {
      const app = appWith(true);
      const list = await request(app).get('/api/git/changes').query({ path: repo });
      const diff = await request(app)
        .get('/api/git/changes/diff')
        .query({ path: repo, file: 'keep.txt' });
      expect(list.status).toBe(401);
      expect(diff.status).toBe(401);
    });

    it('reject traversal in any spelling with 400', async () => {
      const app = appWith(false);
      for (const file of ['../etc/passwd', '/etc/passwd', 'src/../../x', '%2e%2e/etc/passwd']) {
        const res = await request(app)
          .get(`/api/git/changes/diff?path=${encodeURIComponent(repo)}&file=${file}`)
          .send();
        expect(res.status).toBe(400);
        expect(JSON.stringify(res.body)).not.toContain('root:');
      }
      const old = await request(app)
        .get('/api/git/changes/diff')
        .query({ path: repo, file: 'keep.txt', oldFile: '../../etc/passwd' });
      expect(old.status).toBe(400);
    });

    it('list and diff inside the repository', async () => {
      fs.writeFileSync(path.join(repo, 'keep.txt'), 'a\nB\nc\n');
      const app = appWith(false);
      const list = await request(app).get('/api/git/changes').query({ path: repo });
      expect(list.status).toBe(200);
      expect(list.body.files.map((f: { path: string }) => f.path)).toEqual(['keep.txt']);
      const diff = await request(app)
        .get('/api/git/changes/diff')
        .query({ path: repo, file: 'keep.txt' });
      expect(diff.status).toBe(200);
      expect(diff.body.diff).toContain('+B');
    });
  });
});
