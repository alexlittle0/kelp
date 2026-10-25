#!/usr/bin/env bun
import { closeSync, cpSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import hljs from 'highlight.js'
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
// Columns a tab stop is apart in shown code, and the characters of a line of code kept, the rest cut with "…".
const TAB_WIDTH = 4
const MAX_LINE = 500
// Files the repo tab lists at most.
const MAX_REPO_FILES = 20_000
// How long a message, such as where a file was opened, stays in the footer.
const NOTICE_MS = 4000
// How long kelp waits after the last change before saving what it remembers.
const SAVE_MS = 500
// Opened or closed rows remembered at most, the latest kept.
const MAX_TOGGLED = 1000
// Lines of a command's output kept, and shown under its worktree.
const RUN_KEEP = 200
const RUN_LINES = 12
// Lines the view moves per turn of the mouse wheel.
const WHEEL_LINES = 3
// Ignored files a new worktree gets a copy of from the main one, besides those .kelp.json names.
const COPY_ALWAYS = ['.env', '.env.*', '**/.env', '**/.env.*']
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
// Fetching never stops to ask for a password, as kelp has no terminal to ask in: it fails instead.
const FETCH_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  ...(process.env.GIT_SSH_COMMAND ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }),
}
// The coding agents kelp looks for among running processes.
const AGENTS = ['claude', 'codex', 'aider', 'gemini', 'opencode', 'cursor-agent']
// A claude counts as busy while its transcript was written this recently.
const BUSY_MS = 30_000
// A claude whose tool call has waited this long with nothing running for it is asking leave to run it.
const ASKING_MS = 5000
// A claude done with its turn counts as waiting for this long, then only as idle.
const WAITING_MS = 60 * 60_000
// A claude whose transcript ends on a prompt or a tool's result is waiting on its model, quietly while it thinks;
// past this long something went wrong, and it counts as idle.
const THINKING_MS = 10 * 60_000
// Attempts `N` makes at once at most, with a branch such as fix-login*3.
const MAX_ATTEMPTS = 9
// How soon a second `A` must follow the first to go on to the worktree's tmux pane.
const AGAIN_MS = 2000
// How much of the end of a claude transcript is read.
const TRANSCRIPT_TAIL = 256 * 1024
// Tools that run a while with no process of their own, so a call to one waiting is no sign of asking.
const LONG_TOOLS = ['Agent', 'Task', 'WebFetch', 'WebSearch']
// The ports handed to worktrees, one each from a hash of its branch, so it stays the same across restarts.
const PORT_FROM = 10_000
const PORT_COUNT = 10_000

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
    area: 'find',
    keys: [
      ['s', 'worktrees by name, recent activity, or needing attention first'],
      ['/', 'filter the tab as you type, fzf style; ⏎ keep, esc drop'],
      ['esc', 'clear the filter'],
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
    area: 'worktrees',
    keys: [
      ['n', 'new worktree: asks for a branch'],
      ['x', 'remove the worktree, and its branch when merged (twice)'],
      ['X', 'remove it even with uncommitted changes or unmerged commits (twice)'],
      ['C', 'clean up: prune missing worktrees, remove clean merged ones (twice)'],
    ],
  },
  {
    area: 'agents',
    keys: [
      ['t', 'jump to the worktree: its tmux pane, else a new window there'],
      ['a', 'start claude in the worktree, in a new window'],
      ['N', 'new task: a new worktree for a branch, and claude started in it on a prompt; name*3 for 3 attempts'],
      ['A', 'next worktree with an agent waiting for you; again soon, to its tmux pane'],
      ['>', "reply: type a message into the worktree's claude, in its tmux pane; on a diff line, a note on it; y/n when it asks leave"],
    ],
  },
  {
    area: 'merge',
    keys: [
      ['u', 'merge the base branch into the worktree (twice)'],
      ['m', 'merge the worktree\'s branch into the base branch (twice)'],
      ['R', 'rebase the worktree onto the base branch (twice)'],
      ['U', 'abort a merge or rebase under way (twice)'],
      ['S', 'sync every worktree with the base branch, skipping any it can\'t do safely (twice)'],
    ],
  },
  {
    area: 'run',
    keys: [
      ['!', 'run a shell command in the worktree'],
      [':', 'run one of its commands: .kelp.json or package.json'],
      ['K', 'stop the command running in the worktree (twice), or clear one that ended'],
      ['B', 'open the worktree\'s dev server in the browser'],
    ],
  },
  {
    area: 'git',
    keys: [
      ['c', 'commit what is staged, or with nothing staged everything, asking for the message'],
      ['+ -', 'stage, unstage the uncommitted file (on "uncommitted": all; in its diff: the hunk)'],
      ['z', 'stash the uncommitted changes, untracked included, asking for a message'],
      ['Z', 'pop the stash under the cursor, or the worktree\'s latest (twice)'],
      ['D', "discard an uncommitted file's changes (twice)"],
      ['y', 'copy the path of the file or worktree'],
      ['e', 'open the file or worktree in $EDITOR (nvim by default)'],
      ['w', 'switch: quit and cd the shell to the worktree (see README)'],
    ],
  },
  {
    area: 'remote',
    keys: [
      ['p', 'push the branch, setting its upstream the first time'],
      ['P', 'push and open a pull request with gh (twice)'],
      ['b', 'open its pull request, or branch, on GitHub'],
      ['f', 'fetch every remote, then refresh'],
    ],
  },
  {
    area: 'kelp',
    keys: [
      ['r', 'refresh now'],
      ['?', 'these keys; j k scroll them, esc or ? closes'],
      ['q', 'quit'],
    ],
  },
]

// ---- Types ----

// A changed file: its path in the worktree, its line counts, and whether it is new, deleted or binary.
// An uncommitted one may be staged, all of it or only partly, with more changes since.
type Change = { path: string; added: number; removed: number; tag: '' | 'new' | 'deleted' | 'binary' | 'conflict'; isUntracked?: boolean; stage?: 'staged' | 'partly' }

type Commit = { hash: string; at: number; subject: string; files: Change[] }

// A stash made on a worktree's branch: its place in the stash list ("stash@{0}"), its commit, when, its message,
// and the files it holds, untracked ones (kept in its third parent) marked so.
type Stash = { ref: string; hash: string; at: number; message: string; files: Change[] }

// A worktree: where it is, what it has checked out, how far it is from the base branch, and what it holds.
type Tree = {
  path: string
  branch: string
  head: string
  isBase: boolean
  // The repository's first worktree, which git cannot remove.
  isMain: boolean
  // Its folder is gone, so `git worktree prune` would drop it; locked, it is kept from being pruned or removed.
  isMissing: boolean
  isLocked: boolean
  lockReason: string
  ahead: number
  behind: number
  // Whether its branch is fully in the base after commits of its own, so it is safe to remove;
  // a branch made but never committed to is not.
  isMerged: boolean
  commits: Commit[]
  uncommitted: Change[]
  // The stashes made on its branch, newest first.
  stashes: Stash[]
  // Merging the base in, worked out in memory: the merged tree ('' when not worked out, as nothing is behind
  // or a merge is under way) and the files that would conflict.
  merged: string
  conflicts: string[]
  // Whether a merge or a rebase is under way, its conflicted files among the uncommitted ones,
  // and for a rebase how far it has got ("1/3").
  isMerging: boolean
  isRebasing: boolean
  rebaseStep: string
  // What its commits change against the base since it left it: files, and lines added and removed.
  diffStat: { files: number; added: number; removed: number }
  // Its newest commit or edited file, ms since the epoch.
  lastAt: number
  // The coding agents running in it.
  agents: Agent[]
  // The tmux panes whose folder is in it.
  panes: Pane[]
  // The ports that processes running in it listen on, reachable at localhost.
  ports: number[]
  // The remote branch it tracks, such as "origin/feature", or '' when it tracks none,
  // how far it is ahead of and behind that, and whether that branch is gone from the remote.
  upstream: string
  unpushed: number
  unpulled: number
  isUpstreamGone: boolean
}

// A coding agent running in a worktree. Only for claude, from its transcript: whether it is busy, whether it waits
// for the person (its turn done, or with `isAsking` asking leave to run a tool), what it last said or asks to run,
// and while busy when its turn began, ms since the epoch.
type Agent = { name: string; pid: number; isBusy?: boolean; isWaiting?: boolean; isAsking?: boolean; says?: string; turnAt?: number }

// How a claude transcript ends: its turn done, a tool call not yet answered, stopped by the person, or still working;
// `turnAt` when the person last prompted it, 0 when that is not in the part read.
type Ending = { kind: 'done' | 'tool' | 'stopped' | 'working'; at: number; tool?: string; says: string; turnAt: number }

// A tmux pane: its id, its window as "session:index", that window's name, what it runs, and its first process.
type Pane = { id: string; window: string; windowName: string; command: string; pid: number }

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
// else they are coloured as a diff. `tokens` are each line's code highlighted, when its language is known,
// and `numbers` the line of the file each one is, for a conflict's lines.
type Diff = {
  lines: string[]
  colors?: (string | undefined)[]
  tokens?: (Token[] | undefined)[]
  numbers?: number[]
  isCut: boolean
  isUnreadable?: boolean
  version: number
}

// A piece of a highlighted line of code, and how it looks.
type Token = { text: string; color?: string; isDim?: boolean; isItalic?: boolean; isBold?: boolean }
type Style = Omit<Token, 'text'>

type Tab = 'worktrees' | 'repo'

// What kelp remembers across restarts: the tab, the rows opened or closed against how they start,
// each tab's cursor and filter, and whether the repo tab shows diffs.
type Saved = { tab: Tab; toggled: string[]; cursors: Record<Tab, string>; filters: Record<Tab, string>; isDiff: boolean; sort: Sort }

// The order of the worktrees after the base branch's, which always comes first: by name, by recent activity,
// or those that want a look first.
type Sort = 'name' | 'recent' | 'attention'

// A one-line question asked in the footer, such as a new branch's name: what it asks, what is typed so far,
// and what is done with the answer once ⏎ is pressed.
// `onChange` sees the text after each key, for a filter that narrows as it is typed; `onCancel` is called on esc.
type Prompt = { label: string; text: string; onDone: (answer: string) => void; onChange?: (text: string) => void; onCancel?: () => void }

// A destructive action waiting for its key to be pressed again on the same row: what it will do, said in the footer.
type Armed = { input: string; row: string; text: string; run: () => void }

// A shell command run in a worktree: what and when, its last lines of output, the localhost address it mentions,
// and once it ends its exit code (null when a signal stopped it).
type Run = { tree: string; command: string; startedAt: number; endedAt?: number; code?: number | null; lines: string[]; url?: string; pid: number }

// What kelp is doing to a worktree, such as running its postCreate commands, shown under its line; `isFailed` once it went wrong.
type Job = { text: string; isFailed?: boolean }

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

