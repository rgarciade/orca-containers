// Which Orca worktree is focused, and the path helpers shared by the scope rules.
import { orcaJson } from './exec.mjs'

const WORKTREE_AMBIGUITY_TTL_MS = 5000 // an unresolved lookup is retried at most this often

// Maps the active workspace context to a worktree path. The host gives no path (and `orca worktree
// show --worktree active` follows the CLI's cwd, not the focused workspace), so we match:
// 1) terminal ids of the context -> `orca terminal list` -> worktreePath (authoritative);
// 2) branch + display name against `orca worktree list`, only when exactly one worktree fits.
export const stripRef = (b) => String(b ?? '').replace(/^refs\/heads\//, '')

// Pure matcher over `orca worktree list` rows. Returns { path } or { error } saying why not.
export function matchWorktree(worktrees, ctx) {
  const rows = (worktrees ?? []).filter((w) => w && w.path && !w.isArchived)
  const branch = stripRef(ctx?.branch)
  const name = String(ctx?.displayName ?? '')
  const label = branch || name || 'the focused workspace'
  // Exact: same branch (refs/heads/ ignored) and same display name. A detached HEAD has no branch,
  // so only the display name can tell worktrees apart.
  const exact = rows.filter((w) => stripRef(w.branch) === branch && w.displayName === name)
  if (exact.length === 1) return { path: exact[0].path }
  if (exact.length > 1) return { error: `${exact.length} worktrees match ${branch ? `branch ${branch}` : `name ${name}`}. Open a terminal in the one you want.` }
  // Loose: the display name may have been renamed after the context was read; accept a unique branch.
  const byBranch = branch ? rows.filter((w) => stripRef(w.branch) === branch) : []
  if (byBranch.length === 1) return { path: byBranch[0].path }
  if (byBranch.length > 1) return { error: `${byBranch.length} worktrees match branch ${branch}. Open a terminal in the one you want.` }
  const byName = name ? rows.filter((w) => w.displayName === name) : []
  if (byName.length === 1) return { path: byName[0].path }
  if (byName.length > 1) return { error: `${byName.length} worktrees match name ${name}. Open a terminal in the one you want.` }
  return { error: `No Orca worktree matches ${label}.` }
}

let pathCache = { key: null, path: null, error: null, at: 0 }

// Returns { path, error }: exactly one is non-null.
export async function resolveActiveWorktree(orca) {
  const ctx = await orca.host.call('workspace.readContext', {})
  if (!ctx) return { path: null, error: 'No workspace is focused.' }
  const key = JSON.stringify(ctx)
  if (pathCache.key === key && (pathCache.path || Date.now() - pathCache.at < WORKTREE_AMBIGUITY_TTL_MS)) {
    return { path: pathCache.path, error: pathCache.error }
  }
  let found = null
  let error = null
  // Terminal ids are CLI handles (term_...); the CLI terminal list maps them to a worktree path.
  const ids = new Set((ctx.terminals ?? []).map((t) => t.id))
  if (ids.size > 0) {
    const terminals = await orcaJson(['terminal', 'list'])
    const hit = (terminals.result?.terminals ?? []).find((t) => ids.has(t.handle) || ids.has(t.ptyId))
    if (hit?.worktreePath) found = hit.worktreePath
  }
  if (!found) {
    const list = await orcaJson(['worktree', 'list'])
    if (list.ok === false || !list.result?.worktrees) error = 'Could not read the worktree list from the orca CLI.'
    else ({ path: found = null, error = null } = matchWorktree(list.result.worktrees, ctx))
  }
  pathCache = { key, path: found, error, at: Date.now() }
  return { path: found, error }
}

export function resetPathCache() {
  pathCache = { key: null, path: null, error: null, at: 0 }
}

export const inside = (dir, root) => Boolean(dir) && (dir === root || dir.startsWith(`${root}/`))
