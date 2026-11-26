// One follower and one search per panel and container, at most three per panel.
// `docker` is a stand-in shell script put first on PATH; no engine is contacted.
import { after, afterEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'containers-test-followers-')))
after(() => rmSync(base, { recursive: true, force: true }))
const PS = join(base, 'ps')
const IDS = ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc', 'dddddddddddd']
const [A, B, C, D] = IDS
const listed = (ids) => writeFileSync(PS, ids.map((ID) => `${JSON.stringify({ ID, Names: ID, State: 'running', Status: 'running', Labels: '' })}\n`).join(''))
listed(IDS)
// `docker logs` stays running until it is killed.
writeFileSync(join(base, 'docker'), `#!/bin/sh\ncase " $* " in *" logs "*) exec /bin/sleep 30;; *) /bin/cat '${PS}';; esac\n`)
chmodSync(join(base, 'docker'), 0o755)
process.env.PATH = [base, process.env.PATH].join(delimiter)
const { followers, followLogs, stopLogs, sweepFollowers, touchPanel } = await import('../lib/logs/follow.mjs')
const { searches, searchLogs } = await import('../lib/logs/search.mjs')
const { selectEngine } = await import('../lib/docker.mjs')
selectEngine({ name: 'colima', endpoint: '' })

const posts = []
const orca = { panels: { post: (name, data, to) => posts.push({ name, ...data, panel: to?.panel }) } }
const input = (id, token) => ({ id, token, scope: { kind: 'container', id } })
let seq = 0 // the panel's counter: it only goes up
const next = () => ++seq
const follow = (id, token = next(), panel = 'p1') => followLogs(orca, panel, input(id, token))
const stop = (id, token = next()) => stopLogs(orca, 'p1', { id, token })
const search = (id, panel = 'p1') => searchLogs(orca, panel, { ...input(id), query: 'x' })
const following = (panel = 'p1') => [...(followers.get(panel)?.keys() ?? [])]
const searching = (panel = 'p1') => [...(searches.get(panel)?.keys() ?? [])]
const ends = () => posts.filter((p) => p.name === 'colima.logs.end').map((p) => [p.id, p.reason, p.panel])
const until = async (ready) => { while (!ready()) await new Promise((resolve) => setImmediate(resolve)) }

afterEach(() => {
  for (const panel of new Set([...followers.keys(), ...searches.keys()])) stopLogs(orca, panel, {})
  posts.length = 0
  listed(IDS)
})

describe('followers per panel and container', () => {
  test('follows several containers at once, replacing only the same one', async () => {
    assert.equal((await follow(A)).ok, true)
    assert.equal((await follow(B)).ok, true)
    const first = followers.get('p1').get(A)
    assert.equal((await follow(A)).ok, true)
    assert.equal(first.stopped, true)
    assert.deepEqual(following().sort(), [A, B])
    assert.equal(followers.get('p1').get(B).stopped, false)
    assert.deepEqual(ends(), [])
  })

  test('keeps at most three per panel, ending the oldest', async () => {
    for (const id of [A, B, C]) await follow(id)
    await follow(A, next(), 'p2')
    await follow(D)
    assert.deepEqual(following(), [B, C, D])
    assert.deepEqual(following('p2'), [A])
    assert.deepEqual(ends(), [[A, 'limit', 'p1']])
  })

  test('the cap also holds for follows answered together', async () => {
    const all = await Promise.all(IDS.map((id) => follow(id)))
    assert.ok(all.every((r) => r.ok))
    assert.equal(following().length, 3)
  })

  test('stop targets one container, or all of the panel', async () => {
    for (const id of [A, B, C]) await follow(id)
    await follow(A, next(), 'p2')
    stop(B)
    assert.deepEqual(following(), [A, C])
    stop()
    assert.deepEqual(following(), [])
    assert.deepEqual(following('p2'), [A])
    assert.deepEqual(ends(), [])
  })

  test('a stop drops a slow follow of that container only', async () => {
    const a = follow(A)
    const b = follow(B)
    stop(A)
    assert.equal((await a).ok, false)
    assert.equal((await b).ok, true)
    assert.deepEqual(following(), [B])
  })

  test('a stop of everything drops every slow follow', async () => {
    const a = follow(A)
    const b = follow(B)
    stop()
    assert.deepEqual([(await a).ok, (await b).ok], [false, false])
    assert.deepEqual(following(), [])
  })

  test('refuses a follow older than the last stop of everything or of that container', async () => {
    const [old, older] = [next(), next()]
    stop()
    assert.equal((await follow(A, old)).ok, false)
    stop(B)
    assert.equal((await follow(B, older)).ok, false)
    assert.equal((await follow(A)).ok, true)
  })

  test('refuses a container outside the scope', async () => {
    const r = await followLogs(orca, 'p1', { id: A, token: next(), scope: { kind: 'container', id: B } })
    assert.equal(r.ok, false)
    assert.deepEqual(following(), [])
  })
})

