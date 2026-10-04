import { beforeEach, describe, expect, it, vi } from 'vitest';

const gitCalls: string[][] = [];
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: (
      _file: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void
    ) => {
      gitCalls.push(args);
      // Not a repository, answered a little later like a real git would be.
      setTimeout(() => callback(new Error('fatal: not a git repository')), 10);
    },
  };
});

const { clearGitInfoCache, detectGitInfo } = await import('./git-info.js');

describe('detectGitInfo', () => {
  beforeEach(() => {
    gitCalls.length = 0;
    clearGitInfoCache();
  });

  it('runs git once for concurrent lookups of the same directory', async () => {
    const results = await Promise.all(
      Array.from({ length: 30 }, () => detectGitInfo('/not/a/repo'))
    );
    expect(gitCalls).toHaveLength(1);
    expect(results.every((info) => info.gitRepoPath === undefined)).toBe(true);

    await detectGitInfo('/not/a/repo');
    expect(gitCalls).toHaveLength(1); // cached

    await detectGitInfo('/another/dir');
    expect(gitCalls).toHaveLength(2);
  });
});