// Applies a patch to the index, or with `isReverse` takes it back out: null when it worked, else why not.
const applyToIndex = async (cwd: string, patch: string, isReverse: boolean) => {
  try {
    const args = ['git', 'apply', '--cached', ...(isReverse ? ['--reverse'] : []), '-']
    const proc = Bun.spawn(args, { cwd, stdin: new TextEncoder().encode(patch), stdout: 'ignore', stderr: 'pipe' })
    const err = await new Response(proc.stderr).text()

    return (await proc.exited) === 0 ? null : whyFailed(err).replace(/^(fatal|error): /, '')
  } catch {
    return "git couldn't start"
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

// The worktrees git knows of, leaving out bare ones, with whether each one's folder is gone and whether it is locked,
// and why when the lock says. Git lists the main one first.
const listWorktrees = async (dir: string) => {
  const text = (await git(dir, ['worktree', 'list', '--porcelain'])) ?? ''

  return text
    .split('\n\n')
    .map((block, n) => {
      const lines = block.split('\n')
      const value = (name: string) => lines.find(l => l.startsWith(`${name} `))?.slice(name.length + 1) ?? ''
      const path = value('worktree')

      return {
        path,
        head: value('HEAD'),
        branch: value('branch').replace(/^refs\/heads\//, ''),
        isMain: n === 0,
        isMissing: !existsSync(path),
        isLocked: lines.some(l => l === 'locked' || l.startsWith('locked ')),
        lockReason: value('locked'),
        isBare: lines.includes('bare'),
      }
    })
    .filter(w => w.path && !w.isBare)
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

// A line of code as it is shown: tabs out to the next tab stop, a Windows line ending dropped, other control
// characters, which would upset the terminal, as "·", and a very long line, such as minified code, cut.
const cleanLine = (line: string) => {
  let text = ''
  for (const c of line.replace(/\r$/, '').slice(0, MAX_LINE)) {
    text += c === '\t' ? ' '.repeat(TAB_WIDTH - (text.length % TAB_WIDTH)) : c < ' ' || c === '\x7f' ? '·' : c
  }

  return line.length > MAX_LINE ? `${text}…` : text
}

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
    // The first letter is the index's, the second the working tree's.
    const stage = isConflict || code[0] === ' ' ? undefined : code[1] === ' ' ? 'staged' : 'partly'
    changes.push({ path: file, added: count?.[0] ?? 0, removed: count?.[1] ?? 0, tag, ...(stage && { stage }) })
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

// A rebase under way: the branch it rebases (the worktree's HEAD is detached meanwhile) and how far it has got,
// from the notes git keeps in its rebase folder.
const readRebase = async (path: string) => {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const dir = (await git(path, ['rev-parse', '--git-path', name]))?.trim()
    if (!dir || !existsSync(resolve(path, dir))) continue
    const note = (file: string) => readText(resolve(path, dir, file))?.trim() ?? ''
    const [step, total] = name === 'rebase-merge' ? [note('msgnum'), note('end')] : [note('next'), note('last')]

    return { branch: note('head-name').replace(/^refs\/heads\//, ''), step: step && total ? `${step}/${total}` : '' }
  }

  return null
}

// `git diff --shortstat`'s "3 files changed, 10 insertions(+), 2 deletions(-)" as numbers.
const parseShortstat = (text: string) => {
  const count = (pattern: RegExp) => Number(text.match(pattern)?.[1] ?? 0)

  return { files: count(/(\d+) files? changed/), added: count(/(\d+) insertions?/), removed: count(/(\d+) deletions?/) }
}

const loadTree = async (
  w: { path: string; head: string; branch: string; isMain: boolean; isMissing: boolean; isLocked: boolean; lockReason: string },
  base: string,
  upstreams: Upstreams,
): Promise<Tree> => {
  const isBase = w.branch === base
  const range = isBase ? [`-${BASE_COMMITS}`, 'HEAD'] : [`-${MAX_COMMITS}`, `${base}..HEAD`]
  const [log, counts, uncommitted, headAt, mergeHead, rebase] = await Promise.all([
    git(w.path, ['log', ...range, '--format=%x01%h%x00%ct%x00%s', '--numstat', '--summary', '--no-renames', '--diff-merges=first-parent']),
    isBase ? Promise.resolve('0\t0') : git(w.path, ['rev-list', '--left-right', '--count', `${base}...HEAD`]),
    readUncommitted(w.path),
    git(w.path, ['log', '-1', '--format=%ct']),
    git(w.path, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD']),
    readRebase(w.path),
  ])
  const [behind, ahead] = (counts ?? '0\t0').trim().split(/\s+/).map(Number)
  // The branch's reflog says whether anything was ever committed to it.
  const reflog = !isBase && ahead === 0 && w.branch ? await git(w.path, ['reflog', 'show', '--format=%gs', `refs/heads/${w.branch}`]) : null
  const isMerged = (reflog ?? '').split('\n').some(l => l.startsWith('commit'))
  const isMerging = mergeHead !== null
  const shortstat = ahead > 0 ? await git(w.path, ['diff', '--shortstat', `${base}...HEAD`]) : ''
  const { merged, conflicts } = behind > 0 && !isMerging && !rebase ? await readConflicts(w.path, base, uncommitted.length > 0) : { merged: '', conflicts: [] }
  const edited = uncommitted.map(c => modifiedAt(`${w.path}/${c.path}`))

  return {
    ...w,
    branch: w.branch || rebase?.branch || '',
    isBase,
    ahead,
    behind,
    isMerged,
    commits: parseLog(log ?? ''),
    uncommitted,
    merged,
    conflicts,
    isMerging,
    isRebasing: rebase !== null,
    rebaseStep: rebase?.step ?? '',
    diffStat: parseShortstat(shortstat ?? ''),
    lastAt: Math.max(Number(headAt ?? 0) * 1000, ...edited),
    stashes: [],
    agents: [],
    panes: [],
    ports: [],
    ...(upstreams.get(w.branch) ?? { upstream: '', unpushed: 0, unpulled: 0, isUpstreamGone: false }),
  }
}

// The repository's stashes, which every worktree shares, made on one of `branches`, by branch, newest first.
// Git names the branch in the stash's subject: "On <branch>: <message>", or "WIP on <branch>: <hash> <subject>".
const readStashes = async (dir: string, branches: string[]) => {
  const text = (await git(dir, ['stash', 'list', '--format=%gd%x00%H%x00%ct%x00%gs'])) ?? ''
  const listed = text
    .split('\n')
    .map(line => {
      const [ref, hash, time, subject] = line.split('\0')
      const found = subject?.match(/^(?:WIP on|On) ([^:]+): (.*)$/)

      return { ref, hash, at: Number(time) * 1000, branch: found?.[1] ?? '', message: found?.[2] ?? '' }
    })
    .filter(s => s.branch && branches.includes(s.branch))
  const stashes = new Map<string, Stash[]>()
  const read = listed.map(async ({ branch, ...stash }) => {
    const hash = stash.hash
    // Its tracked changes against the commit it was made on, and its untracked files, when it has any.
    const format = '--format=%x01%h%x00%ct%x00%s'
    const [tracked, untracked] = await Promise.all([
      git(dir, ['log', '-1', format, '--numstat', '--summary', '--no-renames', '--diff-merges=first-parent', hash]),
      git(dir, ['log', '-1', format, '--numstat', '--summary', '--no-renames', `${hash}^3`]),
    ])
    const files = [
      ...(parseLog(tracked ?? '')[0]?.files ?? []),
      ...(parseLog(untracked ?? '')[0]?.files ?? []).map(f => ({ ...f, isUntracked: true })),
    ]

    return { branch, stash: { ...stash, files } }
  })
  for (const { branch, stash } of await Promise.all(read)) stashes.set(branch, [...(stashes.get(branch) ?? []), stash])

  return stashes
}

// Every worktree of the repository at or under `root`, the base branch's first and the rest by branch name.
const loadRepo = async (root: string): Promise<Repo | null> => {
  const dir = await findRepo(root)
  if (!dir) return null
  const worktrees = await listWorktrees(dir)
  const [base, remote, upstreams] = await Promise.all([findBase(dir, worktrees[0]?.branch ?? ''), findRemote(dir), readUpstreams(dir)])
  const url = remote ? ((await git(dir, ['remote', 'get-url', remote])) ?? '') : ''
  const [trees, panes, stashes] = await Promise.all([Promise.all(worktrees.map(w => loadTree(w, base, upstreams))), listPanes(), readStashes(dir, worktrees.map(w => w.branch))])
  trees.sort((a, b) => Number(b.isBase) - Number(a.isBase) || label(a).localeCompare(label(b)))
  for (const tree of trees) tree.stashes = (tree.branch && stashes.get(tree.branch)) || []
  for (const agent of findAgents()) {
    const { cwd, ...rest } = agent
    treeAt(trees, cwd)?.agents.push(rest)
  }
  for (const { path, ...pane } of panes) treeAt(trees, path)?.panes.push(pane)
  for (const { path, port } of findListening(trees)) {
    const tree = trees.find(t => t.path === path)!
    if (!tree.ports.includes(port)) tree.ports.push(port)
  }
  for (const tree of trees) tree.ports.sort((a, b) => a - b)

  return { dir, base, remote, github: githubPage(url), trees }
}

// A conflicted file's conflicts, each with a few lines around it, runs apart split by "…". The worktree's side
// is blue, the base's magenta, and the common ancestor's (with merge.conflictStyle diff3) dim.
const readConflict = async (want: Wanted, conflict: Conflict) => {
  const text = conflict.merged ? await git(want.tree, ['cat-file', 'blob', `${conflict.merged}:${want.file}`]) : readText(`${want.tree}/${want.file}`)
  const all = (text ?? '').replace(/\n$/, '').split('\n').map(cleanLine)
  const kept = new Set<number>()
  let start = -1
  all.forEach((line, n) => {
    if (/^<{7}( |$)/.test(line)) start = n
    if (/^>{7}( |$)/.test(line) && start !== -1) {
      for (let k = Math.max(0, start - CONFLICT_CONTEXT); k <= Math.min(all.length - 1, n + CONFLICT_CONTEXT); k++) kept.add(k)
      start = -1
    }
  })

  const markers = all.map(line => line.match(/^(<{7}|\|{7}|={7}|>{7})( |$)/)?.[1])
  // The code highlighted as one, both sides and all, with the marker lines left blank.
  const highlighted = highlight(all.map((line, n) => (markers[n] ? '' : line)), languageOf(want.file, all[0]))

  const lines: string[] = []
  const colors: (string | undefined)[] = []
  const tokens: (Token[] | undefined)[] = []
  const numbers: number[] = []
  let side: string | undefined
  let last = -1
  all.forEach((line, n) => {
    const marker = markers[n]
    if (kept.has(n)) {
      if (last !== -1 && n !== last + 1) {
        lines.push('…')
        colors.push(undefined)
        tokens.push(undefined)
        numbers.push(0)
      }
      last = n
      lines.push(marker === '<<<<<<<' ? `${marker} ${conflict.ours}` : marker === '>>>>>>>' ? `${marker} ${conflict.theirs}` : line)
      colors.push(marker ? 'cyan' : side)
      tokens.push(marker ? undefined : highlighted?.[n])
      numbers.push(n + 1)
    }
    if (marker) side = marker[0] === '<' ? 'blue' : marker[0] === '|' ? 'gray' : marker[0] === '=' ? 'magenta' : undefined
  })
  const cut = <T,>(list: T[]) => list.slice(0, MAX_DIFF_LINES)

  return { lines: cut(lines), colors: cut(colors), tokens: cut(tokens), numbers: cut(numbers), isCut: lines.length > MAX_DIFF_LINES }
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
  // Each line's code cleaned after its sign, so tab stops line up with the code.
  const body = (from === -1 ? [] : lines.slice(from)).slice(0, MAX_DIFF_LINES).map(l => (l.startsWith('@@') ? cleanLine(l) : l.slice(0, 1) + cleanLine(l.slice(1))))
  const isCut = from !== -1 && lines.length - from > MAX_DIFF_LINES

  return { lines: body, tokens: highlightDiff(body, languageOf(want.file, readFirstLine(`${want.tree}/${want.file}`))), isCut }
}

// What to show under an open file: its diff, or the file itself.
const readView = async (want: Wanted) => {
  if (!want.isWhole) return readDiff(want)
  const text = readText(`${want.tree}/${want.file}`)
  if (text === null) return { lines: [], isCut: false, isUnreadable: true }
  const all = toLines(text)
  const lines = all.slice(0, MAX_FILE_LINES).map(cleanLine)

  return { lines, tokens: highlight(lines, languageOf(want.file, lines[0])), isCut: all.length > MAX_FILE_LINES }
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

// ---- Clipboard and editor ----

// Feeds `text` to a command's input; whether it ran and exited cleanly.
const pipeTo = async (command: string[], text: string) => {
  try {
    const proc = Bun.spawn(command, { stdin: new TextEncoder().encode(text), stdout: 'ignore', stderr: 'ignore' })

    return (await proc.exited) === 0
  } catch {
    return false
  }
}

// Puts `text` on the clipboard: by OSC 52, which the terminal acts on even through ssh, and inside tmux
// through tmux's own buffer too (-w hands it on to the outer terminal). Failing both, wl-copy or xclip.
const copyText = async (text: string) => {
  process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`)
  const isInTmux = Boolean(process.env.TMUX) && (await pipeTo(['tmux', 'load-buffer', '-w', '-'], text))
  if (isInTmux) return
  if (process.env.WAYLAND_DISPLAY && (await pipeTo(['wl-copy'], text))) return
  if (process.env.DISPLAY) await pipeTo(['xclip', '-selection', 'clipboard'], text)
}

// Opens a file at `line`, or a folder, in $EDITOR (nvim when unset) and says where. nvim goes the way `o` does;
// any other editor starts in the folder, in a new tmux pane, else a new kitty window.
const openInEditor = async (path: string, line: number) => {
  const editor = process.env.EDITOR || 'nvim'
  const name = basename(editor.split(/\s+/)[0])
  if (name === 'nvim') return openInNvim(path, line)
  let isFolder = false
  try {
    isFolder = statSync(path).isDirectory()
  } catch {
    return `Couldn't open ${shortPath(path)}: it is gone`
  }
  const dir = isFolder ? path : dirname(path)
  // $EDITOR may carry its own arguments, such as "code --wait", so the shell splits it.
  const run = ['sh', '-c', `${editor} "$1"`, 'sh', path]
  if (process.env.TMUX && (await pipeTo(['tmux', 'split-window', '-h', '-c', dir, ...run], ''))) return `Opened ${shortPath(path)} in ${name} in a new tmux pane`
  if (await pipeTo(['setsid', '-f', 'kitty', '--directory', dir, ...run], '')) return `Opened ${shortPath(path)} in ${name} in a new kitty window`

  return `Couldn't open ${shortPath(path)} in ${name}`
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

// The newest transcript of a claude running in `cwd` and when it was written, or null.
// Claude keeps them in ~/.claude/projects/<cwd with all but letters and digits made "-">/.
const newestTranscript = (cwd: string) => {
  const dir = `${homedir()}/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}`
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ file: `${dir}/${f}`, at: modifiedAt(`${dir}/${f}`) }))
      .reduce<{ file: string; at: number } | null>((best, t) => (!best || t.at > best.at ? t : best), null)
  } catch {
    return null
  }
}

// Each transcript's ending, kept while the file is unchanged, so only a changed one is read again.
const endings = new Map<string, { at: number; ending: Ending | null }>()

// The last bytes of a file, from the start of a line on.
const readTail = (file: string, bytes: number) => {
  const fd = openSync(file, 'r')
  try {
    const size = fstatSync(fd).size
    const length = Math.min(size, bytes)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    const text = buffer.toString('utf8')

    return length < size ? text.slice(text.indexOf('\n') + 1) : text
  } catch {
    return ''
  } finally {
    closeSync(fd)
  }
}

// What a tool call is about: its command, file, address or description.
const toolSubject = (input: Record<string, unknown> = {}) =>
  String(input.command ?? input.file_path ?? input.notebook_path ?? input.url ?? input.pattern ?? input.description ?? '')

// How the transcript ends, from its last conversation entry; `at` is the transcript's time, when it last changed.
const readEnding = (file: string, at: number): Ending | null => {
  const cached = endings.get(file)
  if (cached?.at === at) return cached.ending
  type Entry = { type?: string; isMeta?: boolean; timestamp?: string; message?: { stop_reason?: string; content?: unknown } }
  let entries: Entry[] = []
  try {
    entries = readTail(file, TRANSCRIPT_TAIL).split('\n').flatMap(line => {
      try {
        return [JSON.parse(line) as Entry]
      } catch {
        return []
      }
    })
  } catch {
    // Gone, or unreadable.
  }
  const blocks = (e: Entry) => (Array.isArray(e.message?.content) ? e.message.content : [{ type: 'text', text: e.message?.content }]) as { type: string; text?: string; name?: string; input?: Record<string, unknown> }[]
  const conversation = entries.filter(e => e.type === 'assistant' || (e.type === 'user' && !e.isMeta))
  const last = conversation.at(-1)
  // What it said last, in one line.
  const said = conversation.findLast(e => e.type === 'assistant' && blocks(e).some(b => b.type === 'text' && b.text?.trim()))
  const says = (said ? blocks(said).filter(b => b.type === 'text').map(b => b.text).join(' ') : '').replace(/\s+/g, ' ').trim()
  // The person's last prompt, which began the turn: a user entry that is not a tool's result.
  const prompted = conversation.findLast(e => e.type === 'user' && !blocks(e).some(b => b.type === 'tool_result'))
  const turnAt = Date.parse(prompted?.timestamp ?? '') || 0
  let ending: Ending | null = null
  if (last) {
    const when = Date.parse(last.timestamp ?? '') || at
    const tool = last.type === 'assistant' ? blocks(last).findLast(b => b.type === 'tool_use') : undefined
    const text = blocks(last).find(b => b.type === 'text')?.text ?? ''
    if (tool) ending = { kind: 'tool', at: when, tool: tool.name, says: `wants ${tool.name}: ${toolSubject(tool.input)}`.replace(/\s+/g, ' ').trim(), turnAt }
    else if (last.type === 'assistant' && last.message?.stop_reason && last.message.stop_reason !== 'tool_use') ending = { kind: 'done', at: when, says, turnAt }
    else if (last.type === 'user' && text.startsWith('[Request interrupted')) ending = { kind: 'stopped', at: when, says, turnAt }
    else ending = { kind: 'working', at: when, says, turnAt }
  }
  endings.set(file, { at, ending })

  return ending
}

// When the machine started, ms since the epoch, which /proc's process start times count from.
let bootedAt = 0
const bootTime = () => {
  if (!bootedAt) {
    try {
      bootedAt = Number(readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)/m)?.[1] ?? 0) * 1000
    } catch {
      // No /proc.
    }
  }

  return bootedAt
}

// Whether process `pid` has a child started since `since`, ms since the epoch, such as the shell of a tool it runs.
// A process's start is the 22nd field of its stat, in hundredths of a second since boot.
const hasChildSince = (pid: number, since: number) => {
  try {
    return readdirSync('/proc').some(p => {
      if (!/^\d+$/.test(p)) return false
      try {
        const fields = readFileSync(`/proc/${p}/stat`, 'utf8').split(') ').pop()!.split(' ')
        return Number(fields[1]) === pid && bootTime() + Number(fields[19]) * 10 >= since - 2000
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}

// What a claude in `cwd` is up to, from how its newest transcript ends.
const claudeState = (pid: number, cwd: string): Pick<Agent, 'isBusy' | 'isWaiting' | 'isAsking' | 'says' | 'turnAt'> => {
  const transcript = newestTranscript(cwd)
  if (!transcript) return { isBusy: false }
  const ending = readEnding(transcript.file, transcript.at)
  const quiet = Date.now() - transcript.at
  const isRecent = quiet < BUSY_MS
  if (!ending) return { isBusy: isRecent }
  if (ending.kind === 'done') {
    const isWaiting = Date.now() - ending.at < WAITING_MS
    return { isBusy: false, isWaiting, says: ending.says || undefined }
  }
  if (ending.kind === 'stopped') return { isBusy: false, says: ending.says || undefined }
  const turnAt = ending.turnAt || undefined
  if (ending.kind === 'working') return quiet < THINKING_MS ? { isBusy: true, turnAt } : { isBusy: false }
  // A tool call: running, unless it has sat a while with nothing started for it, as it waits for leave to run.
  const isRunning = quiet < ASKING_MS || LONG_TOOLS.includes(ending.tool ?? '') || ending.tool?.startsWith('mcp__') || hasChildSince(pid, ending.at)

  return isRunning ? { isBusy: true, turnAt } : { isBusy: false, isWaiting: true, isAsking: true, says: ending.says }
}

// A process's parent, or 0 when it is gone. The parent's pid is the second field after the name, which ends at the last ")".
const parentPid = (pid: number) => {
  try {
    return Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop()!.split(' ')[1])
  } catch {
    return 0
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
      return [{ name, pid: Number(pid), parent: parentPid(Number(pid)), cwd: readlinkSync(`/proc/${pid}/cwd`) }]
    } catch {
      return []
    }
  })
  const ids = new Set(found.map(a => a.pid))

  return found
    .filter(a => !ids.has(a.parent))
    .map(({ name, pid, cwd }): Agent & { cwd: string } => (name === 'claude' ? { name, pid, cwd, ...claudeState(pid, cwd) } : { name, pid, cwd }))
}

// Every tmux pane but kelp's own and the folder it is in, when kelp runs inside tmux.
const listPanes = async () => {
  if (!process.env.TMUX) return []
  try {
    const format = ['#{pane_id}', '#{session_name}:#{window_index}', '#{window_name}', '#{pane_current_command}', '#{pane_current_path}', '#{pane_pid}'].join('\t')
    const proc = Bun.spawn(['tmux', 'list-panes', '-a', '-F', format], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
    const out = await new Response(proc.stdout).text()
    if ((await proc.exited) !== 0) return []

    return out
      .split('\n')
      .map(line => line.split('\t'))
      .filter(f => f.length === 6 && f[0] !== process.env.TMUX_PANE)
      .map(([id, window, windowName, command, path, pid]) => ({ id, window, windowName, command, path, pid: Number(pid) }))
  } catch {
    return []
  }
}

// Whether a command ran and exited 0.
const succeeds = async (args: string[]) => {
  try {
    return (await Bun.spawn(args, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).exited) === 0
  } catch {
    return false
  }
}

// Opens a window named `name` in `dir` running `command`, a shell when none: a new tmux window inside tmux,
// else a new kitty window. Says which, or null when it couldn't.
const openWindow = async (dir: string, name: string, command: string[] = []) => {
  if (process.env.TMUX) return (await succeeds(['tmux', 'new-window', '-c', dir, '-n', name, ...command])) ? 'a new tmux window' : null

  return (await succeeds(['setsid', '-f', 'kitty', '--directory', dir, '--title', name, ...command])) ? 'a new kitty window' : null
}

// Brings forward a tmux pane in the worktree, or failing that opens a new window there named after its branch. Says what happened.
const jumpTo = async (tree: Tree) => {
  const name = label(tree)
  const pane = tree.panes[0]
  if (pane && (await succeeds(['tmux', 'select-window', '-t', pane.id])) && (await succeeds(['tmux', 'select-pane', '-t', pane.id]))) {
    // Only needed when the pane is in another session.
    await succeeds(['tmux', 'switch-client', '-t', pane.id])
    return `Switched to tmux window ${pane.window} (${pane.windowName}), ${pane.command} in ${name}`
  }
  const where = await openWindow(tree.path, name)

  return where ? `Opened ${name} in ${where}` : `Couldn't open a window in ${shortPath(tree.path)}`
}

// Starts claude in the worktree at `path` named `branch`, given `prompt` to begin with when there is one,
// in a new window named "<branch> claude". Says where.
const startClaude = async (path: string, branch: string, prompt = '') => {
  const name = `${branch} claude`
  const where = await openWindow(path, name, prompt ? ['claude', prompt] : ['claude'])

  return where ? `Started claude in ${branch}, in ${where} "${name}"` : `Couldn't start claude in ${shortPath(path)}`
}

// The tmux pane a process runs in: the pane whose first process it is, or descends from.
const paneOf = (panes: Pane[], pid: number) => {
  for (let p = pid; p > 1; p = parentPid(p)) {
    const pane = panes.find(x => x.pid === p)
    if (pane) return pane
  }

  return undefined
}

// Types `text` into a tmux pane and presses Enter, as if typed there. Enter waits a moment, so an agent
// takes the text as typed rather than as a paste still coming in, where Enter would only start a new line
// (claude 2.1 takes it even with no wait; the wait is to be safe). Whether it went.
const typeInto = async (pane: Pane, text: string) => {
  if (!(await succeeds(['tmux', 'send-keys', '-t', pane.id, '-l', '--', text]))) return false
  await Bun.sleep(150)

  return succeeds(['tmux', 'send-keys', '-t', pane.id, 'Enter'])
}

// Whether a tmux pane shows claude's menu asking leave to run a tool, its first choice "1. Yes". Claude writes
// the tool call to its transcript only once it is answered, so the transcript alone can't always tell.
const isAskingIn = async (pane: Pane) => {
  const run = await runCommand(homedir(), ['tmux', 'capture-pane', '-p', '-t', pane.id])

  return run?.code === 0 && /^\s*❯ 1\. Yes\b/m.test(run.out)
}

// Answers claude's menu asking leave to run a tool: 1 picks its first choice, "Yes"; esc says no, as the number
// of "No" changes from one menu to another. Words given with a no are then typed in, as what to do instead. Whether it went.
const answerAsking = async (pane: Pane, isAllowed: boolean, instead = '') => {
  if (isAllowed) return succeeds(['tmux', 'send-keys', '-t', pane.id, '1'])
  if (!(await succeeds(['tmux', 'send-keys', '-t', pane.id, 'Escape']))) return false
  if (!instead) return true
  await Bun.sleep(500)

  return typeInto(pane, instead)
}

// ---- Ports ----

// Whether an address in /proc/net/tcp's hex can be reached at localhost: any address, or loopback.
// IPv4 is one word, IPv6 four, each with its bytes reversed, so 127.0.0.1 is 0100007F.
const isLocalAddress = (hex: string) => {
  const isLocal4 = (ip: string) => ip === '00000000' || ip.endsWith('7F')
  if (hex.length === 8) return isLocal4(hex)
  if (hex.startsWith('0000000000000000FFFF0000')) return isLocal4(hex.slice(24))

  return hex === '0'.repeat(32) || hex === '00000000000000000000000001000000'
}

// The sockets listening at localhost, by inode, and the port of each, from /proc/net/tcp and tcp6.
const listeningSockets = () => {
  const ports = new Map<string, number>()
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n').slice(1)) {
      // "sl local_address rem_address st … inode": state 0A is listening.
      const fields = line.trim().split(/\s+/)
      const [address, port] = (fields[1] ?? '').split(':')
      if (fields[3] === '0A' && port && isLocalAddress(address)) ports.set(fields[9], parseInt(port, 16))
    }
  }

  return ports
}

// The ports that processes in each of `trees` listen on: each process whose folder is in one, and the listening
// sockets among its open files. None where there is no /proc, or for another user's processes.
const findListening = (trees: { path: string }[]) => {
  const sockets = listeningSockets()
  if (sockets.size === 0) return []
  let pids: string[]
  try {
    pids = readdirSync('/proc').filter(p => /^\d+$/.test(p))
  } catch {
    return []
  }

  return pids.flatMap(pid => {
    try {
      const tree = treeAt(trees, readlinkSync(`/proc/${pid}/cwd`))
      if (!tree) return []

      return readdirSync(`/proc/${pid}/fd`).flatMap(fd => {
        try {
          const inode = readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/)?.[1]
          const port = inode && sockets.get(inode)
          return port ? [{ path: tree.path, port }] : []
        } catch {
          return []
        }
      })
    } catch {
      return []
    }
  })
}

