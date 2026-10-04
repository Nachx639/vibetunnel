import { Router } from 'express';
import type { PreviewItem } from '../../shared/types.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import type { PreviewOpenRequest, PreviewOpenResponse } from '../pty/socket-protocol.js';
import {
  createPreviewCandidateFinder,
  type PreviewCandidateOptions,
} from '../services/preview-candidates.js';
import type { PreviewHealthMonitor } from '../services/preview-health.js';
import type { PreviewProxy } from '../services/preview-proxy.js';
import {
  normalizeOrigin,
  PREVIEW_LOGIN_PATH,
  previewPortError,
  sanitizePreviewMessages,
} from '../services/preview-proxy.js';
import {
  isPreviewId,
  type PreviewRecord,
  type PreviewRegistry,
  parseOpenTarget,
} from '../services/preview-registry.js';

interface PreviewRoutesConfig {
  previewProxy: PreviewProxy;
  previewRegistry: PreviewRegistry;
  getOwnPort: () => number | null | undefined;
  /** The preview listener's port, null when previews are off (or it failed to listen). */
  getPreviewPort: () => number | null;
  /** Public preview origin when it isn't "same host, preview port" (VIBETUNNEL_PREVIEW_ORIGIN). */
  previewOrigin?: string | null;
  sessionExists: (sessionId: string) => boolean;
  /** The session still runs ("from: <session>" is a link to it only then). */
  sessionRunning?: (sessionId: string) => boolean;
  sessionName?: (sessionId: string) => string | undefined;
  health?: PreviewHealthMonitor;
  /**
   * Finds out whether a port is another VibeTunnel server; if so, portError refuses it from
   * then on. Run before a port is opened or added.
   */
  identifyPort?: (port: number) => Promise<void>;
  /** lsof and the HTTP probe of GET /previews/candidates, replaced in tests. */
  candidates?: Pick<PreviewCandidateOptions, 'listListeners' | 'probe' | 'now'>;
  /** config.json `previewIgnoreProcesses`: process names "+ Add preview" never offers. */
  ignoredProcesses?: () => ReadonlySet<string>;
}

/** A registry entry as the app shows it: live/down, and its session's current name. */
export function toPreviewItem(
  entry: PreviewRecord,
  registry: PreviewRegistry,
  isRunning: (sessionId: string) => boolean,
  nameOf: (sessionId: string) => string | undefined
): PreviewItem {
  const state = registry.stateOf(entry.port);
  const alive = entry.sessionId ? isRunning(entry.sessionId) : false;
  const sessionName = (entry.sessionId && alive && nameOf(entry.sessionId)) || entry.sessionName;
  return {
    ...entry,
    ...(sessionName ? { sessionName } : {}),
    ...(entry.sessionId ? { sessionAlive: alive } : {}),
    ...(state ? { state } : {}),
  };
}

/** Every preview, the most recently opened first (pinned or not: the app groups them). */
export function listPreviewItems(
  registry: PreviewRegistry,
  isRunning: (sessionId: string) => boolean,
  nameOf: (sessionId: string) => string | undefined
): PreviewItem[] {
  return registry.all().map((entry) => toPreviewItem(entry, registry, isRunning, nameOf));
}

/**
 * `vt preview <port|url>` from inside a session (over api.sock): saves or bumps the preview
 * of that port and emits 'open' (screens showing the session switch to it).
 */
export function createVtOpenHandler(options: {
  registry: PreviewRegistry;
  sessionExists: (sessionId: string) => boolean;
  /** Range, VibeTunnel's own ports and denied ports. */
  portError: (port: number) => string | null;
}) {
  return ({ sessionId, target }: PreviewOpenRequest): PreviewOpenResponse => {
    const parsed = typeof target === 'string' ? parseOpenTarget(target) : null;
    if (!parsed) return { success: false, error: 'expected a port or a localhost URL' };
    if (typeof sessionId !== 'string' || !options.sessionExists(sessionId)) {
      return { success: false, error: 'unknown session' };
    }
    const error = options.portError(parsed.port);
    if (error) return { success: false, error };
    const event = options.registry.open(sessionId, parsed.port, parsed.path);
    return { success: true, id: event.id, port: event.port, path: event.path };
  };
}

