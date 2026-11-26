// Compose stack discovery and the rules for what a scope may act on.
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { inside } from './worktree.mjs'

// compose.yaml, docker-compose.yml, docker-compose.dev.yml, compose.override.yaml...
const COMPOSE_FILE_RE = /^(?:docker-)?compose(?:\.[\w-]+)*\.ya?ml$/
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]*$/

// Compose stacks of a worktree, from its containers' labels and from compose files in its root.
// Internal shape: { id, project, files (absolute), workdir, running, total }. Every path is
// checked to live inside the worktree; anything else is dropped.
export async function discoverStacks(worktree, containers) {
  const root = resolve(worktree)
  const stacks = new Map()
  for (const c of containers) {
    const workdir = c.workdir ? resolve(c.workdir) : null
    if (!c.project || !PROJECT_RE.test(c.project) || !workdir || !inside(workdir, root)) continue
    const id = `p:${c.project}`
    if (!stacks.has(id)) {
      const files = (c.configFiles ?? []).map((f) => resolve(f))
      // All-or-nothing: a partial file list would start a different stack.
      const safe = files.length > 0 && files.every((f) => inside(f, root) && /\.ya?ml$/.test(f))
      stacks.set(id, { id, project: c.project, files: safe ? files : [], workdir, running: 0, total: 0 })
    }
    const s = stacks.get(id)
    s.total += 1
    if (c.state === 'running') s.running += 1
  }
  const known = new Set([...stacks.values()].flatMap((s) => s.files))
  let entries = []
  try { entries = await readdir(root, { withFileTypes: true }) } catch { /* unreadable root: no file stacks */ }
  for (const e of entries.filter((d) => d.isFile() && COMPOSE_FILE_RE.test(d.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(root, e.name)
    if (known.has(file)) continue
    stacks.set(`f:${e.name}`, { id: `f:${e.name}`, project: null, files: [file], workdir: root, running: 0, total: 0 })
  }
  return [...stacks.values()]
}

// Compose scopes live outside Orca worktrees: their labels are untrusted. A stack is just a project name
// taken from the containers' labels (and format-checked); no files and no working dir are ever used.
export function composeScopeStacks(containers) {
  const stacks = new Map()
  for (const c of containers) {
    if (!c.project || !PROJECT_RE.test(c.project)) continue
    const id = `p:${c.project}`
    if (!stacks.has(id)) stacks.set(id, { id, project: c.project, files: [], workdir: null, running: 0, total: 0 })
    const st = stacks.get(id)
    st.total += 1
    if (c.state === 'running') st.running += 1
  }
  return [...stacks.values()]
}

// Pure. Containers of `project` anywhere on the host that the validated scope does not contain: `-p <project>`
// would act on them too, so such a stack must not be touched from a narrower scope.
export function containersOutsideScope(project, scopeContainers, allContainers) {
  const mine = new Set((scopeContainers ?? []).map((c) => c.id))
  return (allContainers ?? []).filter((c) => c.project === project && !mine.has(c.id))
}
