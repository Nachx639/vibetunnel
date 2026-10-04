# Quick-start availability

The new-session dialog and the compact phone list can dim quick starts whose program is not
installed on the computer running VibeTunnel ("Not installed"); tapping one explains why
instead of starting a session that fails with "command not found".

This is **off by default**. Turn it on in `~/.vibetunnel/config.json`:

```json
{ "quickStartAvailability": true }
```

The key is read on every request, so no restart is needed. It cannot be set through
`PUT /api/config`.

## How the check works

For the first word of each quick-start command, the server:

1. looks it up with `which` in its own `PATH` (as sessions resolve commands);
2. asks the user's shell about the rest in one call, `$SHELL -i -l -c 'whence -w -- "$@"'`
   (zsh) or `type -t` (bash), so aliases, functions and `PATH` changes from the rc files count.

Because step 2 runs the interactive login shell, it executes `~/.zshrc`, `~/.bash_profile` and
so on. That is why the switch exists. Program names are passed as arguments, never spliced into
the script; relative paths and names a session couldn't run through the shell are never asked.
The shell runs detached (no controlling terminal), without the server's own secrets in its
environment, and is killed with its process group after 5 s. Any failure or timeout counts as
"available": the check never hides a command that works. Answers are cached for 5 minutes.

`GET /api/quick-start/availability` (authenticated) returns `{ "<program>": true|false }`, or
`{}` when the switch is off or the check failed.