/** Mounted under /api, behind the normal auth middleware. */
export function createPreviewRoutes(config: PreviewRoutesConfig): Router {
  const router = Router();
  const registry = config.previewRegistry;
  const running = (sessionId: string) => (config.sessionRunning ?? config.sessionExists)(sessionId);
  const item = (entry: PreviewRecord) =>
    toPreviewItem(entry, registry, running, (id) => config.sessionName?.(id));
  /** Range, VibeTunnel's own ports (main + preview) and VIBETUNNEL_PREVIEW_DENY_PORTS. */
  const portError = (port: number) =>
    previewPortError(port, [config.getOwnPort(), config.getPreviewPort()]) ??
    config.previewProxy.portError?.(port) ??
    null;
  const checkNow = async (port: number): Promise<'live' | 'down'> =>
    (config.health ? await config.health.check(port) : true) ? 'live' : 'down';
  /** Web servers on this computer that portError allows and that aren't saved yet. */
  const findCandidates = createPreviewCandidateFinder({
    ...config.candidates,
    portError,
    ignoredProcesses: config.ignoredProcesses,
    savedPorts: () => registry.ports(),
    onVibeTunnelPort: (port) => config.previewProxy.noteVibeTunnelPort?.(port),
  });

  // Where previews live: same host, another port (a separate origin, see preview-proxy.ts).
  router.get('/preview/config', (_req, res) => {
    const port = config.getPreviewPort();
    res.json({ enabled: port !== null, port, origin: config.previewOrigin ?? null });
  });

  // The preview origin has its own auth: a 60 s single-use ticket for one port, redeemed by
  // the iframe at <preview origin>/__vt_preview_login. Only the origin that asked may frame it.
  // `{ id }` names a registered preview (its session may be long gone); `{ port }` any
  // allowed loopback port. `messages` are the frame's texts in the app's language.
  router.post('/preview/ticket', async (req: AuthenticatedRequest, res) => {
    if (config.getPreviewPort() === null) {
      res.status(503).json({ error: 'Previews are disabled' });
      return;
    }
    let port = Number(req.body?.port);
    if (req.body?.id !== undefined) {
      const entry = isPreviewId(req.body.id) ? registry.get(req.body.id) : undefined;
      if (!entry) {
        res.status(404).json({ error: 'Preview not found' });
        return;
      }
      port = entry.port;
    }
    if (!portError(port)) await config.identifyPort?.(port);
    const error = portError(port);
    if (error) {
      res.status(403).json({ error: `Preview not allowed: ${error}` });
      return;
    }
    // Browsers always send Origin on POST; it can't be set by page scripts.
    const parentOrigin = normalizeOrigin(req.headers.origin);
    if (!parentOrigin) {
      res.status(400).json({ error: 'Origin header required' });
      return;
    }
    const rawPath = typeof req.body?.path === 'string' ? req.body.path : '/';
    const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    const ticket = config.previewProxy.issueTicket(
      port,
      parentOrigin,
      sanitizePreviewMessages(req.body?.messages)
    );
    const next = `/preview/${port}${path}`;
    const query = new URLSearchParams({ ticket, next });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ loginPath: `${PREVIEW_LOGIN_PATH}?${query.toString()}`, expiresIn: 60 });
  });

  // "Previews" (phone list, sidebar): every persistent preview.
  router.get('/previews', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ previews: listPreviewItems(registry, running, (id) => config.sessionName?.(id)) });
  });

  // The "+ Add preview" sheet: one tap per web server listening on this computer.
  router.get('/previews/candidates', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ candidates: await findCandidates() });
  });

  // "+ Add preview": { port } or { url: "localhost:3000/about" }, no session needed.
  router.post('/previews', async (req, res) => {
    const body = req.body ?? {};
    const raw = body.url ?? body.target ?? body.port;
    const target =
      typeof raw === 'number'
        ? { port: raw, path: '/' }
        : typeof raw === 'string'
          ? parseOpenTarget(raw)
          : null;
    if (!target) {
      res.status(400).json({ error: 'Expected a port or a localhost URL' });
      return;
    }
    if (!portError(target.port)) await config.identifyPort?.(target.port);
    const error = portError(target.port);
    if (error) {
      res.status(403).json({ error: `Preview not allowed: ${error}` });
      return;
    }
    const entry = registry.addManual(target.port, target.path);
    await checkNow(entry.port);
    const stored = registry.get(entry.id);
    res.status(201).json({ preview: item(stored ?? entry) });
  });

  // Pin/unpin, rename ({ customName: "" } goes back to the page title).
  router.patch('/previews/:id', (req, res) => {
    const body = req.body ?? {};
    const patch: { pinned?: boolean; customName?: string | null } = {};
    if (body.pinned !== undefined) {
      if (typeof body.pinned !== 'boolean') {
        res.status(400).json({ error: 'pinned must be true or false' });
        return;
      }
      patch.pinned = body.pinned;
    }
    if (body.customName !== undefined) {
      if (body.customName !== null && typeof body.customName !== 'string') {
        res.status(400).json({ error: 'customName must be text' });
        return;
      }
      if (typeof body.customName === 'string' && body.customName.length > 200) {
        res.status(400).json({ error: 'customName is too long' });
        return;
      }
      patch.customName = body.customName;
    }
    if (patch.pinned === undefined && patch.customName === undefined) {
      res.status(400).json({ error: 'Nothing to change' });
      return;
    }
    const entry = isPreviewId(req.params.id) ? registry.update(req.params.id, patch) : null;
    if (!entry) {
      res.status(404).json({ error: 'Preview not found' });
      return;
    }
    res.json({ preview: item(entry) });
  });

  // Delete: forget the preview (the dev server keeps running).
  router.delete('/previews/:id', (req, res) => {
    const deleted = isPreviewId(req.params.id) && registry.dismiss(req.params.id);
    res.status(deleted ? 200 : 404).json({ deleted });
  });

  // The preview view's Retry: check the dev server now instead of waiting for the next round.
  router.post('/previews/:id/check', async (req, res) => {
    const entry = isPreviewId(req.params.id) ? registry.get(req.params.id) : undefined;
    if (!entry) {
      res.status(404).json({ error: 'Preview not found' });
      return;
    }
    res.json({ state: await checkNow(entry.port) });
  });

  router.get('/sessions/:sessionId/preview', (req, res) => {
    res.json({ ports: registry.forSession(req.params.sessionId) });
  });

  // Same as `vt preview` from inside the session: { target: "5173" | "http://localhost:5173/x" }
  router.post('/sessions/:sessionId/preview/open', async (req, res) => {
    const { sessionId } = req.params;
    if (!config.sessionExists(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const target = parseOpenTarget(String(req.body?.target ?? ''));
    if (!target) {
      res.status(400).json({ error: 'Expected a port or a localhost URL' });
      return;
    }
    if (!portError(target.port)) await config.identifyPort?.(target.port);
    const error = portError(target.port);
    if (error) {
      res.status(403).json({ error: `Preview not allowed: ${error}` });
      return;
    }
    res.json(registry.open(sessionId, target.port, target.path));
  });

  return router;
}

/**
 * Previews off (no `--preview-port`): only the app's "are previews on?" question is answered,
 * so it hides every preview control. Nothing else under /api/preview(s) exists.
 */
export function createPreviewDisabledRoutes(): Router {
  const router = Router();
  router.get('/preview/config', (_req, res) => {
    res.json({ enabled: false, port: null, origin: null });
  });
  return router;
}
