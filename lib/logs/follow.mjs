// Live log followers, one per panel and container (at most MAX_LOG_VIEWS per panel), and the sweep of the
// ones whose panel went quiet.
import { NOT_OWNED, ownedContainer } from '../scope.mjs'
import { createMerger } from './merge.mjs'
import { spawnDocker, stopDocker } from './process.mjs'
import { killSearch, MAX_LOG_VIEWS } from './search.mjs'
import { createChunker } from './text.mjs'
import { forgetTokens, latestToken, noteToken, tokenOf } from './tokens.mjs'

export const LOG_TAIL_LINES = 200
const PANEL_IDLE_MS = 15000 // no request from the panel for this long: it is gone

// Live log followers, and when each panel last talked to the worker.
export const followers = new Map() // panelId -> Map(containerId -> { id, proc, chunker, merger, stopped }), oldest first
const lastSeen = new Map() // panelId -> ms

export const touchPanel = (panelId) => lastSeen.set(panelId, Date.now())

// Ends the follower of one container, or all of the panel's when `id` is null. A `reason` is reported to the panel.
export function killFollower(panelId, id, reason, orca) {
  const mine = followers.get(panelId)
  if (!mine) return
  for (const key of id === null ? [...mine.keys()] : [id]) {
    const f = mine.get(key)
    if (!f) continue
    mine.delete(key)
    f.stopped = true
    f.merger.stop()
    f.chunker.stop()
    stopDocker(f.proc)
    if (reason) {
      try { orca.panels.post('colima.logs.end', { id: f.id, reason }, { panel: panelId }) } catch { /* panel closed */ }
    }
  }
  if (!mine.size && followers.get(panelId) === mine) followers.delete(panelId)
}

// Stops the follower and the search of one container (`input.id`), or of all of them when no id is given.
export function stopLogs(orca, panelId, input) {
  const id = input?.id == null ? null : String(input.id)
  noteToken(panelId, id, tokenOf(input))
  killFollower(panelId, id, null, orca)
  killSearch(panelId, id)
  return { ok: true }
}

export async function followLogs(orca, panelId, input) {
  const token = tokenOf(input)
  const id = String(input?.id ?? '')
  if (!noteToken(panelId, id, token)) return { ok: false, message: 'Superseded.' }
  const { target } = await ownedContainer(orca, id, input?.scope, true)
  if (!target) return NOT_OWNED
  if (token !== null && latestToken(panelId, id) !== token) return { ok: false, message: 'Superseded.' }
  killFollower(panelId, target.id, null, orca)
  killSearch(panelId, target.id)
  // Checked here, after the last await, so follows answered together cannot exceed the cap.
  while ((followers.get(panelId)?.size ?? 0) >= MAX_LOG_VIEWS) killFollower(panelId, followers.get(panelId).keys().next().value, 'limit', orca)
  const proc = spawnDocker(['logs', '-f', '--timestamps', '--tail', String(LOG_TAIL_LINES), target.id])
  const chunker = createChunker((text) => orca.panels.post('colima.logs.chunk', { id: target.id, text }, { panel: panelId }))
  const merger = createMerger((text) => chunker.push(text))
  const f = { id: target.id, proc, chunker, merger, stopped: false, scope: input?.scope ?? null }
  if (!followers.has(panelId)) followers.set(panelId, new Map())
  followers.get(panelId).set(target.id, f)
  for (const stream of [proc.stdout, proc.stderr]) {
    const pipe = merger.stream()
    stream.setEncoding('utf8')
    stream.on('data', (d) => pipe.write(d))
  }
  const finish = (reason) => {
    if (f.stopped) return
    merger.end()
    chunker.drain()
    if (followers.get(panelId)?.get(f.id) === f) killFollower(panelId, f.id, reason, orca)
  }
  proc.on('error', () => finish('error'))
  proc.on('close', () => finish('exited'))
  return { ok: true, name: target.name }
}

// Kills followers whose panel went quiet or whose container left the active worktree.
export async function sweepFollowers(orca) {
  const now = Date.now()
  for (const [panelId, mine] of [...followers]) {
    if (now - (lastSeen.get(panelId) ?? 0) > PANEL_IDLE_MS) { killFollower(panelId, null, 'idle', orca); continue }
    for (const f of [...mine.values()]) {
      try {
        const { target, uncertain } = await ownedContainer(orca, f.id, f.scope ?? undefined)
        // Only a positive "not there" kills the follower; a failing CLI or docker is not proof.
        if (!target && !uncertain && followers.get(panelId)?.get(f.id) === f) killFollower(panelId, f.id, 'not-owned', orca)
      } catch { /* transient failure: keep following, retry next sweep */ }
    }
  }
  for (const panelId of [...lastSeen.keys()]) {
    if (!followers.has(panelId) && now - lastSeen.get(panelId) > PANEL_IDLE_MS) { lastSeen.delete(panelId); forgetTokens(panelId) }
  }
}
