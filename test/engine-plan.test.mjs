// enginePlan depends on which engine CLIs exist. The worker looks them up at import time (and checks for
// Docker.app on each call), so existsSync is stubbed around both: nothing is read from, or needed on, the
// real machine. No step is executed.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { basename } from 'node:path'

const realExistsSync = fs.existsSync
const setExistsSync = (fn) => { fs.existsSync = fn; syncBuiltinESMExports() }

// A private worker instance that only ever sees the `installed` file names.
async function loadWorker(tag, installed) {
  const fake = (path) => installed.includes(basename(String(path)))
  const withFake = (fn) => {
    setExistsSync(fake)
    try { return fn() } finally { setExistsSync(realExistsSync) }
  }
  setExistsSync(fake)
  try {
    const worker = await import(`../worker.mjs?${tag}`)
    return { enginePlan: (...args) => withFake(() => worker.enginePlan(...args)) }
  } finally {
    setExistsSync(realExistsSync)
  }
}

const all = await loadWorker('all', ['colima', 'orb', 'podman', 'rdctl', 'docker-desktop', 'Docker.app'])
const none = await loadWorker('none', [])
const appOnly = await loadWorker('app-only', ['Docker.app'])

const plain = (steps) => steps.map((s) => [basename(s.bin), ...s.args])
const OPS = ['start', 'stop', 'restart']

describe('enginePlan with the CLIs installed', () => {
  const plan = (ad, op, size) => plain(all.enginePlan(ad, op, size))

  test('Colima passes the size on start and the profile when it is not the default', () => {
    assert.deepEqual(plan({ kind: 'colima', profile: 'default' }, 'start', { cpu: 4, memory: 8 }), [['colima', 'start', '--cpu', '4', '--memory', '8']])
    assert.deepEqual(plan({ kind: 'colima', profile: 'dev' }, 'start', null), [['colima', 'start', '--profile', 'dev', '--cpu', '2', '--memory', '2']])
    assert.deepEqual(plan({ kind: 'colima', profile: 'dev' }, 'stop'), [['colima', 'stop', '--profile', 'dev']])
    assert.deepEqual(plan({ kind: 'colima', profile: 'default' }, 'restart'), [['colima', 'restart']])
  })

  test('Docker Desktop uses its CLI plugin', () => {
    for (const op of OPS) assert.deepEqual(plan({ kind: 'desktop' }, op), [['docker-desktop', 'desktop', op]])
  })

  test('OrbStack, Podman and Rancher restart as stop then start', () => {
    assert.deepEqual(plan({ kind: 'orbstack' }, 'restart'), [['orb', 'stop'], ['orb', 'start']])
    assert.deepEqual(plan({ kind: 'podman', machine: 'podman-machine-dev' }, 'restart'), [
      ['podman', 'machine', 'stop', 'podman-machine-dev'], ['podman', 'machine', 'start', 'podman-machine-dev']
    ])
    assert.deepEqual(plan({ kind: 'podman', machine: null }, 'start'), [['podman', 'machine', 'start']])
    assert.deepEqual(plan({ kind: 'rancher' }, 'restart'), [['rdctl', 'shutdown'], ['rdctl', 'start']])
    assert.deepEqual(plan({ kind: 'rancher' }, 'stop'), [['rdctl', 'shutdown']])
  })

  test('a generic engine cannot be controlled', () => {
    for (const op of OPS) assert.equal(all.enginePlan({ kind: 'generic' }, op), null)
  })
})

describe('enginePlan with CLIs missing', () => {
  test('returns null for every adapter when nothing is installed', () => {
    for (const kind of ['colima', 'desktop', 'orbstack', 'podman', 'rancher', 'generic']) {
      for (const op of OPS) assert.equal(none.enginePlan({ kind, profile: 'default' }, op), null, `${kind} ${op}`)
    }
  })

  test('Docker Desktop without the plugin can only be opened', () => {
    assert.deepEqual(appOnly.enginePlan({ kind: 'desktop' }, 'start'), [{ bin: '/usr/bin/open', args: ['-a', 'Docker'], wait: true }])
    assert.equal(appOnly.enginePlan({ kind: 'desktop' }, 'stop'), null)
    assert.equal(appOnly.enginePlan({ kind: 'desktop' }, 'restart'), null)
  })
})
