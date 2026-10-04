import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TaskRecord } from '../../shared/tasks.js';
import { createTaskLauncher, resolveTaskFolder } from './task-launcher.js';

vi.mock('../utils/git-info.js', () => ({ detectGitInfo: vi.fn(async () => ({})) }));

const task: TaskRecord = {
  id: 't1',
  name: 'Summarize the repo',
  prompt: 'Summarize {folder}',
  workingDir: os.tmpdir(),
  command: ['claude', '--model', 'opus'],
  agent: 'claude',
  notify: true,
  runAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  state: 'running',
};

describe('createTaskLauncher', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-task-launch-'));
    fs.writeFileSync(path.join(dir, 'file.txt'), 'x');
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const launcher = (createSession = vi.fn(async () => ({ sessionId: 'abc', sessionInfo: {} }))) => {
    const deliver = vi.fn();
    const launch = createTaskLauncher({
      ptyManager: { createSession } as never,
      deliverInitialInput: () => deliver,
      enabled: () => true,
    });
    return { launch, deliver, createSession };
  };

  it('starts the command exactly as given and types the prompt, never as an argument', async () => {
    const prompt = 'Summarize $(rm -rf ~); `id` "quoted" && echo done';
    const { launch, deliver, createSession } = launcher();
    await expect(launch({ ...task, prompt }, prompt)).resolves.toEqual({ sessionId: 'abc' });
    expect(createSession).toHaveBeenCalledWith(
      ['claude', '--model', 'opus'],
      expect.objectContaining({ name: 'Summarize the repo', workingDir: os.tmpdir() })
    );
    const argv = (createSession.mock.calls[0] as unknown[])[0] as string[];
    expect(argv.join(' ')).not.toContain('rm -rf');
    expect(deliver).toHaveBeenCalledWith('abc', prompt);
  });

  it('refuses while agent chat is off, and starts nothing', async () => {
    const createSession = vi.fn();
    const launch = createTaskLauncher({
      ptyManager: { createSession } as never,
      deliverInitialInput: () => vi.fn(),
      enabled: () => false,
    });
    await expect(launch(task, 'x')).rejects.toMatchObject({ code: 'disabled' });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('refuses a missing folder, a file and a NUL byte, and starts nothing', async () => {
    const createSession = vi.fn();
    const { launch } = launcher(createSession);
    for (const workingDir of [
      path.join(dir, 'missing'),
      path.join(dir, 'file.txt'),
      `${dir}\0/x`,
    ]) {
      await expect(launch({ ...task, workingDir }, 'x')).rejects.toMatchObject({
        code: 'folderNotFound',
      });
    }
    expect(createSession).not.toHaveBeenCalled();
  });

  it('resolves ~ and relative segments to an absolute folder', () => {
    expect(resolveTaskFolder('~')).toBe(os.homedir());
    expect(resolveTaskFolder(`${dir}/sub/..`)).toBe(path.resolve(dir));
  });
});
