#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { Box, Text, render, useApp, useInput, useStdout } from 'ink'
import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'

const REFRESH_MS = 3000
const MAX_DIFF_LINES = 400
// Commits listed for the base branch's own worktree, newest first.
const BASE_COMMITS = 5
// Commits listed for any other worktree, from where it left the base branch.
const MAX_COMMITS = 50
// Files over this size are not read: not for an untracked file's line count, nor to show in the repo tab.
const MAX_FILE = 1_000_000
// Lines of a file the repo tab shows before cutting it.
const MAX_FILE_LINES = 2000
// Files the repo tab lists at most.
const MAX_REPO_FILES = 20_000
// How long a message, such as where a file was opened, stays in the footer.
const NOTICE_MS = 4000
// Lines the view moves per turn of the mouse wheel.
const WHEEL_LINES = 3
// How often the pull requests are fetched from GitHub, apart from the main refresh, and how many at most.
const PR_REFRESH_MS = 60_000
const MAX_PRS = 50
// Lines shown around each conflict.
const CONFLICT_CONTEXT = 2
// Who `git stash create` says made its commit, and when: fixed, so the same edits make the same commit
// and refreshing writes no new objects.
const STASH_ENV = {
  GIT_AUTHOR_NAME: 'kelp',
  GIT_AUTHOR_EMAIL: 'kelp@localhost',
  GIT_AUTHOR_DATE: '@0 +0000',
  GIT_COMMITTER_NAME: 'kelp',
  GIT_COMMITTER_EMAIL: 'kelp@localhost',
  GIT_COMMITTER_DATE: '@0 +0000',
}
// The coding agents kelp looks for among running processes.
const AGENTS = ['claude', 'codex', 'aider', 'gemini', 'opencode', 'cursor-agent']
// A claude counts as busy while its transcript was written this recently.
const BUSY_MS = 30_000

// Every key, grouped by area, as `?` lists them. Add a line here for any new key.
const KEYS: { area: string; keys: [string, string][] }[] = [
  {
    area: 'move',
    keys: [
      ['↑↓ jk', 'up, down'],
      ['PgUp PgDn', 'a page up, down (also ctrl+u ctrl+d)'],
      ['g G', 'top, bottom'],
      ['wheel', 'scroll'],
    ],
  },
  {
    area: 'open',
    keys: [
      ['⏎ space click', 'open or close'],
      ['→ l', 'open'],
      ['← h', 'close, or step out'],
    ],
  },
  {
    area: 'tabs',
    keys: [
      ['tab', 'the other tab'],
      ['1 2', 'worktrees, repo (or click its name)'],
    ],
  },
  {
    area: 'files',
    keys: [
      ['o', 'open in nvim at the line under the cursor'],
      ['d', 'repo tab: show files or diffs vs HEAD'],
    ],
  },
  {
    area: 'merge',
    keys: [
      ['u', 'merge the base branch into the worktree (twice)'],
      ['U', 'abort a merge under way (twice)'],
    ],
  },
  {
    area: 'kelp',
    keys: [
      ['r', 'refresh now'],
      ['?', 'these keys'],
      ['q', 'quit'],
    ],
  },
]

// ---- Types ----

// A changed file: its path in the worktree, its line counts, and whether it is new, deleted or binary.
type Change = { path: string; added: number; removed: number; tag: '' | 'new' | 'deleted' | 'binary' | 'conflict'; isUntracked?: boolean }

type Commit = { hash: string; at: number; subject: string; files: Change[] }

// A worktree: where it is, what it has checked out, how far it is from the base branch, and what it holds.
type Tree = {
  path: string
  branch: string
  head: string
  isBase: boolean
  ahead: number
  behind: number
  commits: Commit[]
  uncommitted: Change[]
  // Merging the base in, worked out in memory: the merged tree ('' when not worked out, as nothing is behind
  // or a merge is under way) and the files that would conflict.
  merged: string
  conflicts: string[]
  // Whether a merge is under way, its conflicted files among the uncommitted ones.
  isMerging: boolean
  // Its newest commit or edited file, ms since the epoch.
  lastAt: number
  // The coding agents running in it.
  agents: Agent[]
  // The tmux panes whose folder is in it.
  panes: Pane[]
  // The remote branch it tracks, such as "origin/feature", or '' when it tracks none,
  // how far it is ahead of and behind that, and whether that branch is gone from the remote.
  upstream: string
  unpushed: number
  unpulled: number
  isUpstreamGone: boolean
}

// A coding agent running in a worktree; `isBusy` is known only for claude, from its transcript.
type Agent = { name: string; pid: number; isBusy?: boolean }

// A tmux pane: its id, its window as "session:index", that window's name, and what it runs.
type Pane = { id: string; window: string; windowName: string; command: string }

// `remote` is the one to push to ('' when there is none), `github` its page on GitHub ('' when it is not there).
type Repo = { dir: string; base: string; remote: string; github: string; trees: Tree[] }

// A branch's pull request on GitHub: its review decision ('' when none is needed), its checks rolled up into one
// ('' when it has none) and the names of those failing.
type Pr = {
  number: number
  title: string
  url: string
  state: 'draft' | 'open' | 'merged' | 'closed'
  review: '' | 'approved' | 'changes requested' | 'review required'
  checks: '' | 'passing' | 'failing' | 'pending'
  failing: string[]
}

// The files of the worktree the repo tab explores, relative to its folder, and git's status code for each changed one.
type Files = { dir: string; files: string[]; isCut: boolean; status: Record<string, string> }

// A conflict is read from the merged tree, or from the file itself when a merge is under way ('' for `merged`),
// its markers named for the worktree and the base.
type Conflict = { merged: string; ours: string; theirs: string }
// A diff to show under an open file, or with `isWhole` the file itself, or with `conflict` its conflicts, and where it comes from.
type Wanted = { key: string; tree: string; file: string; commit?: string; isUntracked?: boolean; isWhole?: boolean; conflict?: Conflict }
// `isUnreadable` when a whole file is binary, too large or missing; `colors` when the lines carry their own,
// else they are coloured as a diff.
type Diff = { lines: string[]; colors?: (string | undefined)[]; isCut: boolean; isUnreadable?: boolean; version: number }

type Tab = 'worktrees' | 'repo'

// A one-line question asked in the footer, such as a new branch's name: what it asks, what is typed so far,
// and what is done with the answer once ⏎ is pressed.
type Prompt = { label: string; text: string; onDone: (answer: string) => void }

// A destructive action waiting for its key to be pressed again on the same row: what it will do, said in the footer.
type Armed = { input: string; row: string; text: string; run: () => void }

// One line of the view; `parent` is the line it sits under, `canOpen` whether it opens and closes,
// `isOpenByDefault` whether it starts open, `isGap` a blank line between worktrees that the cursor passes over,
// `file` and `line` where `o` opens it in nvim.
type Row = {
  key: string
  parent?: string
  depth: number
  canOpen?: boolean
  isOpenByDefault?: boolean
  isGap?: boolean
  file?: string
  line?: number
  node: JSX.Element
}

// ---- Git ----

// Git's output, or null when it fails or exits with a code not in `ok`.
const git = async (cwd: string, args: string[], ok = [0], env?: Record<string, string>) => {
  const run = await gitRun(cwd, args, env)

  return run && ok.includes(run.code) ? run.out : null
}

// Git's output and exit code, or null when it cannot be started.
const gitRun = async (cwd: string, args: string[], env?: Record<string, string>) => {
  try {
    const proc = Bun.spawn(['git', '-c', 'core.quotePath=false', ...args], { cwd, stdout: 'pipe', stderr: 'ignore', env: env && { ...process.env, ...env } })
    const out = await new Response(proc.stdout).text()

    return { out, code: await proc.exited }
  } catch {
    return null
  }
}

// The repository at `dir`, or failing that the first folder in it holding one.
const findRepo = async (dir: string) => {
  if ((await git(dir, ['rev-parse', '--git-dir'])) !== null) return dir
  for (const name of readdirSync(dir).sort()) {
    if (existsSync(`${dir}/${name}/.git`)) return `${dir}/${name}`
  }

  return null
}

