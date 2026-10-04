# Agent chat on phones

Off by default. When it is on, a phone in chat mode shows the agent conversation running in the
session (Claude Code or OpenAI Codex) as message bubbles, read from the agent's own files, with
a native composer under the live terminal. When it is off, chat mode works as before.

## Turning it on

Either of:

- `~/.vibetunnel/config.json`: `"agentChat": true`
- the environment of the server: `VIBETUNNEL_AGENT_CHAT=1`

`VIBETUNNEL_AGENT_CHAT=0` turns it off whatever config.json says. The switch is read on every
request, so no restart is needed; an open page notices it when chat mode is next turned on.
It cannot be changed through `PUT /api/config`. `GET /api/config` reports it as `agentChat`.

## What it reads

Only while a phone has a session open in chat mode, every 1.5 s (3 s when idle, 5 s when the
session runs no Claude Code), through `GET /api/sessions/:id/claude-chat` (behind the normal
authentication):

- the process tree under the session (`ps -A -o pid=,ppid=,lstart=,args=`, shared by
  concurrent requests for 2 s; arguments are never logged);
- `<Claude dir>/sessions/<pid>.json` for a `claude` process in that tree, checked against the
  process start time so a file left by an earlier process with the same pid is ignored;
- the conversation in `<Claude dir>/projects/<folder>/<sessionId>.jsonl`, from its last 4 MB,
  then only what is appended (at most 8 MB per read, 400 messages kept, 20 transcripts cached).

The Claude dir is `CLAUDE_CONFIG_DIR`, or `~/.claude`. With the switch off the route answers
403 and none of this runs. The phone sends back a fingerprint of the messages it has
(`?have=`), and an unchanged list is left out of the answer.

### Codex

A session started with `codex`, or a shell where `codex` was typed (found in the session's
process tree; its working directory comes from `lsof`, or `/proc` on Linux), is matched to the
newest rollout Codex started in that directory after it began:
`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` (`CODEX_HOME` defaults to `~/.codex`). Only
files found by listing those date folders are read; nothing read from a file or from `ps`
names a path. The same bounds apply as for Claude (last 4 MB first, 8 MB per read, 400
messages, 20 rollouts cached). Codex sessions get Codex's slash commands and no permission-mode
picker.
The session list (agent chat on) also marks a running session as Codex (`codexActive`) and
shows Codex's first prompt as its title (`codexTitle`), where no Claude Code runs.

## On the phone

- Chat mode is turned on from the session menu, as before. With agent chat on, the choice is
  remembered on that phone (`vibetunnel_app_preferences.chatMode`) only once the user toggles
  it; desktop chat mode is never restored.
- The composer keeps a draft per session (`vt-chat-draft:<id>` in localStorage), offers Claude
  Code's slash commands and quick prompts (editable, stored in localStorage), and takes photos:
  they are downscaled and uploaded through `/api/files/upload` while the message is written,
  and their paths are typed, shell-quoted, only when the message is sent.
- A message typed into the composer is sent to the terminal as typed text, then Enter as a
  separate write; text with line breaks goes as a bracketed paste when the program asked for
  it. It shows at once as "sending…" until the transcript has it, and says so if it could not
  be sent (Retry).
- A single-choice question from Claude (AskUserQuestion) shows its options; a tap types the
  option's number, as typing it in the terminal would. Anything else Claude waits for shows
  with a button to open the terminal.
- Markdown is rendered from escaped text: only `http(s)` links, opened in a new tab with
  `noopener`.
