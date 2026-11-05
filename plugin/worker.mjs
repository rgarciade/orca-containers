// Colima panel worker. The panel polls `colima.state`; all process execution happens here.
import { execFile, spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { cpus, homedir, totalmem, tmpdir } from 'node:os'
import { delimiter, join, relative, resolve } from 'node:path'

const DOCKER_HOST = `unix://${homedir()}/.colima/default/docker.sock`
const LOG_TAIL_LINES = 200
const LOG_OLDER_LINES = 500
const SEARCH_MAX_RESULTS = 1000
const SEARCH_QUERY_MAX = 200
const SEARCH_TIMEOUT_MS = 60000
const CONTEXT_LINES = 100
const CONTEXT_TIMEOUT_MS = 20000
const LOG_FLUSH_MS = 300 // plugin post limit is 200 posts / 10s: stay far below it
const LOG_CHUNK_CHARS = 64 * 1024 // post limit is 256 KiB
const LOG_PENDING_MAX = 1024 * 1024 // unsent output kept under a flood; the oldest is dropped
const PANEL_IDLE_MS = 15000 // no request from the panel for this long: it is gone
const SWEEP_MS = 5000
const ERROR_MAX_CHARS = 500
const EXTRA_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']
const ORCA_BIN_DIR = '/Applications/Orca.app/Contents/Resources/bin'
const WORKTREE_AMBIGUITY_TTL_MS = 5000 // an unresolved lookup is retried at most this often
const GIB = 1024 ** 3
const PREFS_KEY = 'vm-prefs'
const DEFAULT_PREFS = { cpu: 4, memory: 8 }
const COMPOSE_ACTIONS = {
  up: ['up', '-d'],
  down: ['down'], // never `-v`: volumes are data
  restart: ['restart']
}
// compose.yaml, docker-compose.yml, docker-compose.dev.yml, compose.override.yaml...
const COMPOSE_FILE_RE = /^(?:docker-)?compose(?:\.[\w-]+)*\.ya?ml$/
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]*$/

// `which`-style lookup over PATH plus the usual Homebrew dirs (GUI apps get a minimal PATH).
const BIN_DIRS = [...new Set([...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...EXTRA_BIN_DIRS])]
const findBin = (name, extraDirs = []) =>
  [...BIN_DIRS, ...extraDirs].map((d) => join(d, name)).find((p) => existsSync(p)) ?? null
const COLIMA = findBin('colima')
// Last-resort names keep error messages meaningful (ENOENT) when a binary is not installed.
const DOCKER = findBin('docker') ?? join(EXTRA_BIN_DIRS[0], 'docker')
const ORCA = findBin('orca', [ORCA_BIN_DIR]) ?? join(ORCA_BIN_DIR, 'orca')
// colima shells out to limactl/docker, so child processes need the Homebrew dirs on PATH.
const COLIMA_ENV = { ...process.env, PATH: BIN_DIRS.join(delimiter) }

function run(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd: '/', env: { ...process.env, DOCKER_HOST }, maxBuffer: 8 * 1024 * 1024, timeout: 20000 },
      (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr: stderr || String(error ?? '') }))
  })
}

async function orcaJson(args) {
  const res = await run(ORCA, [...args, '--json'])
  try { return JSON.parse(res.stdout) } catch { return { ok: false, error: { message: res.stderr } } }
}