// The worktrees git knows of, leaving out bare ones and those whose folder is gone.
const listWorktrees = async (dir: string) => {
  const text = (await git(dir, ['worktree', 'list', '--porcelain'])) ?? ''

  return text
    .split('\n\n')
    .map(block => {
      const lines = block.split('\n')
      const value = (name: string) => lines.find(l => l.startsWith(`${name} `))?.slice(name.length + 1) ?? ''

      return { path: value('worktree'), head: value('HEAD'), branch: value('branch').replace(/^refs\/heads\//, ''), isBare: lines.includes('bare') }
    })
    .filter(w => w.path && !w.isBare && existsSync(w.path))
}

// The branch the others are compared with: origin's default, else main, else master, else the first worktree's.
const findBase = async (dir: string, firstBranch: string) => {
  const remote = (await git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))?.trim().replace(/^origin\//, '')
  for (const name of [remote, 'main', 'master']) {
    if (name && (await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])) !== null) return name
  }

  return firstBranch || 'HEAD'
}

// Commits from `git log --format=%x01%h%x00%ct%x00%s --numstat --summary`.
const parseLog = (text: string): Commit[] =>
  text
    .split('\x01')
    .slice(1)
    .map(chunk => {
      const [head, ...rest] = chunk.split('\n')
      const [hash, time, subject] = head.split('\0')
      const files: Change[] = []
      for (const line of rest) {
        const stat = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
        if (stat) {
          const isBinary = stat[1] === '-'
          files.push({ path: stat[3], added: isBinary ? 0 : Number(stat[1]), removed: isBinary ? 0 : Number(stat[2]), tag: isBinary ? 'binary' : '' })
        }
        const mode = line.match(/^ (create|delete) mode \d+ (.+)$/)
        const file = mode && files.find(f => f.path === mode[2])
        if (mode && file && file.tag === '') file.tag = mode[1] === 'create' ? 'new' : 'deleted'
      }

      return { hash, at: Number(time) * 1000, subject, files }
    })

// A text file's text, or null when it is binary, too large or unreadable.
const readText = (file: string) => {
  try {
    if (statSync(file).size > MAX_FILE) return null
    const text = readFileSync(file, 'utf8')

    return text.includes('\0') ? null : text
  } catch {
    return null
  }
}

