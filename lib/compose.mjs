// Compose stacks as the panel sees them, and the in-flight compose operations.
import { execFile } from 'node:child_process'
import { relative, resolve } from 'node:path'
import { composeScopeStacks, containersOutsideScope, discoverStacks } from './compose-stacks.mjs'
import { listContainers } from './containers.mjs'
import { dockerArgs } from './docker.mjs'
import { CHILD_ENV, DOCKER, ERROR_MAX_CHARS } from './exec.mjs'
import { loadScope } from './scope.mjs'

const COMPOSE_ACTIONS = {
  up: ['up', '-d'],
  down: ['down'], // never `-v`: volumes are data
  restart: ['restart'],
  start: ['start'], // start existing containers (no create)
  stop: ['stop']
}

// In-flight compose operations (they outlive any request), keyed by worktree + stack id.
const composeOps = new Map()
const opKey = (worktree, id) => `${worktree}\0${id}`

// What the panel sees: relative file names and the running operation, never absolute paths.
function publicStack(s, worktree) {
  return {
    id: s.id, project: s.project, running: s.running, total: s.total,
    files: s.files.map((f) => relative(resolve(worktree), f)),
    canUp: s.files.length > 0,
    op: composeOps.get(opKey(worktree, s.id)) ?? null
  }
}

const stacksForScope = async (s) => (s.kind === 'container' ? [] : s.kind === 'compose' ? composeScopeStacks(s.containers) : discoverStacks(s.root, s.containers))

export async function stateForScope(orca, scope) {
  const s = await loadScope(orca, scope)
  if (s.gone) return { gone: true, message: s.error, worktree: null, containers: [], stacks: [], error: null }
  if (!s.root) return { worktree: null, worktreeError: s.worktreeError, containers: [], stacks: [], error: s.error ?? null }
  const stacks = (await stacksForScope(s)).map((st) => publicStack(st, s.root))
  return { worktree: s.root, error: s.error, containers: s.containers, stacks }
}

// Re-discovers server-side so the panel never supplies a path. Returns the internal stack.
async function ownedStack(orca, id, scope) {
  const s = await loadScope(orca, scope, { fresh: true })
  if (!s.root) return { error: 'Could not identify the worktree.' }
  if (s.error) return { error: 'Docker is unreachable. Is the engine running?' }
  const stack = (await stacksForScope(s)).find((st) => st.id === id)
  return stack ? { kind: s.kind, worktree: s.root, stack, scopeContainers: s.containers } : { error: 'Stack is not in the shown scope.' }
}

export async function composeRun(orca, input) {
  const action = input?.action
  if (!Object.hasOwn(COMPOSE_ACTIONS, action)) return { ok: false, message: 'Unknown action.' }
  const id = String(input?.stack ?? '')
  const { kind, worktree, stack, scopeContainers, error } = await ownedStack(orca, id, input?.scope)
  if (!stack) return { ok: false, message: error }
  if (kind === 'compose' && action === 'up') return { ok: false, message: 'Up is not available for Compose projects outside Orca worktrees.' }
  if (action === 'up' && stack.files.length === 0) return { ok: false, message: 'No compose file known for this stack.' }
  if (action !== 'up' && stack.total === 0) return { ok: false, message: 'Stack has no containers.' }
  if (stack.project) {
    const all = await listContainers()
    if (all.error) return { ok: false, message: 'Docker is unreachable. Is the engine running?' }
    const outside = containersOutsideScope(stack.project, scopeContainers, all.containers)
    if (outside.length > 0) return { ok: false, message: `Project ${stack.project} also has ${outside.length} container(s) outside this scope; refusing to act on them.` }
  }
  const key = opKey(worktree, id)
  if (composeOps.has(key)) return { busy: true }
  // Compose scopes: by project name only (no -f, cwd '/'), so label values can never point compose at a directory.
  const args = dockerArgs(['compose', ...(stack.project ? ['-p', stack.project] : []), ...stack.files.flatMap((f) => ['-f', f]), ...COMPOSE_ACTIONS[action]])
  composeOps.set(key, action)
  execFile(DOCKER, args, { cwd: kind === 'compose' ? '/' : stack.workdir, env: CHILD_ENV, maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
    composeOps.delete(key)
    const payload = err
      ? { stack: id, worktree, action, ok: false, error: String(stderr || err).trim().slice(-ERROR_MAX_CHARS) }
      : { stack: id, worktree, action, ok: true }
    orca.panels.post('colima.compose.done', payload)
  })
  return { started: true }
}
