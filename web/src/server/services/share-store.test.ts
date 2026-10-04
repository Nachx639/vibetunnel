import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHARE_TOKEN_RE, ShareStore, sharesFileFor } from './share-store.js';

describe('ShareStore', () => {
  it('creates unguessable links that expire', () => {
    let now = 1_000_000;
    const store = new ShareStore({ now: () => now });
    const a = store.create('s1', 15);
    const b = store.create('s1', 15);
    expect(a.token).toMatch(SHARE_TOKEN_RE);
    expect(a.token).not.toBe(b.token);
    expect(a.expiresAt).toBe(now + 15 * 60_000);
    expect(store.get(a.token)?.sessionId).toBe('s1');
    now += 15 * 60_000;
    expect(store.get(a.token)).toBeUndefined();
  });

  it('tokens are 192 random bits in base64url, never repeated', () => {
    const store = new ShareStore({ now: () => 0 });
    const tokens = new Set<string>();
    for (let i = 0; i < 500; i++) tokens.add(store.create(`s${i}`, 15).token);
    expect(tokens.size).toBe(500);
    for (const token of tokens) {
      expect(token).toMatch(SHARE_TOKEN_RE);
      expect(Buffer.from(token, 'base64url')).toHaveLength(24);
    }
  });

  it('caps a link at 24 h and refuses malformed tokens', () => {
    const store = new ShareStore({ now: () => 0 });
    expect(store.create('s1', 10_000).expiresAt).toBe(24 * 60 * 60_000);
    expect(store.get('../../etc/passwd')).toBeUndefined();
    expect(store.get('')).toBeUndefined();
  });

  it('revokes, and lists a session’s live links newest first (at most 10)', () => {
    let now = 0;
    const store = new ShareStore({ now: () => now });
    const tokens: string[] = [];
    for (let i = 0; i < 12; i++) {
      now += 1000;
      tokens.push(store.create('s1', 60).token);
    }
    store.create('s2', 60);
    const listed = store.listFor('s1').map((record) => record.token);
    expect(listed).toEqual(tokens.slice(2).reverse());
    expect(store.revoke(tokens[11])).toBe(true);
    expect(store.get(tokens[11])).toBeUndefined();
    expect(store.revoke(tokens[11])).toBe(false);
  });

  it('keeps links across restarts in a private file, without the expired ones', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-share-'));
    try {
      const file = sharesFileFor(path.join(dir, 'control'));
      expect(file).toBe(path.join(dir, 'shares.json'));
      let now = 0;
      const first = new ShareStore({ file, now: () => now });
      const short = first.create('s1', 15);
      const long = first.create('s1', 60);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      now = 20 * 60_000;
      const second = new ShareStore({ file, now: () => now });
      expect(second.load()).toBe(1);
      expect(second.get(long.token)?.sessionId).toBe('s1');
      expect(second.get(short.token)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
