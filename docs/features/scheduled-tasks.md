# Scheduled tasks

A task is a prompt for Claude Code in a folder, run now or at a set time ("tonight at 2:00",
or a date and time you pick), with an optional push when Claude has finished. The server does
the work: it starts the session with your Claude quick start, types the prompt once Claude Code
is ready at its prompt, and fires scheduled tasks on time.

## Turning it on

Tasks ride on [agent chat](agent-chat.md), because typing the prompt at the right moment reads
the same Claude Code state the chat view reads:

- `~/.vibetunnel/config.json`: `"agentChat": true`, or the server's environment:
  `VIBETUNNEL_AGENT_CHAT=1`.

While agent chat is off, every task route answers `403 { "code": "disabled" }`, the Tasks
entry is not shown, and a scheduled task whose time comes is marked failed instead of run.

The entry is in the compact phone layout (Settings > Phone layout > Compact): the "+" sheet
and the start screen offer **Tasks**.

## What a current user sees

Nothing changes until a task is created. With no saved tasks the server reads
`<control dir>/tasks.json` once at start (usually missing) and arms no timer; it writes the
file only when a task is created, changed or removed.

## Pushes

- **Task finished**: with Settings > Notifications > Claude status on
  (`notificationPreferences.agentStatus`), the first "Claude finished" of a task's session is
  sent as "Task finished: <name>" instead (one push, not two). Without it, Claude's status is
  not watched, so the push goes out when the task's session ends.
- **Task not run**: a task whose time passed while the server was down is marked missed and
  this push goes out (only for tasks that asked for a push).

Both need push notifications to be set up as usual. A task created with the push off sends
none.

## Overdue tasks

By default a task that should have run while the server was down is **not** run later; it is
marked missed. To run it on the next start when it is at most 6 hours late:

- `~/.vibetunnel/config.json`: `"runOverdueOnStart": true`

## Templates

The sheet has built-in templates (in the app's language) and your own, saved in
`~/.vibetunnel/config.json` as `taskTemplates` (at most 50). `{folder}` in a prompt becomes the
folder's name, `{path}` its full path and `{date}` today's date (YYYY-MM-DD).

Neither `taskTemplates` nor `runOverdueOnStart` can be set through `PUT /api/config`.

## API

All under `/api`, behind the normal authentication:

| Route | |
|---|---|
| `GET /tasks` | scheduled, running and the latest 30 finished tasks |
| `POST /tasks` | run now (no `runAt`) or schedule (`runAt`, ISO time, up to a year ahead) |
| `PUT /tasks/:id` | change a task that has not run yet |
| `DELETE /tasks/:id` | cancel it, or remove a finished one from the list |
| `GET/POST /task-templates`, `PUT/DELETE /task-templates/:id` | your templates |

A task is `{ name, prompt, workingDir, command, agent: "claude", notify, runAt? }`. Errors are
`{ error, code }`, `code` being one of `disabled`, `unavailable`, `invalid`, `pastTime`,
`tooFar`, `tooMany`, `notFound`, `templateNotFound`, `templateInvalid`, `folderNotFound`,
`startFailed`, `interrupted`.

## Limits and safety

- The command is your Claude quick start as given; the server adds nothing to it (no
  permission flags). The prompt is never part of the command line: it is typed into Claude
  Code as keyboard input, and only once Claude Code reports it is idle with no dialog on
  screen. If Claude does not get there (for example a "trust this folder" question nobody
  answers for 10 minutes), nothing is typed.
- The folder must exist when the task is created or changed, and again when it runs.
- At most 50 scheduled tasks; names up to 80 characters, prompts up to 20 000.
- `tasks.json` holds your prompts and folders and is written readable by your user only
  (0600).
- Tasks run on the machine the server runs on, so an HQ server has none.
- Only Claude Code for now.

## Mac app

The Mac app rewrites `config.json` from its own settings model when it saves. Until it keeps
keys it does not know, a save from the Mac app can drop `taskTemplates` and
`runOverdueOnStart` (overdue tasks then go back to being marked missed).
