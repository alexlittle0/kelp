# kelp

Every git worktree of a repository in one live view: what each has committed since it left the base branch, what it has not committed yet, and the diffs of both.

```
bun install
bun src/kelp.tsx [folder] [--cd-file <path>]
```

Run it inside any worktree, or in the folder that holds them. It refreshes every few seconds.

- **worktrees**: one line each, closed to start, saying only what wants a look: conflicts, a merge or rebase under way, failing checks, a busy agent or a running command, how many files are uncommitted, how far it is ahead of and behind the base branch, and when it last changed. Open one for its folder and the rest (idle agents, tmux panes, upstream, its pull request), its uncommitted files and its commits
- **upstream**: how far each branch is ahead of (`↑2`) and behind (`↓1`) the remote branch it tracks, or that it is not pushed yet
- **pull requests**: on a GitHub repository with `gh` installed and logged in, each branch's pull request: its number, whether it is a draft, open, merged or closed, its review decision and whether its checks pass, fail or are still running. Open a worktree to see the PR's title and the checks failing. Fetched with one `gh pr list` in the background every minute, so it never slows the view down
- **push and PRs**: `p` pushes a worktree's branch, setting its upstream the first time; `P` (twice) pushes it if needed and opens a pull request into the base with `gh pr create --fill`; `b` opens its pull request, or else its branch, on GitHub in the browser
- **uncommitted**: the files changed since the worktree's last commit, untracked ones included
- **commits**: the commits since the worktree left the base branch (the base's own worktree shows its latest few), each with its files
- **diffs**: open a file to read its diff
- **conflicts**: a worktree behind the base branch says whether merging the base in would conflict, its uncommitted edits included, and lists the files that would; open one to see its conflicts as the merge would leave them. Worked out in memory with `git merge-tree`, so nothing in the worktree changes
- **merging**: `u` on a worktree merges the base branch into it (press it twice). It needs nothing uncommitted; a merge that conflicts stops with the conflicts in the files, which kelp lists until they are resolved and committed, and `U` (twice) aborts it. `m` (twice) goes the other way, merging the worktree's branch into the base branch in the base's own worktree: a fast-forward when it can be, else a merge commit. It needs both worktrees clean and no predicted conflicts, and says why when it won't. `R` (twice) rebases the worktree onto the base instead; a rebase that conflicts stops with them in the files, shown like a merge's. Once every conflict is resolved and `git add`ed, `u` commits the merge or `R` carries the rebase on, and `U` aborts either
- **diff totals**: an open worktree's details say how many files its commits change against the base branch, and the lines added and removed
- **sync**: `S` (twice) brings every worktree up to the base branch: one with no commits of its own fast-forwards, one with commits gets the base merged in when no conflict is predicted. Any with uncommitted changes, in the middle of a merge or rebase, or that would conflict are left alone, and one line says what was synced and what was skipped and why
- **agents**: the coding agents running in each worktree (claude, codex, aider, gemini, opencode, cursor-agent), found from their processes' folders on Linux. A busy one shows `● claude` on the worktree's line, an idle one `○ claude idle` in its details. A claude waiting for you, its turn done or asking leave to run a tool, shows `◆ claude waiting` in yellow on the line; kelp tells from the end of its transcript (read only when it changes), and counts one done over an hour ago as idle. The details show what a waiting or idle claude last said, or the tool it asks to run. When one starts waiting kelp rings the terminal bell, once, and says so in the footer. `>` answers it without leaving kelp: it asks for a message and types it into that claude's tmux pane, then presses Enter (a claude at work takes it once its turn is done), and says so in the footer when it has no pane to send to
- **tmux**: inside tmux, the panes whose folder is in each worktree and what they run. `t` jumps to the worktree: to its tmux pane when it has one, else to a new tmux window there named after its branch, or outside tmux a new kitty window. `a` starts claude in the worktree in a new window named "<branch> claude". `N` starts a new task: it asks for a branch, then for a prompt, makes the worktree the way `n` does (`.env` copies and `.kelp.json` setup included), then starts claude in it on that prompt, in the same kind of window
- **committing**: `c` asks for a message in the footer and commits everything uncommitted in the worktree under the cursor, untracked files included
- **discarding**: `D` (twice) on an uncommitted file throws its changes away: a tracked file goes back to its last commit, an untracked one is deleted
- **copying**: `y` copies the path of the file or worktree under the cursor, by OSC 52 so it works through tmux and ssh, else with wl-copy or xclip
- **editing**: `e` opens the file under the cursor at its line, or else the worktree's folder, in `$EDITOR` (nvim when unset). nvim goes the way `o` does, into the running nvim nearest the file; any other editor starts in a new tmux pane, else a new kitty window
- **switching**: `w` quits kelp and prints the worktree under the cursor's path, and with `--cd-file <path>` writes it there too, so a shell wrapper can cd to it (see below)
- **shared files**: a file changed in more than one worktree says which others change it too
- **new worktrees**: `n` asks for a branch name and makes a worktree for it: the branch when it exists, here or on origin, else a new one from the base. It goes beside the other worktrees when they share a folder, else next to the repository as `<repo>-<branch>`. It then gets a copy of the main worktree's ignored `.env` and `.env.*` files, and runs the setup in an optional `.kelp.json` at the main worktree's root, `{ "copy": ["node_modules"], "postCreate": ["bun install"] }`: more ignored files or folders to copy, then commands to run in it, its progress shown under its line
- **missing and locked**: a worktree whose folder is gone says `missing` in red on its line, and its details say whether `C` will prune it; a locked one says so, and why, in its details. Neither can be removed with `x`
- **removing**: a worktree whose branch is fully in the base after commits of its own says `merged` on its line, as it is safe to remove (a branch never committed to doesn't, nor one with uncommitted changes). `x` (twice) removes the worktree under the cursor, and its branch when that is fully in the base, keeping it otherwise and saying which. It won't while the worktree has uncommitted changes or commits the base lacks, and says so; `X` (twice) removes it anyway, its branch kept. Never the main worktree, the base's, the one kelp runs in, or one an agent is working in. `C` (twice) cleans up: it prunes the missing worktrees (not locked ones) and removes every clean, merged worktree with its branch, sparing the same ones `x` does
- **repo**: a second tab with the file tree of the worktree kelp runs in; open a file to read it, or press `d` to see its diff against HEAD instead. Changed files and the folders holding them are marked
- **run**: press `!` to run a shell command in the worktree under the cursor (in the repo tab, the one explored). The end of its output streams in under the worktree with its exit code and how long it took, and the worktree's line shows how it is doing. Several can run at once, in different worktrees, while you keep using kelp. A long-running one, such as a dev server, shows how long it has been up and the localhost address it prints; `K` (twice) stops it and all it started, and on a command that has ended clears it away. Commands still running stop when kelp quits
- **commands**: press `:` to run one of the worktree's named commands, by typing its name or the start of it. They come from `"commands"` in a `.kelp.json` at the repository's root, such as `{ "commands": { "test": "bun test", "dev": "bun run dev" } }`, or, without one, from package.json's scripts
- **filter**: `/` narrows the tab as you type, fzf style (letters in order, any case, each word matched on its own): worktrees by branch, folder or the names of the files they change, the repo tab by file path with the folders holding the matches opened. `⏎` keeps the filter, `esc` drops it
- **remembers**: the tab, the rows opened, each tab's cursor and filter, the order of the worktrees, and files or diffs in the repo tab come back after a restart, kept in `~/.cache/kelp/` for each repository

Keys (one per line, so branches adding keys merge cleanly; `?` in kelp lists them all):

- `↑↓`/`jk` move, `g`/`G` top or bottom, `PgUp`/`PgDn` page, the mouse wheel scrolls
- `⏎`/space or a click open or close, `→`/`l` open, `←`/`h` close or step out
- `tab`, `1`/`2` or a click on its name switch tab
- `d` file or diff (repo tab)
- `o` open in nvim at the line under the cursor
- `t` jump to the worktree in tmux, or open a window there
- `a` start claude in the worktree, in a new window
- `N` new task: a new worktree, and claude started in it on a prompt
- `A` go to the next worktree with an agent waiting for you; press it again soon to go on to its tmux pane
- `>` reply to the worktree's claude: type a message into its tmux pane
- `n` new worktree
- `x` (twice) remove the worktree, deleting its branch when merged; `X` (twice) even with uncommitted changes or unmerged commits
- `C` (twice) clean up: prune missing worktrees, remove clean merged ones
- `u` merge the base in
- `m` merge into the base
- `R` (twice) rebase onto the base, again to carry on once conflicts are resolved
- `U` abort a merge
- `S` (twice) sync every worktree with the base
- `!` run a command in the worktree
- `:` run one of its named commands (.kelp.json or package.json scripts)
- `K` (twice) stop the command running there
- `c` commit everything in the worktree
- `D` (twice) discard a file's changes
- `p` push the branch
- `P` (twice) open a pull request with gh
- `b` open the pull request or branch on GitHub
- `f` fetch every remote in the background, then refresh
- `y` copy the path of the file or worktree
- `e` open the file or worktree in `$EDITOR`
- `w` switch to the worktree: quit and cd there
- `/` filter, `esc` clear it
- `s` order the worktrees by name, recent activity, or needing attention first (conflicts, a busy agent, uncommitted changes)
- `r` refresh
- `?` list every key
- `q` quit

### Switching worktrees with `w`

A program can't change its shell's folder, so `w` leaves the path for the shell. Wrap kelp in a function (this assumes the `dist/kelp` binary is on your PATH) and `w` lands you in the worktree, like `wt switch`.

fish, in `~/.config/fish/functions/kelp.fish`:

```fish
function kelp
    set -l cd_file (mktemp)
    command kelp --cd-file $cd_file $argv
    set -l dir (cat $cd_file)
    rm -f $cd_file
    test -n "$dir"; and cd $dir
end
```

bash or zsh, in `~/.bashrc` or `~/.zshrc`:

```sh
kelp() {
  local cd_file dir
  cd_file=$(mktemp)
  command kelp --cd-file "$cd_file" "$@"
  dir=$(cat "$cd_file")
  rm -f "$cd_file"
  [ -n "$dir" ] && cd "$dir"
}
```

`bun run build` makes a single `dist/kelp` binary to put on your PATH.
