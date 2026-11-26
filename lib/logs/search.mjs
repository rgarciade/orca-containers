// Whole-log search: one per panel.
import { NOT_OWNED, ownedContainer } from '../scope.mjs'
import { spawnDocker, stopDocker } from './process.mjs'
import { createSearchCollector, lineSplitter } from './text.mjs'

const SEARCH_QUERY_MAX = 200
const SEARCH_TIMEOUT_MS = 60000

export const searches = new Map() // panelId -> { cancel }

export function killSearch(panelId) {
  const s = searches.get(panelId)
  if (!s) return
  searches.delete(panelId)
  s.cancel()
}

// Streams the full `docker logs` of an owned container through the collector; one search per panel.
export async function searchLogs(orca, panelId, input, signal) {
  const query = typeof input?.query === 'string' ? input.query : ''
  if (query.length < 1 || query.length > SEARCH_QUERY_MAX) return { ok: false, message: `Query must be 1 to ${SEARCH_QUERY_MAX} characters.` }
  const { target } = await ownedContainer(orca, String(input?.id ?? ''), input?.scope)
  if (!target) return NOT_OWNED
  killSearch(panelId)
  const collector = createSearchCollector(query, input?.caseSensitive === true)
  return new Promise((resolve) => {
    const proc = spawnDocker(['logs', '--timestamps', target.id])
    let settled = false
    const entry = { cancel: () => finish({ ok: false, cancelled: true, message: 'Search cancelled.' }) }
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', entry.cancel)
      if (searches.get(panelId) === entry) searches.delete(panelId)
      stopDocker(proc)
      resolve(result)
    }
    const timer = setTimeout(() => finish({ ok: false, message: 'Search timed out.' }), SEARCH_TIMEOUT_MS)
    searches.set(panelId, entry)
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
