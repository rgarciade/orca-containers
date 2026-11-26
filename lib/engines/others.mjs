// ---- Other engines (the panel's engine switcher) ----
import { readlinkSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { containerCounts } from '../containers.mjs'
import { activeContext, contextMissing, contexts } from '../docker.mjs'
import { DOCKER, run } from '../exec.mjs'
import { detectAdapter } from './context.mjs'

// Only local engines are probed: contacting a remote one without being asked is never acceptable.
const OTHERS_TTL_MS = 30000
const OTHERS_TIMEOUT_MS = 4000
const SYMLINK_MAX_HOPS = 16
let othersCache = null // { key: selection, at, promise }

// Pure. { type: 'unix' | 'npipe', path } for an endpoint on this machine, else null.
export function localEndpoint(endpoint) {
  const m = /^(?:unix:\/\/(\/.+)|npipe:\/\/(\/\/\.\/pipe\/.+))$/.exec(String(endpoint ?? ''))
  if (!m) return null
  return m[1] ? { type: 'unix', path: m[1] } : { type: 'npipe', path: m[2] }
}

// Where a socket path really leads. Followed link by link, so a link to a stopped engine's socket (which
// realpath rejects) still resolves.
function socketTarget(path) {
  let current = path
  for (let hop = 0; hop < SYMLINK_MAX_HOPS; hop++) {
    try { current = join(realpathSync(dirname(current)), basename(current)) } catch { /* no such directory */ }
    try { current = resolve(dirname(current), readlinkSync(current)) } catch { break } // not a link
  }
  return current
}

// Identity of the daemon behind a local endpoint; null for a remote one.
export function endpointKey(endpoint) {
  const local = localEndpoint(endpoint)
  if (!local) return null
  return local.type === 'unix' ? `unix:${socketTarget(local.path)}` : `npipe:${local.path.toLowerCase()}`
}

// The contexts to offer besides the selected one: all of them, in list order. The list is the only switcher,
// so the one thing hidden is a `default` that is just another listed context's daemon.
export function selectOtherEngines(list, selected) {
  const all = list ?? []
  const defaultKey = endpointKey(all.find((c) => c.name === 'default')?.endpoint)
  const aliased = Boolean(defaultKey) && all.some((c) => c.name !== 'default' && endpointKey(c.endpoint) === defaultKey)
  return all.filter((c) => c.name !== selected?.name && !(aliased && c.name === 'default'))
}

// True only when a unix socket is certainly not there; any other stat error is left for docker to report.
export function socketMissing(endpoint) {
  const local = localEndpoint(endpoint)
  if (local?.type !== 'unix') return false
  try { statSync(local.path) } catch (e) { return e.code === 'ENOENT' || e.code === 'ENOTDIR' }
  return false
}

// Pure. `res` is the result of `docker ps -a --format {{.State}}`, or null when the socket is missing and
// nothing was run.
export function otherEngineStatus(res) {
  if (!res) return { state: 'stopped' }
  if (!res.ok) return { state: 'unavailable' }
  return { state: 'running', ...containerCounts(res.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) }
}

// What a row says before (or without) a docker call; state null = local, waiting for its count.
export function otherEngineRow(c) {
  const state = localEndpoint(c.endpoint) ? (socketMissing(c.endpoint) ? 'stopped' : null) : c.endpoint ? 'remote' : 'unavailable'
  return { name: c.name, label: detectAdapter(c).label, state }
}

// A vanished selection is not in the list, so every listed context remains a way out.
export function otherContexts() {
  return selectOtherEngines(contexts, contextMissing ? null : { name: activeContext })
}

// Deliberately outside dockerArgs: these calls target engines other than the selected one, and only read.
async function probeOtherEngine(c) {
  const res = socketMissing(c.endpoint) ? null : await run(DOCKER, ['--context', c.name, 'ps', '-a', '--format', '{{.State}}'], OTHERS_TIMEOUT_MS, 'SIGKILL')
  return otherEngineStatus(res)
}

// Contexts sharing a local socket share one probe; remote ones are never probed.
export function probeOncePerDaemon(list, probe) {
  const byKey = new Map()
  return Promise.all(list.filter((c) => localEndpoint(c.endpoint)).map(async (c) => {
    const key = endpointKey(c.endpoint)
    if (!byKey.has(key)) byKey.set(key, probe(c))
    return { name: c.name, ...await byKey.get(key) }
  }))
}

export function otherEngines() {
  const key = `${contextMissing}\0${activeContext}`
  if (othersCache && othersCache.key === key && Date.now() - othersCache.at < OTHERS_TTL_MS) return othersCache.promise
  const promise = probeOncePerDaemon(otherContexts(), probeOtherEngine)
  othersCache = { key, at: Date.now(), promise }
  return promise
}

export function resetOthersCache() {
  othersCache = null
}
