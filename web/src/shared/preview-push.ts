/**
 * "Preview ready" push: sent when `vt preview` opens a dev-server preview from a session.
 * Shared by the server (which builds it) and the service worker (which opens it on tap).
 */

export const PREVIEW_READY_PUSH_TYPE = 'preview-ready';

/** Preview ids as the registry makes them (see PREVIEW_ID_RE on the server). */
const PREVIEW_ID = /^p[a-z0-9]{6,20}$/;

export interface PreviewReadyPushData {
  type: typeof PREVIEW_READY_PUSH_TYPE;
  /** The saved preview. */
  id: string;
  /** The session `vt preview` ran in. */
  sessionId: string;
  port: number;
  path: string;
}

/**
 * Where tapping "Preview ready" goes: the preview's own view, `/preview/<id>` (+ `?path=` for
 * a page other than "/"). Null when the data isn't a preview-ready push with a valid id.
 */
export function previewReadyTapPath(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.type !== PREVIEW_READY_PUSH_TYPE || typeof d.id !== 'string' || !PREVIEW_ID.test(d.id)) {
    return null;
  }
  const base = `/preview/${d.id}`;
  const path = typeof d.path === 'string' && d.path.startsWith('/') ? d.path : '/';
  return path === '/' ? base : `${base}?path=${encodeURIComponent(path)}`;
}
