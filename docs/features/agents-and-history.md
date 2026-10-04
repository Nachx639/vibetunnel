# Agents tab, "Ask Claude…", "While you were away" and Claude history

Four phone features built on [agent chat](agent-chat.md). Nothing here changes VibeTunnel for a
user who has not turned the switches below on.

| Feature | Where | Needs |
|---|---|---|
| Agents tab (mission control) | compact phone layout, list header "Sessions \| Agents", `/agents` | Phone layout = Compact, agent chat on |
| "Ask Claude…" / "Ask Codex…" box | compact phone layout, top of the list and the start screen | Phone layout = Compact, agent chat on |
| "While you were away" card | over a session's terminal | agent chat on |
| Resume an exited Claude session | phone row, its long-press sheet, the "session exited" banner | agent chat on |
| Claude history | phone More menu > History | `claudeHistory` on, and a server with a login |

## Switches

- **Agent chat**: `~/.vibetunnel/config.json` `"agentChat": true`, or `VIBETUNNEL_AGENT_CHAT=1`
  (see [agent-chat.md](agent-chat.md)).
- **Phone layout**: Settings > Application > Phone layout > Compact.
- **Claude history**: `~/.vibetunnel/config.json` `"claudeHistory": true`, or
  `VIBETUNNEL_CLAUDE_HISTORY=1` (`=0` turns it off whatever the file says). Off when missing. It
  cannot be set through `PUT /api/config`. `GET /api/config` reports `claudeHistory: true` only
  when it is on **and** the server has a login: a server started with `--no-auth` never offers
  it, and `GET /api/claude/conversations` answers 403 `no-auth` there.

## Agents tab

Every running Claude Code, Codex or Gemini session as a card: the ones waiting for you first,
then working, then idle, with what each is doing. "Needs you" opens the answer sheet. "On this
computer" (when that section is on) follows with only the outside sessions that run an agent.

**Broadcast.** Long-press a card (or "Select") to pick several agents, type one instruction and
confirm it. It is typed only into the sessions you picked, one after another, and only after a
fresh read of each screen: a session showing a dialog or a numbered menu, one that ended, and a
tmux session opened only to watch are skipped and reported, never typed into. Nothing is sent
without the confirmation, and nothing ever answers an agent by itself.

## "Ask Claude…"

Type a question, pick Claude or Codex and a folder, send. The phone starts your configured
`claude` (or `codex`) quick start in that folder with `POST /api/sessions` and
`initialInput` / `initialInputAgent`. The server types the question as keyboard input once the
agent is ready: for Claude when its status file says idle and no dialog is on screen, for Codex
when its prompt shows twice in a row with no dialog. It never types into a dialog (trust this
folder, an update prompt): when the agent is not ready by the timeout, the question is dropped and
logged. `initialInput` is limited to 20,000 characters, and the server refuses it (403
`agent-chat-off`) while agent chat is off.

## "While you were away"

`GET /api/sessions/:id/away-summary?since=<iso>` summarizes what the agent of one of this server's
own sessions did since then (files edited, commands run, errors, its last message), from the same
transcript agent chat reads. It answers 403 while agent chat is off, and 404 for a session the
server doesn't own.

## Resume

An exited Claude session whose conversation still exists (`claudeResumable`, computed only with
agent chat on) offers "Resume": a new session running `claude --resume <id>` in its folder.
**No permission-bypass flag is ever added on its own**: not from the old command, nor from how
other sessions were started. History has a "Resume without permission prompts" checkbox, off each
time it opens, for when you want `--dangerously-skip-permissions`.

A conversation running right now outside this server's sessions (a terminal tab, a tmux pane,
another VibeTunnel's session) is never resumed: `POST /api/sessions` with `claude --resume <id>` of
one answers 409 `live-elsewhere`, whoever asks. The server finds those from Claude's session files
and one `ps`, only when History lists conversations or a resume is asked for.

## Claude history

`GET /api/claude/conversations?query=&limit=50&offset=0` (behind the login and the switch) lists
the conversations in `<Claude dir>/projects/*/<id>.jsonl` (`CLAUDE_CONFIG_DIR`, else `~/.claude`),
newest first, with title, folder, last reply and an approximate message count. Only plain files in
real folders are read (a link is skipped); each transcript's head and tail are read (at most 2 MB
each) and cached by size and modification time. Pages are at most 200 entries; the search text is
cut at 200 characters.
