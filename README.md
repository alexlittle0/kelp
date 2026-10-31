# kelp

Every git worktree of a repository in one live view: what each has committed since it left the base branch, what it has not committed yet, and the diffs of both.

```
bun install
bun src/kelp.tsx [folder] [--cd-file <path>]
```

Run it inside any worktree, or in the folder that holds them. It refreshes every few seconds.

- **worktrees**: one line each, closed to start, saying only what wants a look: conflicts, a merge or rebase under way, failing checks, a busy agent or a running command, how many files are uncommitted, how far it is ahead of and behind the base branch, and when it last changed. Open one for its folder and the rest (idle agents, tmux panes, upstream, its pull request), its uncommitted files, its stashes and its commits
- **upstream**: how far each branch is ahead of (`↑2`) and behind (`↓1`) the remote branch it tracks, or that it is not pushed yet
- **pull requests**: on a GitHub repository with `gh` installed and logged in, each branch's pull request: its number, whether it is a draft, open, merged or closed, its review decision and whether its checks pass, fail or are still running. Open a worktree to see the PR's title and the checks failing. Fetched with one `gh pr list` in the background every minute, so it never slows the view down
- **push and PRs**: `p` pushes a worktree's branch, setting its upstream the first time; `P` (twice) pushes it if needed and opens a pull request into the base with `gh pr create --fill`; `b` opens its pull request, or else its branch, on GitHub in the browser
- **uncommitted**: the files changed since the worktree's last commit, untracked ones included. `+` stages the file under the cursor and `-` unstages it, or on the "uncommitted" line every file, or on a line of a file's diff only the hunk it is in, as lazygit does; a staged file is green and says `staged`, or `partly staged` when it has changed since, its diff then showing the staged changes and the rest apart under dim `staged` and `unstaged` headings, and the details count the staged and unstaged files
- **stashes**: an open worktree lists the stashes made on its branch, each opening to its files and their diffs, untracked ones included, and its details count them. `z` stashes the worktree's uncommitted changes, untracked files included, asking for a message; `Z` (twice) pops the stash under the cursor, or else the worktree's latest
- **commits**: the commits since the worktree left the base branch (the base's own worktree shows its latest few), each with its files
- **diffs**: open a file to read its diff: each line numbered, added lines with a green `+` and their code highlighted, removed ones in red, unchanged ones dimmed. Diffs, conflicts and the repo tab's files are highlighted in kelp's own colours for the file's language, told by its extension, its name (Dockerfile, Makefile) or its `#!` line: TS/JS, Python, Go, Rust, C/C++, Java, Ruby, shell, JSON, YAML, TOML, Markdown, HTML, CSS, SQL, Lua and the rest highlight.js knows; anything else stays plain. Each text is highlighted once and kept while it is unchanged
- **conflicts**: a worktree behind the base branch says whether merging the base in would conflict, its uncommitted edits included, and lists the files that would; open one to see its conflicts as the merge would leave them. Worked out in memory with `git merge-tree`, so nothing in the worktree changes
- **merging**: `u` on a worktree merges the base branch into it (press it twice). It needs nothing uncommitted; a merge that conflicts stops with the conflicts in the files, which kelp lists until they are resolved and committed, and `U` (twice) aborts it. `m` (twice) goes the other way, merging the worktree's branch into the base branch in the base's own worktree: a fast-forward when it can be, else a merge commit. It needs both worktrees clean and no predicted conflicts, and says why when it won't. `R` (twice) rebases the worktree onto the base instead; a rebase that conflicts stops with them in the files, shown like a merge's. Once every conflict is resolved and `git add`ed, `u` commits the merge or `R` carries the rebase on, and `U` aborts either
- **diff totals**: an open worktree's details say how many files its commits change against the base branch, and the lines added and removed
- **sync**: `S` (twice) brings every worktree up to the base branch: one with no commits of its own fast-forwards, one with commits gets the base merged in when no conflict is predicted. Any with uncommitted changes, in the middle of a merge or rebase, or that would conflict are left alone, and one line says what was synced and what was skipped and why
- **agents**: the coding agents running in each worktree (claude, codex, aider, gemini, opencode, cursor-agent), found from their processes' folders on Linux. A busy one shows `● claude` on the worktree's line, an idle one `○ claude idle` in its details. A claude waiting for you, its turn done or asking leave to run a tool, shows `◆ claude waiting` in yellow on the line; kelp tells from the end of its transcript (read only when it changes), and counts one done over an hour ago as idle. The other agents, which leave no transcript kelp reads, are told the same way from what their tmux pane shows, read once a refresh: working (codex's and claude's "esc to interrupt", gemini's "esc to cancel", opencode's "esc interrupt", aider's "Waiting for", cursor-agent's "ctrl+c to stop"), asking leave (an approval menu, "Allow once", aider's "(Y)es/(N)o"), done with a turn and so waiting for an hour after it was last seen working, or else idle; one in no tmux pane kelp can see shows as `● codex`, running. The details show what a waiting or idle claude last said, or the tool it asks to run, and for a busy one how long it has been working on its current turn, since your last prompt, and for each claude what its session has cost and how full its context window is, such as `claude $1.23 · 45% context` (yellow from 80%, red from 95%, as it nears compacting; the window is 1M tokens, or 200K for claude-haiku-4-5, claude-sonnet-4-5 and older unless run with `[1m]`). The cost is its tokens (input, output, cache writes and reads, each message counted once, its transcript read on from where it was left, a few MB a refresh, the subagents it started counted in) priced at Anthropic's API list prices for its model. Only an estimate, and on a subscription you don't pay per token; for a model kelp has no price for it shows the tokens instead, such as `claude 1.2M tokens`. When one starts waiting kelp rings the terminal bell, once, and says so in the footer. Whether a claude is at work or waiting for you is what claude itself says, in the `status` newer claudes keep in `~/.claude/sessions/<pid>.json`, else what its transcript shows. `>` answers it without leaving kelp, in a box that opens right under its conversation (opening the worktree and the conversation as needed) and stays open to go on talking: `⏎` types what you wrote into that claude's tmux pane and presses Enter (a claude at work takes it once its turn is done), and what you sent shows at the conversation's end straight away, as your prompts do. It looks and works like claude's own prompt: while claude works, a line above the box says so, its spinner turning, with how long it has been at it, `✻ Working… (1m 12s)`, from the moment you send; then a rounded box with `>` before your text, and under it the keys that work in it. The box takes several lines, wrapped to fit, with the cursor anywhere in them: alt+`⏎`, shift+`⏎` or a `\` before `⏎` starts a new line, a paste goes in whole with its newlines kept, `←→↑↓`, home and end (ctrl+a, ctrl+e) move, alt+`←→` by words, alt+backspace or ctrl+w, ctrl+u and ctrl+k erase, PgUp and PgDn scroll the conversation above it, and `esc` closes it, keeping what was typed for the next `>` there. Text of several lines goes in as a bracketed paste, so its newlines stay newlines. On a conversation's rows `>` answers that conversation's claude. kelp says so in the footer when it has no pane to send to. On a line of a diff, uncommitted or a commit's, `>` asks for a review note instead and sends it as `<file>:<line>: <note>`, like Conductor's diff comments. When the claude is asking leave to run a tool (kelp looks for its menu in the pane), the box turns yellow and says what it asks to run: `y` or `n` answer at once, pressing what the menu wants (`1` for yes, esc for no), or type what to do instead and `⏎` says no with it; and should it start asking while you write, `⏎` holds your words back and asks y or n first. The other agents, and notes on diff lines, are asked for in the footer, on one line. The other agents are answered the same way, `>` typing into their pane; asking leave, each gets the keys its own prompt wants: codex and cursor-agent `y` or esc, gemini Enter or esc, aider `y`/`n` and Enter, opencode Enter for "Allow once" or → → Enter for "Reject". An open worktree has a closed `▸ claude conversation` row for each claude session in it, which opens to that session's latest 200 entries in a window of their own, a third of the screen tall: it follows the newest at the bottom as they come in, `j`/`k` past its edge scroll it (and once at its end go on out of it), the mouse wheel over it scrolls it alone, and dim `↑ 12 more` and `↓ 3 more` lines say what is out of view; like the chat Conductor and Crystal show beside the diff: your prompts behind a cyan `›` in bold, claude's replies behind an orange `●` with their markdown shown (headings and bold bold, `code` green, lists and quotes wrapped under their own text, code blocks highlighted for their language), a blank line before each, their first three lines with words in until opened for the rest, and each tool call as one dim line, such as `Edit src/kelp.tsx` or `Bash bun run typecheck`, with a red `✗` when it failed, opening to its input and the first lines of its result; `o` or `e` on one that read or wrote a file opens that file. Thinking and claude's own bookkeeping are left out
- **tmux**: inside tmux, the panes whose folder is in each worktree and what they run. `t` jumps to the worktree: to its tmux pane when it has one, else to a new tmux window there named after its branch, or outside tmux a new kitty window. `a` starts claude in the worktree in a new window named "<branch> claude". `N` starts a new task: it asks for a branch, then for a prompt, makes the worktree the way `n` does (`.env` copies and `.kelp.json` setup included), then starts claude in it on that prompt, in the same kind of window. A branch ending in `*3`, such as `fix-login*3`, makes several attempts at once, like Conductor and claude-squad: `fix-login-1` to `fix-login-3`, each with claude on the same prompt, to compare and keep the best
- **committing**: `c` asks for a message in the footer and commits what is staged in the worktree under the cursor, or with nothing staged everything uncommitted, untracked files included; the question says which. Left empty, it offers to amend the worktree's last commit instead, its message filled in to keep or change, when that commit is not in the base branch nor pushed; with nothing uncommitted, `c` goes straight to rewording it
- **discarding**: `D` (twice) on an uncommitted file throws its changes away: a tracked file goes back to its last commit, an untracked one is deleted
- **copying**: `y` copies the path of the file or worktree under the cursor, by OSC 52 so it works through tmux and ssh, else with wl-copy or xclip
- **editing**: `e` opens the file under the cursor at its line, or else the worktree's folder, in `$EDITOR` (nvim when unset). nvim goes the way `o` does, into the running nvim nearest the file; any other editor starts in a new tmux pane, else a new kitty window
- **switching**: `w` quits kelp and prints the worktree under the cursor's path, and with `--cd-file <path>` writes it there too, so a shell wrapper can cd to it (see below)
- **shared files**: a file changed in more than one worktree says which others change it too
- **new worktrees**: `n` asks for a branch name and makes a worktree for it: the branch when it exists, here or on origin, else a new one from the base. It goes beside the other worktrees when they share a folder, else next to the repository as `<repo>-<branch>`. It then gets a copy of the main worktree's ignored `.env` and `.env.*` files, and runs the setup in an optional `.kelp.json` at the main worktree's root, `{ "copy": ["node_modules"], "postCreate": ["bun install"] }`: more ignored files or folders to copy, then commands to run in it, its progress shown under its line
- **missing and locked**: a worktree whose folder is gone says `missing` in red on its line, and its details say whether `C` will prune it; a locked one says so, and why, in its details. Neither can be removed with `x`
- **removing**: a worktree whose branch is fully in the base after commits of its own says `merged` on its line, as it is safe to remove (a branch never committed to doesn't, nor one with uncommitted changes). `x` (twice) removes the worktree under the cursor, and its branch when that is fully in the base, keeping it otherwise and saying which. It won't while the worktree has uncommitted changes or commits the base lacks, and says so; `X` (twice) removes it anyway, its branch kept. Never the main worktree, the base's, the one kelp runs in, or one an agent is working in. `C` (twice) cleans up: it prunes the missing worktrees (not locked ones) and removes every clean, merged worktree with its branch, sparing the same ones `x` does. Before removing one, `x`, `X` and `C` run the `"preRemove"` commands in `.kelp.json`, such as `{ "preRemove": ["docker compose down"] }`, in the worktree with the same `$PORT` and `KELP_*` variables, their progress shown under its line like postCreate's. One that fails keeps the worktree, and says why; `X` removes it anyway
- **agents tab**: a third tab, like claude-squad's list, with every agent running on the machine on one line each, those in the repository's worktrees by their branch and the rest by their folder (in magenta), after the repository's: those waiting for you first (`◆` yellow), then those at work (`●` green), then the idle ones (`○` dim), each with its worktree's branch, how long it has been on its current turn or idle, and dim the start of what it last said or asks to run. `/` filters it by agent, branch or words. `v` switches between every agent on the machine and only those in the repository's worktrees, and kelp remembers which; with only the repository's, the header's count and the bell when one starts waiting leave the rest out too. Open one for its folder, what its session has cost so far (as in the worktree's details), its tmux pane, what it asks, and a claude's conversation, open; there `t` jumps to that agent's own pane, `>` replies to it, and `a` and `N` start claude as on the worktrees tab
- **repo**: a second tab with the file tree of the worktree kelp runs in; open a file to read it, its lines numbered in dim, tabs set out to stops four apart and long lines cut with `…`, or press `d` to see its diff against HEAD instead. Changed files and the folders holding them are marked
- **run**: press `!` to run a shell command in the worktree under the cursor (in the repo tab, the one explored). The end of its output streams in under the worktree with its exit code and how long it took, and the worktree's line shows how it is doing. Several can run at once, in different worktrees, while you keep using kelp. A long-running one, such as a dev server, shows how long it has been up and the localhost address it prints; `K` (twice) stops it and all it started, and on a command that has ended clears it away. Commands still running stop when kelp quits
- **ports**: each worktree but the base branch's gets a port of its own, from a hash of its branch name, between 10000 and 19999, so it stays the same across restarts and several copies of an app can run side by side; should two branches hash to the same port, the later by name takes the next free one, so no two worktrees share one; an open worktree's details show it, as `port 10162`, only when the repository uses it: its `.kelp.json` (or the main worktree's) mentions `$PORT` or `$KELP_PORT`, or something in the worktree is serving. Every command kelp runs there (`!`, `:` and `.kelp.json`'s postCreate) gets it as `$PORT` and `$KELP_PORT`, with `$KELP_BRANCH`, `$KELP_WORKTREE` (its folder) and `$KELP_BASE` (the base branch). The base branch's worktree gets no `$PORT` from kelp, so the app keeps its default there. A dev server that reads `$PORT` needs nothing more; for one that doesn't, pass it on in `.kelp.json`, such as `{ "commands": { "dev": "vite --port $PORT" } }`. The details also show the localhost ports that processes running in the worktree listen on, such as `serving :10162 :24678`, whoever started them (read with each refresh from `/proc` on Linux, and where there is none, as on macOS, from `lsof`). `B` opens the worktree's dev server in the browser: the address its running command printed, else the port it serves, its own `$PORT` first
- **commands**: press `:` to run one of the worktree's named commands, by typing its name or the start of it. They come from `"commands"` in a `.kelp.json` at the repository's root, such as `{ "commands": { "test": "bun test", "dev": "bun run dev" } }`, or, without one, from package.json's scripts
- **filter**: `/` narrows the tab as you type, fzf style (letters in order, any case, each word matched on its own): worktrees by branch, folder or the names of the files they change, the repo tab by file path with the folders holding the matches opened. `⏎` keeps the filter, `esc` drops it
- **remembers**: the tab (the agents tab too), the rows opened, each tab's cursor and filter, the order of the worktrees, and files or diffs in the repo tab come back after a restart, kept in `~/.cache/kelp/` for each repository

Keys (one per line, so branches adding keys merge cleanly; `?` in kelp lists them all):

- `↑↓`/`jk` move, `g`/`G` top or bottom, `PgUp`/`PgDn` page, the mouse wheel scrolls
- `⏎`/space or a click open or close, `→`/`l` open, `←`/`h` close or step out
- `H` close every row in the tab; press it again straight after to open them as they were
- `tab` next tab, `1`/`2`/`3` or a click on its name switch to worktrees, repo or agents
- `d` file or diff (repo tab)
- `o` open in nvim at the line under the cursor, or the file a claude's tool call in its conversation names
- `t` jump to the worktree in tmux, or open a window there; in the agents tab, to the agent's pane
- `a` start claude in the worktree, in a new window
- `N` new task: a new worktree, and claude started in it on a prompt; `name*3` for three attempts at once
- `v` agents tab: every agent on the machine, or only the repository's
- `A` go to the next worktree with an agent waiting for you; press it again soon to go on to its tmux pane
- `>` reply to the worktree's agent (claude, codex, gemini, aider, opencode, cursor-agent): type a message into its tmux pane, a claude's in a box under its conversation that stays open (`⏎` send, alt+`⏎` new line, `esc` close); on a diff line, send it a note on that line; `y`/`n` when it asks leave to run a tool
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
- `c` commit what is staged, else everything in the worktree; an empty message amends the last commit, when unpushed
- `+`/`-` stage or unstage the file, the hunk under the cursor in its diff, or on "uncommitted" every file
- `z` stash the uncommitted changes
- `Z` (twice) pop the stash under the cursor, or the latest
- `D` (twice) discard a file's changes
- `p` push the branch
- `P` (twice) open a pull request with gh
- `B` open the worktree's dev server in the browser
- `b` open the pull request or branch on GitHub
- `f` fetch every remote in the background, then refresh
- `y` copy the path of the file or worktree
- `e` open the file or worktree in `$EDITOR`
- `w` switch to the worktree: quit and cd there
- `/` filter, `esc` clear it
- `s` order the worktrees by name, recent activity, or needing attention first (conflicts, a busy agent, uncommitted changes)
- `r` refresh
- `?` list every key, `j`/`k` scroll the list when it is longer than the screen, `esc` or `?` close it
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
