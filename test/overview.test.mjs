// Worktree matching and the "All" tree.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildOverview, matchWorktree } from '../worker.mjs'

const wt = (path, branch, displayName, extra = {}) => ({ path, branch, displayName, ...extra })

describe('matchWorktree', () => {
  const rows = [wt('/a', 'refs/heads/main', 'alpha'), wt('/b', 'refs/heads/main', 'beta'), wt('/c', 'refs/heads/feature/x', 'gamma')]

  test('matches branch and display name, ignoring refs/heads/', () => {
    assert.deepEqual(matchWorktree(rows, { branch: 'main', displayName: 'beta' }), { path: '/b' })
    assert.deepEqual(matchWorktree(rows, { branch: 'refs/heads/main', displayName: 'alpha' }), { path: '/a' })
  })

  test('falls back to a unique branch after a rename', () => {
    assert.deepEqual(matchWorktree(rows, { branch: 'feature/x', displayName: 'old name' }), { path: '/c' })
  })

  test('refuses to guess between several candidates', () => {
    assert.match(matchWorktree(rows, { branch: 'main', displayName: 'other' }).error, /2 worktrees match branch main/)
    const twins = [wt('/a', 'dev', 'dev'), wt('/b', 'dev', 'dev')]
    const out = matchWorktree(twins, { branch: 'dev', displayName: 'dev' })
    assert.match(out.error, /2 worktrees match branch dev/)
    assert.equal(out.path, undefined)
  })

  test('uses the display name for a detached HEAD', () => {
    const detached = [wt('/a', '', 'one'), wt('/b', '', 'two'), wt('/c', 'main', 'three')]
    assert.deepEqual(matchWorktree(detached, { displayName: 'two' }), { path: '/b' })
    assert.match(matchWorktree([wt('/a', '', 'x'), wt('/b', '', 'x')], { displayName: 'x' }).error, /2 worktrees match name x/)
  })

  test('skips archived, pathless and empty rows', () => {
    const list = [null, wt('', 'main', 'alpha'), wt('/old', 'main', 'alpha', { isArchived: true }), wt('/a', 'main', 'alpha')]
    assert.deepEqual(matchWorktree(list, { branch: 'main', displayName: 'alpha' }), { path: '/a' })
  })

  test('explains when nothing matches or there is no data', () => {
    assert.match(matchWorktree(rows, { branch: 'nope' }).error, /No Orca worktree matches nope/)
    assert.match(matchWorktree(undefined, undefined).error, /the focused workspace/)
  })
})

describe('buildOverview', () => {
  const c = (name, workdir, project = null, state = 'running') => ({ id: name, name, workdir, project, state, configFiles: ['/secret/compose.yml'] })
  const worktrees = [
    { path: '/r/app', repoId: 'r1', displayName: 'main', branch: 'refs/heads/main' },
    { path: '/r/app/wt/feature', repoId: 'r1', branch: 'refs/heads/feature' },
    { path: '/r/empty', repoId: 'r2' }
  ]
  const repos = [{ id: 'r1', displayName: 'App' }, { id: 'r2', displayName: 'Empty' }]

  test('assigns each container to the deepest worktree and omits empty ones', () => {
    const out = buildOverview([c('top', '/r/app/svc', 'web', 'exited'), c('deep', '/r/app/wt/feature/db', 'db')], worktrees, repos)
    assert.equal(out.projects.length, 1)
    const [project] = out.projects
    assert.deepEqual([project.id, project.name, project.running, project.total], ['r1', 'App', 1, 2])
    // The worktree with running containers goes first; the unnamed one is named after its folder.
    assert.deepEqual(project.worktrees.map((w) => [w.name, w.branch, w.containers.map((x) => x.name)]), [
      ['feature', 'feature', ['deep']],
      ['main', 'main', ['top']]
    ])
  })

  test('keeps prefix siblings and .. escapes out of a worktree', () => {
    const out = buildOverview([c('sibling', '/r/app-two', 'two'), c('escape', '/r/app/../x', 'x')], worktrees, repos)
    assert.deepEqual(out.projects, [])
    assert.deepEqual(out.other.projects.map((p) => p.name), ['two', 'x'])
  })

  test('separates other compose groups from individual containers', () => {
    const out = buildOverview([
      c('a', '/srv/one', 'web', 'exited'), c('b', '/srv/two', 'web'),
      c('noProject', '/srv/folder'), c('noDir', null, 'remote'), c('solo', null)
    ], [], [])
    assert.deepEqual(out.other.projects.map((p) => [p.name, p.workdir, p.running]), [
      ['folder', '/srv/folder', 1], ['remote', null, 1], ['web', '/srv/two', 1], ['web', '/srv/one', 0]
    ])
    assert.deepEqual([out.other.running, out.other.total], [3, 4])
    assert.deepEqual(out.individual.containers.map((x) => x.name), ['solo'])
  })

  test('sorts running containers first and sends only the public fields', () => {
    const out = buildOverview([c('a', null, null, 'exited'), c('z', null)], [], [])
    assert.deepEqual(out.individual.containers.map((x) => x.name), ['z', 'a'])
    assert.equal('configFiles' in out.individual.containers[0], false)
    assert.equal('workdir' in out.individual.containers[0], false)
  })

  test('keeps the container marker in every group', () => {
    const marker = { kind: 'exit', code: 137 }
    const out = buildOverview([
      { ...c('inTree', '/r/app', 'a'), marker }, { ...c('inOther', '/srv/x', 'x'), marker }, { ...c('solo', null), marker }
    ], worktrees, repos)
    assert.deepEqual(out.projects[0].worktrees[0].containers[0].marker, marker)
    assert.deepEqual(out.other.projects[0].containers[0].marker, marker)
    assert.deepEqual(out.individual.containers[0].marker, marker)
  })

  test('ignores archived worktrees and labels unknown repos', () => {
    const wts = [{ path: '/r/gone', isArchived: true }, { path: '/r/live', repoId: 'nope' }]
    const out = buildOverview([c('old', '/r/gone', 'old'), c('new', '/r/live', 'new')], wts, undefined)
    assert.deepEqual(out.projects.map((p) => p.name), ['Unknown project'])
    assert.deepEqual(out.other.projects.map((p) => p.name), ['old'])
  })

  test('returns an empty tree for missing input', () => {
    assert.deepEqual(buildOverview(undefined, undefined, undefined), {
      projects: [], other: { running: 0, total: 0, projects: [] }, individual: { running: 0, total: 0, containers: [] }
    })
  })
})
