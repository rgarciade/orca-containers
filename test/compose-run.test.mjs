// The command composeRun really executes. `docker` and `orca` are stand-in shell scripts put first on PATH
// before the worker modules look them up; no engine is contacted.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'containers-test-compose-')))
after(() => rmSync(base, { recursive: true, force: true }))
const root = join(base, 'wt')
const bin = join(base, 'bin')
const [PS, LOG] = [join(base, 'ps'), join(base, 'log')]
for (const dir of [root, bin]) mkdirSync(dir)
writeFileSync(join(base, 'outside.yml'), 'services: {}\n')
writeFileSync(join(root, 'real.yml'), 'services: {}\n')
symlinkSync(join(base, 'outside.yml'), join(root, 'compose.yaml'))

const script = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755) }
script('docker', `if [ "$1" = ps ]; then /bin/cat '${PS}'; else { /bin/pwd; printf '%s\\n' "$@"; } > '${LOG}'; fi`)
const lists = (key, rows) => `printf '%s' '${JSON.stringify({ ok: true, result: { [key]: rows } })}'`
for (const name of ['orca', 'orca-ide']) script(name, `if [ "$1" = worktree ]; then ${lists('worktrees', [{ path: root }])}; else ${lists('repos', [])}; fi`)
process.env.PATH = [bin, process.env.PATH].join(delimiter)
const { composeRun } = await import('../lib/compose.mjs')

// Runs `action` on project `web`, whose one container carries `configFiles`: { cwd, args } of the compose call.
async function composeCall(action, configFiles) {
  const labels = [`com.docker.compose.project=web`, `com.docker.compose.project.working_dir=${root}`, `com.docker.compose.project.config_files=${configFiles.join(',')}`]
  writeFileSync(PS, `${JSON.stringify({ ID: '0123456789ab', Names: 'web-1', State: 'running', Status: 'Up', Labels: labels.join(',') })}\n`)
  let done
  const finished = new Promise((resolve) => { done = resolve })
  const out = await composeRun({ panels: { post: (_name, payload) => done(payload) } }, { action, stack: 'p:web', scope: { kind: 'worktree', path: root } })
  assert.deepEqual(out, { started: true })
  assert.equal((await finished).ok, true)
  const [cwd, ...args] = readFileSync(LOG, 'utf8').trim().split('\n')
  return { cwd, args }
}

describe('composeRun', () => {
  test('without a trusted file, runs by project name where nothing can be discovered', async () => {
    const cases = { none: [], outside: [join(base, 'outside.yml')], escaping: [join(root, 'compose.yaml')] }
    for (const [label, files] of Object.entries(cases)) {
      for (const [action, verb] of [['down', 'down'], ['restart', 'restart'], ['start', 'start'], ['stop', 'stop']]) {
        assert.deepEqual(await composeCall(action, files), { cwd: '/', args: ['compose', '-p', 'web', verb] }, `${label} ${action}`)
      }
    }
  })

  test('with trusted files, passes them and runs in the working dir', async () => {
    const file = join(root, 'real.yml')
    assert.deepEqual(await composeCall('down', [file]), { cwd: root, args: ['compose', '-p', 'web', '-f', file, 'down'] })
    assert.deepEqual(await composeCall('up', [file]), { cwd: root, args: ['compose', '-p', 'web', '-f', file, 'up', '-d'] })
  })
})
