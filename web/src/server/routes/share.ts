/**
 * Read-only share links (see services/share-store.ts). Off unless `isEnabled()` says so
 * (config.json `shareLinks` or `--share-links`); while off, every route here falls through to
 * the server's normal 404, as if it were not mounted, and the API answers 403.
 *
 * Public, outside /api and its login: `GET /share/<token>`, a small standalone page (not the
 * app) that shows the session's screen, and `GET /share/<token>/screen`, its feed. Nothing
 * there can type into the session, list other sessions or reach the API; an unknown, revoked
 * or expired token gets 404. Under /api (logged in): create, list and revoke links.
 */
import { randomBytes } from 'node:crypto';
import { type NextFunction, type Request, type Response, Router } from 'express';
import { ar } from '../../client/i18n/locales/ar.js';
import { bn } from '../../client/i18n/locales/bn.js';
import { en, type Messages } from '../../client/i18n/locales/en.js';
import { es } from '../../client/i18n/locales/es.js';
import { fr } from '../../client/i18n/locales/fr.js';
import { hi } from '../../client/i18n/locales/hi.js';
import { ptBR } from '../../client/i18n/locales/pt-BR.js';
import { zhCN } from '../../client/i18n/locales/zh-CN.js';
import { SHARE_DURATIONS_MIN, type ShareRecord, type ShareStore } from '../services/share-store.js';

export interface ShareScreen {
  title: string;
  running: boolean;
  /** The screen as plain text (the viewer shows it with textContent, never as HTML). */
  text: string;
  cols: number;
}

export interface ShareRoutesConfig {
  store: ShareStore;
  /** The switch, read on every request: false = routes not there (404) and API refused (403). */
  isEnabled: () => boolean;
  sessionExists: (sessionId: string) => boolean;
  /** The session's current screen, or null when the session is gone. */
  readScreen: (sessionId: string) => Promise<ShareScreen | null>;
}

/** The viewer page's languages: the web app's own locale table (client/i18n/locales). */
const LOCALES: Record<string, Partial<Messages>> = {
  en,
  'zh-CN': zhCN,
  hi,
  es,
  fr,
  ar,
  bn,
  'pt-BR': ptBR,
};
const RTL = new Set(['ar']);

const VIEWER_KEYS = [
  'shareViewer.title',
  'shareViewer.live',
  'shareViewer.ended',
  'shareViewer.readOnly',
  'shareViewer.expiresIn',
  'shareViewer.expired',
  'shareViewer.offline',
  'share.minutes',
  'share.hours',
] as const;
type ViewerKey = (typeof VIEWER_KEYS)[number];
type ViewerStrings = Record<ViewerKey, string>;

/** The first language of Accept-Language the app has (`pt` → `pt-BR`, `zh` → `zh-CN`). */
export function viewerLocale(acceptLanguage: string | undefined): string {
  const wanted = String(acceptLanguage ?? '')
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      return { tag: tag.trim().toLowerCase(), q: q ? Number(q.trim().slice(2)) || 0 : 1 };
    })
    .filter((entry) => entry.tag && entry.q > 0)
    .sort((a, b) => b.q - a.q);
  const codes = Object.keys(LOCALES);
  for (const { tag } of wanted) {
    const exact = codes.find((code) => code.toLowerCase() === tag);
    if (exact) return exact;
    const primary = tag.split('-')[0];
    const byLanguage = codes.find((code) => code.toLowerCase().split('-')[0] === primary);
    if (byLanguage) return byLanguage;
  }
  return 'en';
}

function viewerStrings(locale: string): ViewerStrings {
  const table = LOCALES[locale] ?? en;
  const out = {} as ViewerStrings;
  for (const key of VIEWER_KEYS) out[key] = table[key] ?? en[key];
  return out;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}

function privateHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

