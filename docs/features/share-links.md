# Read-only share links

A share link lets someone watch one session's screen live, in a browser, without a VibeTunnel login and without any way to type into it. Links expire on their own (15 minutes, 1 hour or 8 hours from the app; the server never accepts more than 24 hours) and can be revoked at any time.

## Turning it on

Share links are **off** by default. While they are off, `/share/<token>` is not served (the normal 404), the share API answers `403`, and the session menus don't offer "Share (read-only)".

Either of these turns them on:

- `~/.vibetunnel/config.json`: `"shareLinks": true` (read on every request, so no restart is needed; remove the key or set `false` to turn it off again)
- the server flag `--share-links`

The setting can't be changed through `PUT /api/config`. Links created while the feature was on stay in `shares.json` until they expire; turning the feature off makes them stop working at once, and turning it back on revives the ones that haven't expired yet.

## Using it

Open a running session, then the session menu (the status menu on desktop, the "⋯" menu on narrow screens) and choose **Share (read-only)**. The sheet lists the session's live links with their time left; each can be copied, sent with the system share sheet, or revoked. A session has at most 10 live links; creating an eleventh drops the oldest.

The link is `<the address you opened VibeTunnel with>/share/<token>`. **Anyone who has the link and can reach that address can watch until it expires.** On a server that is only reachable from your own network or VPN, so is the link; on a server exposed to the internet (ngrok, Cloudflare tunnel, Tailscale Funnel, a public IP), the link works from anywhere.

## What the viewer gets

- `GET /share/<token>`: a small standalone page (not the web app), in the visitor's browser language when VibeTunnel has it (the same 8 languages as the app), with a strict Content-Security-Policy (`default-src 'none'`, one nonce'd script, `frame-ancestors 'none'`), `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `noindex`.
- `GET /share/<token>/screen`: the session's current screen as plain text (shown with `textContent`, never as HTML), its title, its column count and whether it is still running. The page polls it every 1.5 s while visible.

Nothing else: no input, resize, kill, file access, other sessions or any `/api` route. A share token is not a login credential; the API refuses it. Unknown, malformed, expired and revoked tokens get a 404.

## Storage

Links live in memory and in `shares.json` next to the control directory (`~/.vibetunnel/shares.json` for the default `~/.vibetunnel/control`), written with mode `0600`. The file only ever holds links that haven't expired. Tokens are 24 random bytes (192 bits) from the operating system's CSPRNG, base64url-encoded.

## With `--no-auth`

With `--no-auth` the whole server, including the full terminal, is already open to anyone who can reach it, so share links add no exposure; they still only show one session, read-only.

## API (behind the normal login)

| Method | Path | Body / answer |
|---|---|---|
| `POST` | `/api/sessions/:sessionId/shares` | `{ "minutes": 15 }` → `201 { share: { token, path, createdAt, expiresAt } }`; 404 for an unknown session, 400 for a bad duration |
| `GET` | `/api/sessions/:sessionId/shares` | `{ shares: [...] }`, newest first |
| `DELETE` | `/api/shares/:token` | `{ revoked: true \| false }` (404 when there was no such link) |

All three answer `403 { code: "disabled" }` while share links are off. `GET /api/config` reports the switch as `shareLinks: true | false`.
