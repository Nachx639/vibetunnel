/**
 * @vitest-environment happy-dom
 */
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../shared/types.js';
import { type PhoneSessionRow, rowState } from './phone-session-row.js';
import './phone-session-row.js';

const session = (overrides: Partial<Session> = {}): Session =>
  ({
    id: 's1',
    name: 'claude (~/Projects/app)',
    command: ['claude'],
    workingDir: '/Users/test/Projects/app',
    status: 'running',
    startedAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
    ...overrides,
  }) as Session;

const renderRow = (value: Session) =>
  fixture<PhoneSessionRow>(
    html`<phone-session-row .session=${value} .authClient=${{ getAuthHeader: () => ({ Authorization: 'Bearer t' }) }}></phone-session-row>`
  );

const permission = {
  question: 'Do you want to proceed?',
  options: ['Yes', 'No'],
  detail: ['Bash command', 'rm -rf dist/'],
  key: 'K1',
};

describe('phone session rows with Claude status', () => {
  afterEach(() => {
    fixtureCleanup();
    vi.unstubAllGlobals();
  });

  it('reads the state from Claude, resting while only background agents run', () => {
    expect(rowState(session())).toBe('running');
    expect(rowState(session({ claudeStatus: { status: 'busy' } }))).toBe('working');
    expect(rowState(session({ claudeStatus: { status: 'waiting' } }))).toBe('waiting');
    expect(
      rowState(session({ claudeStatus: { status: 'busy', waitingForBackground: true } }))
    ).toBe('running');
    expect(rowState(session({ status: 'exited', claudeStatus: { status: 'busy' } }))).toBe(
      'exited'
    );
  });

  it("shows Claude's title, what it is doing and its last message", async () => {
    const row = await renderRow(
      session({
        claudeStatus: {
          status: 'busy',
          title: 'Fix the login',
          activity: { kind: 'tool', tool: 'Edit', target: 'app.ts' },
          preview: { role: 'assistant', text: 'Looking at the form' },
        },
      })
    );
    expect(row.querySelector('.psr-title')?.textContent?.trim()).toBe('Fix the login');
    expect(row.querySelector('[data-testid="row-activity"]')?.textContent).toContain('app.ts');
    expect(row.querySelector('.psr-preview')?.textContent).toContain('Looking at the form');
  });

  it('answers a waiting prompt from the row with the key of the menu it shows', async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
    vi.stubGlobal('fetch', fetch);
    const row = await renderRow(
      session({
        claudeStatus: { status: 'waiting', waitingFor: 'permission prompt', choices: permission },
      })
    );
    expect(row.querySelector('[data-testid="psr-needs-chip"]')).toBeTruthy();
    expect(row.querySelector('.psr-choices-detail')?.textContent).toContain('rm -rf dist/');
    const buttons = row.querySelectorAll<HTMLButtonElement>('.psr-choice');
    expect(buttons).toHaveLength(2);
    buttons[1].click();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/sessions/s1/answer');
    expect(JSON.parse(String(init.body))).toEqual({
      option: 2,
      question: permission.question,
      options: permission.options,
      key: 'K1',
    });
  });

  it('says so when the prompt changed before the answer arrived', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({ error: 'The prompt changed' }),
      }))
    );
    const row = await renderRow(
      session({ claudeStatus: { status: 'waiting', choices: permission } })
    );
    row.querySelector<HTMLButtonElement>('.psr-choice')?.click();
    await vi.waitFor(() => expect(row.querySelector('.psr-choices-error')).toBeTruthy());
  });

  it("shows a shell's last line of output, but not Claude's", async () => {
    const shell = await renderRow(session({ command: ['zsh'], lastLine: 'building 3 of 9' }));
    expect(shell.querySelector('[data-testid="row-last-line"]')?.textContent).toContain('building');
    fixtureCleanup();
    const claude = await renderRow(
      session({
        lastLine: 'building 3 of 9',
        claudeStatus: { status: 'idle', preview: { role: 'assistant', text: 'Done' } },
      })
    );
    expect(claude.querySelector('[data-testid="row-last-line"]')).toBeNull();
  });

  it('opens the answer sheet from the "needs you" chip', async () => {
    const opened = vi.fn();
    window.addEventListener('vt-open-answer-sheet', opened);
    const row = await renderRow(session({ claudeStatus: { status: 'waiting' } }));
    row.querySelector<HTMLElement>('[data-testid="psr-needs-chip"]')?.click();
    expect(opened).toHaveBeenCalledTimes(1);
    window.removeEventListener('vt-open-answer-sheet', opened);
  });
});
