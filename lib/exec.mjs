// Binary lookup, the child-process environment (DOCKER_HOST stripped) and the one-shot process helpers.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

export const ERROR_MAX_CHARS = 500
const EXTRA_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']
const ORCA_BIN_DIR = '/Applications/Orca.app/Contents/Resources/bin'

// `which`-style lookup over PATH plus the usual Homebrew dirs (GUI apps get a minimal PATH).
const BIN_DIRS = [...new Set([...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...EXTRA_BIN_DIRS])]
export const findBin = (name, extraDirs = []) =>
  [...BIN_DIRS, ...extraDirs].map((d) => join(d, name)).find((p) => existsSync(p)) ?? null
// Last-resort names keep error messages meaningful (ENOENT) when a binary is not installed.
export const DOCKER = findBin('docker') ?? join(EXTRA_BIN_DIRS[0], 'docker')
// On Linux the Orca CLI is `orca-ide`: `orca` there is usually the GNOME screen reader.
const ORCA = (process.platform === 'linux' ? findBin('orca-ide', [join(homedir(), '.local', 'bin')]) : null) ?? findBin('orca', [ORCA_BIN_DIR]) ?? join(ORCA_BIN_DIR, 'orca')
// colima shells out to limactl/docker, so child processes need the Homebrew dirs on PATH.
// An inherited DOCKER_HOST is dropped: it overrides Docker contexts and would silently pick another engine.
export const CHILD_ENV = (() => {
  const env = { ...process.env, PATH: BIN_DIRS.join(delimiter) }
  delete env.DOCKER_HOST
  return env
})()

export function run(bin, args, timeout = 20000, killSignal = 'SIGTERM') {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd: '/', env: CHILD_ENV, maxBuffer: 8 * 1024 * 1024, timeout, killSignal },
      (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr: stderr || String(error ?? '') }))
  })
}

export async function orcaJson(args) {
  const res = await run(ORCA, [...args, '--json'])
  try { return JSON.parse(res.stdout) } catch { return { ok: false, error: { message: res.stderr } } }
}
