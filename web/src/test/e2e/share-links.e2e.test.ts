import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ServerInstance, startTestServer, stopServer } from '../utils/server-utils';

// The real server: share links stay off unless --share-links (or config.json) turns them on.
describe('Share links on a real server', () => {
  let off: ServerInstance | null = null;
  let on: ServerInstance | null = null;

  beforeAll(async () => {
    [off, on] = await Promise.all([
      startTestServer({ args: ['--port', '0', '--no-auth'], waitForHealth: true }),
      startTestServer({ args: ['--port', '0', '--no-auth', '--share-links'], waitForHealth: true }),
    ]);
  });

  afterAll(async () => {
    await Promise.all([off, on].map((server) => (server ? stopServer(server.process) : null)));
  });

  const url = (server: ServerInstance | null, path: string) =>
    `http://localhost:${server?.port}${path}`;

  async function createSession(server: ServerInstance | null): Promise<string> {
    const response = await fetch(url(server, '/api/sessions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: ['sh', '-c', 'echo shared-output; sleep 30'] }),
    });
    expect(response.status).toBe(200);
    return (await response.json()).sessionId;
  }

  it('is off by default: no viewer route, API refused, config says off', async () => {
    const page = await fetch(url(off, '/share/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'));
    expect(page.status).toBe(404);
    expect(page.headers.get('content-security-policy')).toBeNull();
    const sessionId = await createSession(off);
    const create = await fetch(url(off, `/api/sessions/${sessionId}/shares`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minutes: 15 }),
    });
    expect(create.status).toBe(403);
    expect((await (await fetch(url(off, '/api/config'))).json()).shareLinks).toBe(false);
  });

  it('with --share-links, a link shows that session read-only', async () => {
    expect((await (await fetch(url(on, '/api/config'))).json()).shareLinks).toBe(true);
    const sessionId = await createSession(on);
    const create = await fetch(url(on, `/api/sessions/${sessionId}/shares`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minutes: 15 }),
    });
    expect(create.status).toBe(201);
    const { share } = await create.json();
    const page = await fetch(url(on, share.path));
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    let text = '';
    for (let i = 0; i < 40 && !text.includes('shared-output'); i++) {
      const feed = await (await fetch(url(on, `${share.path}/screen`))).json();
      text = feed.text ?? '';
      if (!text.includes('shared-output')) await new Promise((r) => setTimeout(r, 250));
    }
    expect(text).toContain('shared-output');
    const input = await fetch(url(on, `${share.path}/input`), { method: 'POST', body: 'x' });
    expect(input.status).toBe(404);
    await fetch(url(on, `/api/sessions/${sessionId}`), { method: 'DELETE' });
  });
});
