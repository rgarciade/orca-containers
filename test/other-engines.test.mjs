// "Other engines" summary: which contexts are shown, and how a probe is labelled. No docker is called; the
// sockets are plain files and symlinks in a temp dir.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { containerCounts } from '../lib/containers.mjs'
import { endpointKey, localEndpoint, otherEngineRow, otherEngineStatus, probeOncePerDaemon, selectOtherEngines, socketMissing } from '../lib/engines/others.mjs'

const dir = mkdtempSync(join(tmpdir(), 'other-engines-'))
after(() => rmSync(dir, { recursive: true, force: true }))
mkdirSync(join(dir, 'real'))
const sock = (name) => join(dir, 'real', name)
for (const name of ['colima.sock', 'orb.sock']) writeFileSync(sock(name), '')
const link = (name, target) => { symlinkSync(target, join(dir, name)); return join(dir, name) }
const toColima = link('docker.sock', sock('colima.sock'))
const chain = link('chain.sock', 'docker.sock') // relative target, two hops
const dangling = link('dangling.sock', sock('gone.sock'))
symlinkSync(join(dir, 'real'), join(dir, 'alias'))

const ctx = (name, path) => ({ name, endpoint: `unix://${path}` })
const names = (list) => list.map((c) => c.name)

describe('localEndpoint', () => {
  test('accepts unix sockets and local named pipes', () => {
    assert.deepEqual(localEndpoint('unix:///var/run/docker.sock'), { type: 'unix', path: '/var/run/docker.sock' })
    assert.deepEqual(localEndpoint('npipe:////./pipe/docker_engine'), { type: 'npipe', path: '//./pipe/docker_engine' })
  })

  test('rejects anything that could leave the machine', () => {
    for (const endpoint of ['ssh://user@host', 'tcp://127.0.0.1:2375', 'http://h', 'fd://', 'npipe:////server/pipe/docker_engine', 'unix://', 'unix://relative.sock', '', undefined, null]) {
      assert.equal(localEndpoint(endpoint), null, String(endpoint))
    }
  })
})

describe('endpointKey', () => {
  test('follows symlinks to the same socket', () => {
    const key = endpointKey(`unix://${sock('colima.sock')}`)
    for (const path of [toColima, chain, join(dir, 'alias', 'colima.sock')]) assert.equal(endpointKey(`unix://${path}`), key, path)
    assert.notEqual(endpointKey(`unix://${sock('orb.sock')}`), key)
  })

  test('follows a symlink whose target does not exist', () => {
    assert.equal(endpointKey(`unix://${dangling}`), endpointKey(`unix://${sock('gone.sock')}`))
  })

  test('has no key for a remote endpoint', () => {
    assert.equal(endpointKey('ssh://user@host'), null)
  })
})

describe('selectOtherEngines', () => {
  const colima = ctx('colima', sock('colima.sock'))
  const orb = ctx('orbstack', sock('orb.sock'))
  const dflt = ctx('default', toColima)

  test('lists every context but the selected one, in list order', () => {
    const list = [{ name: 'prod', endpoint: 'ssh://user@host' }, colima, ctx('mine', chain), orb, ctx('orb-copy', sock('orb.sock')), { name: 'broken', endpoint: '' }]
    assert.deepEqual(names(selectOtherEngines(list, colima)), ['prod', 'mine', 'orbstack', 'orb-copy', 'broken'])
    assert.deepEqual(names(selectOtherEngines(list, null)), names(list))
  })

  test('hides default when another context, selected or not, is the same daemon', () => {
    assert.deepEqual(names(selectOtherEngines([dflt, colima, orb], colima)), ['orbstack'])
    assert.deepEqual(names(selectOtherEngines([dflt, colima, orb], orb)), ['colima'])
  })

  test('keeps a default that is its own daemon or remote', () => {
    assert.deepEqual(names(selectOtherEngines([dflt, orb], orb)), ['default'])
    const remote = [{ name: 'default', endpoint: 'ssh://h' }, { name: 'a', endpoint: 'ssh://h' }]
    assert.deepEqual(names(selectOtherEngines(remote, remote[1])), ['default'])
  })

  test('lists all named contexts when default is selected', () => {
    assert.deepEqual(names(selectOtherEngines([dflt, colima, ctx('mine', chain), orb], dflt)), ['colima', 'mine', 'orbstack'])
  })

  test('is empty when there is nothing else', () => {
    assert.deepEqual(selectOtherEngines([dflt, colima], colima), [])
    assert.deepEqual(selectOtherEngines([], null), [])
  })
})

