// `docker ps` queries and what can be derived from their rows.
import { dockerArgs, engineScope } from './docker.mjs'
import { DOCKER, run } from './exec.mjs'

export const CONTAINER_ID_RE = /^[0-9a-f]{12,64}$/

// Pure. Container states -> counts; only `running` counts as running, as in the overview's group tallies.
export function containerCounts(states) {
  const running = states.filter((s) => s === 'running').length
  return { running, stopped: states.length - running }
}

// Docker flattens labels as "k=v,k=v", but some values (config_files) contain commas themselves:
// a segment that does not start with "key=" continues the previous value.
function parseLabels(text) {
  const labels = {}
  let last = null
  for (const part of String(text ?? '').split(',')) {
    const m = part.match(/^([\w.\-/]+)=(.*)$/s)
    if (m) { labels[m[1]] = m[2]; last = m[1] } else if (last) labels[last] += `,${part}`
  }
  return labels
}

// Exit codes of an ordinary stop: success, SIGINT and SIGTERM.
const NORMAL_EXIT_CODES = new Set([0, 130, 143])

// Pure. What deserves a marker, from the State and Status columns of `docker ps`:
// { kind: 'unhealthy' | 'starting' | 'restarting' } or { kind: 'exit', code }; null otherwise,
// including any Status wording that is not recognised.
export function containerMarker(state, status) {
  const text = String(status ?? '')
  if (state === 'restarting') return { kind: 'restarting' }
  if (state === 'running') {
    if (text.endsWith('(unhealthy)')) return { kind: 'unhealthy' }
    return text.endsWith('(health: starting)') ? { kind: 'starting' } : null
  }
  const exit = state === 'exited' ? text.match(/^Exited \((\d+)\)/) : null
  if (!exit || NORMAL_EXIT_CODES.has(Number(exit[1]))) return null
  return { kind: 'exit', code: Number(exit[1]) }
}

export async function listContainers() {
  const res = await run(DOCKER, dockerArgs(['ps', '-a', '--format', '{{json .}}']))
  if (!res.ok) return { error: res.stderr.slice(0, 500), containers: [] }
  const containers = res.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const c = JSON.parse(line)
    const labels = parseLabels(c.Labels)
    return {
      id: c.ID, name: c.Names, image: c.Image, state: c.State, status: c.Status, ports: c.Ports,
      marker: containerMarker(c.State, c.Status),
      service: labels['com.docker.compose.service'] ?? null,
      workdir: labels['com.docker.compose.project.working_dir'] ?? null,
      project: labels['com.docker.compose.project'] ?? null,
      configFiles: String(labels['com.docker.compose.project.config_files'] ?? '').split(',').filter(Boolean)
    }
  })
  // The whole engine's counts ride along on the answer of any request that listed its containers.
  const scope = engineScope.getStore()
  if (scope) scope.counts = containerCounts(containers.map((c) => c.state))
  return { error: null, containers }
}