// A text's lines; a final newline ends the last line rather than starting another.
const toLines = (text: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'))

// A text file's line count, or null when it is binary, too large or unreadable.
const countLines = (file: string) => {
  const text = readText(file)

  return text === null ? null : toLines(text).length
}

const modifiedAt = (file: string) => {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

// What the worktree has changed since its last commit, untracked files included.
const readUncommitted = async (path: string) => {
  const [status, numstat] = await Promise.all([
    git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']),
    git(path, ['diff', 'HEAD', '--numstat', '--no-renames', '-z']),
  ])
  if (status === null) return []
  // Line counts against HEAD, null for a binary file.
  const counts = new Map<string, [number, number] | null>()
  for (const entry of (numstat ?? '').split('\0')) {
    const [added, removed, file] = entry.split('\t')
    if (file) counts.set(file, added === '-' ? null : [Number(added), Number(removed)])
  }

  const changes: Change[] = []
  for (const entry of status.split('\0')) {
    if (entry.length < 4) continue
    const code = entry.slice(0, 2)
    const file = entry.slice(3)
    if (code === '??') {
      const lines = countLines(`${path}/${file}`)
      changes.push({ path: file, added: lines ?? 0, removed: 0, tag: lines === null ? 'binary' : 'new', isUntracked: true })
      continue
    }
    const count = counts.get(file)
    // Both sides added, both deleted, or either side unmerged: a conflict left by a merge.
    const isConflict = code === 'AA' || code === 'DD' || code.includes('U')
    const tag = isConflict ? 'conflict' : code.includes('D') ? 'deleted' : code.includes('A') ? 'new' : count === null ? 'binary' : ''
    changes.push({ path: file, added: count?.[0] ?? 0, removed: count?.[1] ?? 0, tag })
  }

  return changes
}

// What merging the base into the worktree would do, without touching it: `git merge-tree` merges in memory.
// Uncommitted edits to tracked files count too, through the commit `git stash create` makes of them,
// which it leaves dangling with the worktree, index and stash list as they were.
const readConflicts = async (path: string, base: string, hasUncommitted: boolean) => {
  const stash = hasUncommitted ? (await git(path, ['stash', 'create'], [0], STASH_ENV))?.trim() : ''
  // Exits 1 when there are conflicts.
  const text = await git(path, ['merge-tree', '--write-tree', '--name-only', '--no-messages', stash || 'HEAD', base], [0, 1])
  if (text === null) return { merged: '', conflicts: [] }
  const [merged, ...files] = text.split('\n\n')[0].split('\n')

  return { merged, conflicts: [...new Set(files.filter(Boolean))] }
}

// The remote to push to: origin, else the first there is, else ''.
const findRemote = async (dir: string) => {
  const names = ((await git(dir, ['remote'])) ?? '').split('\n').filter(Boolean)

  return names.includes('origin') ? 'origin' : (names[0] ?? '')
}

// A remote's page on GitHub, such as "https://github.com/owner/repo", or '' when it is elsewhere.
const githubPage = (url: string) => {
  const found = url.trim().match(/github\.com[:/]+([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/)

  return found ? `https://github.com/${found[1]}` : ''
}

// Each local branch's upstream, and how far the branch is ahead of and behind it.
const readUpstreams = async (dir: string) => {
  const text = (await git(dir, ['for-each-ref', '--format=%(refname:lstrip=2)%00%(upstream:short)%00%(upstream:track,nobracket)', 'refs/heads'])) ?? ''
  const upstreams = new Map<string, { upstream: string; unpushed: number; unpulled: number; isUpstreamGone: boolean }>()
  for (const line of text.split('\n')) {
    const [branch, upstream, track] = line.split('\0')
    if (!branch || !upstream) continue
    const unpushed = Number(track.match(/ahead (\d+)/)?.[1] ?? 0)
    const unpulled = Number(track.match(/behind (\d+)/)?.[1] ?? 0)
    upstreams.set(branch, { upstream, unpushed, unpulled, isUpstreamGone: track === 'gone' })
  }

  return upstreams
}

type Upstreams = Awaited<ReturnType<typeof readUpstreams>>

const loadTree = async (w: { path: string; head: string; branch: string }, base: string, upstreams: Upstreams): Promise<Tree> => {
  const isBase = w.branch === base
  const range = isBase ? [`-${BASE_COMMITS}`, 'HEAD'] : [`-${MAX_COMMITS}`, `${base}..HEAD`]
  const [log, counts, uncommitted, headAt, mergeHead] = await Promise.all([
    git(w.path, ['log', ...range, '--format=%x01%h%x00%ct%x00%s', '--numstat', '--summary', '--no-renames', '--diff-merges=first-parent']),
    isBase ? Promise.resolve('0\t0') : git(w.path, ['rev-list', '--left-right', '--count', `${base}...HEAD`]),
    readUncommitted(w.path),
    git(w.path, ['log', '-1', '--format=%ct']),
    git(w.path, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD']),
  ])
  const [behind, ahead] = (counts ?? '0\t0').trim().split(/\s+/).map(Number)
  const isMerging = mergeHead !== null
  const { merged, conflicts } = behind > 0 && !isMerging ? await readConflicts(w.path, base, uncommitted.length > 0) : { merged: '', conflicts: [] }
  const edited = uncommitted.map(c => modifiedAt(`${w.path}/${c.path}`))

  return {
    ...w,
    isBase,
    ahead,
    behind,
    commits: parseLog(log ?? ''),
    uncommitted,
    merged,
    conflicts,
    isMerging,
    lastAt: Math.max(Number(headAt ?? 0) * 1000, ...edited),
    agents: [],
    panes: [],
    ...(upstreams.get(w.branch) ?? { upstream: '', unpushed: 0, unpulled: 0, isUpstreamGone: false }),
  }
}

// Every worktree of the repository at or under `root`, the base branch's first and the rest by branch name.
const loadRepo = async (root: string): Promise<Repo | null> => {
  const dir = await findRepo(root)
  if (!dir) return null
  const worktrees = await listWorktrees(dir)
  const [base, remote, upstreams] = await Promise.all([findBase(dir, worktrees[0]?.branch ?? ''), findRemote(dir), readUpstreams(dir)])
  const url = remote ? ((await git(dir, ['remote', 'get-url', remote])) ?? '') : ''
  const [trees, panes] = await Promise.all([Promise.all(worktrees.map(w => loadTree(w, base, upstreams))), listPanes()])
  trees.sort((a, b) => Number(b.isBase) - Number(a.isBase) || label(a).localeCompare(label(b)))
  for (const agent of findAgents()) {
    const { cwd, ...rest } = agent
    treeAt(trees, cwd)?.agents.push(rest)
  }
  for (const { path, ...pane } of panes) treeAt(trees, path)?.panes.push(pane)

  return { dir, base, remote, github: githubPage(url), trees }
}

// A conflicted file's conflicts, each with a few lines around it, runs apart split by "…". The worktree's side
// is blue, the base's magenta, and the common ancestor's (with merge.conflictStyle diff3) dim.
const readConflict = async (want: Wanted, conflict: Conflict) => {
  const text = conflict.merged ? await git(want.tree, ['cat-file', 'blob', `${conflict.merged}:${want.file}`]) : readText(`${want.tree}/${want.file}`)
  const all = (text ?? '').replace(/\n$/, '').split('\n')
  const kept = new Set<number>()
  let start = -1
  all.forEach((line, n) => {
    if (/^<{7}( |$)/.test(line)) start = n
    if (/^>{7}( |$)/.test(line) && start !== -1) {
      for (let k = Math.max(0, start - CONFLICT_CONTEXT); k <= Math.min(all.length - 1, n + CONFLICT_CONTEXT); k++) kept.add(k)
      start = -1
    }
  })

  const lines: string[] = []
  const colors: (string | undefined)[] = []
  let side: string | undefined
  let last = -1
  all.forEach((line, n) => {
    const marker = line.match(/^(<{7}|\|{7}|={7}|>{7})( |$)/)?.[1]
    if (kept.has(n)) {
      if (last !== -1 && n !== last + 1) {
        lines.push('…')
        colors.push(undefined)
      }
      last = n
      lines.push(marker === '<<<<<<<' ? `${marker} ${conflict.ours}` : marker === '>>>>>>>' ? `${marker} ${conflict.theirs}` : line)
      colors.push(marker ? 'cyan' : side)
    }
    if (marker) side = marker[0] === '<' ? 'blue' : marker[0] === '|' ? 'gray' : marker[0] === '=' ? 'magenta' : undefined
  })

  return { lines: lines.slice(0, MAX_DIFF_LINES), colors: colors.slice(0, MAX_DIFF_LINES), isCut: lines.length > MAX_DIFF_LINES }
}

// A file's diff from its first hunk on, against HEAD when uncommitted or within its commit.
const readDiff = async (want: Wanted): Promise<Omit<Diff, 'version'>> => {
  if (want.conflict) return readConflict(want, want.conflict)
  const text = want.commit
    ? await git(want.tree, ['show', '--format=', '--no-renames', '--diff-merges=first-parent', want.commit, '--', want.file])
    : want.isUntracked
      ? await git(want.tree, ['diff', '--no-index', '--', '/dev/null', want.file], [0, 1])
      : await git(want.tree, ['diff', 'HEAD', '--no-renames', '--', want.file])
  const lines = (text ?? '').replace(/\n$/, '').split('\n')
  const from = lines.findIndex(l => l.startsWith('@@'))
  const body = from === -1 ? [] : lines.slice(from)

  return { lines: body.slice(0, MAX_DIFF_LINES), isCut: body.length > MAX_DIFF_LINES }
}

// What to show under an open file: its diff, or the file itself.
const readView = async (want: Wanted) => {
  if (!want.isWhole) return readDiff(want)
  const text = readText(`${want.tree}/${want.file}`)
  if (text === null) return { lines: [], isCut: false, isUnreadable: true }
  const lines = toLines(text)

  return { lines: lines.slice(0, MAX_FILE_LINES), isCut: lines.length > MAX_FILE_LINES }
}

// The files of the worktree holding `root`, or failing that of the repository `findRepo` finds:
// git's own list, ignored files left out, and what git reports as changed.
const loadFiles = async (root: string): Promise<Files | null> => {
  const dir = (await git(root, ['rev-parse', '--show-toplevel']))?.trim() || (await findRepo(root))
  if (!dir) return null
  const [listing, status] = await Promise.all([
    git(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
    git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']),
  ])
  if (listing === null) return null
  // A repository nested inside, such as another worktree, is listed as its folder with a trailing slash.
  const all = [...new Set(listing.split('\0').filter(f => f && !f.endsWith('/')))].sort()
  const changes: Record<string, string> = {}
  for (const entry of (status ?? '').split('\0')) {
    if (entry.length >= 4 && !entry.endsWith('/')) changes[entry.slice(3)] = entry.slice(0, 2)
  }

  return { dir, files: all.slice(0, MAX_REPO_FILES), isCut: all.length > MAX_REPO_FILES, status: changes }
}

// Opens `$1` at line `$2` in the running nvim whose folder holds it most closely, bringing its tmux pane forward;
// with none, in a new tmux pane, else a new kitty window. Prints where.
const OPEN_IN_NVIM = `
f="$1"; line="\${2:-1}"; run="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"; best=""; bestlen=-1
for s in "$run"/nvim.*.0; do
  [ -S "$s" ] || continue
  pid=\${s##*/nvim.}; pid=\${pid%.0}
  cwd=$(readlink "/proc/$pid/cwd") || continue
  case "$f" in "$cwd"/*) len=\${#cwd} ;; *) len=0 ;; esac
  if [ "$len" -gt "$bestlen" ]; then best=$s; bestpid=$pid; bestlen=$len; fi
done
if [ -n "$best" ]; then
  # :edit, not --remote, which adds the file to the argument list and makes :q say "E173: 1 more file to edit".
  quoted=$(printf '%s' "$f" | sed "s/'/''/g")
  nvim --server "$best" --remote-expr "execute('edit +$line ' . fnameescape('$quoted'))" >/dev/null || exit 1
  if [ -n "$TMUX" ]; then
    panes=$(tmux list-panes -a -F '#{pane_pid} #{pane_id}')
    p=$bestpid
    for i in 1 2 3 4 5 6 7 8; do
      pane=$(printf '%s\\n' "$panes" | awk -v p="$p" '$1 == p { print $2 }')
      if [ -n "$pane" ]; then tmux select-window -t "$pane"; tmux select-pane -t "$pane"; break; fi
      p=$(awk '{ print $4 }' "/proc/$p/stat" 2>/dev/null)
      [ "\${p:-0}" -gt 1 ] || break
    done
  fi
  echo "the running nvim"; exit 0
fi
if [ -n "$TMUX" ]; then tmux split-window -h nvim "+$line" "$f" && echo "a new tmux pane" && exit 0; fi
setsid -f kitty nvim "+$line" "$f" >/dev/null 2>&1 && echo "a new kitty window"
`

// Opens the file in nvim and says where, or that it couldn't.
const openInNvim = async (file: string, line: number) => {
  try {
    const proc = Bun.spawn(['sh', '-c', OPEN_IN_NVIM, 'sh', file, String(line)], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
    const where = (await new Response(proc.stdout).text()).trim()
    if ((await proc.exited) === 0 && where) return `Opened ${shortPath(file)} in ${where}`
  } catch {
    // No sh, or it failed to start.
  }

  return `Couldn't open ${shortPath(file)} in nvim`
}

// ---- Agents and tmux ----

// The worktree holding `dir` most closely, as a worktree may sit inside another.
const treeAt = <T extends { path: string }>(trees: T[], dir: string) =>
  trees.filter(t => dir === t.path || dir.startsWith(`${t.path}/`)).sort((a, b) => b.path.length - a.path.length)[0]

// The agent a process is, by its name or, when node, bun or python runs it, by its script's name.
const agentOf = (pid: string) => {
  try {
    const name = readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
    if (AGENTS.includes(name)) return name
    if (!/^(node|bun|python[\d.]*)$/.test(name)) return null
    const script = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[1] ?? ''
    const scriptName = script.split('/').pop()!.replace(/\.(js|mjs|cjs|py)$/, '')

    return AGENTS.includes(scriptName) ? scriptName : null
  } catch {
    return null
  }
}

// Whether a claude running in `cwd` wrote to one of its transcripts within BUSY_MS.
// Claude keeps them in ~/.claude/projects/<cwd with all but letters and digits made "-">/.
const isClaudeBusy = (cwd: string) => {
  const dir = `${homedir()}/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}`
  try {
    return readdirSync(dir).some(f => f.endsWith('.jsonl') && Date.now() - modifiedAt(`${dir}/${f}`) < BUSY_MS)
  } catch {
    return false
  }
}

// Every coding agent running and the folder it runs in, read from /proc; none where there is no /proc.
// An agent started by another of its kind, such as a helper process, is left out.
const findAgents = () => {
  let pids: string[]
  try {
    pids = readdirSync('/proc').filter(p => /^\d+$/.test(p))
  } catch {
    return []
  }
  const found = pids.flatMap(pid => {
    const name = agentOf(pid)
    if (!name) return []
    try {
      // The parent's pid is the second field after the name, which ends at the last ")".
      const parent = Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop()!.split(' ')[1])

      return [{ name, pid: Number(pid), parent, cwd: readlinkSync(`/proc/${pid}/cwd`) }]
    } catch {
      return []
    }
  })
  const ids = new Set(found.map(a => a.pid))
  const busy = new Map<string, boolean>()

  return found
    .filter(a => !ids.has(a.parent))
    .map(({ name, pid, cwd }): Agent & { cwd: string } => {
      if (name !== 'claude') return { name, pid, cwd }
      if (!busy.has(cwd)) busy.set(cwd, isClaudeBusy(cwd))

      return { name, pid, cwd, isBusy: busy.get(cwd) }
    })
}

// Every tmux pane but kelp's own and the folder it is in, when kelp runs inside tmux.
const listPanes = async () => {
  if (!process.env.TMUX) return []
  try {
    const format = ['#{pane_id}', '#{session_name}:#{window_index}', '#{window_name}', '#{pane_current_command}', '#{pane_current_path}'].join('\t')
    const proc = Bun.spawn(['tmux', 'list-panes', '-a', '-F', format], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
    const out = await new Response(proc.stdout).text()
    if ((await proc.exited) !== 0) return []

    return out
      .split('\n')
      .map(line => line.split('\t'))
      .filter(f => f.length === 5 && f[0] !== process.env.TMUX_PANE)
      .map(([id, window, windowName, command, path]) => ({ id, window, windowName, command, path }))
  } catch {
    return []
  }
}

// ---- GitHub ----

// A command's output, error output and exit code, or null when it cannot be started, such as gh not being installed.
// It never asks for a password or passphrase, which would hang with nobody to answer.
const runCommand = async (cwd: string, args: string[]) => {
  try {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' }
    const proc = Bun.spawn(args, { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])

    return { out, err, code: await proc.exited }
  } catch {
    return null
  }
}

// The line of a failed command's error output that says why: git's "error:", "fatal:" or "! [rejected]", else the last.
const whyFailed = (err: string) => {
  const lines = err.split('\n').map(l => l.trim()).filter(Boolean)

  return lines.find(l => /^(error|fatal|!|GraphQL|HTTP)/i.test(l)) ?? lines.at(-1) ?? 'no reason given'
}

// What `gh pr list --json` gives for each pull request.
type GhPr = {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  headRefName: string
  reviewDecision: string
  statusCheckRollup: { __typename: string; name?: string; context?: string; status?: string; conclusion?: string; state?: string }[] | null
}
const PR_FIELDS = 'number,title,url,state,isDraft,headRefName,reviewDecision,statusCheckRollup'
const FAILED = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']

// Each branch's pull request from `gh pr list --json`'s output: the open one when it has one, else its newest.
const parsePrs = (text: string) => {
  const prs = new Map<string, Pr>()
  for (const p of JSON.parse(text) as GhPr[]) {
    const state = p.state === 'MERGED' ? 'merged' : p.state === 'CLOSED' ? 'closed' : p.isDraft ? 'draft' : 'open'
    const had = prs.get(p.headRefName)
    if (had && (had.state === 'open' || had.state === 'draft' || state === 'merged' || state === 'closed')) continue
    // A check run has a status and, once completed, a conclusion; a commit status has only a state.
    const checks = p.statusCheckRollup ?? []
    const failing = checks.filter(c => FAILED.includes(c.conclusion || c.state || '')).map(c => c.name || c.context || '?')
    const isPending = checks.some(c => (c.status ? c.status !== 'COMPLETED' : c.state === 'PENDING' || c.state === 'EXPECTED'))
    const review = p.reviewDecision === 'APPROVED' ? 'approved' : p.reviewDecision === 'CHANGES_REQUESTED' ? 'changes requested' : p.reviewDecision === 'REVIEW_REQUIRED' ? 'review required' : ''
    prs.set(p.headRefName, {
      number: p.number,
      title: p.title,
      url: p.url,
      state,
      review,
      checks: checks.length === 0 ? '' : failing.length > 0 ? 'failing' : isPending ? 'pending' : 'passing',
      failing,
    })
  }

  return prs
}

// The pull requests of the GitHub repository at `page` by branch, or null when gh is missing, logged out or fails.
const loadPrs = async (dir: string, page: string) => {
  const run = await runCommand(dir, ['gh', 'pr', 'list', '--repo', page.replace('https://github.com/', ''), '--state', 'all', '--limit', String(MAX_PRS), '--json', PR_FIELDS])
  if (run?.code !== 0) return null
  try {
    return parsePrs(run.out)
  } catch {
    return null
  }
}

// Opens a web page in the browser.
const openInBrowser = (url: string) => {
  try {
    Bun.spawn([process.platform === 'darwin' ? 'open' : 'xdg-open', url], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
    return `Opened ${url}`
  } catch {
    return `Couldn't open ${url}`
  }
}

// ---- Formatting ----

const label = (tree: Tree) => tree.branch || `detached ${tree.head.slice(0, 7)}`

const shortPath = (file: string) => file.replace(homedir(), '~')

// Fits a path into `room` columns: drops leading folders first ("…/app/main.py"),
// then cuts the file name itself only when even that alone cannot fit.
const fitPath = (file: string, room: number) => {
  const full = shortPath(file)
  if (full.length <= room) return full
  const parts = full.split('/')
  const name = parts.pop()!
  for (let keep = parts.length - 1; keep >= 0; keep--) {
    const tail = ['…', ...parts.slice(parts.length - keep), name].join('/')
    if (tail.length <= room) return tail
  }
  if (name.length <= room) return name

  return `${name.slice(0, Math.max(1, room - 1))}…`
}

const ago = (at: number) => {
  const minutes = Math.floor((Date.now() - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`

  return `${Math.floor(minutes / 60 / 24)}d ago`
}

const clockTime = (at: number) => {
  const d = new Date(at)

  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

// Each file touched by worktrees other than the base's, and the branches touching it.
const touchedBy = (repo: Repo) => {
  const branches = new Map<string, string[]>()
  for (const tree of repo.trees.filter(t => !t.isBase)) {
    const files = new Set([...tree.uncommitted, ...tree.commits.flatMap(c => c.files)].map(f => f.path))
    for (const file of files) branches.set(file, [...(branches.get(file) ?? []), label(tree)])
  }

  return branches
}

// The line of the new file each diff line stands at, or for a removed line the one after it.
const newLineNumbers = (lines: string[]) => {
  let next = 1

  return lines.map(line => {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/)
    if (hunk) next = Number(hunk[1])
    const at = Math.max(1, next)
    if (!hunk && !line.startsWith('-')) next++

    return at
  })
}

// ---- Rows ----

// A diff's lines under the row `parent`, each knowing where it is in the new file; `colors` when they carry their own.
const diffRows = (parent: string, file: string, lines: string[], depth: number, colors?: (string | undefined)[]): Row[] => {
  const numbers = newLineNumbers(lines)

  return lines.map((line, n) => {
    const color = colors ? colors[n] : line.startsWith('+') ? 'green' : line.startsWith('-') ? 'red' : line.startsWith('@@') ? 'cyan' : undefined

    return { key: `${parent}\t${n}`, parent, depth, file, line: numbers[n], node: <Text color={color} dimColor={!color} wrap="truncate-end">{line || ' '}</Text> }
  })
}

// The color of a pull request's state, and of its checks.
const PR_COLORS: Record<Pr['state'], string | undefined> = { draft: undefined, open: 'green', merged: 'magenta', closed: 'red' }
const CHECK_PARTS: Record<Pr['checks'], { text: string; color?: string }> = {
  '': { text: '' },
  passing: { text: '✓ checks', color: 'green' },
  failing: { text: '✗ checks', color: 'red' },
  pending: { text: '● checks', color: 'yellow' },
}

// Every line of the view: each worktree's line, and when open its pull request, its uncommitted files and its commits,
// each open file's diff under it. `columns` is the width rows are laid out in; `prs` the pull requests by branch.
const buildRows = (repo: Repo, isOpen: (key: string, byDefault: boolean) => boolean, diffs: Map<string, Diff>, columns: number, prs: Map<string, Pr>) => {
  const rows: Row[] = []
  const wanted: Wanted[] = []
  const others = touchedBy(repo)
  const room = (depth: number) => columns - depth * 2
  const note = (key: string, parent: string, depth: number, text: string) =>
    rows.push({ key, parent, depth, node: <Text dimColor wrap="truncate-end">{text}</Text> })

  // A group's line within a worktree, folded or not: a coloured lead (the commit's hash, or "uncommitted"),
  // its title, then the dim details. No rule, so only worktree lines carry one.
  const groupLine = (key: string, parent: string, lead: { text: string; color: string }, title: string, details: string, count: number, byDefault: boolean) => {
    const open = isOpen(key, byDefault)
    const files = open ? '' : ` · ${count} file${count === 1 ? '' : 's'}`
    const meta = `${details}${files}`
    const fits = room(1) - 2 - lead.text.length - 1 - meta.length - 1
    const name = title.length > fits ? `${title.slice(0, Math.max(1, fits - 1)).trimEnd()}…` : title
    rows.push({
      key,
      parent,
      depth: 1,
      canOpen: true,
      isOpenByDefault: byDefault,
      node: (
        <Text wrap="truncate-end">
          <Text dimColor>{open ? '▾' : '▸'} </Text>
          <Text color={lead.color}>{lead.text}</Text>
          {name && ` ${name}`}
          <Text dimColor>{meta}</Text>
        </Text>
      ),
    })

    return open
  }

  const fileRows = (tree: Tree, change: Change, parent: string, commit?: string) => {
    const key = `${parent}\t${change.path}`
    const open = isOpen(key, false)
    const isConflict = change.tag === 'conflict'
    const stats = change.tag === 'binary' || isConflict ? '' : ` +${change.added} -${change.removed}`
    const tag = change.tag ? ` ${change.tag}` : ''
    const shared = tree.isBase ? [] : (others.get(change.path) ?? []).filter(b => b !== label(tree))
    const also = shared.length > 0 ? ` also in ${shared.join(', ')}` : ''
    const path = fitPath(change.path, Math.max(8, room(2) - 2 - stats.length - tag.length - also.length))
    const file = `${tree.path}/${change.path}`
    rows.push({
      key,
      parent,
      depth: 2,
      canOpen: true,
      file,
      line: 1,
      node: (
        <Text wrap="truncate-end">
          {open ? '▾' : '▸'} <Text bold={open}>{path}</Text>
          {stats && <Text color="green"> +{change.added}</Text>}
          {stats && <Text color="red"> -{change.removed}</Text>}
          {tag && <Text color={change.tag === 'deleted' || isConflict ? 'red' : change.tag === 'new' ? 'blue' : undefined} dimColor={change.tag === 'binary'}>{tag}</Text>}
          {also && <Text color="yellow">{also}</Text>}
        </Text>
      ),
    })
    if (!open) return
    const conflict = isConflict ? { merged: tree.isMerging ? '' : tree.merged, ours: label(tree), theirs: repo.base } : undefined
    wanted.push({ key, tree: tree.path, file: change.path, commit, isUntracked: change.isUntracked, conflict })
    const diff = diffs.get(key)
    if (!diff) return note(`${key}\tloading`, key, 3, 'Loading…')
    if (diff.lines.length === 0) {
      return note(`${key}\tempty`, key, 3, isConflict ? 'Changed on one side, deleted or renamed on the other.' : 'No textual changes.')
    }
    rows.push(...diffRows(key, file, diff.lines, 3, diff.colors))
    if (diff.isCut) note(`${key}\tcut`, key, 3, `… diff cut at ${MAX_DIFF_LINES} lines`)
  }

  for (const tree of repo.trees) {
    const key = `tree\t${tree.path}`
    if (rows.length > 0) rows.push({ key: `${key}\tgap`, depth: 0, isGap: true, node: <Text> </Text> })
    const open = isOpen(key, true)
    const name = label(tree)
    const parts: { text: string; color?: string }[] = []
    // Its agents, alike ones counted together: a busy claude green, an idle one dim, the rest cyan.
    const kinds = new Map<string, { agent: Agent; count: number }>()
    for (const agent of tree.agents) {
      const kind = `${agent.name}\t${agent.isBusy}`
      kinds.set(kind, { agent, count: (kinds.get(kind)?.count ?? 0) + 1 })
    }
    for (const { agent, count } of kinds.values()) {
      const text = `${agent.isBusy === false ? '○' : '●'} ${count > 1 ? `${count} ` : ''}${agent.name}`
      parts.push({ text, color: agent.isBusy ? 'green' : agent.isBusy === undefined ? 'cyan' : undefined })
    }
    // Its tmux panes, by what they run.
    if (tree.panes.length > 0) parts.push({ text: `tmux ${[...new Set(tree.panes.map(p => p.command))].join(', ')}` })
    if (tree.isBase) parts.push({ text: 'base' })
    if (tree.ahead > 0) parts.push({ text: `${tree.ahead} ahead`, color: 'green' })
    if (tree.behind > 0) parts.push({ text: `${tree.behind} behind`, color: 'yellow' })
    const unresolved = tree.uncommitted.filter(c => c.tag === 'conflict').length
    if (tree.isMerging) {
      parts.push({ text: `merging ${repo.base}`, color: 'red' })
      parts.push(unresolved > 0 ? { text: `⚠ ${unresolved} unresolved`, color: 'red' } : { text: 'resolved, ready to commit', color: 'green' })
    } else if (tree.conflicts.length > 0) {
      parts.push({ text: `⚠ ${tree.conflicts.length} conflict${tree.conflicts.length === 1 ? '' : 's'} with ${repo.base}`, color: 'red' })
    } else if (tree.merged) parts.push({ text: 'merges cleanly' })
    if (tree.uncommitted.length > 0) parts.push({ text: `● ${tree.uncommitted.length} uncommitted`, color: 'yellow' })
    // Where it stands against its remote branch; nothing when the repository has no remote.
    if (tree.isUpstreamGone) parts.push({ text: 'upstream gone', color: 'red' })
    else if (tree.unpushed > 0 || tree.unpulled > 0) {
      parts.push({ text: [tree.unpushed > 0 && `↑${tree.unpushed}`, tree.unpulled > 0 && `↓${tree.unpulled}`].filter(Boolean).join(' '), color: 'cyan' })
    }
    else if (tree.upstream) parts.push({ text: 'pushed' })
    else if (repo.remote && tree.branch) parts.push({ text: 'not pushed', color: 'yellow' })
    // Its pull request, the review and checks only while it is still open.
    const pr = tree.isBase ? undefined : prs.get(tree.branch)
    if (pr) {
      parts.push({ text: `#${pr.number} ${pr.state}`, color: PR_COLORS[pr.state] })
      if (pr.state === 'open' || pr.state === 'draft') {
        if (pr.review) parts.push({ text: pr.review, color: pr.review === 'approved' ? 'green' : pr.review === 'changes requested' ? 'red' : undefined })
        if (pr.checks) parts.push(CHECK_PARTS[pr.checks])
      }
    }
    if (!tree.isBase && tree.ahead === 0 && tree.uncommitted.length === 0) parts.push({ text: 'nothing new' })
    if (tree.lastAt > 0) parts.push({ text: ago(tree.lastAt) })
    const right = parts.map(p => p.text).join(' · ')
    // The folder goes first, then the rule, when the line runs short.
    const width = room(0)
    let where = ` ${fitPath(tree.path, Math.max(8, width - name.length - right.length - 6))}`
    if (width - 2 - name.length - where.length - right.length - 2 < 1) where = ''
    const fill = Math.max(1, width - 2 - name.length - where.length - right.length - 2)
    rows.push({
      key,
      depth: 0,
      canOpen: true,
      isOpenByDefault: true,
      node: (
        <Text wrap="truncate-end">
          <Text dimColor>{open ? '▾' : '▸'} </Text>
          <Text bold color={tree.isBase ? undefined : 'blue'}>{name}</Text>
          <Text dimColor>{`${where} ${'━'.repeat(fill)} `}</Text>
          {parts.map((p, k) => (
            <Text key={k}>
              {k > 0 && <Text dimColor> · </Text>}
              <Text color={p.color} dimColor={!p.color}>{p.text}</Text>
            </Text>
          ))}
        </Text>
      ),
    })
    if (!open) continue

    if (pr) {
      const prKey = `${key}\tpr`
      const details = [pr.state, pr.review, pr.checks && `checks ${pr.checks}`].filter(Boolean).join(' · ')
      rows.push({
        key: prKey,
        parent: key,
        depth: 1,
        node: (
          <Text wrap="truncate-end">
            <Text color={PR_COLORS[pr.state]} dimColor={!PR_COLORS[pr.state]}>#{pr.number}</Text> {pr.title}<Text dimColor> · {details}</Text>
          </Text>
        ),
      })
      for (const name of pr.failing) {
        rows.push({ key: `${prKey}\t${name}`, parent: prKey, depth: 2, node: <Text color="red" wrap="truncate-end">✗ {name}</Text> })
      }
    }
    if (tree.conflicts.length > 0) {
      const group = `${key}\tconflicts`
      if (groupLine(group, key, { text: '⚠ conflicts', color: 'red' }, `merging ${repo.base} in`, '', tree.conflicts.length, true)) {
        for (const file of tree.conflicts) fileRows(tree, { path: file, added: 0, removed: 0, tag: 'conflict' }, group)
      }
    }
    if (tree.uncommitted.length > 0) {
      const group = `${key}\tuncommitted`
      if (groupLine(group, key, { text: '● uncommitted', color: 'yellow' }, '', '', tree.uncommitted.length, true)) {
        for (const change of tree.uncommitted) fileRows(tree, change, group)
      }
    }
    for (const commit of tree.commits) {
      const group = `${key}\t${commit.hash}`
      if (groupLine(group, key, { text: commit.hash, color: 'yellow' }, commit.subject, ` · ${ago(commit.at)}`, commit.files.length, false)) {
        for (const change of commit.files) fileRows(tree, change, group, commit.hash)
        if (commit.files.length === 0) note(`${group}\tnone`, group, 2, 'No file changes.')
      }
    }
    if (tree.commits.length === 0 && tree.uncommitted.length === 0) {
      note(`${key}\tnone`, key, 1, `Nothing ahead of ${repo.base} and no uncommitted changes.`)
    }
  }

  return { rows, wanted }
}

// What a git status code says of a file, and its color.
const statusOf = (code: string) =>
  code === '??' ? { text: 'untracked', color: 'blue' }
  : code.includes('D') ? { text: 'deleted', color: 'red' }
  : code.includes('A') ? { text: 'new', color: 'blue' }
  : { text: 'modified', color: 'yellow' }

// The repo tab's lines: the worktree's folders first then its files, each open folder's insides under it,
// and under an open file the file itself or, with `isDiff`, its diff against HEAD.
const buildRepoRows = (files: Files, isOpen: (key: string, byDefault: boolean) => boolean, views: Map<string, Diff>, isDiff: boolean) => {
  const rows: Row[] = []
  const wanted: Wanted[] = []
  const note = (key: string, parent: string, depth: number, text: string) =>
    rows.push({ key, parent, depth, node: <Text dimColor wrap="truncate-end">{text}</Text> })

  // Each folder's folders and files, '' the top.
  const inside = new Map<string, { dirs: Set<string>; files: string[] }>()
  const at = (dir: string) => {
    if (!inside.has(dir)) inside.set(dir, { dirs: new Set(), files: [] })

    return inside.get(dir)!
  }
  for (const file of files.files) {
    const parts = file.split('/')
    for (let k = 1; k < parts.length; k++) at(parts.slice(0, k - 1).join('/')).dirs.add(parts.slice(0, k).join('/'))
    at(parts.slice(0, -1).join('/')).files.push(file)
  }
  const changed = Object.keys(files.status)

  const walk = (dir: string, parent: string | undefined, depth: number) => {
    for (const sub of [...at(dir).dirs].sort()) {
      const key = `dir\t${sub}`
      const open = isOpen(key, false)
      const count = changed.filter(f => f.startsWith(`${sub}/`)).length
      rows.push({
        key,
        parent,
        depth,
        canOpen: true,
        node: (
          <Text wrap="truncate-end">
            <Text dimColor>{open ? '▾' : '▸'} </Text>
            <Text color="blue">{sub.split('/').pop()}/</Text>
            {count > 0 && <Text color="yellow"> ● {count} changed</Text>}
          </Text>
        ),
      })
      if (open) walk(sub, key, depth + 1)
    }

    for (const file of at(dir).files) {
      const key = `file\t${file}`
      const open = isOpen(key, false)
      const code = files.status[file]
      const state = code ? statusOf(code) : undefined
      const path = `${files.dir}/${file}`
      rows.push({
        key,
        parent,
        depth,
        canOpen: true,
        file: path,
        line: 1,
        node: (
          <Text wrap="truncate-end">
            <Text dimColor>{open ? '▾' : '▸'} </Text>
            <Text bold={open} color={state?.color}>{file.split('/').pop()}</Text>
            {state && <Text dimColor> {state.text}</Text>}
          </Text>
        ),
      })
      if (!open) continue

      const view = `${key}\t${isDiff ? 'diff' : 'file'}`
      wanted.push({ key: view, tree: files.dir, file, isUntracked: code === '??', isWhole: !isDiff })
      const shown = views.get(view)
      if (!shown) {
        note(`${view}\tloading`, key, depth + 1, 'Loading…')
      } else if (shown.isUnreadable) {
        note(`${view}\tunreadable`, key, depth + 1, `Not shown: binary, over ${MAX_FILE / 1_000_000} MB, or missing.`)
      } else if (isDiff) {
        if (shown.lines.length === 0) note(`${view}\tempty`, key, depth + 1, 'No changes since the last commit.')
        rows.push(...diffRows(key, path, shown.lines, depth + 1))
        if (shown.isCut) note(`${view}\tcut`, key, depth + 1, `… diff cut at ${MAX_DIFF_LINES} lines`)
      } else {
        if (shown.lines.length === 0) note(`${view}\tempty`, key, depth + 1, 'Empty file.')
        const gutter = String(shown.lines.length).length
        shown.lines.forEach((line, n) => {
          rows.push({
            key: `${view}\t${n}`,
            parent: key,
            depth: depth + 1,
            file: path,
            line: n + 1,
            node: (
              <Text wrap="truncate-end">
                <Text dimColor>{String(n + 1).padStart(gutter)} </Text>
                {line.replace(/\t/g, '    ') || ' '}
              </Text>
            ),
          })
        })
        if (shown.isCut) note(`${view}\tcut`, key, depth + 1, `… cut at ${MAX_FILE_LINES} lines`)
      }
    }
  }
  walk('', undefined, 0)
  if (files.files.length === 0) note('none', '', 0, 'No files.')

  return { rows, wanted }
}

// ---- View ----

const App = ({ root }: { root: string }) => {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [size, setSize] = useState({ columns: stdout.columns, rows: stdout.rows })
  const [tab, setTab] = useState<Tab>('worktrees')
  const [repo, setRepo] = useState<Repo | null | undefined>(undefined)
  // The repo tab's files, read only while it is shown.
  const [files, setFiles] = useState<Files | null | undefined>(undefined)
  // Bumped whenever a refresh finds something changed, so open uncommitted diffs are read again.
  const [version, setVersion] = useState(0)
  const [updatedAt, setUpdatedAt] = useState(0)
  // The rows opened or closed against how they start, in either tab.
  const [toggled, setToggled] = useState(new Set<string>())
  // Diffs and, in the repo tab, whole files, by the row they sit under.
  const [diffs, setDiffs] = useState(new Map<string, Diff>())
  // Whether the repo tab shows an open file or its diff against HEAD.
  const [isDiff, setIsDiff] = useState(false)
  const [notice, setNotice] = useState('')
  // The footer's question, kept in a ref too so keys typed faster than a redraw all land.
  const [prompt, setPromptState] = useState<Prompt | null>(null)
  const promptRef = useRef<Prompt | null>(null)
  const setPrompt = (next: Prompt | null) => {
    promptRef.current = next
    setPromptState(next)
  }
  const [armed, setArmed] = useState<Armed | null>(null)
  // Whether `?`'s list of keys covers the rows.
  const [isHelp, setIsHelp] = useState(false)
  // Each tab keeps its own cursor and scroll.
  const [cursors, setCursors] = useState<Record<Tab, string>>({ worktrees: '', repo: '' })
  // Bumped to draw again after the wheel moves the view and the cursor's row stays the same.
  const [, redraw] = useState(0)
  const tops = useRef<Record<Tab, number>>({ worktrees: 0, repo: 0 })
  const lastIndexes = useRef<Record<Tab, number>>({ worktrees: 0, repo: 0 })
  const tabRef = useRef(tab)
  tabRef.current = tab
  const pending = useRef(new Set<string>())
  const refresh = useRef(async () => {})
  // The pull requests by branch, fetched from GitHub on their own slower clock so they never hold up a refresh.
  const [prs, setPrs] = useState(new Map<string, Pr>())
  const fetchPrs = useRef(async () => {})

  useEffect(() => {
    const onResize = () => setSize({ columns: stdout.columns, rows: stdout.rows })
    stdout.on('resize', onResize)

    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])

  useEffect(() => {
    let isBusy = false
    // A refresh asked for while one runs, run once it is done.
    let isAgain = false
    let seen = ''
    let seenFiles = ''
    refresh.current = async () => {
      if (isBusy) {
        isAgain = true
        return
      }
      isBusy = true
      try {
        const [found, listed] = await Promise.all([loadRepo(root), tabRef.current === 'repo' ? loadFiles(root) : undefined])
        const text = JSON.stringify(found)
        if (text !== seen) {
          seen = text
          setRepo(found)
          setVersion(v => v + 1)
        }
        const listedText = JSON.stringify(listed)
        if (listed !== undefined && listedText !== seenFiles) {
          seenFiles = listedText
          setFiles(listed)
        }
        setUpdatedAt(Date.now())
      } finally {
        isBusy = false
      }
      if (isAgain) {
        isAgain = false
        refresh.current()
      }
    }
    refresh.current()
    const timer = setInterval(() => refresh.current(), REFRESH_MS)

    return () => clearInterval(timer)
  }, [root])

  // Fetches the pull requests when the repository is on GitHub; with gh missing or logged out there are just none.
  const dir = repo?.dir ?? ''
  const github = repo?.github ?? ''
  useEffect(() => {
    if (!github) return
    let isBusy = false
    let seen = ''
    fetchPrs.current = async () => {
      if (isBusy) return
      isBusy = true
      try {
        const found = await loadPrs(dir, github)
        const text = JSON.stringify(found && [...found])
        if (found && text !== seen) {
          seen = text
          setPrs(found)
        }
      } finally {
        isBusy = false
      }
    }
    fetchPrs.current()
    const timer = setInterval(() => fetchPrs.current(), PR_REFRESH_MS)

    return () => {
      clearInterval(timer)
      fetchPrs.current = async () => {}
    }
  }, [dir, github])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), NOTICE_MS)

    return () => clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(null), NOTICE_MS)

    return () => clearTimeout(timer)
  }, [armed])

  const isOpen = (key: string, byDefault: boolean) => byDefault !== toggled.has(key)
  // Gutter of two, and one column spare so a row never touches the edge and wraps.
  const columns = Math.max(20, size.columns - 3)
  const empty = { rows: [] as Row[], wanted: [] as Wanted[] }
  const { rows, wanted } =
    tab === 'repo' ? (files ? buildRepoRows(files, isOpen, diffs, isDiff) : empty) : repo ? buildRows(repo, isOpen, diffs, columns, prs) : empty
  // The repo tab reads its open files again on every refresh, as an edit need not change what git reports.
  const current = tab === 'repo' ? updatedAt : version

  // Reads each open file's diff or text not yet read, and an uncommitted one again after a change.
  useEffect(() => {
    for (const want of wanted) {
      const have = diffs.get(want.key)
      if ((have && (want.commit || have.version === current)) || pending.current.has(want.key)) continue
      pending.current.add(want.key)
      readView(want).then(view => {
        pending.current.delete(want.key)
        setDiffs(cur => new Map(cur).set(want.key, { ...view, version: current }))
      })
    }
  })

  // The cursor stays on its row across refreshes; when that row goes, it stays where it was.
  const cursor = cursors[tab]
  let index = rows.findIndex(r => r.key === cursor)
  if (index === -1) index = Math.min(lastIndexes.current[tab], rows.length - 1)
  lastIndexes.current[tab] = Math.max(0, index)
  const height = Math.max(1, size.rows - 3)
  let top = tops.current[tab]
  if (index < top) top = Math.max(0, index)
  if (index >= top + height) top = index - height + 1
  top = Math.max(0, Math.min(top, rows.length - height))
  tops.current[tab] = top

  const setCursor = (key: string) => setCursors(cur => ({ ...cur, [tab]: key }))
  // Moves to row `k`, or on past it by `step` when it is a gap.
  const moveTo = (k: number, step: 1 | -1) => {
    let at = Math.max(0, Math.min(rows.length - 1, k))
    while (rows[at]?.isGap) at += step
    if (rows[at]) setCursor(rows[at].key)
  }
  const toggle = (key: string) => setToggled(cur => {
    const next = new Set(cur)
    if (!next.delete(key)) next.add(key)

    return next
  })
  const row = rows[index]
  const parentOf = (r: Row) => rows.find(p => p.key === r.parent)
  // Opens or closes the row under the cursor, or the row it sits under when it does neither.
  const press = (want?: boolean) => {
    if (!row) return
    const target = row.canOpen ? row : parentOf(row)
    if (!target) return
    if (want === undefined || isOpen(target.key, target.isOpenByDefault === true) !== want) toggle(target.key)
    if (target !== row) setCursor(target.key)
  }
  const switchTab = (next: Tab) => {
    if (next === tab) return
    setTab(next)
    tabRef.current = next
    refresh.current()
  }

  // Scrolls the view by `lines`, bringing the cursor along when it would fall off the screen.
  const scroll = (lines: number) => {
    const to = Math.max(0, Math.min(rows.length - height, top + lines))
    tops.current[tab] = to
    if (index < to) moveTo(to, 1)
    else if (index >= to + height) moveTo(to + height - 1, -1)
    redraw(n => n + 1)
  }

  // A mouse report: SGR's "[<button;column;line" then M when pressed, m when let go.
  // A left click on a tab's name in the header switches to it; on a row it puts the cursor there
  // and opens or closes it. The wheel scrolls.
  const onMouse = (button: number, column: number, line: number) => {
    // Shift, alt and ctrl only add to the button's number.
    const base = button & ~(4 | 8 | 16)
    if (base === 64) return scroll(-WHEEL_LINES)
    if (base === 65) return scroll(WHEEL_LINES)
    if (base !== 0) return
    // The header reads "kelp  worktrees repo": worktrees in columns 7 to 15, repo in 17 to 20.
    if (line === 1 && column >= 7 && column <= 15) return switchTab('worktrees')
    if (line === 1 && column >= 17 && column <= 20) return switchTab('repo')
    // The header is the first line, so the rows start on the second.
    const clicked = rows[top + line - 2]
    if (line < 2 || line - 2 >= height || !clicked || clicked.isGap) return
    setCursor(clicked.key)
    if (clicked.canOpen) toggle(clicked.key)
  }

  // Merges the base into the worktree under the cursor, or aborts the merge it is in, on a second press.
  // A merge needs nothing uncommitted, and stops with its conflicts in the files for the person to resolve and commit.
  const act = (kind: 'merge' | 'abort') => {
    const tree = repo?.trees.find(t => row?.key.split('\t')[1] === t.path)
    if (!repo || !tree) return
    const name = label(tree)
    if (kind === 'abort' && !tree.isMerging) return setNotice(`${name} is not merging anything.`)
    if (kind === 'merge') {
      if (tree.isBase) return setNotice(`${name} is the base branch.`)
      if (tree.isMerging) return setNotice(`${name} is already merging ${repo.base}: resolve and commit, or U to abort.`)
      if (tree.behind === 0) return setNotice(`${name} already has everything in ${repo.base}.`)
      if (tree.uncommitted.length > 0) return setNotice(`${name} has uncommitted changes: commit them first.`)
    }
    const n = tree.conflicts.length
    const leaving = n > 0 ? `, leaving ${n} conflict${n === 1 ? '' : 's'} to resolve` : ''
    const asking = kind === 'merge' ? `Merge ${repo.base} into ${name}${leaving}` : `Abort ${name}'s merge and put it back as it was`

    confirm(kind === 'merge' ? 'u' : 'U', asking, async () => {
      setNotice(kind === 'merge' ? `Merging ${repo.base} into ${name}…` : `Aborting ${name}'s merge…`)
      const run = await gitRun(tree.path, kind === 'merge' ? ['merge', '--no-edit', repo.base] : ['merge', '--abort'])
      await refresh.current()
      if (kind === 'abort') return setNotice(run?.code === 0 ? `Aborted ${name}'s merge.` : `Could not abort: run git merge --abort in ${shortPath(tree.path)} to see why.`)
      if (run?.code === 0) return setNotice(`Merged ${repo.base} into ${name}.`)
      if (run?.code === 1) return setNotice(`Merged ${repo.base} into ${name} with conflicts: resolve them and commit, or U to abort.`)
      setNotice(`The merge failed: run git merge ${repo.base} in ${shortPath(tree.path)} to see why.`)
    })
  }

  // Asks `label` in the footer, then calls `onDone` with the answer, unless esc is pressed.
  const ask = (label: string, onDone: (answer: string) => void, text = '') => setPrompt({ label, text, onDone })

  // Runs `run` when `input` is pressed a second time on the same row; the first press says `text` in the footer.
  const confirm = (input: string, text: string, run: () => void) => {
    const at = row?.key ?? ''
    if (armed && armed.input === input && armed.row === at) {
      setArmed(null)
      run()
    } else {
      setArmed({ input, row: at, text, run })
    }
  }

  // A key typed while the footer asks a question: ⏎ answers, esc gives up, backspace and ctrl+u erase.
  const typeInPrompt = (input: string, key: { return: boolean; escape: boolean; backspace: boolean; delete: boolean; ctrl: boolean; meta: boolean }) => {
    const p = promptRef.current!
    if (key.escape) return setPrompt(null)
    if (key.return) {
      setPrompt(null)
      return p.onDone(p.text.trim())
    }
    if (key.backspace || key.delete) return setPrompt({ ...p, text: p.text.slice(0, -1) })
    if (key.ctrl && input === 'u') return setPrompt({ ...p, text: '' })
    if (key.ctrl || key.meta) return
    setPrompt({ ...p, text: p.text + input.replace(/[\r\n\t]/g, '') })
  }

  useInput((input, key) => {
    const mouse = input.match(/^\[<(\d+);(\d+);(\d+)([Mm])$/)
    if (mouse) {
      if (mouse[4] === 'M') onMouse(Number(mouse[1]), Number(mouse[2]), Number(mouse[3]))
      return
    }
    if (promptRef.current) return typeInPrompt(input, key)
    // Any other key lets an armed action go.
    if (armed && input !== armed.input) setArmed(null)
    if (isHelp) {
      if (input === '?' || input === 'q' || key.escape) setIsHelp(false)
    }
    else if (input === '?') setIsHelp(true)
    else if (input === 'q') exit()
    else if (input === 'u' && !key.ctrl && tab === 'worktrees') act('merge')
    else if (input === 'U' && tab === 'worktrees') act('abort')
    else if (input === 'r') refresh.current()
    else if (key.tab) switchTab(tab === 'worktrees' ? 'repo' : 'worktrees')
    else if (input === '1') switchTab('worktrees')
    else if (input === '2') switchTab('repo')
    else if (input === 'd' && !key.ctrl && tab === 'repo') setIsDiff(v => !v)
    else if (input === 'o') {
      // A row with no file of its own, such as "Loading…", opens the file it sits under.
      const at = row?.file ? row : row && parentOf(row)
      if (at?.file) openInNvim(at.file, at.line ?? 1).then(setNotice)
    }
    else if (key.upArrow || input === 'k') moveTo(index - 1, -1)
    else if (key.downArrow || input === 'j') moveTo(index + 1, 1)
    else if (key.pageUp || (key.ctrl && input === 'u')) moveTo(index - height, -1)
    else if (key.pageDown || (key.ctrl && input === 'd')) moveTo(index + height, 1)
    else if (input === 'g') moveTo(0, 1)
    else if (input === 'G') moveTo(rows.length - 1, -1)
    else if (key.return || input === ' ') press()
    else if (key.rightArrow || input === 'l') press(true)
    else if (key.leftArrow || input === 'h') {
      // Closes an open row, else steps out to the row it sits under.
      if (row?.canOpen && isOpen(row.key, row.isOpenByDefault === true)) toggle(row.key)
      else if (row?.parent) setCursor(row.parent)
    }
  })

  const tabName = (name: Tab) => (
    <Text bold={tab === name} dimColor={tab !== name} underline={tab === name}>{name}</Text>
  )
  const shared = repo ? [...touchedBy(repo).values()].filter(b => b.length > 1).length : 0
  const conflicting = repo ? repo.trees.filter(t => t.conflicts.length > 0).length : 0
  const changed = files ? Object.keys(files.status).length : 0
  const header = (
    <Text wrap="truncate-end">
      <Text bold>kelp</Text>  {tabName('worktrees')} {tabName('repo')}
      {tab === 'worktrees' && repo && (
        <Text dimColor>  {shortPath(repo.dir)} · {repo.trees.length} worktree{repo.trees.length === 1 ? '' : 's'} · base {repo.base}</Text>
      )}
      {tab === 'worktrees' && conflicting > 0 && (
        <Text color="red"> · {conflicting} worktree{conflicting === 1 ? '' : 's'} would conflict with {repo?.base}</Text>
      )}
      {tab === 'worktrees' && shared > 0 && <Text color="yellow"> · {shared} file{shared === 1 ? '' : 's'} changed in more than one worktree</Text>}
      {tab === 'repo' && files && (
        <Text dimColor>  {shortPath(files.dir)} · {files.files.length}{files.isCut ? '+' : ''} files · showing {isDiff ? 'diffs vs HEAD' : 'files'}</Text>
      )}
      {tab === 'repo' && changed > 0 && <Text color="yellow"> · {changed} changed</Text>}
    </Text>
  )
  // The footer keeps to the keys most wanted here; `?` lists them all.
  const keys = isHelp
    ? '? esc close'
    : tab === 'repo'
      ? `↑↓ move · ⏎ open/close · d ${isDiff ? 'files' : 'diffs'} · o nvim · tab worktrees · ? keys · q quit`
      : `↑↓ move · ⏎ open/close · o nvim · u merge ${repo?.base ?? 'base'} in · tab repo · ? keys · q quit`
  // The width of the widest key, so every area's descriptions line up.
  const keyWidth = Math.max(...KEYS.flatMap(a => a.keys.map(([k]) => k.length)))
  const help = (
    <Box flexDirection="row" flexWrap="wrap">
      {KEYS.map(a => (
        <Box key={a.area} flexDirection="column" marginRight={4} marginBottom={1}>
          <Text bold>{a.area}</Text>
          {a.keys.map(([k, what]) => (
            <Text key={k} wrap="truncate-end">
              <Text color="blue">{k.padEnd(keyWidth)}</Text>  <Text dimColor>{what}</Text>
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  )

  return (
    <Box flexDirection="column" height={size.rows - 1}>
      {header}
      {isHelp && <Box flexDirection="column" flexGrow={1}>{help}</Box>}
      <Box flexDirection="column" flexGrow={1} display={isHelp ? 'none' : 'flex'}>
        {tab === 'worktrees' && repo === undefined && <Text dimColor>Reading worktrees…</Text>}
        {tab === 'worktrees' && repo === null && <Text dimColor>No git repository here, nor in any folder directly inside {shortPath(root)}.</Text>}
        {tab === 'repo' && files === undefined && <Text dimColor>Listing the repository…</Text>}
        {tab === 'repo' && files === null && <Text dimColor>No git repository here, nor in any folder directly inside {shortPath(root)}.</Text>}
        {rows.slice(top, top + height).map((r, k) => {
          const isCursor = top + k === index

          return (
            <Box key={r.key} flexWrap="nowrap">
              <Text color="blue" bold>{isCursor ? '› ' : '  '}</Text>
              <Box paddingLeft={r.depth * 2} width={columns}>{r.node}</Box>
            </Box>
          )
        })}
      </Box>
      {prompt ? (
        <Text wrap="truncate-start">
          <Text color="blue" bold>{prompt.label}</Text> {prompt.text}<Text inverse> </Text>
          <Text dimColor> · ⏎ ok · esc cancel</Text>
        </Text>
      ) : armed ? (
        <Text wrap="truncate-end">
          <Text color="red">{armed.text}</Text>
          <Text dimColor> · press {armed.input} again to go ahead, any other key to keep it</Text>
        </Text>
      ) : (
        <Text dimColor wrap="truncate-end">
          {notice ? <Text color="yellow">{notice}</Text> : keys}
          {!notice && updatedAt > 0 ? ` · updated ${clockTime(updatedAt)}` : ''}
        </Text>
      )}
    </Box>
  )
}

// ---- Main ----

const root = resolve(process.argv[2] ?? process.cwd())
// The alternate screen, so quitting gives the terminal back as it was,
// and mouse reports in SGR form: clicks and the wheel, not plain movement.
process.stdout.write('\x1b[?1049h\x1b[H\x1b[?1000h\x1b[?1006h')
const app = render(<App root={root} />)
await app.waitUntilExit()
process.stdout.write('\x1b[?1006l\x1b[?1000l\x1b[?1049l')
