import type * as http from 'node:http';
import { createRequire } from 'node:module';
import type * as net from 'node:net';

/**
 * Test servers listen on 127.0.0.1, never on the wildcard.
 *
 * A server listening with no host binds the dual-stack wildcard [::], while supertest and the
 * tests connect to 127.0.0.1. On macOS a listener bound to 127.0.0.1 on that same port, in any
 * process on the machine, wins those connections (the more specific bind wins, and SO_REUSEADDR
 * lets it bind on top of the wildcard). Route tests then intermittently got another process's
 * answer (a 404 or 401 instead of the expected status, or "socket hang up") while passing alone.
 * Bound to 127.0.0.1, the port cannot be shared: whoever comes second gets EADDRINUSE instead
 * of silently taking the traffic.
 *
 * Both patches go through require, so a test's vi.mock('net') neither sees nor drops them.
 */

const PATCHED = Symbol.for('vibetunnel.test.loopbackServers');
const STARTING = Symbol('starting');
const LOOPBACK = '127.0.0.1';

type Callback = (err: unknown, res: unknown) => void;

interface SupertestTest {
  app: http.Server & { [STARTING]?: true };
  url: string;
  _server?: http.Server;
  [STARTING]?: true;
  end(fn?: Callback): SupertestTest;
  serverAddress(app: http.Server, path: string): string;
}

export function installLoopbackServers(): void {
  const require = createRequire(import.meta.url);
  const netModule = require('node:net') as typeof net;
  const serverProto = netModule.Server.prototype as net.Server & { [PATCHED]?: true };
  if (serverProto[PATCHED]) return;
  serverProto[PATCHED] = true;

  // The guard: a TCP listen on port 0 without a host is exactly the bind that can be hijacked.
  const listen = serverProto.listen as (...args: unknown[]) => net.Server;
  serverProto.listen = function (this: net.Server, ...args: unknown[]) {
    const [first, second] = args;
    const options =
      typeof first === 'object' && first !== null ? (first as net.ListenOptions) : null;
    if (
      (first === 0 && typeof second !== 'string') ||
      (options?.port === 0 && !options.host && options.path === undefined)
    ) {
      throw new Error(
        `a test server on port 0 without a host binds the wildcard, where another process's ` +
          `127.0.0.1 listener on the same port takes its connections: listen(0, '${LOOPBACK}') ` +
          `and wait for 'listening' (src/test/loopback-servers.ts)`
      );
    }
    return listen.apply(this, args);
  } as typeof serverProto.listen;

  // supertest's request(app) calls app.listen(0) and reads the port at once, which works only
  // for the wildcard (with a host the bind waits for a lookup). Listen on 127.0.0.1 instead and
  // send the request once the port is known.
  const { Test } = require('supertest') as { Test: { prototype: SupertestTest } };
  Test.prototype.serverAddress = function (this: SupertestTest, app: http.Server, path: string) {
    const address = app.address();
    if (address && typeof address === 'object') return `http://${LOOPBACK}:${address.port}${path}`;
    this[STARTING] = true;
    // An agent shares one server: the first request starts it, the others wait for it.
    if (!this.app[STARTING]) {
      this.app[STARTING] = true;
      app.once('listening', () => delete this.app[STARTING]);
      this._server = app.listen(0, LOOPBACK);
    }
    return `http://${LOOPBACK}:0${path}`;
  };

  const end = Test.prototype.end;
  Test.prototype.end = function (this: SupertestTest, fn?: Callback) {
    if (!this[STARTING]) return end.call(this, fn);
    delete this[STARTING];
    const server = this.app;
    const send = () => {
      server.off('error', fail);
      const { port } = server.address() as net.AddressInfo;
      this.url = this.url.replace(`://${LOOPBACK}:0`, `://${LOOPBACK}:${port}`);
      end.call(this, fn);
    };
    const fail = (error: Error) => {
      server.off('listening', send);
      fn?.(error, undefined);
    };
    if (server.listening) {
      send();
    } else {
      server.once('listening', send);
      server.once('error', fail);
    }
    return this;
  };
}
