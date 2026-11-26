// The argv of the terminal tabs (shell and logs) and the saved log height. `docker` and `orca` are stand-in
// shell scripts put first on PATH before the worker modules look them up; no engine or Orca is contacted.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'containers-test-terminal-')))
after(() => rmSync(base, { recursive: true, force: true }))
const [root, focused, bin] = ['wt', 'focused', 'bin'].map((name) => join(base, name))
const [PS, LOG] = [join(base, 'ps'), join(base, 'log')]
for (const dir of [root, focused, bin]) mkdirSync(dir)

const script = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755) }
const print = (result) => `printf '%s' '${JSON.stringify({ ok: true, result })}'`
script('docker', `/bin/cat '${PS}'`)
for (const name of ['orca', 'orca-ide']) {
  script(name, `case "$1 $2" in
  "worktree list") ${print({ worktrees: [{ path: root }] })};;
  "repo list") ${print({ repos: [] })};;
  "terminal list") ${print({ terminals: [{ handle: 'term_1', worktreePath: focused }] })};;
  "terminal create") printf '%s\\0' "$@" > '${LOG}'; ${print({})};;
esac`)
}
process.env.PATH = [bin, process.env.PATH].join(delimiter)
const { logsTerminal, shellTerminal } = await import('../lib/terminal.mjs')
const { selectEngine } = await import('../lib/docker.mjs')
const { DOCKER } = await import('../lib/exec.mjs')
const { logsHeightPref } = await import('../lib/prefs.mjs')
selectEngine({ name: 'colima', endpoint: '' })

const ID = '0123456789ab'
const orca = { host: { call: async (method) => (method === 'workspace.readContext' ? { terminals: [{ id: 'term_1' }] } : {}) } }
const container = (state, workdir = root, id = ID) => {
  const labels = workdir ? `com.docker.compose.project=web,com.docker.compose.project.working_dir=${workdir}` : ''
  writeFileSync(PS, `${JSON.stringify({ ID: id, Names: 'web-1', State: state, Status: state, Labels: labels })}\n`)
  rmSync(LOG, { force: true })
}
const scope = { kind: 'worktree', path: root }
// The argv `orca terminal create` received, or null when no terminal was asked for.
const created = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\0').slice(0, -1) : null)
const argv = (path, title, command) => ['terminal', 'create', '--worktree', `path:${path}`, '--title', title, '--command', command, '--focus', '--json']
const logs = (follow) => `'${DOCKER}' --context 'colima' logs${follow ? ' -f' : ''} --tail '200' --timestamps '${ID}'`

describe('logsTerminal', () => {
  test('follows a running container in its worktree', async () => {
    container('running')
    assert.deepEqual(await logsTerminal(orca, { id: ID, scope }), { ok: true })
    assert.deepEqual(created(), argv(root, 'logs web-1', logs(true)))
  })

  test('prints the log of a stopped container without following', async () => {
    container('exited')
    assert.deepEqual(await logsTerminal(orca, { id: ID, scope }), { ok: true })
    assert.deepEqual(created(), argv(root, 'logs web-1', logs(false)))
  })

  test('uses the focused worktree for a container outside one', async () => {
    container('running', null)
    assert.deepEqual(await logsTerminal(orca, { id: ID, scope: { kind: 'container', id: ID } }), { ok: true })
    assert.deepEqual(created(), argv(focused, 'logs web-1', logs(true)))
  })

  test('refuses a container outside the scope, or an unexpected id', async () => {
    container('running', join(base, 'elsewhere'))
    assert.equal((await logsTerminal(orca, { id: ID, scope })).ok, false)
    assert.equal(created(), null)
    container('running', root, '--details')
    assert.deepEqual(await logsTerminal(orca, { id: '--details', scope }), { ok: false, message: 'Unexpected container id.' })
    assert.equal(created(), null)
  })
})

describe('shellTerminal', () => {
  test('still needs a running container', async () => {
    container('exited')
    assert.deepEqual(await shellTerminal(orca, { id: ID, scope }), { ok: false, message: 'A shell needs a running container.' })
    assert.equal(created(), null)
    container('running')
    assert.deepEqual(await shellTerminal(orca, { id: ID, scope }), { ok: true })
    assert.match(created()[7], /--context 'colima' exec -it '0123456789ab' sh -c /)
    assert.equal(created()[5], 'sh web-1')
  })
})

describe('logsHeightPref', () => {
  const storage = () => {
    const data = new Map()
    return { data, host: { call: async (method, { key, value }) => {
      if (method === 'storage.set') data.set(key, value)
      if (method === 'storage.delete') data.delete(key)
      return { value: data.get(key) }
    } } }
  }

  test('saves, reads and clears the height', async () => {
    const store = storage()
    assert.deepEqual(await logsHeightPref(store, {}), { height: null })
    assert.deepEqual(await logsHeightPref(store, { height: 400 }), { height: 400 })
    assert.deepEqual(await logsHeightPref(store, {}), { height: 400 })
    assert.deepEqual(await logsHeightPref(store, { height: null }), { height: null })
    assert.equal(store.data.size, 0)
  })

  test('ignores anything that is not a height in range', async () => {
    const store = storage()
    await logsHeightPref(store, { height: 400 })
    for (const height of [0, 119, 4001, 300.5, '300', {}]) assert.deepEqual(await logsHeightPref(store, { height }), { height: 400 }, JSON.stringify(height))
  })

  test('survives a failing storage', async () => {
    const broken = { host: { call: async () => { throw new Error('unavailable') } } }
    assert.deepEqual(await logsHeightPref(broken, {}), { height: null })
    assert.deepEqual(await logsHeightPref(broken, { height: 300 }), { height: 300 })
  })
})
