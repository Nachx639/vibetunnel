import { describe, expect, it } from 'vitest';
import {
  buildUpstreamHeaders,
  injectClientScript,
  PREVIEW_COOKIE,
  PREVIEW_SW_HEADER,
  parsePreviewUrl,
  previewPortError,
  rewriteLocation,
  rewriteSetCookie,
  sanitizeResponseHeaders,
} from './preview-proxy.js';

describe('preview URL and port rules', () => {
  it('parses /preview/<port>/<path>', () => {
    expect(parsePreviewUrl('/preview/5173/src/main.ts?t=1')).toEqual({
      port: 5173,
      path: '/src/main.ts?t=1',
    });
    expect(parsePreviewUrl('/preview/5173')).toEqual({ port: 5173, path: '/' });
    expect(parsePreviewUrl('/preview/5173?x=1')).toEqual({ port: 5173, path: '/?x=1' });
    expect(parsePreviewUrl('/preview/evil.com/x')).toBeNull();
    expect(parsePreviewUrl('/preview/5173evil/x')).toBeNull();
    expect(parsePreviewUrl('/api/sessions')).toBeNull();
  });

  it('only allows unprivileged ports that are not VibeTunnel itself', () => {
    expect(previewPortError(5173, 7020)).toBeNull();
    expect(previewPortError(7020, 7020)).toMatch(/own port/);
    expect(previewPortError(22, 7020)).toMatch(/range/);
    expect(previewPortError(80, 7020)).toMatch(/range/);
    expect(previewPortError(70000, 7020)).toMatch(/range/);
    expect(previewPortError(6006, 7020, new Set([6006]))).toMatch(/denied/);
    expect(previewPortError(7021, [7020, 7021])).toMatch(/own port/);
  });
});

describe('header handling', () => {
  it('never forwards VibeTunnel credentials or identity to the dev server', () => {
    const headers = buildUpstreamHeaders(
      {
        host: 'vt.example.com',
        cookie: `${PREVIEW_COOKIE}_5173=secret; app=1; vt_preview_port=5173`,
        authorization: 'Bearer vt-jwt',
        'tailscale-user-login': 'me@example.com',
        'x-forwarded-for': '100.1.2.3',
        'x-vibetunnel-local': 'tok',
        origin: 'https://vt.example.com',
        referer: 'https://vt.example.com/preview/5173/about',
        [PREVIEW_SW_HEADER]: '1',
      },
      5173,
      { isVibeTunnelAuthorization: (value) => value === 'Bearer vt-jwt' }
    );
    expect(headers.host).toBe('localhost:5173');
    expect(headers.cookie).toBe('app=1');
    expect(headers.authorization).toBeUndefined();
    expect(headers['tailscale-user-login']).toBeUndefined();
    expect(headers['x-forwarded-for']).toBeUndefined();
    expect(headers['x-vibetunnel-local']).toBeUndefined();
    expect(headers[PREVIEW_SW_HEADER]).toBeUndefined();
    expect(headers.origin).toBe('http://localhost:5173');
    expect(headers.referer).toBe('http://localhost:5173/about');
  });

  it("passes the previewed app's own Authorization through", () => {
    const headers = buildUpstreamHeaders({ host: 'h', authorization: 'Bearer app-token' }, 3000, {
      isVibeTunnelAuthorization: () => false,
    });
    expect(headers.authorization).toBe('Bearer app-token');
  });

  it('strips frame blocking and origin-wide headers from proxied responses', () => {
    const out = sanitizeResponseHeaders(
      {
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
        'service-worker-allowed': '/',
        'clear-site-data': '"storage"',
        'strict-transport-security': 'max-age=1',
        'content-type': 'text/css',
        location: '/login',
      },
      5173
    );
    expect(out['x-frame-options']).toBeUndefined();
    expect(out['content-security-policy']).toBe("default-src 'self'");
    expect(out['service-worker-allowed']).toBeUndefined();
    expect(out['clear-site-data']).toBeUndefined();
    expect(out['strict-transport-security']).toBeUndefined();
    expect(out['content-type']).toBe('text/css');
    expect(out.location).toBe('/preview/5173/login');
  });

  it("scopes the app's cookies to its prefix and drops Domain", () => {
    expect(
      rewriteSetCookie(
        [
          'sid=abc; Path=/; Domain=localhost; HttpOnly',
          'x=1',
          'deep=2; path=/admin',
          `${PREVIEW_COOKIE}=forged; Path=/`,
        ],
        5173
      )
    ).toEqual([
      'sid=abc; Path=/preview/5173/; HttpOnly',
      'x=1; Path=/preview/5173/',
      'deep=2; Path=/preview/5173/admin',
    ]);
  });

  it('keeps redirects to the dev server inside the prefix, others untouched', () => {
    expect(rewriteLocation('http://localhost:5173/a?b=1', 5173)).toBe('/preview/5173/a?b=1');
    expect(rewriteLocation('http://127.0.0.1:5173/', 5173)).toBe('/preview/5173/');
    expect(rewriteLocation('https://accounts.example.com/x', 5173)).toBe(
      'https://accounts.example.com/x'
    );
    expect(rewriteLocation('http://localhost:9999/x', 5173)).toBe('http://localhost:9999/x');
  });

  it('injects the client script first in <head>', () => {
    expect(injectClientScript('<!doctype html><html><head><title>x</title>', 5173)).toBe(
      '<!doctype html><html><head><script src="/preview/5173/__vt_preview_client.js"></script><title>x</title>'
    );
  });
});
