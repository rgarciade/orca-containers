// Engine status, VM size preferences and the single in-flight start/stop/restart operation.
import { execFile } from 'node:child_process'
import { cpus, totalmem } from 'node:os'
import { activeAdapter, activeContext, contextMissing, dockerArgs, guardEngine } from '../docker.mjs'
import { CHILD_ENV, DOCKER, ERROR_MAX_CHARS, run } from '../exec.mjs'
import { COLIMA, colimaProfileArgs, engineControls, enginePlan } from './control.mjs'
import { otherContexts, otherEngineRow } from './others.mjs'

const GIB = 1024 ** 3
const PREFS_KEY = 'vm-prefs'
const DEFAULT_PREFS = { cpu: 4, memory: 8 }

// Single in-flight engine operation (start/stop/restart); it outlives any request, so it is tracked here.
export let vmOpName = null // 'starting' | 'stopping' | 'restarting' | null
const VM_OP_NAMES = { start: 'starting', stop: 'stopping', restart: 'restarting' }
const START_WAIT_MS = 120000 // apps without a CLI (`open -a`): wait this long for the engine to answer
const START_POLL_MS = 3000

// `docker info` through the chosen context: reachability plus the engine's own CPU/memory/version.
async function dockerInfo() {
  let args
  try { args = dockerArgs(['info', '--format', '{{.NCPU}}|{{.MemTotal}}|{{.ServerVersion}}']) } catch { return { ok: false } }
  const res = await run(DOCKER, args, 8000)
  if (!res.ok) return { ok: false }
  const [cpu, memory, version] = res.stdout.trim().split('|')
  return { ok: true, cpu: Number(cpu) || 0, memory: Number(memory) || 0, version: version || '' }
}

export async function vmStatus() {
  const ad = activeAdapter()
  const controls = engineControls(ad)
  const base = { installed: controls.installed, starting: vmOpName === 'starting', op: vmOpName }
  if (!controls.installed || contextMissing) return { ...base, running: false }
  if (ad.kind === 'colima') {
    const res = await new Promise((resolve) => {
      execFile(COLIMA, ['status', ...colimaProfileArgs(ad), '--json'], { cwd: '/', env: CHILD_ENV, timeout: 20000 },
        (error, stdout) => resolve({ ok: !error, stdout }))
    })
    if (!res.ok) return { ...base, running: false }
    try {
      const j = JSON.parse(res.stdout)
      return { ...base, running: true, cpu: j.cpu, memory: j.memory, disk: j.disk, runtime: j.runtime, arch: j.arch }
    } catch { return { ...base, running: false } }
  }
  const info = await dockerInfo()
  return info.ok ? { ...base, running: true, cpu: info.cpu, memory: info.memory, version: info.version } : { ...base, running: false }
}

// Everything the Engine card needs besides the status itself.
export function engineInfo() {
  const ad = activeAdapter()
  return { engine: { name: activeContext, kind: ad.kind, label: ad.label, missing: contextMissing }, engines: otherContexts().map(otherEngineRow), controls: engineControls(ad) }
}

// Host limits for the VM size; the panel shows them, the worker enforces them.
export function hostLimits() {
  return { maxCpu: Math.max(1, cpus().length), maxMemory: Math.max(1, Math.floor(totalmem() / GIB)) }
}

// Validates untrusted panel input; returns { cpu, memory } or { error }.
function parseVmSize(input) {
  const { maxCpu, maxMemory } = hostLimits()
  const cpu = input?.cpu
  const memory = input?.memory
  if (!Number.isInteger(cpu) || cpu < 1 || cpu > maxCpu) return { error: `CPU must be an integer between 1 and ${maxCpu}.` }
  if (!Number.isInteger(memory) || memory < 1 || memory > maxMemory) return { error: `Memory must be an integer between 1 and ${maxMemory} GB.` }
  return { cpu, memory }
}

