# Changes: review a session's git diff

The session menu (the compact menu on narrow screens) has a **Changes** item for sessions whose
folder is inside a git repository. It opens a full-screen sheet with the files changed since the
last commit (modified, added, deleted, renamed and untracked, with `+`/`−` line counts) and, per
file, its unified diff wrapped to the screen. It is read-only: nothing in the repository changes.

- Diffs larger than 200 KB are cut at a line boundary and say so.
- Untracked folders count as one entry (a stray `node_modules` does not flood the list); at most
  500 untracked entries are listed.
- Outside a git repository the menu item is shown greyed out with the reason.

## API

Both routes sit behind the normal authentication.

| Route | Returns |
|---|---|
| `GET /api/git/changes?path=<dir>` | `{ isGitRepo, repoPath, files[], totals, untrackedTruncated? }` for the repository containing `dir` |
| `GET /api/git/changes/diff?path=<dir>&file=<repo-relative>[&oldFile=]` | `{ file, diff, binary, truncated, untracked }` |

`file` and `oldFile` must stay inside the repository: absolute paths, `..` segments and paths
through a symlinked folder that points outside the repository are refused with 400. A symlink
itself shows as its link text, never its target's content. Git runs through `execFile` with
`:(literal)` pathspecs after `--`.

## Commit, Push and Create PR (`gitShip`, off by default)

With the switch on, the Changes sheet of a session also offers **Commit**, **Push** and
**Create PR** for that session's repository. Each action is a form, then a confirmation that
shows exactly what will run, then the git or `gh` output. It is off unless the server's
`~/.vibetunnel/config.json` says:

```json
{ "gitShip": true }
```

The server reads the key on every request, so the change applies without a restart. It cannot
be set from the web UI (`PUT /api/config` ignores it). When it is off the buttons are not shown
and the routes below answer `403` with `code: "disabled"`.

| Route | Does |
|---|---|
| `GET /api/sessions/:id/git/ship-status[?pr=1&base=<branch>]` | branch, upstream, ahead/behind, changed files; with `pr=1` also `gh` state, base branches and a title/body drafted from the commits |
| `POST /api/sessions/:id/git/commit` `{ files: [{ path, oldPath? }], message }` | `git add -A -- <files>` then `git commit --only -m <message> -- <files>` |
| `POST /api/sessions/:id/git/push` `{ setUpstream?, confirmMain? }` | `git push --porcelain <upstream remote> refs/heads/<branch>:refs/heads/<upstream branch>`, or `-u origin <branch>` for a new branch when `setUpstream` is true |
| `POST /api/sessions/:id/git/pr` `{ title, body?, base, draft? }` | `gh pr create --title=… --body=… --base=… --head=<branch> [--draft]` |

Guards, each covered by a test in `web/src/server/routes/git-ship.test.ts`:

- Authentication as for every other `/api` route.
- Every program runs through `execFile` with an argument array, never a shell; file paths are
  `:(literal)` pathspecs after `--`, so a file named `--amend` or `$(…)` is just a file.
- Files must resolve inside the repository, also through symlinked folders.
- The repository is the session's own folder; nothing is pushed to anything but the branch's
  configured upstream, or `origin` for a branch without one.
- No force push: every push argument is checked (`--force*`, `+refspec`, `--mirror`, `--delete`,
  `:ref`) before it runs. A rejected push is reported, never retried with force.
- Pushing to (or from) `main`/`master` needs an explicit `confirmMain: true`, which the sheet sends
  only after the user ticks "Yes, push to main".
- Commits run the repository's hooks (no `--no-verify`) and show their output when they fail.
- Detached HEAD is refused; one operation at a time per repository; every command has a timeout.
- Errors come back as stable codes (`protected`, `push-failed`, `gh-missing`, …) that the web UI
  translates; the English `error` text is for logs and API callers.

Create PR needs the GitHub CLI (`gh`, https://cli.github.com) installed and signed in
(`gh auth login`) on the server.
