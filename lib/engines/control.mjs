// Engine CLIs: which binary each adapter needs, the steps of an operation and what the panel may offer.
// The binaries are looked up when this module is evaluated.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { contextMissing } from '../docker.mjs'
import { findBin } from '../exec.mjs'

export const COLIMA = findBin('colima')
const ORB = findBin('orb', [join(homedir(), '.orbstack', 'bin')])
const PODMAN = findBin('podman')
const RDCTL = findBin('rdctl', [join(homedir(), '.rd', 'bin')])
const DESKTOP_APP = '/Applications/Docker.app'
// `docker desktop ...` is a CLI plugin (binary `docker-desktop`); Docker Desktop ships it inside the app.
const DESKTOP_PLUGIN = findBin('docker-desktop', [
  join(homedir(), '.docker', 'cli-plugins'), `${DESKTOP_APP}/Contents/Resources/cli-plugins`, '/usr/local/lib/docker/cli-plugins'
])

export const colimaProfileArgs = (ad) => (ad.profile && ad.profile !== 'default' ? ['--profile', ad.profile] : [])

// Which binary the adapter needs; null = nothing to install (generic engines).
function adapterBinary(ad) {
  switch (ad.kind) {
    case 'colima': return { name: 'colima', path: COLIMA }
    case 'orbstack': return { name: 'orb', path: ORB }
    case 'podman': return { name: 'podman', path: PODMAN }
    case 'rancher': return { name: 'rdctl', path: RDCTL }
    case 'desktop': return { name: 'Docker Desktop', path: DESKTOP_PLUGIN ?? (existsSync(DESKTOP_APP) ? DESKTOP_APP : null) }
    default: return null
  }
}

// Steps that perform `op` for the adapter, or null when it cannot be controlled from here.
// A step is { bin, args, wait? }; steps run one after another and stop at the first failure.
// Verified against real CLIs: colima. UNTESTED (written from the vendors' docs, CLI not installed here):
// docker desktop plugin, `open -a Docker`, orb, podman machine, rdctl.
export function enginePlan(ad, op, size) {
  const bin = adapterBinary(ad)
  if (bin && !bin.path) return null
  switch (ad.kind) {
    case 'colima': {
      const p = colimaProfileArgs(ad)
      if (op === 'start') return [{ bin: COLIMA, args: ['start', ...p, '--cpu', String(size?.cpu ?? 2), '--memory', String(size?.memory ?? 2)] }]
      return [{ bin: COLIMA, args: [op, ...p] }]
    }
    case 'desktop': // plugin binaries are called as `docker-desktop desktop <cmd>`, as the docker CLI does
      if (DESKTOP_PLUGIN) return [{ bin: DESKTOP_PLUGIN, args: ['desktop', op] }]
      return op === 'start' ? [{ bin: '/usr/bin/open', args: ['-a', 'Docker'], wait: true }] : null
    case 'orbstack': {
      const start = { bin: ORB, args: ['start'] }
      const stop = { bin: ORB, args: ['stop'] }
      return op === 'start' ? [start] : op === 'stop' ? [stop] : [stop, start]
    }
    case 'podman': {
      const m = ad.machine ? [ad.machine] : []
      const start = { bin: PODMAN, args: ['machine', 'start', ...m] }
      const stop = { bin: PODMAN, args: ['machine', 'stop', ...m] }
      return op === 'start' ? [start] : op === 'stop' ? [stop] : [stop, start]
    }
    case 'rancher': {
      const start = { bin: RDCTL, args: ['start'] }
      const stop = { bin: RDCTL, args: ['shutdown'] }
      return op === 'start' ? [start] : op === 'stop' ? [stop] : [stop, start]
    }
    default: return null
  }
}

// What the panel may offer for the adapter.
export function engineControls(ad) {
  const bin = adapterBinary(ad)
  const probe = { cpu: 1, memory: 1 }
  const live = !contextMissing // a vanished context gets no actions until the user picks another engine
  return {
    installed: bin ? Boolean(bin.path) : true,
    missing: bin && !bin.path ? `${bin.name} not found.` : null,
    start: live && enginePlan(ad, 'start', probe) !== null,
    stop: live && enginePlan(ad, 'stop', probe) !== null,
    restart: live && enginePlan(ad, 'restart', probe) !== null,
    size: ad.kind === 'colima' // CPU/RAM can only be chosen where a CLI takes them
  }
}
