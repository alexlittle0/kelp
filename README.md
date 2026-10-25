# kelp

Every git worktree of a repository in one live view: what each has committed since it left the base branch, what it has not committed yet, and the diffs of both.

```
bun install
bun src/kelp.tsx [folder]
```

Run it inside any worktree, or in the folder that holds them. It refreshes every few seconds.

- **worktrees**: each one's branch and folder, how far it is ahead of and behind the base branch, how many files it has uncommitted, and when it last changed
- **upstream**: how far each branch is ahead of (`↑2`) and behind (`↓1`) the remote branch it tracks, or that it is not pushed yet
- **pull requests**: on a GitHub repository with `gh` installed and logged in, each branch's pull request: its number, whether it is a draft, open, merged or closed, its review decision and whether its checks pass, fail or are still running. Open a worktree to see the PR's title and the checks failing. Fetched with one `gh pr list` in the background every minute, so it never slows the view down
- **uncommitted**: the files changed since the worktree's last commit, untracked ones included
- **commits**: the commits since the worktree left the base branch (the base's own worktree shows its latest few), each with its files
- **diffs**: open a file to read its diff
- **conflicts**: a worktree behind the base branch says whether merging the base in would conflict, its uncommitted edits included, and lists the files that would; open one to see its conflicts as the merge would leave them. Worked out in memory with `git merge-tree`, so nothing in the worktree changes
- **merging**: `u` on a worktree merges the base branch into it (press it twice). It needs nothing uncommitted; a merge that conflicts stops with the conflicts in the files, which kelp lists until they are resolved and committed, and `U` (twice) aborts it. `m` (twice) goes the other way, merging the worktree's branch into the base branch in the base's own worktree: a fast-forward when it can be, else a merge commit. It needs both worktrees clean and no predicted conflicts, and says why when it won't
- **agents**: the coding agents running in each worktree (claude, codex, aider, gemini, opencode, cursor-agent), found from their processes' folders on Linux. A claude shows `●` green while it is working and `○` dim when idle, told by whether it wrote to its transcript in the last 30 seconds
- **tmux**: inside tmux, the panes whose folder is in each worktree and what they run
- **committing**: `c` asks for a message in the footer and commits everything uncommitted in the worktree under the cursor, untracked files included
- **discarding**: `D` (twice) on an uncommitted file throws its changes away: a tracked file goes back to its last commit, an untracked one is deleted
- **tmux**: inside tmux, the panes whose folder is in each worktree and what they run. `t` jumps to the worktree: to its tmux pane when it has one, else to a new tmux window there named after its branch, or outside tmux a new kitty window
- **tmux**: inside tmux, the panes whose folder is in each worktree and what they run. `t` jumps to the worktree: to its tmux pane when it has one, else to a new tmux window there named after its branch, or outside tmux a new kitty window. `a` starts claude in the worktree in a new window named "<branch> claude"
- **shared files**: a file changed in more than one worktree says which others change it too
- **new worktrees**: `n` asks for a branch name and makes a worktree for it: the branch when it exists, here or on origin, else a new one from the base. It goes beside the other worktrees when they share a folder, else next to the repository as `<repo>-<branch>`
- **repo**: a second tab with the file tree of the worktree kelp runs in; open a file to read it, or press `d` to see its diff against HEAD instead. Changed files and the folders holding them are marked
- **run**: press `!` to run a shell command in the worktree under the cursor (in the repo tab, the one explored). The end of its output streams in under the worktree with its exit code and how long it took, and the worktree's line shows how it is doing. Several can run at once, in different worktrees, while you keep using kelp

Keys (one per line, so branches adding keys merge cleanly; `?` in kelp lists them all):

- `↑↓`/`jk` move, `g`/`G` top or bottom, `PgUp`/`PgDn` page, the mouse wheel scrolls
- `⏎`/space or a click open or close, `→`/`l` open, `←`/`h` close or step out
- `tab`, `1`/`2` or a click on its name switch tab
- `d` file or diff (repo tab)
- `o` open in nvim at the line under the cursor
- `t` jump to the worktree in tmux, or open a window there
- `n` new worktree
- `u` merge the base in
- `m` merge into the base
- `U` abort a merge
- `!` run a command in the worktree
- `c` commit everything in the worktree
- `D` (twice) discard a file's changes
- `r` refresh
- `?` list every key
- `q` quit
Keys: `↑↓`/`jk` move, `⏎`/space or a click open or close, the mouse wheel scrolls, `→`/`l` open, `←`/`h` close or step out, `g`/`G` top or bottom, `PgUp`/`PgDn` page, `tab`, `1`/`2` or a click on its name switch tab, `d` file or diff (repo tab), `o` open in nvim at the line under the cursor, `t` jump to the worktree in tmux, `u` merge the base in, `U` abort a merge, `!` run a command in the worktree, `r` refresh, `?` list every key, `q` quit.
Keys: `↑↓`/`jk` move, `⏎`/space or a click open or close, the mouse wheel scrolls, `→`/`l` open, `←`/`h` close or step out, `g`/`G` top or bottom, `PgUp`/`PgDn` page, `tab`, `1`/`2` or a click on its name switch tab, `d` file or diff (repo tab), `o` open in nvim at the line under the cursor, `t` jump to the worktree in tmux, `a` start claude in it, `u` merge the base in, `U` abort a merge, `!` run a command in the worktree, `r` refresh, `?` list every key, `q` quit.

`bun run build` makes a single `dist/kelp` binary to put on your PATH.
