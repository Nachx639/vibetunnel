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
