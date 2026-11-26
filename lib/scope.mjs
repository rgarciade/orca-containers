// Scope validation and resolution against live data, and container ownership.
import { resolve } from 'node:path'
import { CONTAINER_ID_RE, listContainers } from './containers.mjs'
import { orcaJson } from './exec.mjs'
import { inside, resolveActiveWorktree } from './worktree.mjs'

const ORCA_LISTS_TTL_MS = 10000 // `orca worktree list` / `repo list` are cached this long for the 3s polls

// ---- Scopes ----
// A scope says which containers a handler works on: omitted = the active worktree; { kind: 'worktree', path }
// = that Orca worktree; { kind: 'compose', workdir } = containers of one compose working directory;
// { kind: 'container', id } = one container WITHOUT compose labels. The panel is never trusted: every
// form is re-validated here against the live data.
let listsCache = { at: 0, value: null }

// Pure. The deepest worktree root containing `dir` (nested paths win; /a/b never captures /a/bc), or null.
export function deepestRoot(dir, roots) {
  let best = null
  if (dir) for (const r of roots) if (inside(dir, r) && (!best || r.length > best.length)) best = r
  return best
}

const worktreeRoots = (worktrees) => (worktrees ?? []).filter((w) => w && w.path && !w.isArchived).map((w) => resolve(w.path))

// Containers whose compose working dir belongs to `root` itself, not to a nested worktree.
export function containersOfWorktree(containers, worktrees, root) {
  const r = resolve(root)
  const roots = [...new Set([...worktreeRoots(worktrees), r])]
  return containers.filter((c) => c.workdir && deepestRoot(resolve(c.workdir), roots) === r)
}

// Worktrees and repos from the orca CLI, cached for a few seconds (ORCA_LISTS_TTL_MS). Read-only paths accept
// that staleness: a worktree removed in the last <=10s can still be shown or validated until the cache expires.
// Mutating handlers pass fresh = true. { worktrees, repos, error }.
export async function orcaLists(fresh = false) {
  if (!fresh && listsCache.value && Date.now() - listsCache.at < ORCA_LISTS_TTL_MS) return listsCache.value
  const [wt, repos] = await Promise.all([orcaJson(['worktree', 'list']), orcaJson(['repo', 'list'])])
  const ok = wt.ok !== false && Array.isArray(wt.result?.worktrees) && repos.ok !== false && Array.isArray(repos.result?.repos)
  const value = {
    worktrees: Array.isArray(wt.result?.worktrees) ? wt.result.worktrees : [],
    repos: Array.isArray(repos.result?.repos) ? repos.result.repos : [],
    error: ok ? null : 'Could not read the worktree list from the orca CLI.'
  }
  if (ok) listsCache = { at: Date.now(), value }
  return value
}

// Pure. Exact string equality only: no normalisation, prefixes or relative paths are ever accepted.
// Returns { kind, root } or { gone: true, error }.
export function validateScope(scope, worktrees, containers) {
  if (!scope || typeof scope !== 'object') return { gone: true, error: 'Invalid scope.' }
  if (scope.kind === 'worktree') {
    const hit = typeof scope.path === 'string' && scope.path
      ? (worktrees ?? []).find((w) => w && !w.isArchived && w.path === scope.path)
      : null
    return hit ? { kind: 'worktree', root: hit.path } : { gone: true, error: 'That worktree no longer exists.' }
  }
  if (scope.kind === 'compose') {
    const ok = typeof scope.workdir === 'string' && scope.workdir && (containers ?? []).some((c) => c.workdir === scope.workdir)
    return ok ? { kind: 'compose', root: scope.workdir } : { gone: true, error: 'That Compose project no longer has containers.' }
  }
  if (scope.kind === 'container') {
    // Only containers outside any Compose project (same rule as the overview's "Individual containers").
    const hit = typeof scope.id === 'string' && CONTAINER_ID_RE.test(scope.id)
      ? (containers ?? []).find((c) => c && c.id === scope.id && !c.project && !c.workdir)
      : null
    return hit ? { kind: 'container', root: hit.id } : { gone: true, error: 'That container no longer exists or belongs to a Compose project.' }
  }
  return { gone: true, error: 'Invalid scope.' }
}

// Resolves a scope to { kind, root, containers (that scope's), error (docker), worktreeError, gone }.
// `uncertain` means a transient failure (CLI/docker), so absence of a container proves nothing.
export async function loadScope(orca, scope, { fresh = false } = {}) {
  if (scope == null) {
    const { path, error } = await resolveActiveWorktree(orca)
    if (!path) return { kind: 'worktree', root: null, worktreeError: error, containers: [], error: null, uncertain: true }
    const [r, lists] = await Promise.all([listContainers(), orcaLists(fresh)])
    const mine = lists.error ? r.containers.filter((c) => inside(c.workdir, path)) : containersOfWorktree(r.containers, lists.worktrees, path)
    return { kind: 'worktree', root: path, containers: mine, error: r.error, uncertain: Boolean(r.error || lists.error) }
  }
  if (typeof scope !== 'object') return { gone: true, error: 'Invalid scope.', containers: [] }
  if (scope.kind === 'worktree') {
    const lists = await orcaLists(fresh)
    // A failing CLI is not proof that the worktree is gone.
    if (lists.error) return { kind: 'worktree', root: null, worktreeError: lists.error, containers: [], error: null, uncertain: true }
    const v = validateScope(scope, lists.worktrees, [])
    if (v.gone) return { ...v, containers: [] }
    const r = await listContainers()
    return { kind: 'worktree', root: v.root, containers: containersOfWorktree(r.containers, lists.worktrees, v.root), error: r.error, uncertain: Boolean(r.error) }
  }
  if (scope.kind === 'container') {
    const r = await listContainers()
    if (r.error) return { kind: 'container', root: null, containers: [], error: r.error, uncertain: true }
    const v = validateScope(scope, [], r.containers)
    if (v.gone) return { ...v, containers: [] }
    return { kind: 'container', root: v.root, containers: r.containers.filter((c) => c.id === v.root), error: null }
  }
  const r = await listContainers()
  if (r.error) return { kind: 'compose', root: null, containers: [], error: r.error, uncertain: true }
  const v = validateScope(scope, [], r.containers)
  if (v.gone) {
    // A compose project with no containers left (e.g. right after Down) keeps its pin and shows an empty list.
    if (scope.kind === 'compose' && typeof scope.workdir === 'string' && scope.workdir) return { kind: 'compose', root: scope.workdir, containers: [], error: null }
    return { ...v, containers: [] }
  }
  return { kind: 'compose', root: v.root, containers: r.containers.filter((c) => c.workdir === v.root), error: null }
}

// Resolves a container id only if it belongs to the scope (default: the active worktree).
export async function ownedContainer(orca, id, scope, fresh = false) {
  const s = await loadScope(orca, scope, { fresh })
  return { worktree: s.root, kind: s.kind, uncertain: Boolean(s.uncertain), target: s.containers.find((c) => c.id === id) }
}

export const NOT_OWNED = { ok: false, message: 'Container is not in the shown scope.' }

export function resetListsCache() {
  listsCache = { at: 0, value: null }
}