export async function loadPrefs(orca) {
  const { maxCpu, maxMemory } = hostLimits()
  try {
    const { value } = await orca.host.call('storage.get', { key: PREFS_KEY })
    const ok = parseVmSize(value)
    if (!ok.error) return { cpu: ok.cpu, memory: ok.memory }
  } catch { /* fall through to defaults */ }
  return { cpu: Math.min(DEFAULT_PREFS.cpu, maxCpu), memory: Math.min(DEFAULT_PREFS.memory, maxMemory) }
}

const runStep = (step) => new Promise((resolve) => {
  execFile(step.bin, step.args, { cwd: '/', env: CHILD_ENV, maxBuffer: 8 * 1024 * 1024 },
    (error, _stdout, stderr) => resolve(error ? String(stderr || error).trim().slice(-ERROR_MAX_CHARS) : null))
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Runs the plan in the background; one op at a time. Reports through the panel posts the panel already listens to.
function launchEngineOp(orca, ad, op, steps) {
  vmOpName = VM_OP_NAMES[op]
  ;(async () => {
    let failure = null
    try {
      for (const step of steps) {
        failure = await runStep(step)
        if (failure) break
        if (step.wait) {
          const until = Date.now() + START_WAIT_MS
          let up = (await dockerInfo()).ok
          while (!up && Date.now() < until) { await sleep(START_POLL_MS); up = (await dockerInfo()).ok }
          if (!up) { failure = `${ad.label} was opened but Docker did not answer within ${START_WAIT_MS / 1000}s.`; break }
        }
      }
    } catch (e) { failure = String(e?.message ?? e).slice(0, ERROR_MAX_CHARS) }
    vmOpName = null
    if (op === 'start') orca.panels.post('colima.started', failure ? { ok: false, error: failure } : { ok: true })
    else orca.panels.post('colima.vmOp.done', failure ? { op, ok: false, error: failure } : { op, ok: true })
  })()
  return { started: true, op: VM_OP_NAMES[op] }
}

export async function startVm(orca, input) {
  const ad = activeAdapter()
  if (contextMissing) return { started: false, error: guardEngine(activeContext, activeContext, true) }
  const controls = engineControls(ad)
  if (!controls.installed) return { started: false, error: controls.missing }
  if (vmOpName) return { starting: vmOpName === 'starting', op: vmOpName, error: `${ad.label} is ${vmOpName}` }
  let size = null
  if (controls.size) {
    size = parseVmSize(input)
    if (size.error) return { started: false, error: size.error }
  }
  const steps = enginePlan(ad, 'start', size)
  if (!steps) return { started: false, error: `${ad.label} cannot be started from here.` }
  if (size) {
    try {
      await orca.host.call('storage.set', { key: PREFS_KEY, value: { cpu: size.cpu, memory: size.memory } })
    } catch { /* persisting the choice is best-effort */ }
  }
  if (vmOpName) return { starting: vmOpName === 'starting', op: vmOpName, error: `${ad.label} is ${vmOpName}` } // lost a race while saving
  return launchEngineOp(orca, ad, 'start', steps)
}

// Stops or restarts the engine in the background; only one operation runs at a time.
export function vmOp(orca, input) {
  const op = input?.op
  if (op !== 'stop' && op !== 'restart') return { started: false, error: 'Unknown VM operation.' }
  const ad = activeAdapter()
  if (contextMissing) return { started: false, error: guardEngine(activeContext, activeContext, true) }
  const controls = engineControls(ad)
  if (!controls.installed) return { started: false, error: controls.missing }
  if (vmOpName) return { started: false, busy: true, op: vmOpName, error: `${ad.label} is ${vmOpName}` }
  const steps = enginePlan(ad, op, null)
  if (!steps) return { started: false, error: `${ad.label} cannot be ${op === 'stop' ? 'stopped' : 'restarted'} from here.` }
  return launchEngineOp(orca, ad, op, steps)
}