describe('probeOncePerDaemon', () => {
  test('probes each socket once and answers every local context', async () => {
    const probed = []
    const probe = async (c) => { probed.push(c.name); return { state: 'running', running: probed.length } }
    const list = [ctx('a', sock('colima.sock')), ctx('b', toColima), ctx('c', sock('orb.sock')), { name: 'r', endpoint: 'ssh://h' }]
    assert.deepEqual(await probeOncePerDaemon(list, probe), [
      { name: 'a', state: 'running', running: 1 }, { name: 'b', state: 'running', running: 1 }, { name: 'c', state: 'running', running: 2 }
    ])
    assert.deepEqual(probed, ['a', 'c'])
  })
})

describe('socketMissing', () => {
  test('is true only for a unix socket that is not there', () => {
    assert.equal(socketMissing(`unix://${sock('gone.sock')}`), true)
    assert.equal(socketMissing(`unix://${dangling}`), true)
    assert.equal(socketMissing(`unix://${toColima}`), false)
    assert.equal(socketMissing('npipe:////./pipe/docker_engine'), false)
  })
})

describe('otherEngineRow', () => {
  const state = (endpoint) => otherEngineRow({ name: 'x', endpoint }).state

  test('leaves a local engine with a socket pending until it is probed', () => {
    assert.equal(state(`unix://${toColima}`), null)
    assert.equal(state('npipe:////./pipe/docker_engine'), null)
  })

  test('settles what needs no docker call', () => {
    assert.equal(state(`unix://${sock('gone.sock')}`), 'stopped')
    assert.equal(state('ssh://user@host'), 'remote')
    assert.equal(state('tcp://10.0.0.1:2375'), 'remote')
    assert.equal(state(''), 'unavailable')
  })

  test('carries the name and the adapter label', () => {
    assert.deepEqual(otherEngineRow({ name: 'orbstack', endpoint: 'ssh://h' }), { name: 'orbstack', label: 'OrbStack', state: 'remote' })
  })
})

describe('otherEngineStatus', () => {
  test('a missing socket is stopped', () => {
    assert.deepEqual(otherEngineStatus(null), { state: 'stopped' })
  })

  test('counts the states of a successful docker ps -a', () => {
    assert.deepEqual(otherEngineStatus({ ok: true, stdout: 'running\nexited\r\nrunning\ncreated\n' }), { state: 'running', running: 2, stopped: 2 })
    assert.deepEqual(otherEngineStatus({ ok: true, stdout: '' }), { state: 'running', running: 0, stopped: 0 })
  })

  test('a failure or timeout never yields a count', () => {
    assert.deepEqual(otherEngineStatus({ ok: false, stdout: 'a1\n' }), { state: 'unavailable' })
  })
})

describe('containerCounts', () => {
  test('counts only the running state as running', () => {
    assert.deepEqual(containerCounts(['running', 'paused', 'restarting', 'exited', 'dead']), { running: 1, stopped: 4 })
    assert.deepEqual(containerCounts([]), { running: 0, stopped: 0 })
  })
})

describe('panel labels', () => {
  const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8')
  const line = (name) => html.match(new RegExp(`^  const ${name} = .*$`, 'm'))[0]
  const { countsText, rowText } = new Function(`${line('countsText')}\n${line('rowText')}\nreturn { countsText, rowText }`)()
  const plain = (text) => text.replaceAll('\u00a0', ' ')

  test('shows running and stopped containers, keeping each number with its word', () => {
    assert.equal(countsText({ running: 3, stopped: 4 }), '3\u00a0running · 4\u00a0stopped')
    assert.equal(plain(rowText({ state: 'running', running: 0, stopped: 2 })), '0 running · 2 stopped')
  })

  test('never words an engine that is off like a container count', () => {
    assert.equal(rowText({ state: 'stopped' }), 'engine stopped')
    assert.equal(rowText({ state: 'remote' }), 'remote')
    assert.equal(rowText({ state: 'unavailable' }), 'unavailable')
    assert.equal(rowText(undefined), 'checking…')
  })
})
