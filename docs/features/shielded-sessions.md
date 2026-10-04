# Shielded sessions

Off by default. A shielded session runs its program inside a detached tmux session on a tmux
server that only VibeTunnel uses; the session's terminal is a `tmux attach` client. When the
VibeTunnel server stops (an update, a crash, a restart) only that client ends: the program
keeps running, and the next server start attaches to it again under the same session id.

## Turning it on

- **Per session:** `POST /api/sessions` with `"shielded": true`, the 🛡 switch of the phone's
  new-session sheet (remembered per browser in `vt-phone-new-shielded`), or "Shield" in a
  running session's menu (a running process can't be moved into tmux: a new shielded session
  opens in the same folder; a Claude Code session with a known conversation continues it with
  `claude --resume` and the old session closes).
- **For every new web/phone session:** Settings > Application > "Shield new sessions", which
  writes `"shieldNewSessions": true` to `~/.vibetunnel/config.json`. Missing means off.
  Terminal-window (`spawn_terminal`) and remote (HQ) sessions are never shielded by default.

Shielding needs tmux on the server; without it the options are hidden and an explicit
`shielded: true` answers 501.

## After a reboot

The tmux server is gone after a reboot (or if tmux is killed). What happens to shielded
sessions that were still running is `shieldRestore` (Settings, or config.json):

| `shieldRestore` | Result |
|---|---|
| `off` (default, also when missing) | marked exited; nothing runs |
| `agents` | Claude Code sessions with a known conversation are recreated with `claude --resume <id>`; others are marked exited |
| `all` | as `agents`, and every other command is started again (a shell starts fresh) |

An unattended restore never carries a permission-bypass flag such as
`--dangerously-skip-permissions`. Sessions the user killed or whose program ended stay
finished. A session restored more than 3 times in an hour is given up. Restored sessions show
"Restored after a restart" (↻) for a day, and their history has a "session restored" line.

## macOS: launchd

On macOS the tmux server is started as its own launchd job in the user's GUI domain
(`sh.vibetunnel.shield-tmux.<hash of the control dir>`), so quitting the app for an update
doesn't take it along. The job's plist is written `0600` next to the socket
(`<control dir>/.shield-tmux.plist`) and holds the environment sessions get. It is unloaded and
removed when the last shielded session ends. `VIBETUNNEL_SHIELD_LAUNCHD=0` starts tmux directly
instead. Tests never use launchd.

## Details

- The tmux socket is `<control dir>/.shield-tmux` (or `-L vibetunnel-<hash>` when that path is
  too long for a unix socket): the user's own tmux server is never touched.
- tmux is configured to be invisible: no status bar, no prefix key, no mouse capture, no
  alternate screen. TERM inside is `tmux-256color`.
- Every tmux call is `execFile` with an argument array; session ids must be plain ids
  (`[A-Za-z0-9_-]`) before they name a tmux session.
- Claude's status, chat and pushes look at the program inside tmux (`programRootPid`), not at
  the tmux client.
