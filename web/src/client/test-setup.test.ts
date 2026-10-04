/**
 * @vitest-environment happy-dom
 */
import { createRequire } from 'node:module';
import type net from 'node:net';
import { describe, expect, it } from 'vitest';

// src/test/setup.ts wraps customElements.define; these guard that wrapper itself.
describe('test setup: customElements.define', () => {
  it('registers an element first defined inside a test', () => {
    class Late extends HTMLElement {}
    customElements.define('vt-setup-late', Late);
    expect(customElements.get('vt-setup-late')).toBe(Late);
    expect(document.createElement('vt-setup-late')).toBeInstanceOf(Late);
  });

  it('still registers one in a later test, and ignores a second definition', () => {
    class Later extends HTMLElement {}
    customElements.define('vt-setup-later', Later);
    expect(() =>
      customElements.define('vt-setup-later', class extends HTMLElement {})
    ).not.toThrow();
    expect(customElements.get('vt-setup-later')).toBe(Later);
  });
});

describe('test setup: loopback test servers', () => {
  it('client workers start their test servers on 127.0.0.1 only, as the server ones do', () => {
    // A client test may run server routes through supertest; on the wildcard, another
    // process's loopback listener on the same port could answer it.
    const netModule = createRequire(import.meta.url)('node:net') as typeof net;
    const proto = netModule.Server.prototype as unknown as Record<symbol, unknown>;
    expect(proto[Symbol.for('vibetunnel.test.loopbackServers')]).toBe(true);
  });
});
