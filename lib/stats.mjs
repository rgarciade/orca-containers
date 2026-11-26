// `docker stats` for a scope and the parsing of its columns.
import { execFile } from 'node:child_process'
import { dockerArgs } from './docker.mjs'
import { CHILD_ENV, DOCKER } from './exec.mjs'
import { loadScope } from './scope.mjs'

const UNITS = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 }

// "123.4MiB" -> bytes; null when it cannot be read.
export function parseBytes(text) {
  const m = String(text ?? '').trim().match(/^([\d.]+)\s*([a-zA-Z]*)$/)
  if (!m) return null
  const name = (m[2] || 'b').toLowerCase()
  const unit = Object.hasOwn(UNITS, name) ? UNITS[name] : null
  const n = Number(m[1])
  return unit && Number.isFinite(n) ? Math.round(n * unit) : null
}

const parsePercent = (text) => {
  const n = parseFloat(String(text ?? '').replace('%', ''))
  return Number.isFinite(n) ? n : 0
}

// One `docker stats` JSON line -> numbers for the panel. "123.4MiB / 7.6GiB" is split on the slash.
export function parseStatsLine(c) {
  const [used, limit] = String(c.MemUsage ?? '').split('/')
  return {
    cpuPercent: parsePercent(c.CPUPerc),
    memUsage: parseBytes(used) ?? 0,
    memLimit: parseBytes(limit) ?? 0,
    memPercent: parsePercent(c.MemPerc),
    netIO: c.NetIO ?? '',
    blockIO: c.BlockIO ?? ''
  }
}

// docker stats for the running containers of the scope. Slow (~1-2s), so it has its own handler.
export async function statsForScope(orca, scope) {
  const state = await loadScope(orca, scope)
  const ids = state.containers.filter((c) => c.state === 'running').map((c) => c.id)
  if (ids.length === 0) return { ok: true, stats: {} }
  const res = await new Promise((resolve) => {
    execFile(DOCKER, dockerArgs(['stats', '--no-stream', '--format', '{{json .}}', ...ids]),
      { cwd: '/', env: CHILD_ENV, maxBuffer: 8 * 1024 * 1024, timeout: 15000 },
      (error, stdout, stderr) => resolve({ stdout, stderr: stderr || String(error ?? '') }))
  })
  const stats = {}
  for (const line of res.stdout.split('\n').filter(Boolean)) {
    try {
      const c = JSON.parse(line)
      const own = ids.find((id) => c.ID === id || String(c.ID).startsWith(id) || id.startsWith(String(c.ID)))
      if (own) stats[own] = parseStatsLine(c)
    } catch { /* skip a malformed line */ }
  }
  // A container may stop between ps and stats: partial output is fine.
  return Object.keys(stats).length || !res.stderr ? { ok: true, stats } : { ok: false, message: res.stderr.slice(0, 300) }
}
