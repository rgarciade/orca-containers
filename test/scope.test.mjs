// Scope validation and ownership: the panel is untrusted, so only exact, live matches may pass.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { containersOfWorktree, containersOutsideScope, deepestRoot, validateContext, validateScope } from '../worker.mjs'

const ID = 'a1b2c3d4e5f6'
const worktrees = [
  { path: '/repos/app' },
  { path: '/repos/old', isArchived: true }
]
const containers = [
  { id: 'c1', project: 'web', workdir: '/srv/web' },
  { id: ID, project: null, workdir: null }
]

describe('validateScope', () => {
  test('accepts the exact path of a live worktree', () => {
    assert.deepEqual(validateScope({ kind: 'worktree', path: '/repos/app' }, worktrees, []), { kind: 'worktree', root: '/repos/app' })
  })

  test('rejects any worktree path that is not an exact live match', () => {
    for (const path of ['/repos/app/', '/repos/app/sub', '/repos', '/repos/ap', '/repos/app/../app', 'repos/app', '/repos/old', '', null, 7, ['/repos/app']]) {
      assert.equal(validateScope({ kind: 'worktree', path }, worktrees, []).gone, true, `path ${JSON.stringify(path)}`)
    }
  })

  test('accepts a compose working dir only when a container has exactly it', () => {
    assert.deepEqual(validateScope({ kind: 'compose', workdir: '/srv/web' }, [], containers), { kind: 'compose', root: '/srv/web' })
    for (const workdir of ['/srv/web/', '/srv', '/srv/web/..', '/etc', '', undefined, null]) {
      assert.equal(validateScope({ kind: 'compose', workdir }, [], containers).gone, true, `workdir ${JSON.stringify(workdir)}`)
    }
  })

  test('accepts a container scope only for a listed container outside Compose', () => {
    assert.deepEqual(validateScope({ kind: 'container', id: ID }, [], containers), { kind: 'container', root: ID })
  })

  test('rejects container ids that belong to Compose, are unknown or are not hex ids', () => {
    const composed = [{ id: ID, project: 'web', workdir: null }, { id: 'b'.repeat(12), project: null, workdir: '/srv' }]
    assert.equal(validateScope({ kind: 'container', id: ID }, [], composed).gone, true)
    assert.equal(validateScope({ kind: 'container', id: 'b'.repeat(12) }, [], composed).gone, true)
    assert.equal(validateScope({ kind: 'container', id: 'f'.repeat(12) }, [], containers).gone, true)
    for (const id of ['--all', 'abc', `${ID}; rm -rf /`, `${ID}\n`, ID.toUpperCase(), 'a'.repeat(65), 123456789012]) {
      // Listed under that very id, so only the format check can reject it.
      assert.equal(validateScope({ kind: 'container', id }, [], [{ id }]).gone, true, `id ${JSON.stringify(id)}`)
    }
  })

  test('rejects malformed scopes and missing data without throwing', () => {
    for (const scope of [null, undefined, 'worktree', 1, {}, { kind: 'all' }, { kind: '__proto__' }]) {
      assert.deepEqual(validateScope(scope, worktrees, containers), { gone: true, error: 'Invalid scope.' })
    }
    assert.equal(validateScope({ kind: 'worktree', path: '/repos/app' }, undefined, undefined).gone, true)
    assert.equal(validateScope({ kind: 'compose', workdir: '/srv/web' }, undefined, undefined).gone, true)
    assert.equal(validateScope({ kind: 'container', id: ID }, undefined, undefined).gone, true)
  })
})

describe('validateContext', () => {
  const list = [{ name: 'colima' }, { name: 'desktop-linux' }]

  test('returns the listed entry itself', () => {
    assert.equal(validateContext('colima', list), list[0])
  })

  test('returns null for anything not listed verbatim', () => {
    for (const name of ['Colima', 'colima ', 'col', '--help', 'colima --debug', '__proto__', '', null, undefined, 1, ['colima'], { name: 'colima' }]) {
      assert.equal(validateContext(name, list), null, `name ${JSON.stringify(name)}`)
    }
    assert.equal(validateContext('colima', undefined), null)
  })
})

describe('deepestRoot', () => {
  const roots = ['/a', '/a/b', '/a/b/c']

  test('picks the deepest containing root, in any order', () => {
    assert.equal(deepestRoot('/a/b/c/d', roots), '/a/b/c')
    assert.equal(deepestRoot('/a/b/x', [...roots].reverse()), '/a/b')
    assert.equal(deepestRoot('/a/b', roots), '/a/b')
  })

  test('never matches a sibling that only shares a string prefix', () => {
    assert.equal(deepestRoot('/a/bc', ['/a/b']), null)
    assert.equal(deepestRoot('/a/bc', roots), '/a')
  })

  test('returns null without a directory or a containing root', () => {
    assert.equal(deepestRoot(null, roots), null)
    assert.equal(deepestRoot('', roots), null)
    assert.equal(deepestRoot('/z', roots), null)
    assert.equal(deepestRoot('/a', []), null)
  })
})

describe('containersOfWorktree', () => {
  const at = (id, workdir) => ({ id, workdir })
  const list = [
    at('root', '/r/app'),
    at('sub', '/r/app/services/api'),
    at('nested', '/r/app/worktrees/feature'),
    at('nestedSub', '/r/app/worktrees/feature/db'),
    at('sibling', '/r/app-two'),
    at('escape', '/r/app/../secret'),
    at('none', null)
  ]
  const wts = [{ path: '/r/app' }, { path: '/r/app/worktrees/feature' }]
  const ids = (found) => found.map((c) => c.id)

  test('excludes nested worktrees, prefix siblings and paths escaping with ..', () => {
    assert.deepEqual(ids(containersOfWorktree(list, wts, '/r/app')), ['root', 'sub'])
  })

  test('gives a nested worktree only its own containers', () => {
    assert.deepEqual(ids(containersOfWorktree(list, wts, '/r/app/worktrees/feature')), ['nested', 'nestedSub'])
  })

  test('ignores archived nested worktrees and normalises the root', () => {
    const archived = [wts[0], { ...wts[1], isArchived: true }]
    assert.deepEqual(ids(containersOfWorktree(list, archived, '/r/app/')), ['root', 'sub', 'nested', 'nestedSub'])
  })

  test('works for a root missing from the worktree list', () => {
    assert.deepEqual(ids(containersOfWorktree(list, undefined, '/r/app-two')), ['sibling'])
  })
})

describe('containersOutsideScope', () => {
  const all = [{ id: '1', project: 'web' }, { id: '2', project: 'web' }, { id: '3', project: 'db' }, { id: '4', project: null }]

  test('reports same-project containers the scope does not hold', () => {
    assert.deepEqual(containersOutsideScope('web', [all[0]], all), [all[1]])
  })

  test('is empty when the scope holds the whole project', () => {
    assert.deepEqual(containersOutsideScope('web', [all[0], all[1]], all), [])
  })

  test('treats a missing scope as holding nothing', () => {
    assert.deepEqual(containersOutsideScope('web', undefined, all), [all[0], all[1]])
    assert.deepEqual(containersOutsideScope('web', [], undefined), [])
  })
})
