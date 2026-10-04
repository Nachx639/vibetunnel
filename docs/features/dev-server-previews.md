# Dev-Server Previews

See the web app a session is building (vite, next, any `localhost:<port>` dev server) inside
VibeTunnel, from a phone or another computer, with hot reload.

**Off by default.** Nothing below exists until you turn it on: no second listener, no
`previews.json`, no health checks, no scanning of session output, no extra response headers,
no preview buttons in the UI.

## Turning it on

Start the server with a preview port:

```bash
vibetunnel --preview-port 4090
# or
VIBETUNNEL_PREVIEW_PORT=4090 vibetunnel
```

Pick any free port that differs from the main one. `off`, `false`, `0` or no value keep
previews off. If the port can't be opened, VibeTunnel keeps running with previews
unavailable and logs why.

| Setting | Default | Meaning |
|---------|---------|---------|
| `--preview-port <port>` / `VIBETUNNEL_PREVIEW_PORT` | off | Port of the preview listener (a separate origin) |
| `VIBETUNNEL_PREVIEW_ORIGIN` | same host, preview port | Public URL of the preview listener when it sits behind a reverse proxy (`https://preview.example.com`) |
| `VIBETUNNEL_PREVIEW_DENY_PORTS` | none | Comma-separated loopback ports that are never previewed (`6006,9229`) |
| `previewIgnoreProcesses` in `~/.vibetunnel/config.json` | none | Process names (as `lsof` shows them) that "+ Add preview" never offers, e.g. `["tunneld"]` |

Reaching it from a phone: the preview port must be reachable the same way the main port is
(same bind address). Behind a reverse proxy that serves one hostname (Tailscale Serve, ngrok),
expose the preview port as its own HTTPS endpoint and set `VIBETUNNEL_PREVIEW_ORIGIN` to it.
Without `VIBETUNNEL_PREVIEW_ORIGIN`, the app hides every preview control, with one line in
the session list saying why, when the page didn't reach this server directly: the request
carries forwarding headers (`X-Forwarded-*`, `Forwarded`, `X-Real-IP`), came in on another
port than the main one (a Docker port mapping, an HTTPS front end), or names a host that isn't
the bind address, `localhost`, an address of this machine or its name.

## Using it

- Inside a session: `vt preview 5173` or `vt preview localhost:3000/settings`. Screens showing
  that session switch to the preview.
- A dev server that prints its URL (`➜  Local:   http://localhost:5173/`) gets a **Preview**
  chip on its session automatically.
- The compact phone list shows a **Previews** section; **+ Add preview** lists the web
  servers listening on the computer (macOS, via `lsof`) or takes a port or localhost URL.
- Each preview has its own page at `/preview/<id>` with an address bar, back/forward,
  reload, "Open in browser", and "show beside the session" (split view).

Previews are kept in `previews.json` next to the control directory (one entry per port), so
they survive session and server restarts. Unpinned previews whose dev server has been down
for more than 7 days are removed.

`vt open …` is unchanged: outside a session it still runs `open …` in a new session.

## How it is isolated

- The previewed app runs on the **preview origin** (the second listener), never on
  VibeTunnel's own origin, so its JavaScript and npm dependencies can't read VibeTunnel's
  token or call `/api` with it.
- The authenticated main API issues a 60-second single-use ticket for one port
  (`POST /api/preview/ticket`); the frame redeems it at `/__vt_preview_login` on the preview
  origin for an `HttpOnly`, `SameSite=Strict` cookie scoped to `/preview/<port>/`. That cookie
  means nothing to the main API, and main-origin credentials mean nothing to the preview
  listener.
- The proxy connects only to `127.0.0.1` / `::1`, on ports 1024-65535 that are not
  VibeTunnel's own, not denied, and not another VibeTunnel server. It never follows redirects
  and always sends `Host: localhost:<port>`.
- VibeTunnel credentials, cookies and Tailscale identity headers are never forwarded to the
  dev server. Frame-blocking headers are removed only from proxied responses and replaced by
  `frame-ancestors <the VibeTunnel origin that asked>`.
- While previews are on, the main origin refuses browser requests to `/api` that come from
  the preview origin, from an opaque (`null`) origin or cross-site, and every response carries
  `X-VibeTunnel-Server: 1` so one VibeTunnel never previews another.

## API

All under `/api`, behind the normal authentication.

| Route | Purpose |
|-------|---------|
| `GET /preview/config` | `{ enabled, port, origin }`; the only route when previews are off |
| `POST /preview/ticket` | `{ id }` or `{ port }`, plus `path` → a login URL for the frame |
| `GET /previews` | Every saved preview |
| `GET /previews/candidates` | Web servers listening on this computer, not saved yet |
| `POST /previews` | Add `{ port }` or `{ url: "localhost:3000/x" }` |
| `PATCH /previews/:id` | `{ pinned }`, `{ customName }` |
| `DELETE /previews/:id` | Forget it (the dev server keeps running) |
| `POST /previews/:id/check` | Check the dev server now |
| `POST /sessions/:id/preview/open` | Same as `vt preview` from that session |