// ---- GitHub ----

// A command's output, error output and exit code, or null when it cannot be started, such as gh not being installed.
// It never asks for a password or passphrase, which would hang with nobody to answer.
const runCommand = async (cwd: string, args: string[], more: Record<string, string> = {}) => {
  try {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes', ...more }
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

// ---- Commands ----

// What .kelp.json in `dir` holds, such as { "commands": { "test": "bun test" } }; {} when there is none or it isn't JSON.
// Keys kelp doesn't know are left alone.
const readKelpJson = (dir: string): Record<string, unknown> => {
  try {
    const json = JSON.parse(readFileSync(`${dir}/.kelp.json`, 'utf8'))

    return json && typeof json === 'object' ? json : {}
  } catch {
    return {}
  }
}

// The named commands `:` offers in the worktree at `tree`: "commands" in its .kelp.json, or failing that the main
// checkout's at `repoDir`; with neither, its package.json's scripts, run with the package manager its lock file names.
const loadCommands = (tree: string, repoDir: string) => {
  for (const dir of [tree, repoDir]) {
    const commands = readKelpJson(dir).commands
    if (commands && typeof commands === 'object') {
      return Object.entries(commands as Record<string, unknown>)
        .filter(([, command]) => typeof command === 'string')
        .map(([name, command]) => ({ name, command: command as string }))
    }
  }
  try {
    const scripts = JSON.parse(readFileSync(`${tree}/package.json`, 'utf8')).scripts ?? {}
    const manager =
      existsSync(`${tree}/bun.lock`) || existsSync(`${tree}/bun.lockb`) ? 'bun'
      : existsSync(`${tree}/pnpm-lock.yaml`) ? 'pnpm'
      : existsSync(`${tree}/yarn.lock`) ? 'yarn'
      : 'npm'

    return Object.keys(scripts).map(name => ({ name, command: `${manager} run ${name}` }))
  } catch {
    return []
  }
}

// The command run last in each worktree, by its folder; kept out here so it outlives refreshes.
const runs = new Map<string, Run>()

// Colours and other terminal escapes, left out of a command's output.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

// The local address a line of output mentions: a URL on this machine, or else "port 3000".
const findUrl = (line: string) => {
  const url = line.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?[^\s'")]*/)
  if (url) return url[0]
  const port = line.match(/\bport:? (\d{2,5})\b/i)

  return port ? `localhost:${port[1]}` : undefined
}

const isRunning = (run?: Run) => run !== undefined && run.endedAt === undefined

type PortTree = { path: string; branch: string; isBase: boolean }

// The port a worktree's dev server should listen on, from a hash of its branch (its folder when detached);
// none for the base branch's worktree, which keeps the app's own default. When two of `trees` hash to the same port,
// the later by branch name takes the next free one, so each worktree's port is its own.
const portOf = (tree: PortTree, trees: PortTree[]) => {
  if (tree.isBase) return undefined
  const taken = new Set<number>()
  const name = (t: PortTree) => t.branch || t.path
  const others = trees.filter(t => !t.isBase && t.path !== tree.path)
  for (const t of [...others, tree].sort((a, b) => name(a).localeCompare(name(b)))) {
    let port = PORT_FROM + Number(BigInt(Bun.hash(name(t))) % BigInt(PORT_COUNT))
    while (taken.has(port)) port = PORT_FROM + ((port - PORT_FROM + 1) % PORT_COUNT)
    if (t === tree) return port
    taken.add(port)
  }
}

// What kelp tells every command it runs in a worktree: its port as PORT and KELP_PORT, its branch, its folder and the base branch.
const kelpEnv = (tree: PortTree, trees: PortTree[], base: string): Record<string, string> => {
  const port = portOf(tree, trees)

  return { ...(port ? { PORT: String(port), KELP_PORT: String(port) } : {}), KELP_BRANCH: tree.branch, KELP_WORKTREE: tree.path, KELP_BASE: base }
}

// Runs `command` with sh in the worktree at `tree`, in a process group of its own so stopping it stops all it started,
// with `env` added to kelp's own. `onChange` is called as output comes and when it ends. Throws when it cannot start.
const startRun = (tree: string, command: string, env: Record<string, string>, onChange: () => void) => {
  const proc = Bun.spawn(['sh', '-c', command], {
    cwd: tree,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
    env: { ...process.env, NO_COLOR: '1', ...env },
  })
  const run: Run = { tree, command, startedAt: Date.now(), lines: [], pid: proc.pid }
  runs.set(tree, run)

  const add = (lines: string[]) => {
    for (const raw of lines) {
      // A carriage return draws the line again, as progress bars do; keep what it ends as.
      const line = raw.replace(ESCAPES, '').split('\r').filter(Boolean).pop()?.replace(/\t/g, '    ') ?? ''
      run.url ??= findUrl(line)
      run.lines.push(line)
    }
    run.lines.splice(0, run.lines.length - RUN_KEEP)
    onChange()
  }
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    // The unfinished last line.
    let rest = ''
    for await (const chunk of stream) {
      const parts = (rest + decoder.decode(chunk, { stream: true })).split('\n')
      rest = parts.pop()!
      if (parts.length > 0) add(parts)
    }
    if (rest) add([rest])
  }
  read(proc.stdout).catch(() => {})
  read(proc.stderr).catch(() => {})
  // It ends when sh does, even if something it left behind still holds the output open.
  proc.exited.then(code => {
    run.endedAt = Date.now()
    run.code = proc.signalCode ? null : code
    onChange()
  })

  return run
}

// Stops a command and all it started: politely, then for good if anything is left a few seconds on.
const stopRun = (run: Run) => {
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-run.pid, name)
    } catch {
      // Already gone.
    }
  }
  signal('SIGTERM')
  setTimeout(() => signal('SIGKILL'), 3000).unref()
}

// ---- Lifecycle ----

// Runs git for a change it makes: null when it worked, else why not.
const gitDo = async (cwd: string, args: string[]) => {
  const run = await runCommand(cwd, ['git', ...args])

  return run === null ? "git couldn't start" : run.code === 0 ? null : whyFailed(run.err).replace(/^(fatal|error): /, '')
}

// Where a new worktree for `branch` goes: beside the other worktrees when they share a folder,
// else next to the main one as <repo>-<branch>.
const newTreePath = (repo: Repo, branch: string) => {
  const name = branch.replace(/\//g, '-')
  const main = repo.trees.find(t => t.isMain)?.path ?? repo.dir
  const folders = repo.trees.filter(t => !t.isMain).map(t => dirname(t.path))
  const isShared = folders.length > 0 && folders.every(f => f === folders[0]) && folders[0] !== dirname(main)

  return isShared ? `${folders[0]}/${name}` : `${dirname(main)}/${basename(main)}-${name}`
}

// Makes a worktree for `branch` at `path`: the branch when it exists here or on origin, else a new one from the base.
// Null when it worked, else why not.
const addTree = async (repo: Repo, branch: string, path: string) => {
  if ((await git(repo.dir, ['check-ref-format', '--branch', branch])) === null) return `"${branch}" is not a valid branch name`
  if (existsSync(path)) return `${shortPath(path)} already exists`
  const has = async (ref: string) => (await git(repo.dir, ['rev-parse', '--verify', '--quiet', ref])) !== null
  // Given a branch only on origin, git makes a local one tracking it.
  const isKnown = (await has(`refs/heads/${branch}`)) || (await has(`refs/remotes/origin/${branch}`))

  return gitDo(repo.dir, isKnown ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, repo.base])
}

// .kelp.json at the main worktree's root: { "copy": [globs of ignored files to copy into a new worktree],
// "postCreate": [commands run in it after], "preRemove": [commands run in a worktree before x or C removes it] }.
// `error` when it is there but can't be read.
const readConfig = (dir: string) => {
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter(s => typeof s === 'string') : [])
  if (!existsSync(`${dir}/.kelp.json`)) return { copy: [], postCreate: [], preRemove: [] }
  try {
    const config = JSON.parse(readFileSync(`${dir}/.kelp.json`, 'utf8'))

    return { copy: strings(config.copy), postCreate: strings(config.postCreate), preRemove: strings(config.preRemove) }
  } catch {
    return { copy: [], postCreate: [], preRemove: [], error: "Couldn't read .kelp.json" }
  }
}

// The files git ignores in `dir` that a new worktree needs too: .env files, and those .kelp.json's copy names.
// An ignored folder git lists whole, such as node_modules/, matches by its name without the slash.
const localFiles = async (dir: string, globs: string[]) => {
  const ignored = (await git(dir, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])) ?? ''
  const patterns = [...COPY_ALWAYS, ...globs].map(g => new Bun.Glob(g))

  return ignored
    .split('\0')
    .map(f => f.replace(/\/$/, ''))
    .filter(f => f && patterns.some(p => p.match(f)))
}

// Copies each file or folder from one worktree to another, leaving any already there alone. Null when it worked, else why not.
const copyFiles = (from: string, to: string, files: string[]) => {
  try {
    for (const file of files) {
      mkdirSync(dirname(`${to}/${file}`), { recursive: true })
      cpSync(`${from}/${file}`, `${to}/${file}`, { recursive: true, force: false })
    }

    return null
  } catch (e) {
    return e instanceof Error ? e.message : 'copying failed'
  }
}

const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`

// Whether x, or X forcing it, may remove `tree`: why not, or what the first press says and whether its branch
// goes too, as only a branch fully in the base is deleted. Never the main worktree, the base's, kelp's own,
// or one an agent is working in.
const planRemoval = (tree: Tree, repo: Repo, root: string, isForce: boolean) => {
  const name = label(tree)
  if (tree.isMain) return `${name} is the main worktree, which git can't remove.`
  if (tree.isBase) return `${name} has the base branch checked out.`
  if (tree.isMissing) return `${name}'s folder is gone: C prunes it.`
  if (tree.isLocked) return `${name} is locked${tree.lockReason ? ` (${tree.lockReason})` : ''}: git worktree unlock it first.`
  if (root === tree.path || root.startsWith(`${tree.path}/`)) return `kelp is running in ${name}.`
  if (tree.agents.length > 0) return `${[...new Set(tree.agents.map(a => a.name))].join(', ')} is running in ${name}: stop it first.`
  const n = tree.uncommitted.length
  const unmerged = `${plural(tree.ahead, 'commit')} not in ${repo.base}`
  const why = [n > 0 && plural(n, 'uncommitted file'), tree.ahead > 0 && unmerged].filter(Boolean).join(' and ')
  if (why && !isForce) return `${name} has ${why}: X removes it anyway.`
  const isBranchGone = tree.branch !== '' && tree.ahead === 0
  const losing = isForce && n > 0 ? `, throwing away ${plural(n, 'uncommitted file')}` : ''
  const branch = !tree.branch ? '' : isBranchGone ? `, and delete its branch, fully in ${repo.base}` : `, keeping its branch, with ${unmerged}`

  return { ask: `Remove ${name}${losing}${branch}`, isBranchGone }
}

// What C cleans up: the missing worktrees git can prune, as locked ones it keeps, and every merged worktree
// x would remove without forcing, so never the main one, the base's, kelp's own or one an agent works in.
const planCleanup = (repo: Repo, root: string) => ({
  missing: repo.trees.filter(t => t.isMissing && !t.isLocked),
  merged: repo.trees.filter(t => t.isMerged && typeof planRemoval(t, repo, root, false) !== 'string'),
})

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

// How long something took or has run: "0.4s", "12s", "3m 05s", "1h 02m".
const duration = (ms: number) => {
  const s = Math.floor(ms / 1000)
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`

  return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`
}

