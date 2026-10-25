# kelp

Every git worktree of a repository in one live view: what each has committed since it left the base branch, what it has not committed yet, and the diffs of both.

```
bun install
bun src/kelp.tsx [folder]
```

Run it inside any worktree, or in the folder that holds them. It refreshes every few seconds.

- **worktrees**: each one's branch and folder, how far it is ahead of and behind the base branch, how many files it has uncommitted, and when it last changed
- **uncommitted**: the files changed since the worktree's last commit, untracked ones included
- **commits**: the commits since the worktree left the base branch (the base's own worktree shows its latest few), each with its files
- **diffs**: open a file to read its diff
- **shared files**: a file changed in more than one worktree says which others change it too
- **repo**: a second tab with the file tree of the worktree kelp runs in; open a file to read it, or press `d` to see its diff against HEAD instead. Changed files and the folders holding them are marked

Keys: `↑↓`/`jk` move, `⏎`/space or a click open or close, the mouse wheel scrolls, `→`/`l` open, `←`/`h` close or step out, `g`/`G` top or bottom, `PgUp`/`PgDn` page, `tab`, `1`/`2` or a click on its name switch tab, `d` file or diff (repo tab), `o` open in nvim at the line under the cursor, `r` refresh, `q` quit.

`bun run build` makes a single `dist/kelp` binary to put on your PATH.
