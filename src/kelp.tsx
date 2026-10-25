#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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
// Untracked files over this size are not read for their line count.
const MAX_UNTRACKED = 1_000_000

// ---- Types ----

// A changed file: its path in the worktree, its line counts, and whether it is new, deleted or binary.
type Change = { path: string; added: number; removed: number; tag: '' | 'new' | 'deleted' | 'binary'; isUntracked?: boolean }

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
  // Its newest commit or edited file, ms since the epoch.
  lastAt: number
}

type Repo = { dir: string; base: string; trees: Tree[] }

// A diff to show under an open file, and where it comes from.
type Wanted = { key: string; tree: string; file: string; commit?: string; isUntracked?: boolean }
type Diff = { lines: string[]; isCut: boolean; version: number }

// One line of the view; `parent` is the line it sits under, `canOpen` whether it opens and closes.
type Row = { key: string; parent?: string; depth: number; canOpen?: boolean; node: JSX.Element }

// ---- Git ----

// Git's output, or null when it fails or exits with a code not in `ok`.
const git = async (cwd: string, args: string[], ok = [0]) => {
  try {
    const proc = Bun.spawn(['git', '-c', 'core.quotePath=false', ...args], { cwd, stdout: 'pipe', stderr: 'ignore' })
    const out = await new Response(proc.stdout).text()

    return ok.includes(await proc.exited) ? out : null
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

// A text file's line count, or null when it is binary, too large or unreadable.
const countLines = (file: string) => {
  try {
    if (statSync(file).size > MAX_UNTRACKED) return null
    const text = readFileSync(file, 'utf8')
    if (text.includes('\0')) return null

    return text === '' ? 0 : text.replace(/\n$/, '').split('\n').length
  } catch {
    return null
  }
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
    const tag = code.includes('D') ? 'deleted' : code.includes('A') ? 'new' : count === null ? 'binary' : ''
    changes.push({ path: file, added: count?.[0] ?? 0, removed: count?.[1] ?? 0, tag })
  }

  return changes
}

const loadTree = async (w: { path: string; head: string; branch: string }, base: string): Promise<Tree> => {
  const isBase = w.branch === base
  const range = isBase ? [`-${BASE_COMMITS}`, 'HEAD'] : [`-${MAX_COMMITS}`, `${base}..HEAD`]
  const [log, counts, uncommitted, headAt] = await Promise.all([
    git(w.path, ['log', ...range, '--format=%x01%h%x00%ct%x00%s', '--numstat', '--summary', '--no-renames']),
    isBase ? Promise.resolve('0\t0') : git(w.path, ['rev-list', '--left-right', '--count', `${base}...HEAD`]),
    readUncommitted(w.path),
    git(w.path, ['log', '-1', '--format=%ct']),
  ])
  const [behind, ahead] = (counts ?? '0\t0').trim().split(/\s+/).map(Number)
  const edited = uncommitted.map(c => modifiedAt(`${w.path}/${c.path}`))

  return {
    ...w,
    isBase,
    ahead,
    behind,
    commits: parseLog(log ?? ''),
    uncommitted,
    lastAt: Math.max(Number(headAt ?? 0) * 1000, ...edited),
  }
}

// Every worktree of the repository at or under `root`, the base branch's first and the rest by branch name.
const loadRepo = async (root: string): Promise<Repo | null> => {
  const dir = await findRepo(root)
  if (!dir) return null
  const worktrees = await listWorktrees(dir)
  const base = await findBase(dir, worktrees[0]?.branch ?? '')
  const trees = await Promise.all(worktrees.map(w => loadTree(w, base)))
  trees.sort((a, b) => Number(b.isBase) - Number(a.isBase) || label(a).localeCompare(label(b)))

  return { dir, base, trees }
}

// A file's diff from its first hunk on, against HEAD when uncommitted or within its commit.
const readDiff = async (want: Wanted) => {
  const text = want.commit
    ? await git(want.tree, ['show', '--format=', '--no-renames', want.commit, '--', want.file])
    : want.isUntracked
      ? await git(want.tree, ['diff', '--no-index', '--', '/dev/null', want.file], [0, 1])
      : await git(want.tree, ['diff', 'HEAD', '--no-renames', '--', want.file])
  const lines = (text ?? '').replace(/\n$/, '').split('\n')
  const from = lines.findIndex(l => l.startsWith('@@'))
  const body = from === -1 ? [] : lines.slice(from)

  return { lines: body.slice(0, MAX_DIFF_LINES), isCut: body.length > MAX_DIFF_LINES }
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

// ---- Rows ----

// Every line of the view: each worktree's line, and when open its uncommitted files and its commits,
// each open file's diff under it. `columns` is the width rows are laid out in.
const buildRows = (repo: Repo, isOpen: (key: string, byDefault: boolean) => boolean, diffs: Map<string, Diff>, columns: number) => {
  const rows: Row[] = []
  const wanted: Wanted[] = []
  const others = touchedBy(repo)
  const room = (depth: number) => columns - depth * 2
  const note = (key: string, parent: string, depth: number, text: string) =>
    rows.push({ key, parent, depth, node: <Text dimColor wrap="truncate-end">{text}</Text> })

  // A group's line, folded or not, filled out with a rule as the sidebar's are.
  const groupLine = (key: string, parent: string, title: string, count: number, byDefault: boolean) => {
    const open = isOpen(key, byDefault)
    const files = open ? '' : ` (${count} file${count === 1 ? '' : 's'})`
    const width = room(1)
    const fits = width - 2 - files.length - 2
    const name = title.length > fits ? `${title.slice(0, Math.max(1, fits - 1)).trimEnd()}…` : title
    const text = `${open ? '▾' : '▸'} ${name}${files}`
    rows.push({
      key,
      parent,
      depth: 1,
      canOpen: true,
      node: <Text dimColor wrap="truncate-end">{`${text} ${'─'.repeat(Math.max(0, width - text.length - 1))}`}</Text>,
    })

    return open
  }

  const fileRows = (tree: Tree, change: Change, parent: string, commit?: string) => {
    const key = `${parent}\t${change.path}`
    const open = isOpen(key, false)
    const stats = change.tag === 'binary' ? '' : ` +${change.added} -${change.removed}`
    const tag = change.tag ? ` ${change.tag}` : ''
    const shared = tree.isBase ? [] : (others.get(change.path) ?? []).filter(b => b !== label(tree))
    const also = shared.length > 0 ? ` also in ${shared.join(', ')}` : ''
    const path = fitPath(change.path, Math.max(8, room(2) - 2 - stats.length - tag.length - also.length))
    rows.push({
      key,
      parent,
      depth: 2,
      canOpen: true,
      node: (
        <Text wrap="truncate-end">
          {open ? '▾' : '▸'} <Text bold={open}>{path}</Text>
          {stats && <Text color="green"> +{change.added}</Text>}
          {stats && <Text color="red"> -{change.removed}</Text>}
          {tag && <Text color={change.tag === 'deleted' ? 'red' : change.tag === 'new' ? 'blue' : undefined} dimColor={change.tag === 'binary'}>{tag}</Text>}
          {also && <Text color="yellow">{also}</Text>}
        </Text>
      ),
    })
    if (!open) return
    wanted.push({ key, tree: tree.path, file: change.path, commit, isUntracked: change.isUntracked })
    const diff = diffs.get(key)
    if (!diff) return note(`${key}\tloading`, key, 3, 'Loading…')
    if (diff.lines.length === 0) return note(`${key}\tempty`, key, 3, 'No textual changes.')
    diff.lines.forEach((line, n) => {
      const color = line.startsWith('+') ? 'green' : line.startsWith('-') ? 'red' : line.startsWith('@@') ? 'cyan' : undefined
      rows.push({ key: `${key}\t${n}`, parent: key, depth: 3, node: <Text color={color} dimColor={!color} wrap="truncate-end">{line || ' '}</Text> })
    })
    if (diff.isCut) note(`${key}\tcut`, key, 3, `… diff cut at ${MAX_DIFF_LINES} lines`)
  }

  for (const tree of repo.trees) {
    const key = `tree\t${tree.path}`
    const open = isOpen(key, true)
    const name = label(tree)
    const parts: { text: string; color?: string }[] = []
    if (tree.isBase) parts.push({ text: 'base' })
    if (tree.ahead > 0) parts.push({ text: `${tree.ahead} ahead`, color: 'green' })
    if (tree.behind > 0) parts.push({ text: `${tree.behind} behind`, color: 'yellow' })
    if (tree.uncommitted.length > 0) parts.push({ text: `● ${tree.uncommitted.length} uncommitted`, color: 'yellow' })
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
      node: (
        <Text wrap="truncate-end">
          <Text dimColor>{open ? '▾' : '▸'} </Text>
          <Text bold color={tree.isBase ? undefined : 'blue'}>{name}</Text>
          <Text dimColor>{`${where} ${'─'.repeat(fill)} `}</Text>
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

    if (tree.uncommitted.length > 0) {
      const group = `${key}\tuncommitted`
      if (groupLine(group, key, 'uncommitted', tree.uncommitted.length, true)) {
        for (const change of tree.uncommitted) fileRows(tree, change, group)
      }
    }
    for (const commit of tree.commits) {
      const group = `${key}\t${commit.hash}`
      if (groupLine(group, key, `${commit.hash} ${commit.subject} · ${ago(commit.at)}`, commit.files.length, false)) {
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

// ---- View ----

const App = ({ root }: { root: string }) => {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [size, setSize] = useState({ columns: stdout.columns, rows: stdout.rows })
  const [repo, setRepo] = useState<Repo | null | undefined>(undefined)
  // Bumped whenever a refresh finds something changed, so open uncommitted diffs are read again.
  const [version, setVersion] = useState(0)
  const [updatedAt, setUpdatedAt] = useState(0)
  // The rows opened or closed against how they start.
  const [toggled, setToggled] = useState(new Set<string>())
  const [diffs, setDiffs] = useState(new Map<string, Diff>())
  const [cursor, setCursor] = useState('')
  const top = useRef(0)
  const lastIndex = useRef(0)
  const pending = useRef(new Set<string>())
  const refresh = useRef(async () => {})

  useEffect(() => {
    const onResize = () => setSize({ columns: stdout.columns, rows: stdout.rows })
    stdout.on('resize', onResize)

    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])

  useEffect(() => {
    let isBusy = false
    let seen = ''
    refresh.current = async () => {
      if (isBusy) return
      isBusy = true
      try {
        const found = await loadRepo(root)
        const text = JSON.stringify(found)
        if (text !== seen) {
          seen = text
          setRepo(found)
          setVersion(v => v + 1)
        }
        setUpdatedAt(Date.now())
      } finally {
        isBusy = false
      }
    }
    refresh.current()
    const timer = setInterval(() => refresh.current(), REFRESH_MS)

    return () => clearInterval(timer)
  }, [root])

  const isOpen = (key: string, byDefault: boolean) => byDefault !== toggled.has(key)
  // Gutter of two, and one column spare so a row never touches the edge and wraps.
  const columns = Math.max(20, size.columns - 3)
  const { rows, wanted } = repo ? buildRows(repo, isOpen, diffs, columns) : { rows: [] as Row[], wanted: [] as Wanted[] }

  // Reads each open file's diff not yet read, and an uncommitted one again after a change.
  useEffect(() => {
    for (const want of wanted) {
      const have = diffs.get(want.key)
      if ((have && (want.commit || have.version === version)) || pending.current.has(want.key)) continue
      pending.current.add(want.key)
      readDiff(want).then(diff => {
        pending.current.delete(want.key)
        setDiffs(cur => new Map(cur).set(want.key, { ...diff, version }))
      })
    }
  })

  // The cursor stays on its row across refreshes; when that row goes, it stays where it was.
  let index = rows.findIndex(r => r.key === cursor)
  if (index === -1) index = Math.min(lastIndex.current, rows.length - 1)
  lastIndex.current = Math.max(0, index)
  const height = Math.max(1, size.rows - 3)
  if (index < top.current) top.current = Math.max(0, index)
  if (index >= top.current + height) top.current = index - height + 1
  top.current = Math.max(0, Math.min(top.current, rows.length - height))

  const moveTo = (k: number) => rows.length > 0 && setCursor(rows[Math.max(0, Math.min(rows.length - 1, k))].key)
  const toggle = (key: string) => setToggled(cur => {
    const next = new Set(cur)
    if (!next.delete(key)) next.add(key)

    return next
  })
  const row = rows[index]
  // Opens or closes the row under the cursor, or the row it sits under when it does neither.
  const press = (want?: boolean) => {
    if (!row) return
    const target = row.canOpen ? row : rows.find(r => r.key === row.parent)
    if (!target) return
    const byDefault = target.depth === 0 || target.key.endsWith('\tuncommitted')
    if (want === undefined || isOpen(target.key, byDefault) !== want) toggle(target.key)
    if (target !== row) setCursor(target.key)
  }

  useInput((input, key) => {
    if (input === 'q') exit()
    else if (input === 'r') refresh.current()
    else if (key.upArrow || input === 'k') moveTo(index - 1)
    else if (key.downArrow || input === 'j') moveTo(index + 1)
    else if (key.pageUp || (key.ctrl && input === 'u')) moveTo(index - height)
    else if (key.pageDown || (key.ctrl && input === 'd')) moveTo(index + height)
    else if (input === 'g') moveTo(0)
    else if (input === 'G') moveTo(rows.length - 1)
    else if (key.return || input === ' ') press()
    else if (key.rightArrow || input === 'l') press(true)
    else if (key.leftArrow || input === 'h') {
      // Closes an open row, else steps out to the row it sits under.
      const byDefault = row?.depth === 0 || row?.key.endsWith('\tuncommitted')
      if (row?.canOpen && isOpen(row.key, byDefault === true)) toggle(row.key)
      else if (row?.parent) setCursor(row.parent)
    }
  })

  const shared = repo ? [...touchedBy(repo).values()].filter(b => b.length > 1).length : 0
  const header = repo ? (
    <Text wrap="truncate-end">
      <Text bold>kelp</Text>
      <Text dimColor> {shortPath(repo.dir)} · {repo.trees.length} worktree{repo.trees.length === 1 ? '' : 's'} · base {repo.base}</Text>
      {shared > 0 && <Text color="yellow"> · {shared} file{shared === 1 ? '' : 's'} changed in more than one worktree</Text>}
    </Text>
  ) : (
    <Text bold>kelp</Text>
  )

  return (
    <Box flexDirection="column" height={size.rows - 1}>
      {header}
      <Box flexDirection="column" flexGrow={1}>
        {repo === undefined && <Text dimColor>Reading worktrees…</Text>}
        {repo === null && <Text dimColor>No git repository here, nor in any folder directly inside {shortPath(root)}.</Text>}
        {rows.slice(top.current, top.current + height).map((r, k) => {
          const isCursor = top.current + k === index

          return (
            <Box key={r.key} flexWrap="nowrap">
              <Text color="blue" bold>{isCursor ? '› ' : '  '}</Text>
              <Box paddingLeft={r.depth * 2} width={columns}>{r.node}</Box>
            </Box>
          )
        })}
      </Box>
      <Text dimColor wrap="truncate-end">
        ↑↓ jk move · ⏎ open/close · ←→ hl in/out · g G ends · r refresh · q quit{updatedAt > 0 ? ` · updated ${clockTime(updatedAt)}` : ''}
      </Text>
    </Box>
  )
}

// ---- Main ----

const root = resolve(process.argv[2] ?? process.cwd())
// The alternate screen, so quitting gives the terminal back as it was.
process.stdout.write('\x1b[?1049h\x1b[H')
const app = render(<App root={root} />)
await app.waitUntilExit()
process.stdout.write('\x1b[?1049l')
