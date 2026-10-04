/**
 * Dev-server previews as one unit the server creates only when they are turned on
 * (`--preview-port <n>` or VIBETUNNEL_PREVIEW_PORT). Off, none of this exists: no second
 * listener, no previews.json, no health checks, no output scanning, no extra headers.
 */
import type * as http from 'node:http';
import { isVibeTunnelServer, PreviewHealthMonitor } from './preview-health.js';
import {
  createPreviewProxy,
  normalizeOrigin,
  type PreviewProxy,
  parseDeniedPorts,
  previewPortError,
} from './preview-proxy.js';
import { PreviewRegistry, previewsFileFor } from './preview-registry.js';
import { createPreviewServer, resolvePreviewPort } from './preview-server.js';

/** True when `--preview-port` / VIBETUNNEL_PREVIEW_PORT ask for previews (a port, not "off"). */
export function previewsRequested(
  flag: string | null | undefined,
  env: string | undefined
): boolean {
  // 0 can't be a main port, so the "same as the main port" check never fires here.
  const resolved = resolvePreviewPort(flag, env, 0);
  return resolved.port !== null || Boolean(resolved.error);
}

export interface PreviewFeatureOptions {
  controlDir: string;
  /** The main listener's port (VibeTunnel's own: never previewable). */
  getMainPort: () => number | null | undefined;
  /** True when an Authorization value is a VibeTunnel credential (never forwarded). */
  isVibeTunnelAuthorization: (value: string) => boolean;
  env?: NodeJS.ProcessEnv;
}

export interface PreviewFeature {
  registry: PreviewRegistry;
  proxy: PreviewProxy;
  health: PreviewHealthMonitor;
  server: http.Server;
  /** Public preview origin when it isn't "same host, preview port" (VIBETUNNEL_PREVIEW_ORIGIN). */
  publicOrigin: string | null;
  /** The preview listener's port once it listens, else null. */
  listenPort: () => number | null;
  /** Range, VibeTunnel's own ports, denied ports and other VibeTunnel servers. */
  portError: (port: number) => string | null;
  /** Asks the port whether it is a VibeTunnel server; then portError refuses it. */
  identifyPort: (port: number) => Promise<void>;
  /**
   * Starts the preview listener next to the main one (same bind address). A failure leaves
   * VibeTunnel running with previews unavailable. Resolves with the port, or null.
   */
  listen: (
    flag: string | null | undefined,
    mainPort: number,
    bindAddress: string
  ) => Promise<{ port: number | null; error?: string }>;
  /** Stops the health checks, writes pending changes and closes the listener. */
  close: () => void;
}

export function createPreviewFeature(options: PreviewFeatureOptions): PreviewFeature {
  const env = options.env ?? process.env;
  const file = previewsFileFor(options.controlDir);
  const registry = new PreviewRegistry({ file });
  registry.load();
  let listenPort: number | null = null;
  const proxy = createPreviewProxy({
    getOwnPorts: () => [options.getMainPort(), listenPort],
    isVibeTunnelAuthorization: options.isVibeTunnelAuthorization,
    deniedPorts: parseDeniedPorts(env.VIBETUNNEL_PREVIEW_DENY_PORTS),
    // Another VibeTunnel answered through the proxy: its row goes too.
    onVibeTunnelPort: () => registry.removeRefused(),
  });
  const portError = (port: number) =>
    previewPortError(port, [options.getMainPort(), listenPort]) ?? proxy.portError(port);
  // VibeTunnel's own ports, VIBETUNNEL_PREVIEW_DENY_PORTS and other VibeTunnel servers are
  // never previews, however they're announced.
  registry.setPortFilter((port) => proxy.portError(port));
  const identifyPort = async (port: number) => {
    if (proxy.portError(port)) return;
    if (await isVibeTunnelServer(port)) proxy.noteVibeTunnelPort(port);
  };
  registry.setNewPortVetter(async (port) => {
    await identifyPort(port);
    return !proxy.portError(port);
  });
  const health = new PreviewHealthMonitor({
    registry,
    onVibeTunnel: (port) => proxy.noteVibeTunnelPort(port),
  });
  health.start();
  const server = createPreviewServer(proxy);

  const listen: PreviewFeature['listen'] = (flag, mainPort, bindAddress) => {
    registry.removeRefused();
    const resolved = resolvePreviewPort(flag, env.VIBETUNNEL_PREVIEW_PORT, mainPort);
    if (resolved.port === null) return Promise.resolve(resolved);
    const requested = resolved.port;
    return new Promise((resolve) => {
      const onError = (error: NodeJS.ErrnoException) => {
        listenPort = null;
        resolve({
          port: null,
          error: `cannot listen on ${bindAddress}:${requested} (${error.code ?? error.message})`,
        });
      };
      server.once('error', onError);
      server.listen(requested, bindAddress, () => {
        server.off('error', onError);
        const address = server.address();
        listenPort = address && typeof address === 'object' ? address.port : requested;
        registry.removeRefused();
        resolve({ port: listenPort });
      });
    });
  };

  return {
    registry,
    proxy,
    health,
    server,
    publicOrigin: normalizeOrigin(env.VIBETUNNEL_PREVIEW_ORIGIN),
    listenPort: () => listenPort,
    portError,
    identifyPort,
    listen,
    close: () => {
      health.stop();
      registry.flush();
      server.close();
      server.closeAllConnections?.();
    },
  };
}