// How a command is doing: its mark and colour, and the words for it.
const runState = (run: Run) => {
  if (run.endedAt === undefined) return { mark: '▶', color: 'cyan', text: `running ${duration(Date.now() - run.startedAt)}` }
  const took = duration(run.endedAt - run.startedAt)
  if (run.code === 0) return { mark: '✓', color: 'green', text: `exit 0 · ${took}` }

  return { mark: '✗', color: 'red', text: `${run.code === null ? 'stopped' : `exit ${run.code}`} · ${took}` }
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

// The header starts with kelp's name and then each tab's, one space apart.
const HEADER_LEAD = 'kelp  '
const TABS: Tab[] = ['worktrees', 'repo']

// The first and last column of a tab's name in the header, counted from 1 as mouse reports count them,
// so a click finds the tab whatever the names are.
const tabColumns = (name: Tab) => {
  const from = HEADER_LEAD.length + TABS.slice(0, TABS.indexOf(name)).reduce((n, t) => n + t.length + 1, 0) + 1

  return [from, from + name.length - 1]
}

// The orders `s` steps through, the first the default, and how the header names each.
const SORTS: Sort[] = ['name', 'recent', 'attention']
const SORT_NAMES: Record<Sort, string> = { name: 'by name', recent: 'by recent activity', attention: 'needing attention first' }

// How much a worktree wants a look: trouble merging or rebasing, then a busy agent, then uncommitted changes.
const attention = (tree: Tree) =>
  tree.conflicts.length > 0 || tree.isMerging || tree.isRebasing ? 3
  : tree.agents.some(a => a.isBusy !== false) ? 2
  : tree.uncommitted.length > 0 ? 1
  : 0

// The worktrees in `sort`'s order, the base branch's first; ties go to the most recently active.
const sortTrees = (trees: Tree[], sort: Sort) =>
  [...trees].sort(
    (a, b) =>
      Number(b.isBase) - Number(a.isBase) ||
      (sort === 'name' ? label(a).localeCompare(label(b)) : 0) ||
      (sort === 'attention' ? attention(b) - attention(a) : 0) ||
      b.lastAt - a.lastAt,
  )

// ---- Highlighting ----

// How each kind of token highlight.js finds looks, in kelp's colours. A kind given {} shows plain, as the code
// inside a template string does, rather than taking on the colour of what holds it.
const STYLES: Record<string, Style> = {
  keyword: { color: 'magenta' },
  'selector-tag': { color: 'magenta' },
  'template-tag': { color: 'magenta' },
  'variable.language': { color: 'magenta' },
  built_in: { color: 'cyan' },
  type: { color: 'cyan' },
  'title.class': { color: 'cyan' },
  title: { color: 'blue' },
  name: { color: 'blue' },
  attr: { color: 'blue' },
  attribute: { color: 'blue' },
  string: { color: 'green' },
  code: { color: 'green' },
  addition: { color: 'green' },
  number: { color: 'yellow' },
  literal: { color: 'yellow' },
  symbol: { color: 'yellow' },
  char: { color: 'yellow' },
  bullet: { color: 'yellow' },
  'variable.constant': { color: 'yellow' },
  'selector-class': { color: 'yellow' },
  'selector-id': { color: 'yellow' },
  regexp: { color: 'red' },
  deletion: { color: 'red' },
  meta: { color: 'cyan' },
  'selector-attr': { color: 'cyan' },
  'selector-pseudo': { color: 'cyan' },
  'template-variable': { color: 'cyan' },
  link: { color: 'cyan' },
  section: { color: 'blue', isBold: true },
  strong: { isBold: true },
  emphasis: { isItalic: true },
  comment: { isDim: true, isItalic: true },
  quote: { isDim: true, isItalic: true },
  doctag: { isDim: true, isBold: true },
  subst: {},
  params: {},
  variable: {},
  property: {},
}

// A span's look from its class, such as "hljs-title function_", or nothing to take on the look of what holds it.
const styleOf = (className: string): Style | undefined => {
  const [kind, sub] = className.replace(/^hljs-/, '').split(' ')

  return (sub && STYLES[`${kind}.${sub.replace(/_+$/, '')}`]) || STYLES[kind]
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'" }

// highlight.js's HTML as lines of tokens; a span still open at the end of a line, such as a long comment, goes on into the next.
const parseHighlighted = (html: string) => {
  const lines: Token[][] = [[]]
  const open: Style[] = []
  for (const [, className, close, text] of html.matchAll(/<span class="([^"]*)">|(<\/span>)|([^<]+)/g)) {
    if (className !== undefined) open.push(styleOf(className) ?? open.at(-1) ?? {})
    else if (close) open.pop()
    else {
      text.split('\n').forEach((part, k) => {
        if (k > 0) lines.push([])
        if (part) lines.at(-1)!.push({ text: part.replace(/&[#\w]+;/g, e => ENTITIES[e] ?? e), ...open.at(-1) })
      })
    }
  }

  return lines
}

// Files known by their name, then extensions highlight.js doesn't know as its own, and the programs a #! line names.
const LANGUAGE_NAMES: Record<string, string> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  'cmakelists.txt': 'cmake',
  gemfile: 'ruby',
  rakefile: 'ruby',
  podfile: 'ruby',
  vagrantfile: 'ruby',
  '.bashrc': 'bash',
  '.bash_profile': 'bash',
  '.zshrc': 'bash',
  '.profile': 'bash',
  '.env': 'bash',
  '.gitconfig': 'ini',
  '.editorconfig': 'ini',
}
const LANGUAGE_EXTENSIONS: Record<string, string> = { jsonc: 'json', json5: 'json', jsonl: 'json', fish: 'bash', vue: 'xml', svelte: 'xml', mdx: 'markdown', lock: '' }
const SHEBANGS: Record<string, string> = { node: 'javascript', bun: 'typescript', deno: 'typescript', sh: 'bash', dash: 'bash', zsh: 'bash', ksh: 'bash', fish: 'bash' }

// The language highlight.js knows `file` by, from its name, its extension or a #! first line; undefined when none.
const languageOf = (file: string, firstLine = '') => {
  const name = basename(file).toLowerCase()
  if (LANGUAGE_NAMES[name]) return LANGUAGE_NAMES[name]
  if (name.startsWith('dockerfile') || name.endsWith('.dockerfile')) return 'dockerfile'
  if (name.startsWith('.env.')) return 'bash'
  const extension = name.includes('.') ? name.split('.').pop()! : ''
  const known = extension in LANGUAGE_EXTENSIONS ? LANGUAGE_EXTENSIONS[extension] : extension && hljs.getLanguage(extension) ? extension : ''
  if (known) return known
  // "#!/usr/bin/env -S python3 -u" names python, as does "#!/usr/bin/python3".
  const words = firstLine.match(/^#!\s*(.*)/)?.[1].split(/\s+/).filter(w => w && !w.startsWith('-')) ?? []
  const program = basename((basename(words[0] ?? '') === 'env' ? words[1] : words[0]) ?? '').replace(/[\d.]+$/, '')
  if (!program) return undefined

  return SHEBANGS[program] ?? (hljs.getLanguage(program) ? program : undefined)
}

// The first line of a file, for its #!; '' when it can't be read.
const readFirstLine = (file: string) => {
  try {
    const fd = openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(256)
      return buffer.subarray(0, readSync(fd, buffer, 0, 256, 0)).toString('utf8').split('\n')[0]
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

// Highlighted texts by their language and a hash of the text, the latest used kept, so a file read again unchanged costs nothing.
const highlights = new Map<string, Token[][]>()
const MAX_HIGHLIGHTS = 200

// The lines highlighted as `language`, read as one text; undefined with no language, or when highlight.js fails.
const highlight = (lines: string[], language: string | undefined) => {
  if (!language || lines.length === 0) return undefined
  const text = lines.join('\n')
  const key = `${language}\0${Bun.hash(text)}`
  let found = highlights.get(key)
  if (found) highlights.delete(key)
  else {
    try {
      found = parseHighlighted(hljs.highlight(text, { language, ignoreIllegals: true }).value)
    } catch {
      return undefined
    }
    if (highlights.size >= MAX_HIGHLIGHTS) highlights.delete(highlights.keys().next().value!)
  }
  highlights.set(key, found)

  return found
}

// A diff's lines highlighted: each hunk's unchanged and added lines, the code as it is now, read as one.
// Removed lines and hunk headers have none, as they show in their own colour.
const highlightDiff = (lines: string[], language: string | undefined) => {
  if (!language) return undefined
  const tokens: (Token[] | undefined)[] = lines.map(() => undefined)
  let hunk: number[] = []
  const finish = () => {
    const found = highlight(hunk.map(n => lines[n].slice(1)), language)
    hunk.forEach((n, k) => (tokens[n] = found?.[k]))
    hunk = []
  }
  lines.forEach((line, n) => {
    if (line.startsWith('@@')) finish()
    else if (line.startsWith(' ') || line.startsWith('+')) hunk.push(n)
  })
  finish()

  return tokens
}

// A line of code: its tokens, all dimmed with `isDim`, or with none its plain text.
const codeNode = (text: string, tokens: Token[] | undefined, isDim = false) =>
  tokens ? (
    tokens.map((t, k) => (
      <Text key={k} color={t.color} dimColor={isDim || t.isDim} italic={t.isItalic} bold={t.isBold}>
        {t.text}
      </Text>
    ))
  ) : (
    <Text dimColor={isDim}>{text}</Text>
  )

// ---- Rows ----

// Whether a `/` filter matches, as fzf does: each word of `query` must turn up, its letters in order but not
// necessarily together and ignoring case, within one of `fields`. An empty query matches everything.
const isMatch = (query: string, fields: string[]) =>
  query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every(word =>
      fields.some(field => {
        const text = field.toLowerCase()
        let at = 0
        for (const c of word) {
          at = text.indexOf(c, at) + 1
          if (at === 0) return false
        }

        return true
      }),
    )

// A diff's lines under the row `parent`, each knowing where it is in the new file. Each line starts with its number,
// of the old file for a removed one, then its sign: added lines green with their code highlighted, removed ones red,
// unchanged ones dimmed. A conflict's lines (`colors` set) are marked by the side they come from.
const diffRows = (parent: string, file: string, diff: Pick<Diff, 'lines' | 'colors' | 'tokens' | 'numbers'>, depth: number): Row[] => {
  const { lines, colors, tokens } = diff
  const numbers = diff.numbers ?? newLineNumbers(lines)
  // The number each line shows: in the old file for a removed line, else the new; 0 for none.
  let old = 1
  const shown = diff.numbers ?? lines.map((line, n) => {
    const hunk = line.match(/^@@ -(\d+)/)
    if (hunk) old = Number(hunk[1])
    if (hunk || line.startsWith('\\')) return 0
    if (line.startsWith('+')) return numbers[n]
    const at = old++

    return line.startsWith('-') ? at : numbers[n]
  })
  const width = String(Math.max(0, ...shown)).length

  return lines.map((line, n) => {
    const number = shown[n] ? String(shown[n]).padStart(width) : ' '.repeat(width)
    let node: JSX.Element
    if (colors) {
      const side = colors[n]
      node =
        side === 'cyan' || !shown[n] ? (
          <Text color={side} dimColor={!side} wrap="truncate-end">{' '.repeat(width + 3)}{line}</Text>
        ) : (
          <Text wrap="truncate-end">
            <Text dimColor>{number} </Text>
            <Text color={side}>{side ? '▌' : ' '}</Text> {codeNode(line, tokens?.[n], !side || side === 'gray')}
          </Text>
        )
    } else if (line.startsWith('@@')) {
      node = <Text color="cyan" wrap="truncate-end">{line}</Text>
    } else if (line.startsWith('+') || line.startsWith('-')) {
      const color = line[0] === '+' ? 'green' : 'red'
      node = (
        <Text wrap="truncate-end">
          <Text color={color}>{number} {line[0]}</Text> {line[0] === '+' ? codeNode(line.slice(1), tokens?.[n]) : <Text color="red">{line.slice(1)}</Text>}
        </Text>
      )
    } else if (line.startsWith(' ')) {
      node = (
        <Text wrap="truncate-end">
          <Text dimColor>{number}  </Text> {codeNode(line.slice(1), tokens?.[n], true)}
        </Text>
      )
    } else {
      node = <Text dimColor wrap="truncate-end">{line || ' '}</Text>
    }

    return { key: `${parent}\t${n}`, parent, depth, file, line: numbers[n] || undefined, node }
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
// With a `query`, only worktrees whose branch or folder name matches it, all of them shown, and of the rest
// only the files that match, their groups opened.
const buildRows = (
  repo: Repo,
  isOpen: (key: string, byDefault: boolean) => boolean,
  diffs: Map<string, Diff>,
  columns: number,
  prs: Map<string, Pr>,
  query: string,
  jobs: Map<string, Job>,
) => {
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
    const staged = change.stage === 'staged' ? ' staged' : change.stage === 'partly' ? ' partly staged' : ''
    const path = fitPath(change.path, Math.max(8, room(2) - 2 - stats.length - tag.length - staged.length - also.length))
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
          {open ? '▾' : '▸'} <Text bold={open} color={change.stage === 'staged' ? 'green' : undefined}>{path}</Text>
          {stats && <Text color="green"> +{change.added}</Text>}
          {stats && <Text color="red"> -{change.removed}</Text>}
          {tag && <Text color={change.tag === 'deleted' || isConflict ? 'red' : change.tag === 'new' ? 'blue' : undefined} dimColor={change.tag === 'binary'}>{tag}</Text>}
          {staged && <Text color="green">{staged}</Text>}
          {also && <Text color="yellow">{also}</Text>}
        </Text>
      ),
    })
    if (!open) return
    // A rebase replays the worktree's commits onto the base, so its HEAD side is the base.
    const isStopped = tree.isMerging || tree.isRebasing
    const sides = tree.isRebasing ? { ours: repo.base, theirs: label(tree) } : { ours: label(tree), theirs: repo.base }
    const conflict = isConflict ? { merged: isStopped ? '' : tree.merged, ...sides } : undefined
    wanted.push({ key, tree: tree.path, file: change.path, commit, isUntracked: change.isUntracked, conflict })
    const diff = diffs.get(key)
    if (!diff) return note(`${key}\tloading`, key, 3, 'Loading…')
    if (diff.lines.length === 0) {
      const empty = !isConflict
        ? 'No textual changes.'
        : isStopped
          ? 'No conflict markers left, or changed on one side and deleted on the other: git add or git rm it once resolved.'
          : 'Changed on one side, deleted or renamed on the other.'

      return note(`${key}\tempty`, key, 3, empty)
    }
    rows.push(...diffRows(key, file, diff, 3))
    if (diff.isCut) note(`${key}\tcut`, key, 3, `… diff cut at ${MAX_DIFF_LINES} lines`)
  }

  for (const tree of repo.trees) {
    const key = `tree\t${tree.path}`
    const name = label(tree)
    const fields = [name, tree.path.split('/').pop() ?? '']
    const isWhole = isMatch(query, fields)
    const shows = (file: string) => isWhole || isMatch(query, [...fields, file])
    const conflicts = tree.conflicts.filter(shows)
    const uncommitted = tree.uncommitted.filter(c => shows(c.path))
    const commits = tree.commits.map(c => ({ ...c, files: c.files.filter(f => shows(f.path)) })).filter(c => isWhole || c.files.length > 0)
    const stashes = tree.stashes.map(s => ({ ...s, files: s.files.filter(f => shows(f.path)) })).filter(s => isWhole || s.files.length > 0)
    if (!isWhole && conflicts.length + uncommitted.length + commits.length + stashes.length === 0) continue
    // Worktrees start closed, one line each; a blank line sets one apart only after one left open.
    if (rows.length > 0 && rows[rows.length - 1].depth > 0) rows.push({ key: `${key}\tgap`, depth: 0, isGap: true, node: <Text> </Text> })
    const open = isOpen(key, false)
    // The worktree's line says only what wants a look: trouble in red, then work under way, then how far it has come.
    // The rest waits in its details line, shown when it is open.
    const parts: { text: string; color?: string }[] = []
    const details: { text: string; color?: string }[] = []
    const unresolved = tree.uncommitted.filter(c => c.tag === 'conflict').length
    if (tree.isMerging || tree.isRebasing) {
      parts.push({ text: tree.isMerging ? `merging ${repo.base}` : `rebasing${tree.rebaseStep ? ` ${tree.rebaseStep}` : ''}`, color: 'red' })
      const next = tree.isMerging ? 'u commits it' : 'R carries on'
      parts.push(unresolved > 0 ? { text: `⚠ ${unresolved} unresolved`, color: 'red' } : { text: `resolved, ${next}`, color: 'green' })
    } else if (tree.conflicts.length > 0) {
      parts.push({ text: `⚠ ${tree.conflicts.length} conflict${tree.conflicts.length === 1 ? '' : 's'}`, color: 'red' })
    } else if (tree.merged) details.push({ text: `merges ${repo.base} in cleanly` })
    const stat = tree.diffStat
    if (stat.files > 0) details.push({ text: `${stat.files} file${stat.files === 1 ? '' : 's'} +${stat.added} -${stat.removed} vs ${repo.base}` })
    // A worktree whose folder is gone wants pruning; a lock only wants knowing about.
    if (tree.isMissing) {
      parts.push({ text: 'missing', color: 'red' })
      details.push({ text: tree.isLocked ? 'folder gone, locked so C keeps it' : 'folder gone, C prunes it', color: 'red' })
    }
    if (tree.isLocked) details.push({ text: `locked${tree.lockReason ? `: ${tree.lockReason}` : ''}` })
    if (tree.isUpstreamGone) parts.push({ text: 'upstream gone', color: 'red' })
    // Its pull request: failing checks or asked-for changes on the line, the rest in the details.
    const pr = tree.isBase ? undefined : prs.get(tree.branch)
    const isPrOpen = pr?.state === 'open' || pr?.state === 'draft'
    if (pr && isPrOpen && pr.checks === 'failing') parts.push({ text: `#${pr.number} checks failing`, color: 'red' })
    else if (pr && isPrOpen && pr.review === 'changes requested') parts.push({ text: `#${pr.number} changes requested`, color: 'red' })
    else if (pr) {
      details.push({ text: `#${pr.number} ${pr.state}`, color: PR_COLORS[pr.state] })
      if (isPrOpen && pr.review) details.push({ text: pr.review, color: pr.review === 'approved' ? 'green' : undefined })
      if (isPrOpen && pr.checks) details.push(CHECK_PARTS[pr.checks])
    }
    // A running command, and its address once it says one, in the details.
    const run = runs.get(tree.path)
    if (run) {
      const state = runState(run)
      const what = run.command.length > 16 ? `${run.command.slice(0, 15)}…` : run.command
      if (isRunning(run) || run.code !== 0) parts.push({ text: `${state.mark} ${what}`, color: state.color })
      if (isRunning(run) && run.url) details.push({ text: run.url.replace(/^https?:\/\//, ''), color: 'cyan' })
    }
    // The port kelp hands its commands as $PORT.
    const port = portOf(tree, repo.trees)
    if (port) details.push({ text: `port ${port}` })
    if (tree.ports.length > 0) details.push({ text: `serving ${tree.ports.map(p => `:${p}`).join(' ')}`, color: 'cyan' })
    // Its agents: one waiting for the person and a busy one on the line, the idle ones in the details.
    const waiting = tree.agents.filter(a => a.isWaiting)
    const busy = tree.agents.filter(a => a.isBusy !== false && !a.isWaiting)
    const idle = tree.agents.filter(a => a.isBusy === false && !a.isWaiting)
    const names = (agents: Agent[]) => [...new Set(agents.map(a => a.name))].join(', ')
    if (waiting.length > 0) parts.push({ text: `◆ ${names(waiting)} waiting`, color: 'yellow' })
    if (busy.length > 0) parts.push({ text: `● ${names(busy)}`, color: 'green' })
    if (idle.length > 0) details.push({ text: `○ ${names(idle)} idle` })
    // How long each busy agent has been at its current turn.
    for (const agent of busy.filter(a => a.turnAt)) details.push({ text: `${agent.name} working ${duration(Date.now() - agent.turnAt!)}` })
    // What each agent not at work last said, or asks to run, so it can be read without going there.
    for (const agent of tree.agents.filter(a => a.says && !a.isBusy)) {
      details.push({ text: agent.says!.length > 60 ? `${agent.says!.slice(0, 59)}…` : agent.says! })
    }
    if (tree.uncommitted.length > 0) parts.push({ text: `● ${tree.uncommitted.length}`, color: 'yellow' })
    // How much of it is staged, a partly staged file counting on both sides.
    const staged = tree.uncommitted.filter(c => c.stage).length
    const unstaged = tree.uncommitted.filter(c => c.stage !== 'staged').length
    if (staged > 0) details.push({ text: `${staged} staged`, color: 'green' }, ...(unstaged > 0 ? [{ text: `${unstaged} unstaged` }] : []))
    if (tree.ahead > 0) parts.push({ text: `${tree.ahead} ahead`, color: 'green' })
    if (tree.behind > 0) parts.push({ text: `${tree.behind} behind` })
    // Fully in the base and nothing uncommitted: safe to remove.
    if (tree.isMerged && tree.uncommitted.length === 0) parts.push({ text: 'merged' })
    // Where it stands against its remote branch; nothing when the repository has no remote.
    if (!tree.isUpstreamGone) {
      if (tree.unpushed > 0 || tree.unpulled > 0) {
        details.push({ text: [tree.unpushed > 0 && `↑${tree.unpushed}`, tree.unpulled > 0 && `↓${tree.unpulled}`].filter(Boolean).join(' '), color: 'cyan' })
      }
      else if (tree.upstream) details.push({ text: 'pushed' })
      else if (repo.remote && tree.branch) details.push({ text: 'not pushed' })
    }
    if (tree.stashes.length > 0) details.push({ text: `${tree.stashes.length} stash${tree.stashes.length === 1 ? '' : 'es'}` })
    if (tree.panes.length > 0) details.push({ text: `tmux ${[...new Set(tree.panes.map(p => p.command))].join(', ')}` })
    if (tree.lastAt > 0) parts.push({ text: ago(tree.lastAt) })
    const right = parts.map(p => p.text).join(' · ')
    const width = room(0)
    const fill = Math.max(1, width - 2 - name.length - right.length - 2)
    rows.push({
      key,
      depth: 0,
      canOpen: true,
      node: (
        <Text wrap="truncate-end">
          <Text dimColor>{open ? '▾' : '▸'} </Text>
          <Text bold color={tree.isBase ? undefined : 'blue'}>{name}</Text>
          <Text dimColor>{` ${'━'.repeat(fill)} `}</Text>
          {parts.map((p, k) => (
            <Text key={k}>
              {k > 0 && <Text dimColor> · </Text>}
              <Text color={p.color} dimColor={!p.color}>{p.text}</Text>
            </Text>
          ))}
        </Text>
      ),
    })
    const job = jobs.get(tree.path)
    if (job) {
      rows.push({ key: `${key}\tjob`, parent: key, depth: 1, node: <Text color={job.isFailed ? 'red' : 'cyan'} wrap="truncate-end">{job.text}</Text> })
    }
    if (!open) continue

    // Its folder, then whatever the line left out.
    rows.push({
      key: `${key}\tdetails`,
      parent: key,
      depth: 1,
      node: (
        <Text wrap="truncate-end">
          <Text dimColor>{shortPath(tree.path)}{tree.isBase ? ' · base' : ''}</Text>
          {details.map((p, k) => (
            <Text key={k}>
              <Text dimColor> · </Text>
              <Text color={p.color} dimColor={!p.color}>{p.text}</Text>
            </Text>
          ))}
        </Text>
      ),
    })

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
    if (conflicts.length > 0) {
      const group = `${key}\tconflicts`
      if (groupLine(group, key, { text: '⚠ conflicts', color: 'red' }, `merging ${repo.base} in`, '', conflicts.length, true)) {
        for (const file of conflicts) fileRows(tree, { path: file, added: 0, removed: 0, tag: 'conflict' }, group)
      }
    }

    // The command run here last, and the end of its output.
    if (run) {
      const group = `${key}\trun`
      const isRunOpen = isOpen(group, true)
      const state = runState(run)
      rows.push({
        key: group,
        parent: key,
        depth: 1,
        canOpen: true,
        isOpenByDefault: true,
        node: (
          <Text wrap="truncate-end">
            <Text dimColor>{isRunOpen ? '▾' : '▸'} </Text>
            <Text color={state.color}>{state.mark} run</Text>
            {` ${run.command}`}
            <Text color={state.color} dimColor={isRunning(run)}> · {state.text}</Text>
            {run.url && <Text color="cyan"> · {run.url}</Text>}
          </Text>
        ),
      })
      if (isRunOpen) {
        const shown = run.lines.slice(-RUN_LINES)
        if (run.lines.length > RUN_LINES) note(`${group}\tearlier`, group, 2, `… ${run.lines.length - RUN_LINES} earlier lines`)
        if (shown.length === 0) note(`${group}\tnone`, group, 2, isRunning(run) ? 'No output yet.' : 'No output.')
        shown.forEach((line, n) => note(`${group}\t${n}`, group, 2, line || ' '))
      }
    }

    if (uncommitted.length > 0) {
      const group = `${key}\tuncommitted`
      if (groupLine(group, key, { text: '● uncommitted', color: 'yellow' }, '', '', uncommitted.length, true)) {
        for (const change of uncommitted) fileRows(tree, change, group)
      }
    }
    // Its stashes, closed, each opening to its files and their diffs.
    for (const stash of stashes) {
      const group = `${key}\tstash\t${stash.hash}`
      if (groupLine(group, key, { text: stash.ref, color: 'cyan' }, stash.message, ` · ${ago(stash.at)}`, stash.files.length, false)) {
        for (const change of stash.files) fileRows(tree, change, group, change.isUntracked ? `${stash.hash}^3` : stash.hash)
        if (stash.files.length === 0) note(`${group}\tnone`, group, 2, 'No file changes.')
      }
    }
    for (const commit of commits) {
      const group = `${key}\t${commit.hash}`
      if (groupLine(group, key, { text: commit.hash, color: 'yellow' }, commit.subject, ` · ${ago(commit.at)}`, commit.files.length, !isWhole)) {
        for (const change of commit.files) fileRows(tree, change, group, commit.hash)
        if (commit.files.length === 0) note(`${group}\tnone`, group, 2, 'No file changes.')
      }
    }
    if (tree.commits.length === 0 && tree.uncommitted.length === 0 && tree.stashes.length === 0) {
      note(`${key}\tnone`, key, 1, `Nothing ahead of ${repo.base} and no uncommitted changes.`)
    }
  }
  if (query && rows.length === 0) note('none', '', 0, `No worktree, nor any file changed in one, matches "${query}".`)

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
// With a `query`, only the files whose path matches it, with the folders holding them opened.
const buildRepoRows = (files: Files, isOpen: (key: string, byDefault: boolean) => boolean, views: Map<string, Diff>, isDiff: boolean, query: string) => {
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
  const matching = files.files.filter(file => isMatch(query, [file]))
  for (const file of matching) {
    const parts = file.split('/')
    for (let k = 1; k < parts.length; k++) at(parts.slice(0, k - 1).join('/')).dirs.add(parts.slice(0, k).join('/'))
    at(parts.slice(0, -1).join('/')).files.push(file)
  }
  const changed = Object.keys(files.status)

  const walk = (dir: string, parent: string | undefined, depth: number) => {
    for (const sub of [...at(dir).dirs].sort()) {
      const key = `dir\t${sub}`
      const open = isOpen(key, query !== '')
      const count = changed.filter(f => f.startsWith(`${sub}/`)).length
      rows.push({
        key,
        parent,
        depth,
        canOpen: true,
        isOpenByDefault: query !== '',
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
        rows.push(...diffRows(key, path, shown, depth + 1))
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
                <Text dimColor>{String(n + 1).padStart(gutter)}  </Text>
                {codeNode(line, shown.tokens?.[n])}
              </Text>
            ),
          })
        })
        if (shown.isCut) note(`${view}\tcut`, key, depth + 1, `… cut at ${MAX_FILE_LINES} lines`)
      }
    }
  }
  walk('', undefined, 0)
  if (matching.length === 0) note('none', '', 0, query ? `No files match "${query}".` : 'No files.')

  return { rows, wanted }
}

// ---- Actions ----

// What the merge keys do to a worktree: u merges the base into it, m merges its branch into the base,
// R rebases it onto the base, U aborts a merge or rebase under way.
type Action = 'merge' | 'land' | 'rebase' | 'abort'
const ACTION_KEYS: Record<Action, string> = { merge: 'u', land: 'm', rebase: 'R', abort: 'U' }

// An action's git, where it runs, what the first press asks, and what to say after by git's exit code
// (0, or 1 for stopping on conflicts); any other code says it failed.
type Step = { ask: string; cwd: string; args: string[]; said: Record<number, string> }

// What an action would do to `tree`, or why it can't. m merges into the base in the base's own worktree,
// as git can't move a branch another worktree has checked out, so that worktree must be clean too.
// A merge or rebase stopped on conflicts goes on with u or R once they are all resolved and added.
const planFor = (action: Action, tree: Tree, repo: Repo): Step | string => {
  const name = label(tree)
  const base = repo.base
  const baseTree = repo.trees.find(t => t.isBase)
  const n = tree.conflicts.length
  const conflicts = `${n} conflict${n === 1 ? '' : 's'}`
  const unresolved = tree.uncommitted.filter(c => c.tag === 'conflict').length
  const resolveFirst = `${name} has ${unresolved} unresolved file${unresolved === 1 ? '' : 's'}: resolve, git add, then`
  if (action === 'abort') {
    const what = tree.isMerging ? 'merge' : 'rebase'
    if (!tree.isMerging && !tree.isRebasing) return `${name} is not merging or rebasing anything.`

    return { ask: `abort ${name}'s ${what} and put it back as it was`, cwd: tree.path, args: [what, '--abort'], said: { 0: `Aborted ${name}'s ${what}.` } }
  }
  if (tree.isMerging) {
    if (action !== 'merge') return `${name} is merging ${base}: resolve and u commits it, or U aborts.`
    if (unresolved > 0) return `${resolveFirst} u commits the merge.`

    return { ask: `commit the merge of ${base} into ${name}`, cwd: tree.path, args: ['commit', '--no-edit'], said: { 0: `Merged ${base} into ${name}.` } }
  }
  if (tree.isRebasing) {
    if (action !== 'rebase') return `${name} is rebasing onto ${base}: resolve and R carries on, or U aborts.`
    if (unresolved > 0) return `${resolveFirst} R carries the rebase on.`

    return {
      ask: `carry on rebasing ${name} onto ${base}`,
      cwd: tree.path,
      args: ['rebase', '--continue'],
      said: { 0: `Rebased ${name} onto ${base}.`, 1: `Rebasing ${name} stopped on conflicts again: resolve, git add, then R; U aborts.` },
    }
  }
  if (tree.isBase) return action === 'land' ? `${name} is the base branch: m merges another worktree's branch into it.` : `${name} is the base branch.`
  if (tree.uncommitted.length > 0) return `${name} has uncommitted changes: commit them first.`

  if (action === 'merge') {
    if (tree.behind === 0) return `${name} already has everything in ${base}.`

    return {
      ask: `merge ${base} into ${name}${n > 0 ? `, leaving ${conflicts} to resolve` : ''}`,
      cwd: tree.path,
      args: ['merge', '--no-edit', base],
      said: { 0: `Merged ${base} into ${name}.`, 1: `Merged ${base} into ${name} with conflicts: resolve them and commit, or U to abort.` },
    }
  }

  if (action === 'rebase') {
    if (tree.behind === 0) return `${name} already has everything in ${base}.`

    return {
      ask: `rebase ${name} onto ${base}${n > 0 ? ', which will stop on conflicts to resolve' : ''}`,
      cwd: tree.path,
      args: ['rebase', base],
      said: { 0: `Rebased ${name} onto ${base}.`, 1: `Rebasing ${name} stopped on conflicts: resolve, git add, then R carries on; U aborts.` },
    }
  }

  if (!tree.branch) return `${name} is not on a branch.`
  if (tree.ahead === 0) return `${name} has nothing ${base} doesn't.`
  if (n > 0) return `${name} would conflict with ${base} (${conflicts}): u merges ${base} in to resolve them first.`
  if (!baseTree) return `${base} is not checked out in any worktree to merge into.`
  if (baseTree.uncommitted.length > 0 || baseTree.isMerging || baseTree.isRebasing) return `${base}'s worktree has uncommitted changes: commit them first.`

  return {
    ask: `merge ${name} into ${base}${tree.behind === 0 ? ', a fast-forward' : ' with a merge commit'}`,
    cwd: baseTree.path,
    args: ['merge', '--no-edit', tree.branch],
    said: { 0: `Merged ${name} into ${base}.`, 1: `Merging ${name} into ${base} conflicted after all: resolve it in ${base}'s worktree, or U there to abort.` },
  }
}

// What S does: brings every worktree behind the base up to it, leaving alone any it can't do safely. One with no commits
// of its own fast-forwards; one with commits gets the base merged in when merge-tree sees no conflict. One with
// uncommitted changes, in the middle of a merge or rebase, or that would conflict is skipped, with why.
type Sync = { tree: Tree; isFastForward: boolean }

const planSync = (repo: Repo) => {
  const syncs: Sync[] = []
  const skipped: string[] = []
  for (const tree of repo.trees.filter(t => !t.isBase && t.behind > 0)) {
    const why = tree.isMerging
      ? 'merging'
      : tree.isRebasing
        ? 'rebasing'
        : tree.uncommitted.length > 0
          ? 'uncommitted'
          : tree.conflicts.length > 0
            ? 'conflicts'
            : ''
    if (why) skipped.push(`${label(tree)}: ${why}`)
    else syncs.push({ tree, isFastForward: tree.ahead === 0 })
  }

  return { syncs, skipped }
}

// ---- Help ----

// Columns apart in the `?` list.
const HELP_GAP = 4

// A line of the `?` list in each of its columns: an area's name, a key and what it does, or nothing.
type HelpCell = string | [string, string] | undefined

// The `?` list laid out in `columns`: the areas run down as many columns as fit side by side, as evenly as they go,
// a blank line after each. `width` is each column's, `keyWidth` the widest key's, so descriptions line up.
const layoutHelp = (columns: number) => {
  const keyWidth = Math.max(...KEYS.flatMap(a => a.keys.map(([k]) => k.length)))
  const widest = Math.max(...KEYS.flatMap(a => a.keys.map(([, what]) => keyWidth + 2 + what.length)))
  const count = Math.max(1, Math.min(KEYS.length, Math.floor((columns + HELP_GAP) / (widest + HELP_GAP))))
  const width = Math.floor((columns + HELP_GAP) / count) - HELP_GAP
  const areas: HelpCell[][] = KEYS.map(a => [a.area, ...a.keys, undefined])
  // The shortest columns the areas fit in, taken in order.
  const total = areas.reduce((n, a) => n + a.length, 0)
  let stacks: HelpCell[][] = []
  for (let most = Math.ceil(total / count); stacks.length === 0 || stacks.length > count; most++) {
    stacks = [[]]
    for (const area of areas) {
      if (stacks.at(-1)!.length > 0 && stacks.at(-1)!.length + area.length > most) stacks.push([])
      stacks.at(-1)!.push(...area)
    }
  }
  const length = Math.max(...stacks.map(s => s.length)) - 1
  const lines = Array.from({ length }, (_, n) => stacks.map(s => s[n]))

  return { lines, width, keyWidth }
}

// ---- Saved state ----

// Where kelp remembers the repository holding `root`: ~/.cache/kelp/<hash>.json, the hash of git's own folder,
// which every worktree of the repository shares. Outside a repository, the hash of `root` itself.
const stateFile = (root: string) => {
  let dir = root
  try {
    const run = Bun.spawnSync(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, stdout: 'pipe', stderr: 'ignore' })
    if (run.exitCode === 0) dir = run.stdout.toString().trim()
  } catch {
    // No git: keyed by the folder.
  }
  const cache = process.env.XDG_CACHE_HOME || `${homedir()}/.cache`

  return `${cache}/kelp/${Bun.hash(dir).toString(16)}.json`
}

// What was saved, or nothing when there is no file or it can't be read.
const loadSaved = (file: string): Partial<Saved> => {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'))

    return typeof saved === 'object' && saved !== null ? saved : {}
  } catch {
    return {}
  }
}

// Saves quietly: a cache that can't be written only means starting afresh next time.
const save = (file: string, saved: Saved) => {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(saved))
  } catch {
    // Nothing to do.
  }
}

// ---- View ----

const App = ({ root, saved }: { root: string; saved: Partial<Saved> }) => {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [size, setSize] = useState({ columns: stdout.columns, rows: stdout.rows })
  const [tab, setTab] = useState<Tab>(saved.tab === 'repo' ? 'repo' : 'worktrees')
  const [repo, setRepo] = useState<Repo | null | undefined>(undefined)
  // The repo tab's files, read only while it is shown.
  const [files, setFiles] = useState<Files | null | undefined>(undefined)
  // Bumped whenever a refresh finds something changed, so open uncommitted diffs are read again.
  const [version, setVersion] = useState(0)
  const [updatedAt, setUpdatedAt] = useState(0)
  // The rows opened or closed against how they start, in either tab.
  const [toggled, setToggled] = useState(new Set<string>(Array.isArray(saved.toggled) ? saved.toggled : []))
  // Diffs and, in the repo tab, whole files, by the row they sit under.
  const [diffs, setDiffs] = useState(new Map<string, Diff>())
  // Whether the repo tab shows an open file or its diff against HEAD.
  const [isDiff, setIsDiff] = useState(saved.isDiff === true)
  const [sort, setSort] = useState<Sort>(SORTS.find(s => s === saved.sort) ?? SORTS[0])
  const [notice, setNotice] = useState('')
  // What kelp is doing to each worktree, by its folder.
  const [jobs, setJobs] = useState(new Map<string, Job>())
  const setJob = (path: string, job?: Job) =>
    setJobs(cur => {
      const next = new Map(cur)
      if (job) next.set(path, job)
      else next.delete(path)

      return next
    })
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
  // How far the list of keys is scrolled, when it is longer than the screen.
  const [helpTop, setHelpTop] = useState(0)
  // Each tab's `/` filter, '' for none.
  const [filters, setFilters] = useState<Record<Tab, string>>({ worktrees: '', repo: '', ...saved.filters })
  // Each tab keeps its own cursor and scroll.
  const [cursors, setCursors] = useState<Record<Tab, string>>({ worktrees: '', repo: '', ...saved.cursors })
  // Bumped to draw again after the wheel moves the view and the cursor's row stays the same.
  const [, redraw] = useState(0)
  const tops = useRef<Record<Tab, number>>({ worktrees: 0, repo: 0 })
  const lastIndexes = useRef<Record<Tab, number>>({ worktrees: 0, repo: 0 })
  const tabRef = useRef(tab)
  tabRef.current = tab
  const pending = useRef(new Set<string>())
  // Where `A` last took the cursor, and when, so a second press soon after goes on to its tmux pane.
  const lastWaiting = useRef({ path: '', at: 0 })
  const refresh = useRef(async () => {})
  const isFetching = useRef(false)
  // The pull requests by branch, fetched from GitHub on their own slower clock so they never hold up a refresh.
  const [prs, setPrs] = useState(new Map<string, Pr>())
  const fetchPrs = useRef(async () => {})

  // Remembers the view a moment after it last changed, and on quitting, so a restart opens it as it was.
  useEffect(() => {
    latest = { tab, toggled: [...toggled].slice(-MAX_TOGGLED), cursors, filters, isDiff, sort }
    const timer = setTimeout(() => latest && save(STATE_FILE, latest), SAVE_MS)

    return () => clearTimeout(timer)
  }, [tab, toggled, cursors, filters, isDiff, sort])

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
    // Whether each agent, by pid, waited for the person at the last refresh; null before the first.
    let wasWaiting: Map<number, boolean> | null = null
    refresh.current = async () => {
      if (isBusy) {
        isAgain = true
        return
      }
      isBusy = true
      try {
        const [found, listed] = await Promise.all([loadRepo(root), tabRef.current === 'repo' ? loadFiles(root) : undefined])
        // An agent that starts waiting rings the bell, once, and says so; not one already waiting when kelp starts.
        const agents = (found?.trees ?? []).flatMap(t => t.agents.map(agent => ({ agent, tree: t })))
        const started = agents.filter(({ agent }) => agent.isWaiting && wasWaiting?.get(agent.pid) === false)
        wasWaiting = new Map(agents.map(({ agent }) => [agent.pid, agent.isWaiting === true]))
        if (started.length > 0) {
          process.stdout.write('\x07')
          const { agent, tree } = started[0]
          const others = started.length > 1 ? `, and ${started.length - 1} more` : ''
          setNotice(`◆ ${agent.name} in ${label(tree)} is waiting${agent.says ? `: ${agent.says.slice(0, 60)}` : ''}${others}`)
        }
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

  // Ticks while a command runs, so its time stays current.
  useEffect(() => {
    const timer = setInterval(() => {
      if ([...runs.values()].some(r => isRunning(r))) redraw(n => n + 1)
    }, 1000)

    return () => clearInterval(timer)
  }, [])

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
    tab === 'repo'
      ? (files ? buildRepoRows(files, isOpen, diffs, isDiff, filters.repo) : empty)
      : repo ? buildRows({ ...repo, trees: sortTrees(repo.trees, sort) }, isOpen, diffs, columns, prs, filters.worktrees, jobs) : empty
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

  // The `?` list of keys in lines, cut to the screen's height when longer, its last line then saying so.
  const { lines: helpLines, width: helpWidth, keyWidth } = layoutHelp(columns)
  const helpRoom = helpLines.length > height ? height - 1 : height
  const shownHelpTop = Math.max(0, Math.min(helpTop, helpLines.length - helpRoom))
  const scrollHelp = (lines: number) => setHelpTop(t => Math.max(0, Math.min(helpLines.length - helpRoom, Math.min(t, shownHelpTop) + lines)))

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
    if (base === 64) return isHelp ? scrollHelp(-WHEEL_LINES) : scroll(-WHEEL_LINES)
    if (base === 65) return isHelp ? scrollHelp(WHEEL_LINES) : scroll(WHEEL_LINES)
    if (isHelp) return
    if (base !== 0) return
    const tabHit = line === 1 ? TABS.find(t => column >= tabColumns(t)[0] && column <= tabColumns(t)[1]) : undefined
    if (tabHit) return switchTab(tabHit)
    // The header is the first line, so the rows start on the second.
    const clicked = rows[top + line - 2]
    if (line < 2 || line - 2 >= height || !clicked || clicked.isGap) return
    setCursor(clicked.key)
    if (clicked.canOpen) toggle(clicked.key)
  }

  // Moves the cursor to the next worktree, after the one it is in, with an agent waiting for the person.
  const nextWaiting = () => {
    if (!repo) return
    const here = treeUnder()
    const last = lastWaiting.current
    if (here && last.path === here.path && Date.now() - last.at < AGAIN_MS) {
      lastWaiting.current = { path: '', at: 0 }
      return jumpTo(here).then(setNotice)
    }
    const from = here ? repo.trees.indexOf(here) : -1
    const next = [...repo.trees.slice(from + 1), ...repo.trees.slice(0, from + 1)].find(t => t.agents.some(a => a.isWaiting))
    if (!next) return setNotice('No agent is waiting for you.')
    switchTab('worktrees')
    setCursors(cur => ({ ...cur, worktrees: `tree\t${next.path}` }))
    lastWaiting.current = { path: next.path, at: Date.now() }
    const agent = next.agents.find(a => a.isWaiting)!
    setNotice(`◆ ${agent.name} in ${label(next)} is waiting${agent.says ? `: ${agent.says.slice(0, 60)}` : ''} · A again for its tmux pane`)
  }

  // `>`: asks for a message and types it into the tmux pane of the worktree's claude, the one waiting for the person
  // first, else an idle one, else one at work, which takes it once its turn is done. Says why when there is no pane to send to.
  // On a line of a diff or file it asks for a review note instead, sent as "<file>:<line>: <note>".
  const reply = async () => {
    const tree = treeUnder()
    if (!repo || !tree) return setNotice('Move to a worktree to answer its claude.')
    const name = label(tree)
    const claudes = tree.agents.filter(a => a.name === 'claude')
    const agent = claudes.find(a => a.isWaiting) ?? claudes.find(a => a.isBusy === false) ?? claudes[0]
    if (!agent) return setNotice(`No claude runs in ${name}, so there is nothing to send to: a starts one.`)
    if (!process.env.TMUX) return setNotice(`kelp is not in tmux, so it has no pane to send to claude in ${name} through.`)
    const pane = paneOf(repo.trees.flatMap(t => t.panes), agent.pid)
    if (!pane) return setNotice(`claude in ${name} runs in no tmux pane kelp can see, so there is nowhere to send to.`)
    const state = agent.isWaiting ? 'waiting' : agent.isBusy ? 'working' : 'idle'
    // A line under a file, not the file's own line, which opens and closes.
    const at = row?.file && !row.canOpen && row.file.startsWith(`${tree.path}/`) ? `${row.file.slice(tree.path.length + 1)}:${row.line ?? 1}` : ''
    // Asking leave to run a tool, its menu wants yes or no, not free text; a note goes with a no.
    if (agent.isAsking || (await isAskingIn(pane))) {
      const asks = agent.says?.startsWith('wants ') ? agent.says.slice(6) : 'a tool'
      return ask(`claude in ${name} asks to run ${asks.length > 50 ? `${asks.slice(0, 49)}…` : asks} · allow? y/n, or n and what to do instead:`, async answer => {
        const no = answer.match(/^no?(?:\s+|$)(.*)$/i)
        if (!/^y(es)?$/i.test(answer) && !no) return setNotice('Nothing sent: answer y or n.')
        const instead = no?.[1] && at ? `${at}: ${no[1]}` : (no?.[1] ?? '')
        const isSent = await answerAsking(pane, !no, instead)
        setNotice(!isSent ? `Couldn't send keys to tmux pane ${pane.id}.` : no ? `Told claude in ${name} no${instead ? ', and what to do instead' : ''}.` : `Allowed claude in ${name} to run ${asks}.`)
        refresh.current()
      })
    }
    ask(at ? `note on ${at} for claude in ${name} (${state}):` : `reply to claude in ${name} (${state}):`, async text => {
      if (!text) return
      const isSent = await typeInto(pane, at ? `${at}: ${text}` : text)
      setNotice(isSent ? `Sent to claude in ${name}, tmux pane ${pane.id}.` : `Couldn't type into tmux pane ${pane.id}.`)
      refresh.current()
    })
  }

  // The worktree under the cursor, or in the repo tab the one it explores.
  const treeUnder = () =>
    tab === 'repo' ? (repo && files ? treeAt(repo.trees, files.dir) : undefined) : repo?.trees.find(t => row?.key.split('\t')[1] === t.path)

  // Runs what a key plans for the worktree under the cursor on its second press, the first saying what it will do.
  const act = (action: Action) => {
    const tree = repo?.trees.find(t => row?.key.split('\t')[1] === t.path)
    if (!repo || !tree) return
    const step = planFor(action, tree, repo)
    if (typeof step === 'string') return setNotice(step)

    confirm(ACTION_KEYS[action], `${step.ask[0].toUpperCase()}${step.ask.slice(1)}`, async () => {
      const command = `git ${step.args.join(' ')}`
      setNotice(`Running ${command} in ${shortPath(step.cwd)}…`)
      const run = await gitRun(step.cwd, step.args, { GIT_EDITOR: 'true' })
      await refresh.current()
      setNotice((run && step.said[run.code]) || `${command} failed: run it in ${shortPath(step.cwd)} to see why.`)
    })
  }

  // Pushes the worktree's branch, setting its upstream on the remote the first time; true when it went.
  const push = async (tree: Tree) => {
    if (!repo) return false
    const name = label(tree)
    setNotice(`Pushing ${name} to ${repo.remote}…`)
    const run = await runCommand(tree.path, tree.upstream ? ['git', 'push'] : ['git', 'push', '-u', repo.remote, tree.branch])
    await refresh.current()
    if (run?.code === 0) setNotice(`Pushed ${name} to ${repo.remote}.`)
    else setNotice(`Couldn't push ${name}: ${run ? whyFailed(run.err) : 'git did not start'}`)

    return run?.code === 0
  }

  // What `p`, `P` and `b` do to the worktree under the cursor: push its branch, open a pull request for it
  // with gh (on a second press, pushing first when needed), or show its pull request or branch on GitHub.
  const remoteAct = (kind: 'push' | 'pr' | 'browse') => {
    const tree = repo?.trees.find(t => row?.key.split('\t')[1] === t.path)
    if (!repo || !tree) return
    const name = label(tree)
    const pr = tree.isBase ? undefined : prs.get(tree.branch)
    const needsPush = !tree.upstream || tree.unpushed > 0 || tree.isUpstreamGone
    if (kind === 'browse') {
      if (pr) return setNotice(openInBrowser(pr.url))
      if (!repo.github) return setNotice(repo.remote ? `${repo.remote} is not on GitHub.` : 'This repository has no remote.')
      const branch = tree.upstream.startsWith(`${repo.remote}/`) && !tree.isUpstreamGone ? tree.upstream.slice(repo.remote.length + 1) : ''

      return setNotice(openInBrowser(branch ? `${repo.github}/tree/${encodeURI(branch)}` : repo.github))
    }
    if (!repo.remote) return setNotice('This repository has no remote to push to.')
    if (!tree.branch) return setNotice(`${name} is not on a branch.`)
    if (kind === 'push') {
      if (!needsPush) return setNotice(`${name} is already pushed.`)
      return void push(tree)
    }
    if (!repo.github) return setNotice(`${repo.remote} is not on GitHub.`)
    if (tree.isBase) return setNotice(`${name} is the base branch.`)
    if (pr && (pr.state === 'open' || pr.state === 'draft')) return setNotice(`${name} already has pull request #${pr.number}: b opens it.`)
    if (tree.ahead === 0) return setNotice(`${name} has nothing ahead of ${repo.base} to propose.`)

    confirm('P', `${needsPush ? `Push ${name} and open` : 'Open'} a pull request from ${name} into ${repo.base} with gh pr create --fill`, async () => {
      if (needsPush && !(await push(tree))) return
      setNotice(`Opening a pull request for ${name}…`)
      const slug = repo.github.replace('https://github.com/', '')
      const run = await runCommand(tree.path, ['gh', 'pr', 'create', '--fill', '--repo', slug, '--base', repo.base, '--head', tree.branch])
      if (!run) return setNotice('gh is not installed: see https://cli.github.com')
      if (run.code !== 0) return setNotice(`Couldn't open the pull request: ${whyFailed(run.err)}`)
      setNotice(`Opened ${run.out.trim().split('\n').pop()}`)
      fetchPrs.current()
    })
  }

  // Syncs every worktree with the base on a second press of S, one at a time, then says in one line what came of it.
  // A merge that conflicts after all, though merge-tree saw none, is aborted, so a sync never leaves one half done.
  const syncAll = () => {
    if (!repo) return
    const base = repo.base
    const { syncs, skipped } = planSync(repo)
    const skips = skipped.length > 0 ? `skipped ${skipped.length} (${skipped.join(', ')})` : ''
    if (syncs.length === 0) return setNotice(skips ? `Nothing to sync safely: ${skips}.` : `Every worktree already has everything in ${base}.`)
    const forwards = syncs.filter(s => s.isFastForward).length
    const plan = [forwards > 0 && `fast-forward ${forwards}`, syncs.length > forwards && `merge ${base} into ${syncs.length - forwards}`, skipped.length > 0 && `skip ${skipped.length}`]

    confirm('S', `Sync every worktree with ${base}: ${plan.filter(Boolean).join(', ')}`, async () => {
      setNotice(`Syncing ${syncs.length} worktree${syncs.length === 1 ? '' : 's'} with ${base}…`)
      let forwarded = 0
      let merged = 0
      const failed: string[] = []
      for (const { tree, isFastForward } of syncs) {
        const run = await gitRun(tree.path, isFastForward ? ['merge', '--ff-only', base] : ['merge', '--no-edit', base], { GIT_EDITOR: 'true' })
        if (run?.code === 0 && isFastForward) forwarded++
        else if (run?.code === 0) merged++
        else {
          if (!isFastForward) await gitRun(tree.path, ['merge', '--abort'])
          failed.push(label(tree))
        }
      }
      await refresh.current()
      const how = [forwarded > 0 && `fast-forwarded ${forwarded}`, merged > 0 && `merged ${base} into ${merged}`].filter(Boolean).join(', ')
      const said = [
        forwarded + merged > 0 && `Synced ${forwarded + merged} with ${base} (${how})`,
        skips,
        failed.length > 0 && `${failed.length} failed and left as it was (${failed.join(', ')})`,
      ]
      setNotice(`${said.filter(Boolean).join(', ')}.`.replace(/^./, c => c.toUpperCase()))
    })
  }

  // Fetches every remote in the background, then refreshes; quiet when the repository has none.
  const fetchAll = async () => {
    if (!repo?.remote || isFetching.current) return
    isFetching.current = true
    setNotice('Fetching every remote…')
    const run = await gitRun(repo.dir, ['fetch', '--all', '--prune', '--quiet'], FETCH_ENV)
    isFetching.current = false
    await refresh.current()
    setNotice(run?.code === 0 ? 'Fetched every remote.' : `Couldn't fetch: run git fetch --all in ${shortPath(repo.dir)} to see why.`)
  }

  // Asks `label` in the footer, then calls `onDone` with the answer, unless esc is pressed.
  const ask = (label: string, onDone: (answer: string) => void, text = '', more: Pick<Prompt, 'onChange' | 'onCancel'> = {}) =>
    setPrompt({ label, text, onDone, ...more })

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

  // Runs .kelp.json commands one at a time in the worktree at `path` with `env`, each shown under its line as it runs.
  // Stops at the first that fails, left shown in red, and says why; null when all ran.
  const runHooks = async (path: string, commands: string[], env: Record<string, string>) => {
    for (const command of commands) {
      setJob(path, { text: `Running ${command}…` })
      const run = await runCommand(path, ['sh', '-c', command], env)
      if (run?.code !== 0) {
        const why = `${command} failed (${run ? `exit ${run.code}: ${whyFailed(run.err || run.out)}` : "couldn't start"})`
        setJob(path, { text: why, isFailed: true })
        return why
      }
    }

    return null
  }

  // Makes a worktree for the branch named and puts the cursor on it, then readies it: copies the main worktree's
  // ignored local files it needs and runs .kelp.json's postCreate commands, saying how far it has got under its line.
  // Its folder once made, readied or not, else null.
  const createTree = async (branch: string) => {
    if (!repo || !branch) return null
    const path = newTreePath(repo, branch)
    const main = repo.trees.find(t => t.isMain)?.path ?? repo.dir
    setNotice(`Creating ${branch} at ${shortPath(path)}…`)
    const failed = await addTree(repo, branch, path)
    if (failed) {
      setNotice(`Couldn't create ${branch}: ${failed}`)
      return null
    }
    setCursors(cur => ({ ...cur, worktrees: `tree\t${path}` }))
    refresh.current()

    const config = readConfig(main)
    if (config.error) {
      setJob(path, { text: config.error, isFailed: true })
      return path
    }
    const files = await localFiles(main, config.copy)
    const done = [`Created ${branch}`]
    if (files.length > 0) {
      setJob(path, { text: `Copying ${files.join(', ')}…` })
      const why = copyFiles(main, path, files)
      if (why) {
        setJob(path, { text: `Couldn't copy the local files: ${why}`, isFailed: true })
        return path
      }
      done.push(`copied ${files.join(', ')}`)
    }
    if (await runHooks(path, config.postCreate, kelpEnv({ path, branch, isBase: false }, [...repo.trees, { path, branch, isBase: false }], repo.base))) return path
    done.push(...config.postCreate.map(command => `ran ${command}`))
    setJob(path)
    setNotice(done.join(', '))

    return path
  }

  // N: asks for a branch, then for what claude should do there; makes the worktree as `n` does,
  // then starts claude in it with that prompt, once the worktree is readied. A branch ending in *3, such as
  // fix-login*3, makes several attempts at once: fix-login-1 to fix-login-3, each with claude on the same prompt.
  const newTask = () =>
    ask('new task on branch (name*3 for 3 attempts)', answer => {
      if (!answer) return
      const many = answer.match(/^(.+)\*(\d+)$/)
      const count = many ? Number(many[2]) : 1
      if (count < 1 || count > MAX_ATTEMPTS) return setNotice(`Between 1 and ${MAX_ATTEMPTS} attempts at once.`)
      const branches = many ? Array.from({ length: count }, (_, k) => `${many[1]}-${k + 1}`) : [answer]
      ask(`task for claude in ${many ? `${branches[0]} to ${branches.at(-1)}` : answer}:`, async task => {
        if (!task) return setNotice('No task started: the prompt was empty.')
        const started: string[] = []
        for (const branch of branches) {
          const path = await createTree(branch)
          if (!path) continue
          const said = await startClaude(path, branch, task)
          if (!said.startsWith('Started')) return setNotice(said)
          started.push(branch)
        }
        refresh.current()
        if (started.length > 0) setNotice(started.length === 1 ? `Started claude in ${started[0]} on the task.` : `Started claude in ${started.join(', ')} on the same task.`)
      })
    })

  // The path of what the cursor is on: a file (or a line of it), a folder in the repo tab, else its worktree.
  const pathUnder = () => {
    if (row?.file) return row.file
    if (tab === 'repo' && files) return row?.key.startsWith('dir\t') ? `${files.dir}/${row.key.slice(4)}` : files.dir
    return treeUnder()?.path
  }

  // Copies the path under the cursor to the clipboard and says what it copied.
  const copyPath = async () => {
    const path = pathUnder()
    if (!path) return setNotice('Nothing here to copy.')
    await copyText(path)
    setNotice(`Copied ${path} to the clipboard.`)
  }

  // Quits kelp to switch to the worktree under the cursor: its path is printed, and written to --cd-file, for the shell to cd to.
  const switchTree = () => {
    const path = tab === 'repo' ? files?.dir : treeUnder()?.path
    if (!path) return setNotice('Put the cursor on a worktree to switch to it.')
    switchTo = path
    exit()
  }

  // The page of the dev server in the worktree: the address its command printed when it serves that port, else the port
  // it serves (its own $PORT first), else the address alone; '' when it serves nothing.
  const serverUrl = (tree: Tree) => {
    const run = runs.get(tree.path)
    const printed = isRunning(run) && run!.url ? run!.url.replace(/^(https?:\/\/)?(0\.0\.0\.0|\[::\])/, '$1localhost') : ''
    const printedPort = Number(printed.match(/:(\d+)/)?.[1] ?? 0)
    const port = tree.ports.find(p => p === portOf(tree, repo?.trees ?? [])) ?? tree.ports[0]
    const url = printed && (!port || tree.ports.includes(printedPort)) ? printed : port ? `localhost:${port}` : ''

    return url && !/^https?:\/\//.test(url) ? `http://${url}` : url
  }

  // Opens the dev server of the worktree under the cursor in the browser.
  const openServer = () => {
    const tree = treeUnder()
    if (!tree) return setNotice('Put the cursor on a worktree to open its dev server.')
    const url = serverUrl(tree)
    const port = portOf(tree, repo?.trees ?? [])
    if (!url) return setNotice(`${label(tree)} serves nothing: start its dev server with ! or :${port ? `, on $PORT ${port}` : ''}.`)
    setNotice(openInBrowser(url))
  }

  // Opens the file under the cursor at its line, or else its worktree (or repo-tab folder), in $EDITOR.
  const edit = () => {
    const at = row?.file ? row : row && parentOf(row)
    const path = at?.file ?? pathUnder()
    if (!path) return setNotice('Nothing here to open.')
    openInEditor(path, at?.line ?? 1).then(setNotice)
  }

  // The uncommitted file the cursor is on or in the diff of: its worktree's folder, its path there, and whether git tracks it.
  const uncommittedUnder = () => {
    const at = row && (row.canOpen ? row : parentOf(row))
    const parts = at?.key.split('\t') ?? []
    const dir = tab === 'repo' ? files?.dir : treeUnder()?.path
    // An uncommitted file's line is "tree\t<worktree>\tuncommitted\t<file>" in the worktrees tab, "file\t<file>" in the repo tab.
    const file = tab === 'repo' ? (parts[0] === 'file' ? parts[1] : undefined) : parts[2] === 'uncommitted' && parts.length === 4 ? parts[3] : undefined
    const change = treeUnder()?.uncommitted.find(c => c.path === file)
    const code = tab === 'repo' ? files?.status[file ?? ''] : change && (change.isUntracked ? '??' : 'M')
    if (!dir || !file || !code) return undefined

    return { dir, file, isUntracked: code === '??' }
  }

  // Throws away the uncommitted changes of the file under the cursor, on a second press:
  // a tracked file goes back to its last commit, an untracked one is deleted.
  const discard = () => {
    const under = uncommittedUnder()
    if (tab === 'worktrees' && row?.key.startsWith('tree\t') && row.key.split('\t').length === 2) return setNotice('D discards an uncommitted file; it does nothing to a whole worktree.')
    if (!under) return setNotice('Put the cursor on an uncommitted file to discard its changes.')
    const { dir, file, isUntracked } = under
    // A repository inside this one, such as another worktree, shows as its folder; kelp never deletes those.
    if (file.endsWith('/')) return setNotice(`${file} is a repository of its own: kelp won't delete it.`)

    confirm('D', isUntracked ? `Delete ${file}, which git does not track` : `Throw away the uncommitted changes to ${file}`, async () => {
      let isDone = false
      if (isUntracked) {
        try {
          rmSync(`${dir}/${file}`, { force: true })
          isDone = true
        } catch {
          // Left as it was.
        }
      } else {
        isDone = (await gitRun(dir, ['restore', '--source=HEAD', '--staged', '--worktree', '--', `:(literal)${file}`]))?.code === 0
      }
      await refresh.current()
      if (!isDone) return setNotice(`Could not discard ${file}: run git restore in ${shortPath(dir)} to see why.`)
      setNotice(isUntracked ? `Deleted ${file}.` : `Discarded the changes to ${file}.`)
    })
  }

  // Asks for a message, then commits what is staged in the worktree under the cursor, or with nothing staged
  // everything uncommitted, untracked files included.
  const commitAll = () => {
    const tree = treeUnder()
    if (!tree) return
    const name = label(tree)
    const n = tree.uncommitted.length
    if (n === 0) return setNotice(`${name} has nothing to commit.`)
    const staged = tree.uncommitted.filter(c => c.stage).length
    const what = staged > 0 ? `the ${plural(staged, 'staged file')}` : `all ${plural(n, 'file')}`
    ask(`commit ${what} in ${name}:`, async message => {
      if (!message) return setNotice('Nothing committed: the message was empty.')
      setNotice(`Committing in ${name}…`)
      const added = staged > 0 ? { code: 0 } : await gitRun(tree.path, ['add', '-A'])
      const run = added?.code === 0 ? await gitRun(tree.path, ['commit', '--quiet', '-m', message]) : null
      const hash = (await git(tree.path, ['rev-parse', '--short', 'HEAD']))?.trim()
      await refresh.current()
      setNotice(run?.code === 0 ? `Committed ${hash} ${message} in ${name}.` : `The commit failed: run git commit in ${shortPath(tree.path)} to see why.`)
    })
  }

  // The hunk the cursor is in, on a line of an uncommitted file's diff: the file's folder and path, the hunk's lines,
  // and whether the diff shown is of staged changes. Only for a changed file git tracks; a new, deleted
  // or binary one is staged whole.
  const hunkUnder = () => {
    const tree = treeUnder()
    const parent = row?.parent
    const at = Number(row?.key.split('\t').pop())
    const parts = parent?.split('\t') ?? []
    if (tab !== 'worktrees' || !tree || !parent || parts[2] !== 'uncommitted' || parts.length !== 4 || !Number.isInteger(at)) return undefined
    const change = tree.uncommitted.find(c => c.path === parts[3])
    const diff = diffs.get(parent)
    if (!change || change.tag !== '' || change.isUntracked || !diff) return undefined
    const start = diff.lines.findLastIndex((l, n) => n <= at && l.startsWith('@@'))
    const next = diff.lines.findIndex((l, n) => n > at && l.startsWith('@@'))
    const end = next === -1 ? diff.lines.length : next
    if (start === -1) return undefined

    return { dir: tree.path, file: change.path, change, lines: diff.lines.slice(start, end), isCut: diff.isCut && next === -1, isStaged: change.stage === 'staged' }
  }

  // Stages (+) or unstages (-) the hunk under the cursor in a file's diff by applying it to the index, as a patch.
  const stageHunk = async (hunk: NonNullable<ReturnType<typeof hunkUnder>>, isStage: boolean) => {
    const { dir, file } = hunk
    if (hunk.isCut) return setNotice(`The diff of ${file} is cut short there: stage the whole file with ${isStage ? '+' : '-'} on its line.`)
    if (hunk.change.stage === 'partly') return setNotice(`${file} is partly staged: stage or unstage it whole on its line.`)
    if (isStage === hunk.isStaged) return setNotice(`That hunk of ${file} is already ${isStage ? 'staged' : 'unstaged'}.`)
    const patch = `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${hunk.lines.join('\n')}\n`
    const failed = await applyToIndex(dir, patch, !isStage)
    await refresh.current()
    setNotice(failed ? `Couldn't ${isStage ? 'stage' : 'unstage'} the hunk: ${failed}` : `${isStage ? 'Staged' : 'Unstaged'} a hunk of ${file}.`)
  }

  // Stages (+) or unstages (-) the uncommitted file under the cursor, or on a worktree's "uncommitted" line all its files;
  // on a line of a file's diff, only the hunk it is in.
  const stage = async (isStage: boolean) => {
    const hunk = hunkUnder()
    if (hunk) return stageHunk(hunk, isStage)
    const tree = treeUnder()
    const isAll = tab === 'worktrees' && tree !== undefined && row?.key === `tree\t${tree.path}\tuncommitted`
    const under = isAll ? undefined : uncommittedUnder()
    const dir = isAll ? tree!.path : under?.dir
    if (!dir) return setNotice(`Put the cursor on an uncommitted file, or the "uncommitted" line for all of them, to ${isStage ? 'stage' : 'unstage'} it.`)
    const what = isAll ? `every file in ${label(tree!)}` : under!.file
    const target = isAll ? [] : ['--', `:(literal)${under!.file}`]
    const run = await gitRun(dir, isStage ? ['add', '-A', ...target] : ['reset', '-q', ...target])
    await refresh.current()
    if (run?.code !== 0) return setNotice(`Could not ${isStage ? 'stage' : 'unstage'} ${what}: run git status in ${shortPath(dir)} to see why.`)
    setNotice(`${isStage ? 'Staged' : 'Unstaged'} ${what}.`)
  }

  // Asks for a message, then stashes everything uncommitted in the worktree under the cursor, untracked files included.
  const stashAll = () => {
    const tree = treeUnder()
    if (!tree) return
    const name = label(tree)
    const n = tree.uncommitted.length
    if (n === 0) return setNotice(`${name} has nothing to stash.`)
    ask(`stash ${plural(n, 'file')} in ${name}, message:`, async message => {
      setNotice(`Stashing in ${name}…`)
      const run = await runCommand(tree.path, ['git', 'stash', 'push', '--include-untracked', ...(message ? ['-m', message] : [])])
      await refresh.current()
      setNotice(run?.code === 0 ? `Stashed ${plural(n, 'file')} in ${name}${message ? `: ${message}` : ''}.` : `Couldn't stash: ${run ? whyFailed(run.err) : 'git did not start'}`)
    })
  }

  // The stash the cursor is on or in, by its commit.
  const stashUnder = (tree: Tree) => {
    const parts = row?.key.split('\t') ?? []

    return parts[2] === 'stash' ? tree.stashes.find(s => s.hash === parts[3]) : undefined
  }

  // Pops the stash under the cursor, or else the worktree's latest, into the worktree on a second press of Z.
  const popStash = () => {
    const tree = treeUnder()
    if (!tree) return
    const name = label(tree)
    const stash = stashUnder(tree) ?? tree.stashes[0]
    if (!stash) return setNotice(`${name} has no stashes: z stashes its uncommitted changes.`)

    confirm('Z', `Pop ${stash.ref} (${stash.message}) into ${name}, dropping it from the stash list`, async () => {
      // Found again by its commit, as other stashes may have come or gone since.
      const list = (await git(tree.path, ['stash', 'list', '--format=%gd%x00%H'])) ?? ''
      const ref = list.split('\n').map(l => l.split('\0')).find(([, hash]) => hash === stash.hash)?.[0]
      if (!ref) return setNotice(`${stash.ref} is gone from the stash list.`)
      setNotice(`Popping ${ref} into ${name}…`)
      const run = await runCommand(tree.path, ['git', 'stash', 'pop', '--quiet', ref])
      await refresh.current()
      if (run?.code === 0) return setNotice(`Popped ${ref} into ${name}.`)
      // A pop that conflicts leaves the conflicts in the files and keeps the stash.
      setNotice(`Couldn't pop ${ref} cleanly: ${run ? whyFailed(run.err || run.out) : 'git did not start'}`)
    })
  }

  // Removes the worktree under the cursor on a second press of x, or of X to force it past uncommitted changes
  // and unmerged commits, deleting its branch when that is fully in the base and keeping it otherwise.
  const removeTree = (isForce: boolean) => {
    const tree = repo?.trees.find(t => row?.key.split('\t')[1] === t.path)
    if (!repo || !tree) return
    const plan = planRemoval(tree, repo, root, isForce)
    if (typeof plan === 'string') return setNotice(plan)
    const main = repo.trees.find(t => t.isMain)?.path ?? repo.dir
    const { preRemove } = readConfig(main)
    const hooks = preRemove.length > 0 ? `, after running ${preRemove.join(', ')}${isForce ? ' even if it fails' : ''}` : ''

    confirm(isForce ? 'X' : 'x', `${plan.ask}${hooks}`, async () => {
      const name = label(tree)
      // A preRemove command that fails keeps the worktree, unless X forces it.
      const hookFailed = await runHooks(tree.path, preRemove, kelpEnv(tree, repo.trees, repo.base))
      if (hookFailed && !isForce) return setNotice(`Kept ${name}: ${hookFailed}. X removes it anyway.`)
      setNotice(`Removing ${name}…`)
      const failed = await gitDo(main, ['worktree', 'remove', ...(isForce ? ['--force'] : []), tree.path])
      if (failed) {
        await refresh.current()
        return setNotice(`Couldn't remove ${name}: ${failed}`)
      }
      setJob(tree.path)
      // Checked again, as the branch may have moved since the first press.
      const isMerged = plan.isBranchGone && (await git(main, ['merge-base', '--is-ancestor', tree.branch, repo.base])) !== null
      const isDeleted = isMerged && (await gitDo(main, ['branch', '-D', tree.branch])) === null
      await refresh.current()
      const branch = !tree.branch ? '' : isDeleted ? ` and its branch, fully in ${repo.base}` : `; kept its branch ${tree.branch}, not fully in ${repo.base}`
      setNotice(`Removed ${name}${branch}.`)
    })
  }

  // Cleans up on a second press of C: prunes the missing worktrees, then removes each clean, merged one and its branch.
  const cleanUp = () => {
    if (!repo) return
    const { missing, merged } = planCleanup(repo, root)
    if (missing.length + merged.length === 0) return setNotice(`Nothing to clean up: no missing worktrees, and none clean and merged into ${repo.base}.`)
    const prune = missing.length > 0 ? `prune ${plural(missing.length, 'missing worktree')}` : ''
    const remove = merged.length > 0 ? `remove ${merged.map(label).join(', ')} with ${merged.length === 1 ? 'its branch' : 'their branches'}, merged into ${repo.base}` : ''
    const ask = [prune, remove].filter(Boolean).join(', and ')

    confirm('C', `${ask[0].toUpperCase()}${ask.slice(1)}`, async () => {
      const main = repo.trees.find(t => t.isMain)?.path ?? repo.dir
      setNotice('Cleaning up…')
      const failures: string[] = []
      if (missing.length > 0) {
        const failed = await gitDo(main, ['worktree', 'prune'])
        if (failed) failures.push(`prune: ${failed}`)
      }
      const removed: string[] = []
      const { preRemove } = readConfig(main)
      for (const tree of merged) {
        const failed = (await runHooks(tree.path, preRemove, kelpEnv(tree, repo.trees, repo.base))) ?? (await gitDo(main, ['worktree', 'remove', tree.path]))
        if (failed) {
          failures.push(`${label(tree)}: ${failed}`)
          continue
        }
        removed.push(label(tree))
        setJob(tree.path)
        // Checked again, as the branch may have moved since the first press.
        if ((await git(main, ['merge-base', '--is-ancestor', tree.branch, repo.base])) !== null) await gitDo(main, ['branch', '-D', tree.branch])
      }
      await refresh.current()
      const done = [
        missing.length > 0 && !failures.some(f => f.startsWith('prune')) && `Pruned ${plural(missing.length, 'missing worktree')}`,
        removed.length > 0 && `Removed ${removed.join(', ')}`,
        failures.length > 0 && `Couldn't: ${failures.join('; ')}`,
      ]
      setNotice(`${done.filter(Boolean).join('. ')}.`)
    })
  }

  // A key typed while the footer asks a question: ⏎ answers, esc gives up, backspace and ctrl+u erase.
  const typeInPrompt = (input: string, key: { return: boolean; escape: boolean; backspace: boolean; delete: boolean; ctrl: boolean; meta: boolean }) => {
    const p = promptRef.current!
    if (key.escape) {
      setPrompt(null)
      return p.onCancel?.()
    }
    if (key.return) {
      setPrompt(null)
      return p.onDone(p.text.trim())
    }
    const text =
      key.backspace || key.delete ? p.text.slice(0, -1)
      : key.ctrl && input === 'u' ? ''
      : key.ctrl || key.meta ? p.text
      : p.text + input.replace(/[\r\n\t]/g, '')
    if (text === p.text) return
    setPrompt({ ...p, text })
    p.onChange?.(text)
  }

  // The folder of the worktree under the cursor, or in the repo tab the one it explores.
  const treeAtCursor = () => treeUnder()?.path ?? (tab === 'repo' ? files?.dir : undefined)
  const treeName = (path: string) => {
    const tree = repo?.trees.find(t => t.path === path)

    return tree ? label(tree) : shortPath(path)
  }

  // Output can come fast; it is drawn at most ten times a second.
  const drawTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const drawRunsSoon = () => {
    if (drawTimer.current) return
    drawTimer.current = setTimeout(() => {
      drawTimer.current = undefined
      redraw(n => n + 1)
    }, 100)
  }

  // Runs `command` in the worktree at `tree` and shows its output under it, unless one runs there already.
  const runIn = (tree: string, command: string) => {
    const running = runs.get(tree)
    if (isRunning(running)) return setNotice(`${treeName(tree)} still runs ${running!.command}; K twice stops it`)
    const at = repo && treeAt(repo.trees, tree)
    try {
      startRun(tree, command, at ? kelpEnv(at, repo.trees, repo.base) : {}, drawRunsSoon)
    } catch {
      return setNotice(`Couldn't run ${command} in ${shortPath(tree)}`)
    }
    if (tab === 'repo') return setNotice(`Running ${command} in ${treeName(tree)}; its output is in the worktrees tab`)
    // Open the worktree and its run section, and go to it.
    const key = `tree\t${tree}`
    setToggled(cur => {
      const next = new Set(cur)
      next.delete(key)
      next.delete(`${key}\trun`)

      return next
    })
    setCursor(`${key}\trun`)
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
      else if (key.upArrow || input === 'k') scrollHelp(-1)
      else if (key.downArrow || input === 'j') scrollHelp(1)
      else if (key.pageUp || (key.ctrl && input === 'u')) scrollHelp(-helpRoom)
      else if (key.pageDown || (key.ctrl && input === 'd')) scrollHelp(helpRoom)
      else if (input === 'g') scrollHelp(-helpLines.length)
      else if (input === 'G') scrollHelp(helpLines.length)
    }
    else if (input === '?') {
      setIsHelp(true)
      setHelpTop(0)
    }
    else if (input === 's' && tab === 'worktrees') setSort(SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length])
    else if (input === '/') {
      // Narrows the tab as the filter is typed; ⏎ keeps it, esc drops it.
      const filterBy = (text: string) => setFilters(cur => ({ ...cur, [tab]: text.trim() }))
      ask('/', filterBy, filters[tab], { onChange: filterBy, onCancel: () => filterBy('') })
    }
    else if (key.escape && filters[tab]) setFilters(cur => ({ ...cur, [tab]: '' }))
    else if (input === 'q') exit()
    else if (input === 'u' && !key.ctrl && tab === 'worktrees') act('merge')
    else if (input === 'U' && tab === 'worktrees') act('abort')
    else if (input === 'm' && tab === 'worktrees') act('land')
    else if (input === 'c' && !key.ctrl) commitAll()
    else if (input === 'D') discard()
    else if (input === '+' || input === '-') stage(input === '+')
    else if (input === 'z' && tab === 'worktrees') stashAll()
    else if (input === 'Z' && tab === 'worktrees') popStash()
    else if (input === 'A') nextWaiting()
    else if (input === '>') reply()
    else if (input === 't' || input === 'a') {
      const tree = treeUnder()
      if (tree) (input === 't' ? jumpTo(tree) : startClaude(tree.path, label(tree))).then(text => {
        setNotice(text)
        refresh.current()
      })
    }
    else if (input === 'y') copyPath()
    else if (input === 'e') edit()
    else if (input === 'w') switchTree()
    else if (input === 'B') openServer()
    else if (input === 'p' && tab === 'worktrees') remoteAct('push')
    else if (input === 'P' && tab === 'worktrees') remoteAct('pr')
    else if (input === 'b' && tab === 'worktrees') remoteAct('browse')
    else if (input === 'R' && tab === 'worktrees') act('rebase')
    else if (input === 'S' && tab === 'worktrees') syncAll()
    else if (input === 'f') fetchAll()
    else if (input === 'r') refresh.current()
    else if (input === '!') {
      const tree = treeAtCursor()
      if (!tree) return setNotice('Move to a worktree to run a command in it')
      ask(`run in ${treeName(tree)}:`, command => command && runIn(tree, command), runs.get(tree)?.command)
    }
    else if (input === 'K') {
      // Stops the worktree's command, pressed twice; one that has ended goes from view at once.
      const tree = treeAtCursor()
      const run = tree ? runs.get(tree) : undefined
      if (!tree || !run) return setNotice('No command run here')
      if (!isRunning(run)) {
        runs.delete(tree)
        return redraw(n => n + 1)
      }
      confirm('K', `Stop ${run.command} in ${treeName(tree)}, and everything it started`, () => {
        stopRun(run)
        setNotice(`Stopping ${run.command}…`)
      })
    }
    else if (input === ':') {
      // Names one of the worktree's commands; the start of a name, or any part of it, will do.
      const tree = treeAtCursor()
      if (!tree) return setNotice('Move to a worktree to run a command in it')
      const commands = loadCommands(tree, repo?.dir ?? tree)
      if (commands.length === 0) return setNotice(`No commands: add { "commands": { "test": "bun test" } } to .kelp.json, or scripts to package.json`)
      const last = commands.find(c => c.command === runs.get(tree)?.command)?.name
      ask(`run in ${treeName(tree)} (${commands.map(c => c.name).join(' · ')}):`, name => {
        if (!name) return
        const found = commands.find(c => c.name === name) ?? commands.find(c => c.name.startsWith(name)) ?? commands.find(c => c.name.includes(name))
        if (!found) return setNotice(`No command named ${name}`)
        runIn(tree, found.command)
      }, last)
    }
    else if (key.tab) switchTab(tab === 'worktrees' ? 'repo' : 'worktrees')
    else if (input === '1') switchTab('worktrees')
    else if (input === '2') switchTab('repo')
    else if (input === 'd' && !key.ctrl && tab === 'repo') setIsDiff(v => !v)
    else if (input === 'o') {
      // A row with no file of its own, such as "Loading…", opens the file it sits under.
      const at = row?.file ? row : row && parentOf(row)
      if (at?.file) openInNvim(at.file, at.line ?? 1).then(setNotice)
    }
    else if (input === 'n' && tab === 'worktrees' && repo) ask('new worktree for branch', createTree)
    else if (input === 'N' && tab === 'worktrees' && repo) newTask()
    else if ((input === 'x' || input === 'X') && tab === 'worktrees') removeTree(input === 'X')
    else if (input === 'C' && tab === 'worktrees') cleanUp()
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
      <Text bold>{HEADER_LEAD}</Text>
      {TABS.map((t, k) => (
        <Text key={t}>
          {k > 0 && ' '}
          {tabName(t)}
        </Text>
      ))}
      {filters[tab] && <Text color="yellow">  /{filters[tab]}</Text>}
      {tab === 'worktrees' && repo && (
        <Text dimColor>  {shortPath(repo.dir)} · {repo.trees.length} worktree{repo.trees.length === 1 ? '' : 's'} · base {repo.base}{sort !== SORTS[0] && ` · ${SORT_NAMES[sort]}`}</Text>
      )}
      {tab === 'worktrees' && conflicting > 0 && (
        <Text color="red"> · {conflicting} would conflict</Text>
      )}
      {tab === 'worktrees' && shared > 0 && <Text color="yellow"> · {shared} shared file{shared === 1 ? '' : 's'}</Text>}
      {tab === 'repo' && files && (
        <Text dimColor>  {shortPath(files.dir)} · {files.files.length}{files.isCut ? '+' : ''} files · showing {isDiff ? 'diffs vs HEAD' : 'files'}</Text>
      )}
      {tab === 'repo' && changed > 0 && <Text color="yellow"> · {changed} changed</Text>}
    </Text>
  )
  // The footer keeps to the keys most wanted here; `?` lists them all. Discarding is offered only on an uncommitted file.
  const isUncommittedLine = tab === 'worktrees' && row?.key.endsWith('\tuncommitted') === true
  const isStashLine = tab === 'worktrees' && row?.key.split('\t')[2] === 'stash'
  const discardKey = uncommittedUnder() ? ' · +/- stage · D discard' : isUncommittedLine ? ' · +/- stage all · z stash' : isStashLine ? ' · Z pop' : ''
  // The merge keys for the worktree under the cursor: carrying on or aborting what is under way, else merging the base in.
  const cursorTree = repo?.trees.find(t => row?.key.split('\t')[1] === t.path)
  const mergeKeys = cursorTree?.isMerging ? 'u commit merge · U abort' : cursorTree?.isRebasing ? 'R carry on · U abort' : `u merge ${repo?.base ?? 'base'} in`
  const find = filters[tab] ? '/ change filter · esc clear it' : '/ filter'
  // Answering is offered where a claude waits for the person.
  const replyKey = treeUnder()?.agents.some(a => a.name === 'claude' && a.isWaiting) ? ' · > reply' : ''
  const keys = isHelp
    ? `? esc close${helpLines.length > height ? ' · j k scroll' : ''}`
    : tab === 'repo'
      ? `⏎ open/close · ${find} · d ${isDiff ? 'files' : 'diffs'} · o nvim · c commit${discardKey} · tab worktrees · ? keys · q quit`
      : `⏎ open · ${find} · n new · t tmux · a claude${replyKey} · ! run${isRunning(runs.get(treeAtCursor() ?? '')) ? ' · K stop' : ''}${cursorTree && serverUrl(cursorTree) ? ' · B browser' : ''} · c commit${discardKey} · ${mergeKeys}${repo?.remote ? ' · p push' : ''}${repo?.github ? ' · P PR' : ''} · ? keys · q quit`
  const help = (
    <Box flexDirection="column">
      {helpLines.slice(shownHelpTop, shownHelpTop + helpRoom).map((cells, n) => (
        <Box key={n} flexWrap="nowrap">
          {cells.map((cell, k) => (
            <Box key={k} width={helpWidth} marginRight={k < cells.length - 1 ? HELP_GAP : 0}>
              <Text wrap="truncate-end">
                {typeof cell === 'string' ? <Text bold>{cell}</Text> : cell ? <><Text color="blue">{cell[0].padEnd(keyWidth)}</Text>  <Text dimColor>{cell[1]}</Text></> : ' '}
              </Text>
            </Box>
          ))}
        </Box>
      ))}
      {helpLines.length > height && (
        <Text dimColor wrap="truncate-end">
          … lines {shownHelpTop + 1}–{Math.min(helpLines.length, shownHelpTop + helpRoom)} of {helpLines.length} · j k scroll
        </Text>
      )}
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

// `kelp [folder] [--cd-file <path>]`: with --cd-file, `w` writes the worktree it switches to there, for a shell wrapper to cd to.
const args = process.argv.slice(2)
const cdAt = args.indexOf('--cd-file')
const cdFile = cdAt === -1 ? undefined : args[cdAt + 1]
const root = resolve(args.filter((_, k) => cdAt === -1 || (k !== cdAt && k !== cdAt + 1))[0] ?? process.cwd())
const STATE_FILE = stateFile(root)
// The view as it last was, saved once more on quitting.
let latest: Saved | undefined
// The worktree `w` switched to, told once kelp has quit.
let switchTo = ''
// The alternate screen, so quitting gives the terminal back as it was,
// and mouse reports in SGR form: clicks and the wheel, not plain movement.
process.stdout.write('\x1b[?1049h\x1b[H\x1b[?1000h\x1b[?1006h')
const app = render(<App root={root} saved={loadSaved(STATE_FILE)} />)
await app.waitUntilExit()
if (latest) save(STATE_FILE, latest)
// Commands still running, such as dev servers, end with kelp.
for (const run of runs.values()) if (isRunning(run)) stopRun(run)
process.stdout.write('\x1b[?1006l\x1b[?1000l\x1b[?1049l')
if (switchTo) {
  if (cdFile) writeFileSync(cdFile, `${switchTo}\n`)
  console.log(switchTo)
}