// Maps the active workspace context to a worktree path. The host gives no path (and `orca worktree
// show --worktree active` follows the CLI's cwd, not the focused workspace), so we match:
// 1) terminal ids of the context -> `orca terminal list` -> worktreePath (authoritative);
// 2) branch + display name against `orca worktree list`, only when exactly one worktree fits.
const stripRef = (b) => String(b ?? '').replace(/^refs\/heads\//, '')

// Pure matcher over `orca worktree list` rows. Returns { path } or { error } saying why not.
export function matchWorktree(worktrees, ctx) {
  const rows = (worktrees ?? []).filter((w) => w && w.path && !w.isArchived)
  const branch = stripRef(ctx?.branch)
  const name = String(ctx?.displayName ?? '')
  const label = branch || name || 'the focused workspace'
  // Exact: same branch (refs/heads/ ignored) and same display name. A detached HEAD has no branch,
  // so only the display name can tell worktrees apart.
  const exact = rows.filter((w) => stripRef(w.branch) === branch && w.displayName === name)
  if (exact.length === 1) return { path: exact[0].path }
  if (exact.length > 1) return { error: `${exact.length} worktrees match ${branch ? `branch ${branch}` : `name ${name}`}. Open a terminal in the one you want.` }
  // Loose: the display name may have been renamed after the context was read; accept a unique branch.
  const byBranch = branch ? rows.filter((w) => stripRef(w.branch) === branch) : []
  if (byBranch.length === 1) return { path: byBranch[0].path }
  if (byBranch.length > 1) return { error: `${byBranch.length} worktrees match branch ${branch}. Open a terminal in the one you want.` }
  const byName = name ? rows.filter((w) => w.displayName === name) : []
  if (byName.length === 1) return { path: byName[0].path }
  if (byName.length > 1) return { error: `${byName.length} worktrees match name ${name}. Open a terminal in the one you want.` }
  return { error: `No Orca worktree matches ${label}.` }
}

let pathCache = { key: null, path: null, error: null, at: 0 }

// Returns { path, error }: exactly one is non-null.
async function resolveActiveWorktree(orca) {
  const ctx = await orca.host.call('workspace.readContext', {})
  if (!ctx) return { path: null, error: 'No workspace is focused.' }
  const key = JSON.stringify(ctx)
  if (pathCache.key === key && (pathCache.path || Date.now() - pathCache.at < WORKTREE_AMBIGUITY_TTL_MS)) {
    return { path: pathCache.path, error: pathCache.error }
  }
  let found = null
  let error = null
  // Terminal ids are CLI handles (term_...); the CLI terminal list maps them to a worktree path.
  const ids = new Set((ctx.terminals ?? []).map((t) => t.id))
  if (ids.size > 0) {
    const terminals = await orcaJson(['terminal', 'list'])
    const hit = (terminals.result?.terminals ?? []).find((t) => ids.has(t.handle) || ids.has(t.ptyId))
    if (hit?.worktreePath) found = hit.worktreePath
  }
  if (!found) {
    const list = await orcaJson(['worktree', 'list'])
    if (list.ok === false || !list.result?.worktrees) error = 'Could not read the worktree list from the orca CLI.'
    else ({ path: found = null, error = null } = matchWorktree(list.result.worktrees, ctx))
  }
  pathCache = { key, path: found, error, at: Date.now() }
  return { path: found, error }
}

const resolveActiveWorktreePath = async (orca) => (await resolveActiveWorktree(orca)).path

const inside = (dir, root) => Boolean(dir) && (dir === root || dir.startsWith(`${root}/`))

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

async function listContainers() {
  const res = await run(DOCKER, ['ps', '-a', '--format', '{{json .}}'])
  if (!res.ok) return { error: res.stderr.slice(0, 500), containers: [] }
  const containers = res.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const c = JSON.parse(line)
    const labels = parseLabels(c.Labels)
    return {
      id: c.ID, name: c.Names, image: c.Image, state: c.State, status: c.Status, ports: c.Ports,
      service: labels['com.docker.compose.service'] ?? null,
      workdir: labels['com.docker.compose.project.working_dir'] ?? null,
      project: labels['com.docker.compose.project'] ?? null,
      configFiles: String(labels['com.docker.compose.project.config_files'] ?? '').split(',').filter(Boolean)
    }
  })
  return { error: null, containers }
}

