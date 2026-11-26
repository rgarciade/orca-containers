// Live log followers, one per panel, and the sweep of the ones whose panel went quiet.
import { NOT_OWNED, ownedContainer } from '../scope.mjs'
import { spawnDocker, stopDocker } from './process.mjs'
import { killSearch } from './search.mjs'
import { createChunker } from './text.mjs'

const LOG_TAIL_LINES = 200
const PANEL_IDLE_MS = 15000 // no request from the panel for this long: it is gone

// Live log followers, one per panel id, and when each panel last talked to the worker.
export const followers = new Map() // panelId -> { id, proc, chunker, ended }
const lastSeen = new Map() // panelId -> ms
const followTokens = new Map() // panelId -> highest follow/stop token seen (the panel's counter)

export const touchPanel = (panelId) => lastSeen.set(panelId, Date.now())

export function killFollower(panelId, reason, orca) {
  const f = followers.get(panelId)
  if (!f) return
  followers.delete(panelId)
  f.stopped = true
  f.chunker.stop()
  stopDocker(f.proc)
  if (reason) {
    try { orca.panels.post('colima.logs.end', { id: f.id, reason }, { panel: panelId }) } catch { /* panel closed */ }
  }
}

// A follow older than the latest follow/stop of its panel is dropped (a stop can overtake a slow follow).
export const tokenOf = (input) => (Number.isInteger(input?.token) ? input.token : null)
export function noteToken(panelId, token) {
  if (token === null) return true
  const latest = followTokens.get(panelId) ?? -1
  if (token < latest) return false
  followTokens.set(panelId, token)
  return true
}

export async function followLogs(orca, panelId, input) {
  const token = tokenOf(input)
  if (!noteToken(panelId, token)) return { ok: false, message: 'Superseded.' }
  const { target } = await ownedContainer(orca, String(input?.id ?? ''), input?.scope, true)
  if (!target) return NOT_OWNED
  if (token !== null && followTokens.get(panelId) !== token) return { ok: false, message: 'Superseded.' }
  killFollower(panelId, null, orca)
  killSearch(panelId)
  const proc = spawnDocker(['logs', '-f', '--timestamps', '--tail', String(LOG_TAIL_LINES), target.id])
  const chunker = createChunker((text) => orca.panels.post('colima.logs.chunk', { id: target.id, text }, { panel: panelId }))
  const f = { id: target.id, proc, chunker, stopped: false, scope: input?.scope ?? null }
  followers.set(panelId, f)
  for (const stream of [proc.stdout, proc.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', (d) => chunker.push(d))
  }
  const finish = (reason) => {
    if (f.stopped) return
    chunker.drain()
    if (followers.get(panelId) === f) killFollower(panelId, reason, orca)
  }
  proc.on('error', () => finish('error'))
  proc.on('close', () => finish('exited'))
  return { ok: true, name: target.name }
}

// Kills followers whose panel went quiet or whose container left the active worktree.
export async function sweepFollowers(orca) {
  const now = Date.now()
  for (const [panelId, f] of [...followers]) {
    if (now - (lastSeen.get(panelId) ?? 0) > PANEL_IDLE_MS) { killFollower(panelId, 'idle', orca); continue }
    try {
      const { target, uncertain } = await ownedContainer(orca, f.id, f.scope ?? undefined)
      // Only a positive "not there" kills the follower; a failing CLI or docker is not proof.
      if (!target && !uncertain && followers.get(panelId) === f) killFollower(panelId, 'not-owned', orca)
    } catch { /* transient failure: keep following, retry next sweep */ }
  }
  for (const panelId of [...lastSeen.keys()]) {
    if (!followers.has(panelId) && now - lastSeen.get(panelId) > PANEL_IDLE_MS) { lastSeen.delete(panelId); followTokens.delete(panelId) }
  }
}
