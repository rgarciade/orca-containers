// Whole-log search: one per panel and container, at most MAX_LOG_VIEWS per panel.
import { NOT_OWNED, ownedContainer } from '../scope.mjs'
import { spawnDocker, stopDocker } from './process.mjs'
import { createSearchCollector, lineSplitter } from './text.mjs'
import { latestToken, noteToken, tokenOf } from './tokens.mjs'

const SEARCH_QUERY_MAX = 200
const SEARCH_TIMEOUT_MS = 60000

export const MAX_LOG_VIEWS = 3 // log viewers a panel can have open: the same limit as the panel's

export const searches = new Map() // panelId -> Map(containerId -> { cancel }), oldest first

// Forgets an entry, and the panel with it once nothing is left.
const dropSearch = (panelId, id) => {
  const mine = searches.get(panelId)
  mine?.delete(id)
  if (mine && !mine.size) searches.delete(panelId)
}

// Cancels the search of one container, or all of the panel's when `id` is null.
export function killSearch(panelId, id = null) {
  const mine = searches.get(panelId)
  if (!mine) return
  for (const key of id === null ? [...mine.keys()] : [id]) {
    const s = mine.get(key)
    if (!s) continue
    dropSearch(panelId, key)
    s.cancel()
  }
}

// Streams the full `docker logs` of an owned container through the collector.
export async function searchLogs(orca, panelId, input, signal) {
  const query = typeof input?.query === 'string' ? input.query : ''
  if (query.length < 1 || query.length > SEARCH_QUERY_MAX) return { ok: false, message: `Query must be 1 to ${SEARCH_QUERY_MAX} characters.` }
  const id = String(input?.id ?? '')
  const token = tokenOf(input)
  const cancelled = { ok: false, cancelled: true, message: 'Search cancelled.' }
  if (!noteToken(panelId, id, token)) return cancelled
  const { target } = await ownedContainer(orca, id, input?.scope)
  // Stopped, followed or searched again during the check: no process, and no running search is displaced.
  if (token !== null && latestToken(panelId, id) !== token) return cancelled
  if (!target) return NOT_OWNED
  killSearch(panelId, target.id)
  const collector = createSearchCollector(query, input?.caseSensitive === true)
  return new Promise((resolve) => {
    const proc = spawnDocker(['logs', '--timestamps', target.id])
    let settled = false
    const entry = { cancel: () => finish(cancelled) }
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', entry.cancel)
      if (searches.get(panelId)?.get(target.id) === entry) dropSearch(panelId, target.id)
      stopDocker(proc)
      resolve(result)
    }
    const timer = setTimeout(() => finish({ ok: false, message: 'Search timed out.' }), SEARCH_TIMEOUT_MS)
    while ((searches.get(panelId)?.size ?? 0) >= MAX_LOG_VIEWS) killSearch(panelId, searches.get(panelId).keys().next().value)
    if (!searches.has(panelId)) searches.set(panelId, new Map())
    searches.get(panelId).set(target.id, entry)
    if (signal?.aborted) { entry.cancel(); return }
    signal?.addEventListener?.('abort', entry.cancel, { once: true })
    const splitters = [proc.stdout, proc.stderr].map((stream) => {
      const splitter = lineSplitter((line) => collector.push(line))
      stream.setEncoding('utf8')
      stream.on('data', (d) => splitter.write(d))
      return splitter
    })
    proc.on('error', (err) => finish({ ok: false, message: String(err.message ?? err).slice(0, 300) }))
    proc.on('close', (code) => {
      for (const s of splitters) s.end()
      finish(code === 0 ? { ok: true, ...collector.result() } : { ok: false, message: `docker logs failed (exit ${code}).` })
    })
  })
}
