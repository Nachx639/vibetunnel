/**
 * Read-only share links: a random token that shows one session's screen, live, to whoever has
 * the link and can reach this server, without the VibeTunnel login and without any way to type
 * into it. Off unless enabled (`shareLinks` in config.json or `--share-links`; see
 * docs/features/share-links.md). A link is only as private as the server's address: on a
 * server reachable from the internet, anyone with the link can watch until it expires.
 *
 * A link expires (1 min to 24 h; the app offers 15 min, 1 h and 8 h) and can be revoked.
 * Links are kept next to the control dir (`shares.json`, 0600) so a restart doesn't break
 * them; the file only ever holds links that haven't expired.
 *
 * Tokens are 24 random bytes (192 bits) from the OS CSPRNG. Lookup is a Map lookup by the
 * whole token, never a prefix or character-by-character comparison against a secret, so the
 * response time doesn't tell how much of a guess was right.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('share-store');

/** The lengths offered in the app. */
export const SHARE_DURATIONS_MIN = [15, 60, 480] as const;
export const SHARE_MAX_MIN = 24 * 60;
/** 24 random bytes, base64url: 32 characters. */
export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
/** At most this many live links per session (the oldest goes). */
const MAX_PER_SESSION = 10;

export interface ShareRecord {
  token: string;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
}

/** `~/.vibetunnel/control` → `~/.vibetunnel/shares.json` (same rule as previews.json). */
export function sharesFileFor(controlDir: string): string {
  const dir = path.resolve(controlDir);
  return path.basename(dir) === 'control'
    ? path.join(path.dirname(dir), 'shares.json')
    : path.join(dir, 'shares.json');
}

export class ShareStore {
  private shares = new Map<string, ShareRecord>();
  private readonly file: string | null;
  private readonly now: () => number;

  constructor(options: { file?: string | null; now?: () => number } = {}) {
    this.file = options.file ?? null;
    this.now = options.now ?? Date.now;
  }

  load(): number {
    if (!this.file) return 0;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { shares?: unknown };
      for (const raw of Array.isArray(parsed.shares) ? parsed.shares : []) {
        const record = raw as Partial<ShareRecord>;
        if (
          typeof record.token === 'string' &&
          SHARE_TOKEN_RE.test(record.token) &&
          typeof record.sessionId === 'string' &&
          typeof record.createdAt === 'number' &&
          typeof record.expiresAt === 'number' &&
          record.expiresAt > this.now()
        ) {
          this.shares.set(record.token, record as ShareRecord);
        }
      }
    } catch {
      // No file yet, or unreadable: no links.
    }
    return this.shares.size;
  }

  /** A new link for `sessionId`, valid for `minutes` (1 min to 24 h). */
  create(sessionId: string, minutes: number): ShareRecord {
    const clamped = Math.min(Math.max(Math.round(minutes), 1), SHARE_MAX_MIN);
    const now = this.now();
    const record: ShareRecord = {
      token: randomBytes(24).toString('base64url'),
      sessionId,
      createdAt: now,
      expiresAt: now + clamped * 60_000,
    };
    this.shares.set(record.token, record);
    const mine = this.listFor(sessionId);
    for (const old of mine.slice(MAX_PER_SESSION)) this.shares.delete(old.token);
    this.save();
    return { ...record };
  }

  /** The link, if it exists and hasn't expired. */
  get(token: string): ShareRecord | undefined {
    if (typeof token !== 'string' || !SHARE_TOKEN_RE.test(token)) return undefined;
    const record = this.shares.get(token);
    if (!record) return undefined;
    if (record.expiresAt <= this.now()) {
      this.shares.delete(token);
      this.save();
      return undefined;
    }
    return { ...record };
  }

  revoke(token: string): boolean {
    const deleted = this.shares.delete(token);
    if (deleted) this.save();
    return deleted;
  }

  /** Live links of a session, the newest first. */
  listFor(sessionId: string): ShareRecord[] {
    const now = this.now();
    return [...this.shares.values()]
      .filter((record) => record.sessionId === sessionId && record.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((record) => ({ ...record }));
  }

  private save(): void {
    if (!this.file) return;
    const now = this.now();
    const shares = [...this.shares.values()].filter((record) => record.expiresAt > now);
    const tmp = `${this.file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, shares }, null, 2)}\n`, {
        mode: 0o600,
      });
      fs.renameSync(tmp, this.file);
    } catch (error) {
      logger.warn(`could not save shares.json: ${error}`);
      try {
        fs.unlinkSync(tmp);
      } catch {
        // never written
      }
    }
  }
}
