import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import webpush from 'web-push';
import { DEFAULT_VAPID_CONTACT, VapidManager, vapidSubject } from './vapid-manager.js';

const warn = vi.hoisted(() => vi.fn());
vi.mock('./logger.js', () => ({
  createLogger: () => ({ log: vi.fn(), debug: vi.fn(), error: vi.fn(), warn }),
}));

describe('vapidSubject', () => {
  const fallback = `mailto:${DEFAULT_VAPID_CONTACT}`;

  it.each([
    // Apple answers 403 BadJwtToken for these.
    ['noreply@vibetunnel.local', fallback],
    ['mailto:me@host.local', fallback],
    ['me@localhost.localdomain', fallback],
    ['me@localhost', fallback],
    ['me@192.168.1.10', fallback],
    ['https://localhost:4020', fallback],
    ['https://host.local', fallback],
    ['not-an-email', fallback],
    ['', fallback],
    [undefined, fallback],
    ['me@example.com', 'mailto:me@example.com'],
    ['mailto:ops@example.org', 'mailto:ops@example.org'],
    ['https://vibetunnel.sh', 'https://vibetunnel.sh'],
  ])('%s → %s', (contact, expected) => {
    expect(vapidSubject(contact)).toBe(expected);
  });

  it('never defaults to a reserved domain', () => {
    expect(vapidSubject(DEFAULT_VAPID_CONTACT)).toBe(`mailto:${DEFAULT_VAPID_CONTACT}`);
  });
});

describe('VapidManager', () => {
  let dir: string | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('signs with a subject Apple accepts even when the stored contact is .local', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'vt-vapid-'));
    const setVapidDetails = vi.spyOn(webpush, 'setVapidDetails');
    const manager = new VapidManager(dir);
    await manager.initialize({ contactEmail: 'noreply@vibetunnel.local' });
    expect(setVapidDetails).toHaveBeenCalled();
    expect(setVapidDetails.mock.calls.at(-1)?.[0]).toBe(`mailto:${DEFAULT_VAPID_CONTACT}`);
  });

  it('says in the log when it replaces the configured contact', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'vt-vapid-'));
    warn.mockClear();
    const manager = new VapidManager(dir);
    await manager.initialize({ contactEmail: 'me@host.local' });
    expect(warn.mock.calls.flat().join(' ')).toContain('me@host.local');
  });

  it('keeps a valid contact as is, without a warning', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'vt-vapid-'));
    const setVapidDetails = vi.spyOn(webpush, 'setVapidDetails');
    warn.mockClear();
    const manager = new VapidManager(dir);
    await manager.initialize({ contactEmail: 'me@example.com' });
    expect(setVapidDetails.mock.calls.at(-1)?.[0]).toBe('mailto:me@example.com');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('VAPID contact');
  });
});
