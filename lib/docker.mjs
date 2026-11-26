// The selected engine (its only owner) and the per-request guard every docker command goes through.
import { AsyncLocalStorage } from 'node:async_hooks'
import { chooseEngine, detectAdapter, parseContexts, validateContext } from './engines/context.mjs'
import { DOCKER, run } from './exec.mjs'

export const ENGINE_KEY = 'engine' // name of the chosen Docker context

// ---- Engines (Docker contexts) ----
// The engine is a Docker context. Every docker call targets it with the global `--context <name>` flag
// (which beats DOCKER_HOST/DOCKER_CONTEXT). Names always come from the listed contexts, never from the panel.
export let activeContext = null // name of the chosen context; null until resolved (docker then uses its own current one)
let activeSnapshot = null // last known entry of the chosen context (keeps its adapter when the context vanishes)
export let contextMissing = false // the chosen context is no longer listed: nothing runs until the user picks another
export let contexts = [] // last successful `docker context ls`: [{ name, endpoint, current, description, error }]
let contextsOk = false // a context list has been read at least once
let contextsAt = 0
let contextsInflight = null
let enginePromise = null
const CONTEXTS_TTL_MS = 10000

// Each request captures the engine once (before any ownership check); every docker command of that request is
// built through dockerArgs, which re-checks that the engine is still the one the request started with.
export const engineScope = new AsyncLocalStorage()
export class EngineError extends Error {}
export function guardEngine(captured, active, missing) {
  if (missing) return `The engine context ${active ? `"${active}" ` : ''}no longer exists. Select another engine.`
  if (captured !== undefined && captured !== active) return 'The engine changed while this request was running.'
  return null
}
export function dockerArgs(args) {
  const scope = engineScope.getStore()
  const problem = guardEngine(scope ? scope.engine : undefined, activeContext, contextMissing)
  if (problem) throw new EngineError(problem)
  return activeContext ? ['--context', activeContext, ...args] : args
}

const activeEntry = () => validateContext(activeContext, contexts)
export const activeAdapter = () => detectAdapter(activeEntry() ?? activeSnapshot ?? { name: activeContext ?? 'default', endpoint: '' })

// Cached for CONTEXTS_TTL_MS. A failed or timed-out listing keeps the previous list (and is not retried until
// the TTL passes); `force` skips the cache.
export async function loadContexts(force = false) {
  if (!force && Date.now() - contextsAt < CONTEXTS_TTL_MS) return contexts
  contextsInflight ??= (async () => {
    const res = await run(DOCKER, ['context', 'ls', '--format', '{{json .}}'], 8000)
    if (res.ok) { contexts = parseContexts(res.stdout); contextsOk = true }
    contextsAt = Date.now()
    syncMissing()
    return contexts
  })().finally(() => { contextsInflight = null })
  return contextsInflight
}

// After a successful listing: is the chosen context still there?
function syncMissing() {
  if (!activeContext || !contextsOk || contexts.length === 0) return
  const entry = activeEntry()
  contextMissing = !entry
  if (entry) activeSnapshot = entry
}

async function firstReachable(list) {
  for (const c of list) {
    const res = await run(DOCKER, ['--context', c.name, 'version', '--format', '{{.Server.Version}}'], 5000)
    if (res.ok) return c
  }
  return null
}

// Saved choice if it still exists, else the docker CLI's current context, else the first reachable, else the first.
async function pickEngine(orca) {
  let saved = null
  try { saved = (await orca.host.call('storage.get', { key: ENGINE_KEY })).value } catch { /* no saved choice */ }
  if (!contextsOk || contexts.length === 0) { activeContext = typeof saved === 'string' && saved ? saved : null; contextMissing = false; return }
  const pick = chooseEngine(saved, contexts)
  if (pick.probe) pick.name = (await firstReachable(contexts) ?? contexts[0]).name
  activeContext = pick.name
  contextMissing = pick.missing
  activeSnapshot = validateContext(activeContext, contexts)
}

export function ensureEngine(orca) {
  enginePromise ??= (async () => { await loadContexts(); await pickEngine(orca) })().catch(() => {})
  return enginePromise
}

// The user picked `entry`, a context from the live list.
export function selectEngine(entry) {
  activeContext = entry.name
  activeSnapshot = entry
  contextMissing = false
}
