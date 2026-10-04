# Sessions on this computer ("On this Mac")

Off by default. When it is on, the phone's session list has a section for what runs on the
computer outside VibeTunnel. On macOS it is called **On this Mac**; elsewhere, **On this
computer**. It lists two kinds of thing:

- **tmux sessions** on your own tmux servers: one row per tmux session, with the agents running
  in its panes, its folder, its window count and the other terminals attached to it.
- **Agents outside VibeTunnel and outside those tmux sessions**: Claude Code, Codex and Gemini
  running in a Terminal tab, iTerm2, an IDE's terminal, over SSH, and so on. Each row names the
  app it runs in.

Rows are ordered by state (waiting for you, working, idle, then tmux sessions without an agent)
and, within a state, newest first. At most 100 rows are listed. The section shows in the
compact phone list (Settings → phone layout) and in the sidebar opened from a session.

## Turning it on

Any of:

- Settings → "Show sessions from this Mac" (or "…from this computer"), which writes
  `"macSessions": true` to `~/.vibetunnel/config.json` through `PUT /api/config`;
- `~/.vibetunnel/config.json`: `"macSessions": true`;
- the server's command line: `--mac-sessions`;
- the server's environment: `VIBETUNNEL_MAC_SESSIONS=1`.

`--no-mac-sessions` and `VIBETUNNEL_MAC_SESSIONS=0` turn it off whatever config.json says. The
order is: command line (`--no-mac-sessions` wins over `--mac-sessions`), then environment, then
`config.json`, then the default (off). While an override is in force, Settings shows the switch
locked and names it; a change made there is still saved and applies once the override is gone.

While it is off nothing is scanned: no `ps` or `lsof` for this section, no tmux socket is read,
`GET /api/mac-sessions` answers `{ "enabled": false, "reason": "disabled", "items": [] }`, and the
phone asks once and then stops asking until Settings is saved or the page is loaded again.

## What a tap does

**On a tmux session**, VibeTunnel opens it: a new VibeTunnel session runs a tmux client attached
to that tmux session, so the session view, the chat view, the composer, quick answers and pushes
all work on it, exactly as for a session started in VibeTunnel. If a VibeTunnel session is
already attached to that tmux session, that one opens instead.

It opens in one of two modes (Settings → "Opening a tmux session"):

- **Ready to type** (`control`, the default): what you type on the phone reaches the tmux
  session.
- **Watch only** (`watch`): a read-only tmux client. tmux itself drops what you type; the
  session view shows a "Watching" banner with "Take control", hides the composer, the quick
  keys and the action bar, and the server refuses quick answers and replies (409 `read-only`).

The client always attaches with tmux's `ignore-size` flag. While a terminal on the computer is
attached to the same tmux session, the window keeps that terminal's size and the phone shows a
cropped view that follows the cursor. When nothing else is attached, the window takes the
phone's size. "Fit to this screen" (control only, in the session menu) makes the window follow
whichever client was used last; your other terminals then resize too.

Closing the VibeTunnel session **disconnects**: VibeTunnel's tmux client detaches and the tmux
session keeps running.

**On an agent**, VibeTunnel shows its live status and opens its conversation read-only, followed
live from its transcript. Nothing is attached and nothing is typed into it: only the app it runs
in can type into it. To control an agent from the phone, start it inside tmux, or with `vt`
(then it is a VibeTunnel session).

## Requirements and platforms

- **macOS and Linux.** Elsewhere (and on an HQ server, which has no sessions of its own) the
  section is not offered and Settings hides the switch.
- **tmux 3.2 or newer** to open a tmux session (it brought `attach-session -f`, the
  `ignore-size` client flag and `-N`). Older tmux servers are listed but can't be opened.
  Without tmux, only agents are listed.
- **No macOS permission prompt.** The list only uses `ps`, `lsof` (`/proc` on Linux), the tmux
  command line on your own sockets, and files in your Claude Code, Codex and Gemini folders.

## Settings

| Setting | Where | Default | What it does |
|---|---|---|---|
| `macSessions` | `config.json`; Settings switch | `false` | Lists sessions on this computer and serves their API. |
| `macSessionsOpenMode` | `config.json`; Settings, "Opening a tmux session" | `"control"` | What a tap on a tmux session opens: `"control"` or `"watch"`. |
| `macSessionsIncludeHeadless` | `config.json` only | `false` | Also lists agents without a terminal, and Claude Code processes not started from its CLI (SDK clients), read-only. |
| `macSessionsHideIn` | `config.json` only | none | Absolute folders (`~` allowed) whose tmux sessions and agents are not listed, below them included. |

"Share with phone" (macOS, off by default) has its own settings: see [mac-share.md](mac-share.md).

The Mac app rewrites `config.json` from its own settings; these keys survive that only with the
config-preserving change of the Mac app (see the PR that keeps unknown keys).

### Command line and environment

