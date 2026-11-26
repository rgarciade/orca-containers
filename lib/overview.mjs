// The "All" tree: Orca projects and worktrees, other compose projects and individual containers.
import { basename, resolve } from 'node:path'
import { deepestRoot } from './scope.mjs'
import { stripRef } from './worktree.mjs'

// ---- Overview tree ----
const byRunningThenName = (a, b) => (b.running > 0) - (a.running > 0) || String(a.name).localeCompare(String(b.name))
const tally = (items) => ({ running: items.filter((c) => c.state === 'running').length, total: items.length })
const slimContainer = (c) => ({ id: c.id, name: c.name, image: c.image, state: c.state, status: c.status, marker: c.marker, ports: c.ports, project: c.project })
const sortContainers = (items) => items.map(slimContainer).sort((a, b) => (b.state === 'running') - (a.state === 'running') || a.name.localeCompare(b.name))

// Pure. Orca project > worktree > containers, then "other" compose projects and individual containers.
// A container belongs to the DEEPEST worktree that contains its compose working dir (nested paths win,
// /a/b never captures /a/bc). Empty projects/worktrees are omitted; groups with running containers go first.
export function buildOverview(containers, worktrees, repos) {
  const wts = (worktrees ?? []).filter((w) => w && w.path && !w.isArchived).map((w) => ({ w, root: resolve(w.path) }))
  const repoNames = new Map((repos ?? []).map((r) => [r.id, r.displayName || r.path]))
  const byWorktree = new Map() // root -> containers
  const other = new Map() // key -> { name, workdir, items }
  const individual = []
  for (const c of containers ?? []) {
    if (!c.workdir && !c.project) { individual.push(c); continue }
    const dir = c.workdir ? resolve(c.workdir) : null
    const best = deepestRoot(dir, wts.map((t) => t.root))
    if (best) {
      if (!byWorktree.has(best)) byWorktree.set(best, [])
      byWorktree.get(best).push(c)
      continue
    }
    const key = `${c.project ?? ''}\0${c.workdir ?? ''}`
    if (!other.has(key)) other.set(key, { key, name: c.project || (c.workdir ? basename(c.workdir) : 'unknown'), workdir: c.workdir ?? null, items: [] })
    other.get(key).items.push(c)
  }
  const projects = new Map()
  for (const t of wts) {
    const items = byWorktree.get(t.root)
    if (!items) continue
    const id = t.w.repoId ?? ''
    if (!projects.has(id)) projects.set(id, { id, name: repoNames.get(id) ?? 'Unknown project', worktrees: [] })
    projects.get(id).worktrees.push({
      path: t.w.path, name: t.w.displayName || basename(t.w.path), branch: stripRef(t.w.branch),
      ...tally(items), containers: sortContainers(items)
    })
  }
  const projectList = [...projects.values()].map((p) => ({
    ...p, worktrees: p.worktrees.sort(byRunningThenName),
    running: p.worktrees.reduce((n, w) => n + w.running, 0), total: p.worktrees.reduce((n, w) => n + w.total, 0)
  })).sort(byRunningThenName)
  const otherProjects = [...other.values()].map((g) => ({
    key: g.key, name: g.name, workdir: g.workdir, ...tally(g.items), containers: sortContainers(g.items)
  })).sort(byRunningThenName)
  return {
    projects: projectList,
    other: { ...tally(otherProjects.flatMap((p) => p.containers)), projects: otherProjects },
    individual: { ...tally(individual), containers: sortContainers(individual) }
  }
}