/** What the app gets for a link: its page path, never a full URL (the app knows its origin). */
export function shareItem(record: ShareRecord) {
  return {
    token: record.token,
    path: `/share/${record.token}`,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

function viewerPage(locale: string, nonce: string, valid: boolean): string {
  const s = viewerStrings(locale);
  const title = escapeHtml(s['shareViewer.title']);
  // JSON in a non-script type is data: CSP doesn't run it, the page script reads it.
  const strings = JSON.stringify(s).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="${locale}" dir="${RTL.has(locale) ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>${title} · VibeTunnel</title>
<style>
  :root { color-scheme: light dark; --bg: #fafafa; --fg: #1a1a1a; --muted: #6b6b6b; --line: #e3e3e3; --live: #16a34a; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0a0a0a; --fg: #e6e6e6; --muted: #8a8a8a; --line: #262626; } }
  html, body { margin: 0; background: var(--bg); color: var(--fg); }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif; }
  header { position: sticky; top: 0; background: var(--bg); border-bottom: 1px solid var(--line);
    padding: calc(10px + env(safe-area-inset-top)) 16px 10px; }
  #name { font-weight: 600; font-size: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #meta { margin-top: 2px; font-size: 13px; color: var(--muted); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--live); display: inline-block; }
  .dot.off { background: var(--muted); }
  pre { margin: 0; padding: 12px 12px calc(16px + env(safe-area-inset-bottom)); overflow-x: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; line-height: 1.3; white-space: pre; }
  #notice { padding: 24px 16px; color: var(--muted); font-size: 15px; }
</style>
</head>
<body>
<header>
  <div id="name">${valid ? '' : title}</div>
  ${valid ? `<div id="meta"><span class="dot" id="dot"></span><span id="state">${escapeHtml(s['shareViewer.live'])}</span><span>· ${escapeHtml(s['shareViewer.readOnly'])}</span><span id="expiry"></span></div>` : ''}
</header>
${valid ? '<pre id="screen" dir="ltr" aria-live="off"></pre>' : `<div id="notice">${escapeHtml(s['shareViewer.expired'])}</div>`}
<script type="application/json" id="vt-strings">${strings}</script>
<script nonce="${nonce}">
(() => {
  const s = JSON.parse(document.getElementById('vt-strings').textContent);
  const screen = document.getElementById('screen');
  if (!screen) return;
  const name = document.getElementById('name');
  const state = document.getElementById('state');
  const dot = document.getElementById('dot');
  const expiry = document.getElementById('expiry');
  const feed = location.pathname.replace(/\\/+$/, '') + '/screen';
  let cols = 80;
  let expiresAt = 0;
  let stopped = false;
  const fit = () => {
    const size = Math.max(7, Math.min(14, (document.documentElement.clientWidth - 24) / (cols * 0.6)));
    screen.style.fontSize = size.toFixed(2) + 'px';
  };
  const left = () => {
    const minutes = Math.max(0, Math.round((expiresAt - Date.now()) / 60000));
    expiry.textContent = expiresAt ? '· ' + s['shareViewer.expiresIn'].replace('{time}', minutes >= 90 ? s['share.hours'].replace('{n}', Math.round(minutes / 60)) : s['share.minutes'].replace('{n}', minutes)) : '';
  };
  const expired = () => {
    stopped = true;
    document.getElementById('meta').remove();
    const notice = document.createElement('div');
    notice.id = 'notice';
    notice.textContent = s['shareViewer.expired'];
    screen.replaceWith(notice);
  };
  async function tick() {
    if (stopped) return;
    try {
      const response = await fetch(feed, { cache: 'no-store', credentials: 'omit' });
      if (response.status === 404) return expired();
      const data = await response.json();
      expiresAt = data.expiresAt || 0;
      left();
      if (data.ended) {
        dot.className = 'dot off';
        state.textContent = s['shareViewer.ended'];
        return;
      }
      name.textContent = data.title || '';
      document.title = (data.title || s['shareViewer.title']) + ' · VibeTunnel';
      dot.className = data.running ? 'dot' : 'dot off';
      state.textContent = data.running ? s['shareViewer.live'] : s['shareViewer.ended'];
      if (data.cols && data.cols !== cols) { cols = data.cols; fit(); }
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 40;
      if (screen.textContent !== data.text) {
        screen.textContent = data.text;
        if (atBottom) window.scrollTo(0, document.documentElement.scrollHeight);
      }
    } catch {
      state.textContent = s['shareViewer.offline'];
      dot.className = 'dot off';
    }
  }
  const loop = async () => {
    if (!document.hidden) await tick();
    if (!stopped) setTimeout(loop, 1500);
  };
  window.addEventListener('resize', fit);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  fit();
  loop();
})();
</script>
</body>
</html>
`;
}

/** While the switch is off, behave as if these routes were not mounted. */
function whenEnabled(config: ShareRoutesConfig) {
  return (_req: Request, _res: Response, next: NextFunction) => {
    if (config.isEnabled()) next();
    else next('router');
  };
}

/** Public (no login): the viewer page and its screen feed. */
export function createShareViewRoutes(config: ShareRoutesConfig): Router {
  const router = Router();
  router.use('/share', whenEnabled(config));

  router.get('/share/:token', (req, res) => {
    privateHeaders(res);
    const valid = Boolean(config.store.get(req.params.token));
    const nonce = randomBytes(16).toString('base64');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
    );
    res.setHeader('X-Frame-Options', 'DENY');
    res
      .status(valid ? 200 : 404)
      .type('html')
      .send(viewerPage(viewerLocale(req.headers['accept-language']), nonce, valid));
  });

  router.get('/share/:token/screen', async (req, res) => {
    privateHeaders(res);
    const record = config.store.get(req.params.token);
    if (!record) {
      res.status(404).json({ error: 'Link expired or revoked' });
      return;
    }
    const screen = await config.readScreen(record.sessionId).catch(() => null);
    res.json({ expiresAt: record.expiresAt, ...(screen ?? { ended: true }) });
  });

  return router;
}

/** Under /api (logged in): create, list and revoke a session's links. */
export function createShareApiRoutes(config: ShareRoutesConfig): Router {
  const router = Router();

  const refuseWhenOff = (_req: Request, res: Response, next: NextFunction) => {
    if (config.isEnabled()) {
      next();
      return;
    }
    res.status(403).json({
      error: 'Share links are turned off on this server (shareLinks)',
      code: 'disabled',
    });
  };
  router.use(['/sessions/:sessionId/shares', '/shares'], refuseWhenOff);

  router.post('/sessions/:sessionId/shares', (req, res) => {
    const { sessionId } = req.params;
    if (!config.sessionExists(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const minutes = Number(req.body?.minutes ?? SHARE_DURATIONS_MIN[1]);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      res.status(400).json({ error: 'Invalid duration' });
      return;
    }
    res.status(201).json({ share: shareItem(config.store.create(sessionId, minutes)) });
  });

  router.get('/sessions/:sessionId/shares', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ shares: config.store.listFor(req.params.sessionId).map(shareItem) });
  });

  router.delete('/shares/:token', (req, res) => {
    const revoked = config.store.revoke(req.params.token);
    res.status(revoked ? 200 : 404).json({ revoked });
  });

  return router;
}
