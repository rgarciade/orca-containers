// Container markers derived from the State/Status columns of `docker ps`.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { containerMarker } from '../worker.mjs'

describe('containerMarker', () => {
  test('reports the health of a running container', () => {
    assert.deepEqual(containerMarker('running', 'Up 3 hours (unhealthy)'), { kind: 'unhealthy' })
    assert.deepEqual(containerMarker('running', 'Up 10 seconds (health: starting)'), { kind: 'starting' })
    assert.equal(containerMarker('running', 'Up About an hour (healthy)'), null)
    assert.equal(containerMarker('running', 'Up 2 days'), null)
    assert.equal(containerMarker('paused', 'Up 2 hours (Paused)'), null)
  })

  test('reports a restarting container from its state', () => {
    assert.deepEqual(containerMarker('restarting', 'Restarting (1) 5 seconds ago'), { kind: 'restarting' })
    assert.deepEqual(containerMarker('restarting', ''), { kind: 'restarting' })
  })

  test('reports abnormal exit codes only', () => {
    assert.deepEqual(containerMarker('exited', 'Exited (1) 2 hours ago'), { kind: 'exit', code: 1 })
    assert.deepEqual(containerMarker('exited', 'Exited (137) 5 minutes ago'), { kind: 'exit', code: 137 })
    for (const code of [0, 130, 143]) assert.equal(containerMarker('exited', `Exited (${code}) 3 days ago`), null)
  })

  test('degrades to no marker for unknown or missing strings', () => {
    assert.equal(containerMarker('running', 'Up 3 hours (starting)'), null)
    assert.equal(containerMarker('exited', 'Exited'), null)
    assert.equal(containerMarker('created', 'Created'), null)
    assert.equal(containerMarker('dead', 'Dead'), null)
    assert.equal(containerMarker('stopped', 'Stopped (1) 2 hours ago'), null)
    assert.equal(containerMarker(undefined, undefined), null)
    assert.equal(containerMarker('running', null), null)
  })
})
