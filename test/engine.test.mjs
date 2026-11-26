// Docker context parsing, engine choice and adapter detection.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseEngine, detectAdapter, parseContexts } from '../worker.mjs'

describe('chooseEngine', () => {
  const list = [{ name: 'default', current: false }, { name: 'colima', current: true }]

  test('keeps a saved context that is still listed', () => {
    assert.deepEqual(chooseEngine('default', list), { name: 'default', missing: false })
  })

  test('never silently replaces a saved context that is gone', () => {
    assert.deepEqual(chooseEngine('gone', list), { name: 'gone', missing: true })
    assert.deepEqual(chooseEngine('gone', undefined), { name: 'gone', missing: true })
  })

  test('uses the CLI current context without a usable saved value', () => {
    for (const saved of [null, undefined, '', 5, { name: 'default' }]) {
      assert.deepEqual(chooseEngine(saved, list), { name: 'colima', missing: false })
    }
  })

  test('asks for a probe when nothing is saved or current', () => {
    assert.deepEqual(chooseEngine(null, [{ name: 'a' }]), { name: null, missing: false, probe: true })
    assert.deepEqual(chooseEngine(null, undefined), { name: null, missing: false, probe: true })
  })
})

describe('parseContexts', () => {
  test('maps one JSON object per line', () => {
    const line = JSON.stringify({ Name: 'colima', DockerEndpoint: 'unix:///s.sock', Current: true, Description: 'd', Error: '' })
    assert.deepEqual(parseContexts(`${line}\r\n\n{"Name":"bare"}\n`), [
      { name: 'colima', endpoint: 'unix:///s.sock', current: true, description: 'd', error: '' },
      { name: 'bare', endpoint: '', current: false, description: '', error: '' }
    ])
  })

  test('skips malformed lines and entries without a string name', () => {
    const text = ['not json', 'null', '42', '[]', '{}', '{"Name":""}', '{"Name":7}', '{"Name":["a"]}', '{"Name":"ok","Current":"true"}', '{"Name":"cut'].join('\n')
    assert.deepEqual(parseContexts(text).map((c) => [c.name, c.current]), [['ok', false]])
  })

  test('returns an empty list for no output', () => {
    assert.deepEqual(parseContexts(''), [])
    assert.deepEqual(parseContexts(undefined), [])
  })
})

describe('detectAdapter', () => {
  const detect = (name, endpoint = '') => detectAdapter({ name, endpoint })

  test('detects Colima profiles from the socket path or the name', () => {
    assert.deepEqual(detect('colima'), { kind: 'colima', profile: 'default', label: 'Colima' })
    assert.deepEqual(detect('colima-dev'), { kind: 'colima', profile: 'dev', label: 'Colima (dev)' })
    assert.equal(detect('custom', 'unix:///Users/x/.colima/work/docker.sock').profile, 'work')
    assert.equal(detect('custom', 'unix:///Users/x/.config/colima/work/docker.sock').profile, 'work')
  })

  test('never yields a profile that could be read as a CLI option', () => {
    for (const ad of [detect('colima---help'), detect('colima--f'), detect('colima-'), detect('x', 'unix:///h/.colima/--force/docker.sock'), detect('colima-a b')]) {
      assert.notEqual(ad.kind, 'colima')
      assert.equal(ad.profile, undefined)
    }
  })

  test('detects OrbStack, Rancher Desktop and Docker Desktop', () => {
    assert.equal(detect('orbstack').kind, 'orbstack')
    assert.equal(detect('x', 'unix:///h/.orbstack/run/docker.sock').kind, 'orbstack')
    assert.equal(detect('rancher-desktop').kind, 'rancher')
    assert.equal(detect('x', 'unix:///h/.rd/docker.sock').kind, 'rancher')
    for (const ad of [detect('desktop-linux'), detect('desktop-windows'), detect('x', 'unix:///h/.docker/run/docker.sock'), detect('x', 'unix:///h/.docker/desktop/docker.sock')]) {
      assert.equal(ad.kind, 'desktop')
    }
  })

  test('detects Podman and its machine name', () => {
    assert.deepEqual(detect('p', 'unix:///t/podman/podman-machine-default-api.sock'), { kind: 'podman', label: 'Podman', machine: 'podman-machine-default' })
    assert.equal(detect('p', 'unix:///t/podman-machine-dev.sock').machine, 'podman-machine-dev')
    assert.equal(detect('my-Podman', 'tcp://host:1').machine, null)
  })

  test('falls back to a generic engine', () => {
    assert.deepEqual(detect('remote', 'ssh://user@host'), { kind: 'generic', label: 'Docker (context remote)' })
    assert.equal(detectAdapter(undefined).kind, 'generic')
  })
})
