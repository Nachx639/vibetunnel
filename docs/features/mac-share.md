# Share with phone (macOS)

An idle Claude Code running in a plain Terminal or iTerm2 tab (not in tmux, not under `vt`) can be moved under VibeTunnel without leaving its tab. "Share with phone" closes it there with one SIGTERM and types into that same tab the line that reopens the same conversation through `vt`. It then runs in the tab and in VibeTunnel, with full control in both.

It is part of "On this computer" ([mac-sessions.md](mac-sessions.md)) and is **off unless turned on**. It only works on macOS, with "On this computer" on, with a login (never under `--no-auth`), and never on an HQ server.

## Turning it on

| How | Effect |
|---|---|
| `~/.vibetunnel/config.json`: `"macShare": true` | On (missing means off). |
| Settings → "Share Mac terminals with the phone" (shown under "On this computer" while that is on, on macOS) | Saves `macShare` in `config.json`. |
| `--mac-share` | On, whatever Settings says. |
| `--no-mac-share` | Off, whatever Settings says (wins over `--mac-share`). |
| `VIBETUNNEL_MAC_SHARE=0` or `=1` | Off or on, whatever Settings says (`true`/`false`, `on`/`off`, `yes`/`no` work too). |

The order is: command line, then environment, then `config.json`, then the default (off). While an override is in force, Settings shows the switch locked and names it.

Turning it on from Settings needs the same login that already lets that browser open a shell on this computer, so it gives a logged-in user nothing they couldn't already do. Turning it on still asks macOS for permission (below) the first time a tab is probed.

## Other settings

| Setting | Where | Default | What it does |
|---|---|---|---|
| `macShareLauncher` | `config.json`; Settings, "Reopen with" | `"vt"` | `"vt"` types `vt claude …`. `"shell"` reloads the tab's startup file (`~/.zshrc`, `~/.bashrc` or fish's `config.fish`) and types `claude …`, for a shell function that already starts Claude through `vt`. |
| `macShareVtPath` | `config.json` only | none | An absolute path to type instead of the bare `vt`. A relative path is ignored. |
| `macShareAutoTrust` | `config.json` only | `false` | When `true`, the reopened Claude's trust dialog is confirmed, but only when it asks about the very folder the conversation was already running in. Otherwise every dialog is left for you to answer in VibeTunnel. |
| `macShareStartTimeoutSec` | `config.json` only | `30` | How long the reopened agent may take to appear (5–300 seconds). |

The Mac app rewrites `config.json` from its own settings; these keys survive that only with the
config-preserving change of the Mac app (see the PR that keeps unknown keys).

## What happens after you confirm

1. **Checks, before anything changes.** Claude says it is idle (its own session file) and has been for 3 seconds; its transcript ends in a whole line and is still; no Bash command it started is still running; it is the foreground job of a zsh, bash or fish prompt on its tab; and, when the screen is unlocked, that exact tab answers a read-only AppleScript probe within 5 seconds, with no unsent text in Claude's prompt. Any failure: "Nothing was changed."
2. **Close.** One SIGTERM to that process (pid and start time checked again right before). Never SIGKILL, never a process group, never a second signal: if it hasn't exited in 10 seconds, nothing else is done.
3. **Reopen.** Once the shell has the prompt back, the line `cd <folder> && vt claude --resume <id> <options>` is typed into the same tab. If the Mac locked meanwhile and nothing was typed yet, it reopens in a new window instead (below).
4. **Hand over.** When the new `vt` session appears, VibeTunnel opens it.

If something fails after the close, the conversation is saved, and the sheet shows the exact command to run in that tab.

**Options carried over.** `ps` shows a process's arguments joined by spaces, so only options whose values are a single plain word are carried (`--model`, `--permission-mode`, `--dangerously-skip-permissions`…). Free-text options, modes, unknown options and the message it was started with are not; the confirm sheet lists them. The command shown in the sheet is exactly what is typed.

**Which `claude`.** The line names the agent as the process was started: a bare `claude` is typed bare (your shell resolves it, as it did), an absolute path still there is typed as is. VibeTunnel never looks agents up itself and never runs an agent binary.

## Permissions

macOS asks once whether VibeTunnel (the app that started the server) may control Terminal or iTerm2; the sheet explains this before the first probe. To change your answer: System Settings → Privacy & Security → Automation.

## Locked screen

While the Mac is locked, every Apple Event to Terminal or iTerm2 hangs without an answer. The screen lock is read (`ioreg`) before every AppleScript call, every `osascript` is killed after 5 seconds, and any still running when the server stops is killed too. A locked Mac doesn't refuse the share: Claude is closed the same way and reopens in a new Terminal window through LaunchServices (`/usr/bin/open -a Terminal <file>.command`, minimal environment). The file lives in a private temporary folder (0700), deletes itself as its first line, and the server also removes it after 5 minutes. The old tab is neither read nor typed into. Since the tab can't be read, unsent text in Claude's prompt can't be checked: the confirm sheet warns that it would be lost.

## Safety

- **AppleScript.** The scripts are fixed text in `terminal-scripts.ts`. Every value (window and tab ids, the line to type) is passed as an `osascript` argument and read as `item N of argv`; nothing from a client or from the agent is ever spliced into script text. `osascript` runs with `execFile` (no shell).
- **What is typed.** The relaunch line is built by `relaunch-command.ts` with quoting for the tab's shell (zsh, bash, fish); a value that can't be quoted safely (a newline, a control character) refuses the share.
- **What is closed.** Only an idle Claude Code that "On this computer" lists, in a Terminal or iTerm2 tab, found again in the same tab right before the close. The one signal is SIGTERM to that verified pid.
- **Two steps.** The phone first asks for a plan (`POST /api/mac-sessions/:id/share/plan`): everything is checked and nothing is changed. Only the plan's single-use token, sent after the confirm sheet, starts the share (`POST /api/mac-sessions/:id/share`). A token is single-use, bound to that agent and that plan, and expires after 120 seconds; if anything changed meanwhile, the share is refused.
- **Login.** The routes sit behind the normal login, like the rest of `/api`, and the feature is off under `--no-auth`.

## Not supported yet

Codex, agents in other apps, tmux panes (open those from "On this computer" instead), and subagents running in the background inside Claude (they stop when it closes; the confirm sheet says so).

## API

| Route | What it does |
|---|---|
| `POST /api/mac-sessions/:id/share/plan` `{allowPrompt?}` | Checks everything, changes nothing; answers the plan with its token. |
| `POST /api/mac-sessions/:id/share` `{token}` | 202 `{jobId}`: starts the share. |
| `GET /api/mac-sessions/share/:jobId` | Where the share is (polled every second). |

Errors: `{ "error": "<code>" }` with the codes in `web/src/shared/mac-share.ts`; 503 `disabled` while the feature is off.