| Override | Effect |
|---|---|
| `--mac-sessions` | On, whatever Settings says. |
| `--no-mac-sessions` | Off, whatever Settings says (wins over `--mac-sessions`). |
| `VIBETUNNEL_MAC_SESSIONS=0` or `=1` | Off or on (`true`/`false`, `on`/`off`, `yes`/`no` work too). |
| `VIBETUNNEL_MAC_SESSIONS_ONLY_IN=/a,/b` | Lists only what runs in one of these folders (or below), even when hidden. |
| `VIBETUNNEL_MAC_SESSIONS_HIDE_IN=/a,/b` | Adds these folders to `macSessionsHideIn`. |
| `VIBETUNNEL_TMUX_BIN` | The tmux binary to use. |
| `TMUX_TMPDIR` | Where tmux keeps its sockets (`<dir>/tmux-<uid>/`), as tmux itself reads it. |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME` | The agents' folders. |

An item's folder is its tmux session's current pane folder, or the agent's working folder.
Folders are compared with links resolved (`/tmp/x` and `/private/tmp/x` are the same) and whole
names only: hiding `/a/b` doesn't hide `/a/bc`.

## What is never listed

- Sessions VibeTunnel runs itself, including the tmux servers of shielded sessions, of this
  instance or another (sockets named `.shield-tmux` or `-L vibetunnel-<hash>`; tmux sessions
  named `vt-<id>`).
- Agents running inside another VibeTunnel instance's sessions (their environment has
  `VIBETUNNEL_SESSION_ID`; only the presence of that name is checked).
- Agents without a terminal, unless `macSessionsIncludeHeadless` is set.
- Processes of other users, plain terminal tabs without an agent or tmux, and zellij or GNU
  screen sessions.

## Safety

- **Same login as the rest of the API.** There is no bypass; `--no-auth` works as it does
  everywhere else.
- **Clients only send ids the server made**, such as `t-<server pid>-<server start>-<N>`. The
  socket, pid or tmux target an id names is looked up on the server, in its latest scan; a
  request never names a socket, a path or a process.
- **On your tmux servers VibeTunnel only reads**, and only changes its own tmux client. Every
  tmux command runs without a shell as `tmux -u -N -S <socket> …` (`-N` never starts a server
  that is gone), with an environment without `TMUX`. It may run `list-panes`, `list-clients`
  and `has-session`, and, on its own client only (found again by its pid right before),
  `switch-client -E -r`, `refresh-client -f ignore-size` and `detach-client`. It never runs
  `send-keys`, `kill-*`, `new-*`, `set-option`, `rename-*`, `select-*` or `resize-*`.
- **Opening is exact.** The tmux session is opened by its id (`$N`), never by name, on the
  server process the list showed: it is checked again (same socket, pid and start time) right
  before.
- **Agents outside tmux receive no input at all.** A tmux session receives input only through
  the client you opened from the phone; in watch mode not even that.
- **Conversations are read only for agents the latest scan listed**, and checked again (pid and
  start time) before each answer; an id never names a file.
- The list never carries command lines or environments; nothing reads
  `~/.claude/sessions/*.key` or environment values (beyond checking for
  `VIBETUNNEL_SESSION_ID`), and nothing logs command lines, environments or transcript text.

## Cost

The computer is scanned only while a phone shows the list, at most once every 3 seconds (a
forced refresh at most once a second), and never while the section is off. A scan reuses the
process list VibeTunnel already reads for its own sessions, plus one tmux call per tmux server.

## Known limits

- Menus and quick answers on an opened tmux session read VibeTunnel's own copy of its client's
  screen, which includes tmux's status bar and splits, and is cropped while a larger terminal is
  attached. A menu can then be missed.
- Host app names for iTerm2, Ghostty and IDEs are best effort.
- A Claude Code started with a different `CLAUDE_CONFIG_DIR` than the server's is not seen.

## API

All answers are JSON with `Cache-Control: no-store`; errors are
`{ "error": "<code>", "details"?: "…" }`. Types are in `web/src/shared/mac-sessions.ts`.

| Request | Answer | Errors |
|---|---|---|
| `GET /api/mac-sessions[?force=1]` | `MacSessionsResponse`; `enabled: false` (and a `reason`) while off | — |
| `GET /api/mac-sessions/:id/chat[?have=<fingerprint>]` | The conversation of an agent (`a-…`) or of the agent in a tmux pane (`p-…`), shaped like `GET /api/sessions/:id/claude-chat` | 400 `bad-id`, 404 `gone`, 503 `disabled` |
| `POST /api/mac-sessions/:id/open` `{mode?, cols?, rows?}` | `{sessionId, reused, mode}` | 400 `bad-id`/`bad-request`, 404 `gone`, 409 `tmux-too-old`, 422 `not-openable`, 503 `disabled`, 500 `open-failed` |
| `POST /api/mac-sessions/attached/:sessionId/mode` `{mode?, sizing?}` | `{mode, sizing}` as tmux reports it | 400 `not-attached`/`bad-request`, 409 `client-not-found`, 500 `mode-failed` |
| `GET /api/config` | `macSessions`, `macSessionsOpenMode`, `macSessionsLocked`, `macSessionsLockedBy?`, `macSessionsSupported`, `platform` | — |
| `PUT /api/config` `{macSessions?, macSessionsOpenMode?}` | Saves them | 400 when neither is valid |
