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
- **push and PRs**: `p` pushes a worktree's branch, setting its upstream the first time; `P` (twice) pushes it if needed and opens a pull request into the base with `gh pr create --fill`; `b` opens its pull request, or else its branch, on GitHub in the browser
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
- **copying**: `y` copies the path of the file or worktree under the cursor, by OSC 52 so it works through tmux and ssh, else with wl-copy or xclip
- **tmux**: inside tmux, the panes whose folder is in each worktree and what they run. `t` jumps to the worktree: to its tmux pane when it has one, else to a new tmux window there named after its branch, or outside tmux a new kitty window. `a` starts claude in the worktree in a new window named "<branch> claude"
- **shared files**: a file changed in more than one worktree says which others change it too
- **new worktrees**: `n` asks for a branch name and makes a worktree for it: the branch when it exists, here or on origin, else a new one from the base. It goes beside the other worktrees when they share a folder, else next to the repository as `<repo>-<branch>`. It then gets a copy of the main worktree's ignored `.env` and `.env.*` files, and runs the setup in an optional `.kelp.json` at the main worktree's root, `{ "copy": ["node_modules"], "postCreate": ["bun install"] }`: more ignored files or folders to copy, then commands to run in it, its progress shown under its line
- **repo**: a second tab with the file tree of the worktree kelp runs in; open a file to read it, or press `d` to see its diff against HEAD instead. Changed files and the folders holding them are marked
- **run**: press `!` to run a shell command in the worktree under the cursor (in the repo tab, the one explored). The end of its output streams in under the worktree with its exit code and how long it took, and the worktree's line shows how it is doing. Several can run at once, in different worktrees, while you keep using kelp. A long-running one, such as a dev server, shows how long it has been up and the localhost address it prints; `K` (twice) stops it and all it started, and on a command that has ended clears it away. Commands still running stop when kelp quits
- **commands**: press `:` to run one of the worktree's named commands, by typing its name or the start of it. They come from `"commands"` in a `.kelp.json` at the repository's root, such as `{ "commands": { "test": "bun test", "dev": "bun run dev" } }`, or, without one, from package.json's scripts
- **run**: press `!` to run a shell command in the worktree under the cursor (in the repo tab, the one explored). The end of its output streams in under the worktree with its exit code and how long it took, and the worktree's line shows how it is doing. Several can run at once, in different worktrees, while you keep using kelp
- **filter**: `/` narrows the tab as you type, fzf style (letters in order, any case, each word matched on its own): worktrees by branch, folder or the names of the files they change, the repo tab by file path with the folders holding the matches opened. `⏎` keeps the filter, `esc` drops it

Keys (one per line, so branches adding keys merge cleanly; `?` in kelp lists them all):

- `↑↓`/`jk` move, `g`/`G` top or bottom, `PgUp`/`PgDn` page, the mouse wheel scrolls
- `⏎`/space or a click open or close, `→`/`l` open, `←`/`h` close or step out
- `tab`, `1`/`2` or a click on its name switch tab
- `d` file or diff (repo tab)
- `o` open in nvim at the line under the cursor
- `t` jump to the worktree in tmux, or open a window there
- `a` start claude in the worktree, in a new window
- `n` new worktree
- `u` merge the base in
- `m` merge into the base
- `U` abort a merge
- `!` run a command in the worktree
- `:` run one of its named commands (.kelp.json or package.json scripts)
- `K` (twice) stop the command running there
- `c` commit everything in the worktree
- `D` (twice) discard a file's changes
- `p` push the branch
- `P` (twice) open a pull request with gh
- `b` open the pull request or branch on GitHub
- `y` copy the path of the file or worktree
- `/` filter, `esc` clear it
- `r` refresh
- `?` list every key
- `q` quit

`bun run build` makes a single `dist/kelp` binary to put on your PATH.