// Compose stacks of a worktree, from its containers' labels and from compose files in its root.
// Internal shape: { id, project, files (absolute), workdir, running, total }. Every path is
// checked to live inside the worktree; anything else is dropped.
export async function discoverStacks(worktree, containers) {
  const root = resolve(worktree)
  const stacks = new Map()
  for (const c of containers) {
    const workdir = c.workdir ? resolve(c.workdir) : null
    if (!c.project || !PROJECT_RE.test(c.project) || !workdir || !inside(workdir, root)) continue
    const id = `p:${c.project}`
    if (!stacks.has(id)) {
      const files = (c.configFiles ?? []).map((f) => resolve(f))
      // All-or-nothing: a partial file list would start a different stack.
      const safe = files.length > 0 && files.every((f) => inside(f, root) && /\.ya?ml$/.test(f))
      stacks.set(id, { id, project: c.project, files: safe ? files : [], workdir, running: 0, total: 0 })
    }
    const s = stacks.get(id)
    s.total += 1
    if (c.state === 'running') s.running += 1
  }
  const known = new Set([...stacks.values()].flatMap((s) => s.files))
  let entries = []
  try { entries = await readdir(root, { withFileTypes: true }) } catch { /* unreadable root: no file stacks */ }
  for (const e of entries.filter((d) => d.isFile() && COMPOSE_FILE_RE.test(d.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(root, e.name)
    if (known.has(file)) continue
    stacks.set(`f:${e.name}`, { id: `f:${e.name}`, project: null, files: [file], workdir: root, running: 0, total: 0 })
  }
  return [...stacks.values()]
}

// In-flight compose operations (they outlive any request), keyed by worktree + stack id.
const composeOps = new Map()
const opKey = (worktree, id) => `${worktree}\0${id}`

// What the panel sees: relative file names and the running operation, never absolute paths.
function publicStack(s, worktree) {
  return {
    id: s.id, project: s.project, running: s.running, total: s.total,
    files: s.files.map((f) => relative(resolve(worktree), f)),
    canUp: s.files.length > 0,
    op: composeOps.get(opKey(worktree, s.id)) ?? null
  }
}

async function stateForActiveWorktree(orca) {
  const { path: worktree, error: worktreeError } = await resolveActiveWorktree(orca)
  if (!worktree) return { worktree: null, worktreeError, containers: [], stacks: [], error: null }
  const { error, containers } = await listContainers()
  const mine = containers.filter((c) => inside(c.workdir, worktree))
  const stacks = (await discoverStacks(worktree, mine)).map((s) => publicStack(s, worktree))
  return { worktree, error, containers: mine, stacks }
}

// Re-discovers server-side so the panel never supplies a path. Returns the internal stack.
async function ownedStack(orca, id) {
  const worktree = await resolveActiveWorktreePath(orca)
  if (!worktree) return { error: 'Could not identify the active worktree.' }
  const { error, containers } = await listContainers()
  if (error) return { error: 'Docker is unreachable. Is Colima running?' }
  const mine = containers.filter((c) => inside(c.workdir, worktree))
  const stack = (await discoverStacks(worktree, mine)).find((s) => s.id === id)
  return stack ? { worktree, stack } : { error: 'Stack is not in the active worktree.' }
}

async function composeRun(orca, input) {
  const action = input?.action
  if (!Object.hasOwn(COMPOSE_ACTIONS, action)) return { ok: false, message: 'Unknown action.' }
  const id = String(input?.stack ?? '')
  const { worktree, stack, error } = await ownedStack(orca, id)
  if (!stack) return { ok: false, message: error }
  if (action === 'up' && stack.files.length === 0) return { ok: false, message: 'No compose file known for this stack.' }
  if ((action === 'down' || action === 'restart') && stack.total === 0) return { ok: false, message: 'Stack has no containers.' }
  const key = opKey(worktree, id)
  if (composeOps.has(key)) return { busy: true }
  composeOps.set(key, action)
  const args = ['compose', ...(stack.project ? ['-p', stack.project] : []), ...stack.files.flatMap((f) => ['-f', f]), ...COMPOSE_ACTIONS[action]]
  execFile(DOCKER, args, { cwd: stack.workdir, env: { ...COLIMA_ENV, DOCKER_HOST }, maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
    composeOps.delete(key)
    const payload = err
      ? { stack: id, action, ok: false, error: String(stderr || err).trim().slice(-ERROR_MAX_CHARS) }
      : { stack: id, action, ok: true }
    orca.panels.post('colima.compose.done', payload)
  })
  return { started: true }
}

// Resolves a container id only if it belongs to the active worktree.
async function ownedContainer(orca, id) {
  const state = await stateForActiveWorktree(orca)
  const target = state.containers.find((c) => c.id === id)
  return { worktree: state.worktree, target }
}

// Single in-flight VM operation (start/stop/restart); it outlives any request, so it is tracked here.
let vmOpName = null // 'starting' | 'stopping' | 'restarting' | null
const VM_OP_NAMES = { stop: 'stopping', restart: 'restarting' }

async function vmStatus() {
  if (!COLIMA) return { installed: false, running: false, starting: vmOpName === 'starting', op: vmOpName }
  const res = await new Promise((resolve) => {
    execFile(COLIMA, ['status', '--json'], { cwd: '/', env: COLIMA_ENV, timeout: 20000 },
      (error, stdout) => resolve({ ok: !error, stdout }))
  })
  if (!res.ok) return { installed: true, running: false, starting: vmOpName === 'starting', op: vmOpName }
  try {
    const j = JSON.parse(res.stdout)
    return { installed: true, running: true, starting: vmOpName === 'starting', op: vmOpName, cpu: j.cpu, memory: j.memory, disk: j.disk, runtime: j.runtime, arch: j.arch }
  } catch { return { installed: true, running: false, starting: vmOpName === 'starting', op: vmOpName } }
}

// Host limits for the VM size; the panel shows them, the worker enforces them.
function hostLimits() {
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

async function loadPrefs(orca) {
  const { maxCpu, maxMemory } = hostLimits()
  try {
    const { value } = await orca.host.call('storage.get', { key: PREFS_KEY })
    const ok = parseVmSize(value)
    if (!ok.error) return { cpu: ok.cpu, memory: ok.memory }
  } catch { /* fall through to defaults */ }
  return { cpu: Math.min(DEFAULT_PREFS.cpu, maxCpu), memory: Math.min(DEFAULT_PREFS.memory, maxMemory) }
}

async function startVm(orca, input) {
  if (!COLIMA) return { started: false, error: 'colima binary not found.' }
  if (vmOpName) return { starting: vmOpName === 'starting', op: vmOpName, error: `Colima is ${vmOpName}` }
  const size = parseVmSize(input)
  if (size.error) return { started: false, error: size.error }
  vmOpName = 'starting'
  try {
    await orca.host.call('storage.set', { key: PREFS_KEY, value: { cpu: size.cpu, memory: size.memory } })
  } catch { /* persisting the choice is best-effort */ }
  execFile(COLIMA, ['start', '--cpu', String(size.cpu), '--memory', String(size.memory)], { cwd: '/', env: COLIMA_ENV, maxBuffer: 8 * 1024 * 1024 }, (error, _stdout, stderr) => {
    vmOpName = null
    const payload = error
      ? { ok: false, error: String(stderr || error).trim().slice(-ERROR_MAX_CHARS) }
      : { ok: true }
    orca.panels.post('colima.started', payload)
  })
  return { started: true }
}

// Stops or restarts the VM in the background; only one VM operation runs at a time.
function vmOp(orca, input) {
  const op = input?.op
  if (op !== 'stop' && op !== 'restart') return { started: false, error: 'Unknown VM operation.' }
  if (!COLIMA) return { started: false, error: 'colima binary not found.' }
  if (vmOpName) return { started: false, busy: true, op: vmOpName, error: `Colima is ${vmOpName}` }
  vmOpName = VM_OP_NAMES[op]
  execFile(COLIMA, [op], { cwd: '/', env: COLIMA_ENV, maxBuffer: 8 * 1024 * 1024 }, (error, _stdout, stderr) => {
    vmOpName = null
    const payload = error
      ? { op, ok: false, error: String(stderr || error).trim().slice(-ERROR_MAX_CHARS) }
      : { op, ok: true }
    orca.panels.post('colima.vmOp.done', payload)
  })
  return { started: true, op: VM_OP_NAMES[op] }
}

const UNITS = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 }

// "123.4MiB" -> bytes; null when it cannot be read.
export function parseBytes(text) {
  const m = String(text ?? '').trim().match(/^([\d.]+)\s*([a-zA-Z]*)$/)
  if (!m) return null
  const unit = UNITS[(m[2] || 'b').toLowerCase()]
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

// Batches log output: at most one post per interval, each <= maxChars. `post(text)` does the sending.
// Under a flood the unsent backlog is capped at maxPending (oldest dropped).
export function createChunker(post, { intervalMs = LOG_FLUSH_MS, maxChars = LOG_CHUNK_CHARS, maxPending = LOG_PENDING_MAX } = {}) {
  let pending = ''
  let timer = null
  let stopped = false
  const flush = () => {
    timer = null
    if (stopped || !pending) return
    const text = pending.slice(0, maxChars)
    pending = pending.slice(text.length)
    try { post(text) } catch { /* the panel may be gone */ }
    if (pending) timer = setTimeout(flush, intervalMs)
  }
  return {
    push(text) {
      if (stopped || !text) return
      pending += text
      if (pending.length > maxPending) pending = pending.slice(-maxPending)
      if (!timer) timer = setTimeout(flush, intervalMs)
    },
    // Sends everything left right now (process exit), still respecting maxChars per post.
    drain() {
      clearTimeout(timer)
      timer = null
      while (!stopped && pending) {
        const text = pending.slice(0, maxChars)
        pending = pending.slice(text.length)
        try { post(text) } catch { /* the panel may be gone */ }
      }
    },
    stop() { stopped = true; clearTimeout(timer); timer = null; pending = '' }
  }
}

// ---- Docker log child processes that die with the worker ----
// A hard kill of the worker (SIGKILL/crash) runs no handlers, and `docker logs -f` on an idle container
// never writes, so it would never see SIGPIPE. macOS has no PR_SET_PDEATHSIG, so each child runs under a
// tiny `sh` wrapper that watches its stdin: the worker holds the write end of that pipe, and the OS closes
// it when the worker dies for any reason. On EOF the wrapper kills docker. Everything dynamic is passed as
// positional args, never interpolated into the script.
const WATCHDOG_MARKER = 'colima-logs-watchdog'
const WATCHDOG_SCRIPT = [
  'exec 3<&0',
  '"$@" </dev/null &',
  'pid=$!',
  "trap 'kill $pid 2>/dev/null' TERM INT HUP",
  '(cat <&3 >/dev/null; kill $pid 2>/dev/null) &',
  'w=$!',
  'wait $pid',
  'rc=$?',
  'kill $w 2>/dev/null',
  'exit $rc'
].join('\n')
const PID_PREFIX = 'colima-orca-plugin-logs.'
const PID_FILE_RE = /^colima-orca-plugin-logs\.(\d+)\.pids$/
const PID_FILE = join(tmpdir(), `${PID_PREFIX}${process.pid}.pids`) // one file per worker instance
const liveWrappers = new Set() // wrapper pids; each leads its own process group (wrapper + docker + watcher)

const savePids = () => {
  try { writeFileSync(PID_FILE, [...liveWrappers].join('\n')) } catch { /* best-effort */ }
}

// Spawns `docker <args>` under the watchdog. stdout/stderr are docker's own. Stop it with stopDocker().
function spawnDocker(args) {
  const proc = spawn('/bin/sh', ['-c', WATCHDOG_SCRIPT, WATCHDOG_MARKER, DOCKER, ...args],
    { cwd: '/', env: { ...process.env, DOCKER_HOST }, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
  proc.stdin.on('error', () => {}) // EPIPE if the wrapper is already gone
  proc.reaped = false
  if (proc.pid) { liveWrappers.add(proc.pid); savePids() }
  proc.on('close', () => {
    proc.reaped = true // the pgid may be reused from now on: never signal it again
    try { proc.stdin.destroy() } catch { /* closed */ } // EOF: lets the watcher inside the group exit
    if (liveWrappers.delete(proc.pid)) savePids()
  })
  return proc
}

// Kills the wrapper's whole process group (wrapper, docker, watcher).
function stopDocker(proc) {
  if (proc.reaped || proc.exitCode !== null || proc.signalCode) return
  try { process.kill(-proc.pid, 'SIGTERM') } catch { try { proc.kill('SIGTERM') } catch { /* already gone */ } }
  try { proc.stdin.destroy() } catch { /* closed */ }
}

const ownerAlive = (pid) => {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

// Startup: reap process groups left by workers that were killed hard. Only pid files whose owner worker
// is dead are touched (live instances and our own file are never read or killed), and a group is only
// signalled when `ps` shows its LEADER running our watchdog marker, so reused PIDs are safe.
function cleanupStaleDocker() {
  let files = []
  try { files = readdirSync(tmpdir()).filter((n) => PID_FILE_RE.test(n)) } catch { return }
  const stale = files
    .map((n) => ({ path: join(tmpdir(), n), owner: Number(PID_FILE_RE.exec(n)[1]) }))
    .filter((f) => f.owner !== process.pid && !ownerAlive(f.owner))
  if (!stale.length) return
  execFile('ps', ['-A', '-o', 'pid=,command='], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
    const leaders = new Map() // pid -> command
    if (!error) for (const line of stdout.split('\n')) { const m = /^\s*(\d+)\s+(.*)$/.exec(line); if (m) leaders.set(Number(m[1]), m[2]) }
    for (const f of stale) {
      let saved = []
      try { saved = readFileSync(f.path, 'utf8').split('\n').map(Number).filter((n) => Number.isInteger(n) && n > 1) } catch { /* unreadable */ }
      if (!error) for (const pgid of saved) {
        if (pgid !== process.pid && leaders.get(pgid)?.includes(WATCHDOG_MARKER)) { try { process.kill(-pgid, 'SIGTERM') } catch { /* gone */ } }
      }
      if (!error || !saved.length) { try { unlinkSync(f.path) } catch { /* gone */ } }
    }
  })
}

// Live log followers, one per panel id, and when each panel last talked to the worker.
const followers = new Map() // panelId -> { id, proc, chunker, ended }
const lastSeen = new Map() // panelId -> ms

function killFollower(panelId, reason, orca) {
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

async function followLogs(orca, panelId, input) {
  const { target } = await ownedContainer(orca, String(input?.id ?? ''))
  if (!target) return NOT_OWNED
  killFollower(panelId, null, orca)
  killSearch(panelId)
  const proc = spawnDocker(['logs', '-f', '--timestamps', '--tail', String(LOG_TAIL_LINES), target.id])
  const chunker = createChunker((text) => orca.panels.post('colima.logs.chunk', { id: target.id, text }, { panel: panelId }))
  const f = { id: target.id, proc, chunker, stopped: false }
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

// ---- Log history paging ----
const RFC3339_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/
const LINE_TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))(?: |$)/

export function isRfc3339(text) {
  if (typeof text !== 'string' || text.length > 40) return false
  const m = RFC3339_RE.exec(text)
  return Boolean(m) && !Number.isNaN(Date.parse(`${m[1]}${m[3]}`))
}

// Compares two RFC3339 timestamps with nanosecond precision: negative, 0 or positive.
export function compareTs(a, b) {
  const parse = (t) => {
    const m = RFC3339_RE.exec(t)
    return { sec: Date.parse(`${m[1]}${m[3]}`), ns: (m[2] ?? '').padEnd(9, '0') }
  }
  const x = parse(a)
  const y = parse(b)
  if (x.sec !== y.sec) return x.sec - y.sec
  return x.ns < y.ns ? -1 : x.ns > y.ns ? 1 : 0
}

// Keeps only the lines strictly older than `until`; continuation lines follow their parent line.
export function filterOlder(lines, until) {
  const out = []
  let keep = true
  for (const line of lines) {
    const m = LINE_TS_RE.exec(line)
    if (m) keep = compareTs(m[1], until) < 0
    if (keep) out.push(line)
  }
  return out
}

// Verified against Docker (Colima, nanosecond timestamps): `docker logs --until T` is INCLUSIVE of a line
// stamped exactly T (until=T-1ns drops it, until=T keeps it). Paging therefore requests until = the first
// displayed timestamp and removes the boundary lines the panel already shows (`skip`), so lines sharing
// that timestamp are never lost.
const LOG_OLDER_MAX_TAIL = 20000
const LOG_OLDER_MAX_SKIP = 5000

// Lines strictly older than `until`, plus the lines stamped exactly `until` that are NOT displayed yet.
// The panel shows the last `skip` entries of the boundary timestamp, so those are dropped from the end of
// the group. Continuation lines (no timestamp) stay attached to their parent entry.
export function selectOlder(lines, until, skip = 0) {
  const entries = []
  for (const line of lines) {
    const m = LINE_TS_RE.exec(line)
    if (m || !entries.length) entries.push({ cmp: m ? compareTs(m[1], until) : -1, lines: [line] })
    else entries[entries.length - 1].lines.push(line)
  }
  const boundary = entries.filter((e) => e.cmp === 0)
  const shown = new Set(boundary.slice(Math.max(boundary.length - skip, 0)))
  return entries.filter((e) => e.cmp < 0 || (e.cmp === 0 && !shown.has(e))).flatMap((e) => e.lines)
}

async function olderLogs(orca, input) {
  const until = String(input?.until ?? '')
  if (!isRfc3339(until)) return { ok: false, message: 'Invalid timestamp.' }
  const skip = input?.skip ?? 0
  if (!Number.isInteger(skip) || skip < 0 || skip > LOG_OLDER_MAX_SKIP) return { ok: false, message: 'Invalid skip count.' }
  const { target } = await ownedContainer(orca, String(input?.id ?? ''))
  if (!target) return NOT_OWNED
  // Ask for enough extra lines to cover the already displayed boundary lines; if a page still yields
  // nothing new (a huge run of identical timestamps), grow the tail instead of looping on the same page.
  let tail = LOG_OLDER_LINES + skip
  for (;;) {
    const res = await new Promise((resolve) => {
      execFile(DOCKER, ['logs', '--timestamps', '--until', until, '--tail', String(tail), target.id],
        { cwd: '/', env: { ...process.env, DOCKER_HOST }, maxBuffer: 64 * 1024 * 1024, timeout: 20000 },
        (error, stdout, stderr) => resolve({ error, stdout, stderr }))
    })
    if (res.error) return { ok: false, message: (res.stderr || String(res.error)).slice(0, 300) }
    // The container's stdout and stderr arrive separately: merge them back by timestamp.
    const raw = [res.stdout, res.stderr].flatMap((s) => s.split('\n').filter((l) => l !== ''))
    const stamped = raw.map((line, i) => ({ line, i, ts: LINE_TS_RE.exec(line)?.[1] ?? null }))
    const sorted = stamped.every((l) => l.ts) && res.stderr
      ? stamped.sort((a, b) => compareTs(a.ts, b.ts) || a.i - b.i).map((l) => l.line)
      : raw
    const lines = selectOlder(sorted, until, skip)
    const exhausted = raw.length < tail
    if (lines.length || exhausted) return { ok: true, text: lines.length ? `${lines.join('\n')}\n` : '', done: exhausted }
    if (tail >= LOG_OLDER_MAX_TAIL) {
      return { ok: true, text: '', done: true, message: 'Too many log lines share one timestamp; older history is unreachable from here.' }
    }
    tail = Math.min(tail * 2, LOG_OLDER_MAX_TAIL)
  }
}

// ---- Log search and context ----
const logsEnv = () => ({ ...process.env, DOCKER_HOST })

// Splits a stream into lines (one splitter per stream, so partial lines never mix).
function lineSplitter(onLine) {
  let rest = ''
  return {
    write(text) {
      const parts = (rest + text).split('\n')
      rest = parts.pop()
      for (const line of parts) onLine(line.replace(/\r$/, ''))
    },
    end() { if (rest) onLine(rest.replace(/\r$/, '')); rest = '' }
  }
}

// Plain-text line test (no regex). Case-insensitive unless asked otherwise.
export function lineMatcher(query, caseSensitive = false) {
  const needle = caseSensitive ? query : query.toLowerCase()
  return (text) => (caseSensitive ? text : text.toLowerCase()).includes(needle)
}

// Streaming collector: counts every match but keeps only the last `max` (ring buffer).
// The timestamp prefix is not searched, only the message.
export function createSearchCollector(query, caseSensitive = false, max = SEARCH_MAX_RESULTS) {
  const test = lineMatcher(query, caseSensitive)
  const ring = []
  let head = 0
  let total = 0
  return {
    push(line) {
      const m = LINE_TS_RE.exec(line)
      if (!test(m ? line.slice(m[0].length) : line)) return
      total++
      if (ring.length < max) ring.push(line)
      else { ring[head] = line; head = (head + 1) % max }
    },
    result() {
      let lines = ring.slice(head).concat(ring.slice(0, head))
      // stdout and stderr arrive separately: restore chronological order when every line is stamped.
      const stamped = lines.map((line, i) => ({ line, i, ts: LINE_TS_RE.exec(line)?.[1] ?? null }))
      if (stamped.every((l) => l.ts)) lines = stamped.sort((a, b) => compareTs(a.ts, b.ts) || a.i - b.i).map((l) => l.line)
      return { lines, total, truncated: total > lines.length }
    }
  }
}

const searches = new Map() // panelId -> { cancel }

function killSearch(panelId) {
  const s = searches.get(panelId)
  if (!s) return
  searches.delete(panelId)
  s.cancel()
}

// Streams the full `docker logs` of an owned container through the collector; one search per panel.
async function searchLogs(orca, panelId, input, signal) {
  const query = typeof input?.query === 'string' ? input.query : ''
  if (query.length < 1 || query.length > SEARCH_QUERY_MAX) return { ok: false, message: `Query must be 1 to ${SEARCH_QUERY_MAX} characters.` }
  const { target } = await ownedContainer(orca, String(input?.id ?? ''))
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

// ~CONTEXT_LINES lines before and after a timestamp, plus the line itself.
async function contextLogs(orca, input) {
  const ts = String(input?.ts ?? '')
  if (!isRfc3339(ts)) return { ok: false, message: 'Invalid timestamp.' }
  const { target } = await ownedContainer(orca, String(input?.id ?? ''))
  if (!target) return NOT_OWNED
  const before = await new Promise((resolve) => {
    execFile(DOCKER, ['logs', '--timestamps', '--until', ts, '--tail', String(CONTEXT_LINES + 10), target.id],
      { cwd: '/', env: logsEnv(), maxBuffer: 16 * 1024 * 1024, timeout: CONTEXT_TIMEOUT_MS },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }))
  })
  if (before.error) return { ok: false, message: (before.stderr || String(before.error)).slice(0, 300) }
  // --until is inclusive: lines stamped exactly ts come back here, so the strict filter drops them; they are
  // returned once, by the --since read below (which keeps everything >= ts), so the clicked line is never doubled.
  const older = filterOlder(sortByTs([before.stdout, before.stderr]), ts).slice(-CONTEXT_LINES)
  // --since is read a second early so the clicked line is never lost to boundary rules, then trimmed exactly.
  const sinceMs = Date.parse(ts.replace(/\.\d+/, '')) - 1000
  const after = await collectFrom(target.id, new Date(sinceMs).toISOString(), ts, CONTEXT_LINES + 1)
  if (after.error) return { ok: false, message: after.error }
  return { ok: true, lines: [...older, ...after.lines] }
}

// Merges stdout/stderr text blocks back into one chronological list (input order when unstamped).
function sortByTs(blocks) {
  const raw = blocks.flatMap((s) => s.split('\n').filter((l) => l !== ''))
  const stamped = raw.map((line, i) => ({ line, i, ts: LINE_TS_RE.exec(line)?.[1] ?? null }))
  return stamped.every((l) => l.ts) ? stamped.sort((a, b) => compareTs(a.ts, b.ts) || a.i - b.i).map((l) => l.line) : raw
}

// Reads `docker logs --since` and keeps the first `limit` lines at or after `from`, then stops the process.
function collectFrom(id, since, from, limit) {
  return new Promise((resolve) => {
    const proc = spawnDocker(['logs', '--timestamps', '--since', since, id])
    const lines = []
    let keep = false
    let done = false
    const finish = (error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      stopDocker(proc)
      resolve(error ? { error } : { lines: sortByTs([lines.join('\n')]).slice(0, limit) })
    }
    const timer = setTimeout(() => finish('Context request timed out.'), CONTEXT_TIMEOUT_MS)
    const onLine = (line) => {
      if (done) return
      const m = LINE_TS_RE.exec(line)
      if (m) keep = compareTs(m[1], from) >= 0
      if (!keep) return
      lines.push(line)
      if (lines.length >= limit + 10) finish(null)
    }
    const splitters = [proc.stdout, proc.stderr].map((stream) => {
      const splitter = lineSplitter(onLine)
      stream.setEncoding('utf8')
      stream.on('data', (d) => splitter.write(d))
      return splitter
    })
    proc.on('error', (err) => finish(String(err.message ?? err).slice(0, 300)))
    proc.on('close', () => { for (const s of splitters) s.end(); finish(null) })
  })
}

// Kills followers whose panel went quiet or whose container left the active worktree.
async function sweepFollowers(orca) {
  const now = Date.now()
  for (const [panelId, f] of [...followers]) {
    if (now - (lastSeen.get(panelId) ?? 0) > PANEL_IDLE_MS) { killFollower(panelId, 'idle', orca); continue }
    try {
      const { target } = await ownedContainer(orca, f.id)
      if (!target && followers.get(panelId) === f) killFollower(panelId, 'not-owned', orca)
    } catch { /* transient failure: keep following, retry next sweep */ }
  }
  for (const panelId of [...lastSeen.keys()]) {
    if (!followers.has(panelId) && now - lastSeen.get(panelId) > PANEL_IDLE_MS) lastSeen.delete(panelId)
  }
}

// docker stats for the running containers of the active worktree. Slow (~1-2s), so it has its own handler.
async function statsForActiveWorktree(orca) {
  const state = await stateForActiveWorktree(orca)
  const ids = state.containers.filter((c) => c.state === 'running').map((c) => c.id)
  if (ids.length === 0) return { ok: true, stats: {} }
  const res = await new Promise((resolve) => {
    execFile(DOCKER, ['stats', '--no-stream', '--format', '{{json .}}', ...ids],
      { cwd: '/', env: { ...process.env, DOCKER_HOST }, maxBuffer: 8 * 1024 * 1024, timeout: 15000 },
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

const CONTAINER_ID_RE = /^[0-9a-f]{12,64}$/

// POSIX single-quote quoting: safe for any text, including quotes, spaces and $.
export const shellQuote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`

// The command line typed into the new Orca terminal. Throws on an id that is not a hex container id.
export function buildShellCommand(dockerBin, dockerHost, id) {
  if (!CONTAINER_ID_RE.test(id)) throw new Error('Invalid container id.')
  return `DOCKER_HOST=${shellQuote(dockerHost)} ${shellQuote(dockerBin)} exec -it ${shellQuote(id)} sh`
}

const NOT_OWNED = { ok: false, message: 'Container is not in the active worktree.' }

export default async function activate(orca) {
  cleanupStaleDocker()
  // Every handler call proves the panel is alive; followers of silent panels are swept.
  const handle = (name, fn) => orca.panels.handle(name, async (input, ctx) => {
    if (ctx?.panel?.id) lastSeen.set(ctx.panel.id, Date.now())
    return fn(input, ctx)
  })
  const sweeper = setInterval(() => { sweepFollowers(orca).catch(() => {}) }, SWEEP_MS)
  sweeper.unref?.()
  const killAll = () => {
    for (const panelId of [...followers.keys()]) killFollower(panelId, null, orca)
    for (const panelId of [...searches.keys()]) killSearch(panelId)
  }
  process.once('exit', () => { killAll(); try { unlinkSync(PID_FILE) } catch { /* none */ } })
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { killAll(); process.exit(0) })

  handle('colima.state', async () => stateForActiveWorktree(orca))
  handle('colima.stats', async () => statsForActiveWorktree(orca))

  handle('colima.vm', async () => ({ ...(await vmStatus()), prefs: await loadPrefs(orca), limits: hostLimits() }))
  handle('colima.start', async (input) => startVm(orca, input))
  handle('colima.vmOp', async (input) => vmOp(orca, input))

  handle('colima.compose', async (input) => composeRun(orca, input))

  handle('colima.logs.follow', async (input, ctx) => followLogs(orca, ctx.panel.id, input))
  handle('colima.logs.stop', async (_input, ctx) => { killFollower(ctx.panel.id, null, orca); killSearch(ctx.panel.id); return { ok: true } })

  handle('colima.logs.older', async (input) => olderLogs(orca, input))
  handle('colima.logs.search', async (input, ctx) => searchLogs(orca, ctx.panel.id, input, ctx.signal))
  handle('colima.logs.context', async (input) => contextLogs(orca, input))

  handle('colima.action', async (input) => {
    const action = input?.action
    if (action !== 'start' && action !== 'stop') return { ok: false, message: 'Unknown action.' }
    const { target } = await ownedContainer(orca, String(input?.id ?? ''))
    if (!target) return NOT_OWNED
    const res = await run(DOCKER, [action, target.id])
    return res.ok ? { ok: true } : { ok: false, message: res.stderr.slice(0, 300) }
  })

  handle('colima.shell', async (input) => {
    const { worktree, target } = await ownedContainer(orca, String(input?.id ?? ''))
    if (!target) return NOT_OWNED
    if (!CONTAINER_ID_RE.test(target.id)) return { ok: false, message: 'Unexpected container id.' }
    const res = await orcaJson(['terminal', 'create', '--worktree', `path:${worktree}`, '--title', `sh ${target.name}`,
      '--command', buildShellCommand(DOCKER, DOCKER_HOST, target.id), '--focus'])
    return res.ok ? { ok: true } : { ok: false, message: `orca CLI failed: ${String(res.error?.message ?? '').slice(0, 200)}` }
  })

  orca.commands.register('colima.refresh', async () => {
    orca.panels.post('colima.refresh', {})
    await orca.host.call('notifications.show', { title: 'Colima', body: 'Refresh requested.' })
  })
}
