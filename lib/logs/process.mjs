import { execFile, spawn } from 'node:child_process'
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dockerArgs } from '../docker.mjs'
import { CHILD_ENV, DOCKER } from '../exec.mjs'

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
export const PID_FILE = join(tmpdir(), `${PID_PREFIX}${process.pid}.pids`) // one file per worker instance
const liveWrappers = new Set() // wrapper pids; each leads its own process group (wrapper + docker + watcher)

const savePids = () => {
  try { writeFileSync(PID_FILE, [...liveWrappers].join('\n')) } catch { /* best-effort */ }
}

// Spawns `docker <args>` under the watchdog. stdout/stderr are docker's own. Stop it with stopDocker().
export function spawnDocker(args) {
  const proc = spawn('/bin/sh', ['-c', WATCHDOG_SCRIPT, WATCHDOG_MARKER, DOCKER, ...dockerArgs(args)],
    { cwd: '/', env: CHILD_ENV, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
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
export function stopDocker(proc) {
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
export function cleanupStaleDocker() {
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