describe('sweep', () => {
  test('ends only the follower whose container is gone', async () => {
    await follow(A)
    await follow(B)
    touchPanel('p1')
    listed([B, C, D])
    await sweepFollowers(orca)
    assert.deepEqual(following(), [B])
    assert.deepEqual(ends(), [[A, 'not-owned', 'p1']])
  })

  test('ends every follower of an idle panel', async () => {
    mock.timers.enable({ apis: ['Date'] })
    try {
      touchPanel('p1')
      await follow(A)
      await follow(B)
      mock.timers.tick(16000)
      await sweepFollowers(orca)
    } finally { mock.timers.reset() }
    assert.deepEqual(following(), [])
    assert.deepEqual(ends(), [[A, 'idle', 'p1'], [B, 'idle', 'p1']])
  })
})

describe('searches per panel and container', () => {
  test('run side by side, a new one replacing only the same container', async () => {
    const a = search(A)
    await until(() => searching().length === 1)
    const b = search(B)
    await until(() => searching().length === 2)
    const again = search(A)
    assert.equal((await a).cancelled, true)
    stopLogs(orca, 'p1', { id: B })
    assert.equal((await b).cancelled, true)
    assert.deepEqual(searching(), [A])
    stopLogs(orca, 'p1', {})
    assert.equal((await again).cancelled, true)
    assert.deepEqual(searching(), [])
  })

  test('keeps at most three per panel', async () => {
    const running = []
    for (const [i, id] of [A, B, C].entries()) {
      running.push(search(id))
      await until(() => searching().length === i + 1)
    }
    running.push(search(D))
    assert.equal((await running[0]).cancelled, true)
    assert.deepEqual(searching(), [B, C, D])
    stopLogs(orca, 'p1', {})
    await Promise.all(running)
  })

  test('a follow cancels the search of its own container only', async () => {
    const a = search(A)
    const b = search(B)
    await until(() => searching().length === 2)
    await follow(A)
    assert.equal((await a).cancelled, true)
    assert.deepEqual(searching(), [B])
    stopLogs(orca, 'p1', {})
    await b
  })
})

describe('a search still checking ownership', () => {
  const tokened = (id, token = next()) => searchLogs(orca, 'p1', { ...input(id, token), query: 'x' })

  test('never starts after a stop or a follow of its container, or a stop of everything', async () => {
    for (const cancel of [() => stop(A), () => stop(), () => follow(A)]) {
      const pending = tokened(A)
      const done = cancel()
      assert.equal((await pending).cancelled, true)
      assert.deepEqual(searching(), [])
      await done
      stop()
    }
  })

  test('is not cancelled by a stop of another container', async () => {
    const pending = tokened(A)
    stop(B)
    await until(() => searching().length === 1)
    stop(A)
    assert.equal((await pending).cancelled, true)
  })

  test('does not evict a running search under the cap once cancelled', async () => {
    const running = []
    for (const [i, id] of [A, B, C].entries()) {
      running.push(tokened(id))
      await until(() => searching().length === i + 1)
    }
    const late = tokened(D)
    stop(D)
    assert.equal((await late).cancelled, true)
    assert.deepEqual(searching(), [A, B, C])
    stop()
    await Promise.all(running)
  })

  test('does not replace a newer search of the same container', async () => {
    const [old, newer] = [next(), next()]
    const first = tokened(A, old)
    const second = tokened(A, newer)
    assert.equal((await first).cancelled, true)
    await until(() => searching().length === 1)
    stop(A)
    assert.equal((await second).cancelled, true)
  })
})
