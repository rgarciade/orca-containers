// Compose stack discovery: label values are untrusted. Paths are checked lexically; symlinked label
// config files are not covered here.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeScopeStacks, discoverStacks } from '../worker.mjs'

const BAD_PROJECTS = ['-f', '--project-directory=/', '../up', 'Web', 'a b', 'a;rm', 'a/b', '_x', '', null, undefined]

describe('composeScopeStacks', () => {
  test('groups by project and never exposes label paths', () => {
    const out = composeScopeStacks([
      { project: 'web', state: 'running', workdir: '/etc', configFiles: ['/etc/passwd.yml'] },
      { project: 'web', state: 'exited' },
      { project: 'db_1', state: 'exited' }
    ])
    assert.deepEqual(out, [
      { id: 'p:web', project: 'web', files: [], workdir: null, running: 1, total: 2 },
      { id: 'p:db_1', project: 'db_1', files: [], workdir: null, running: 0, total: 1 }
    ])
  })

  test('drops hostile or malformed project names', () => {
    assert.deepEqual(composeScopeStacks(BAD_PROJECTS.map((project) => ({ project, state: 'running' }))), [])
  })
})

describe('discoverStacks', () => {
  let base
  let root
  before(() => {
    base = mkdtempSync(join(tmpdir(), 'containers-test-'))
    root = join(base, 'wt')
    mkdirSync(join(root, 'sub'), { recursive: true })
    mkdirSync(join(root, 'compose.dir.yml')) // a directory, not a file
    for (const name of ['compose.yaml', 'docker-compose.dev.yml', 'compose.txt', 'mycompose.yml', 'compose.yml.bak', 'sub/compose.yml']) {
      writeFileSync(join(root, name), 'services: {}\n')
    }
    writeFileSync(join(base, 'outside.yml'), 'services: {}\n')
    symlinkSync(join(base, 'outside.yml'), join(root, 'compose.link.yml'))
  })
  after(() => rmSync(base, { recursive: true, force: true }))

  const container = (over = {}) => ({ project: 'web', workdir: root, configFiles: [join(root, 'compose.yaml')], state: 'running', ...over })

  test('lists only regular compose files of the worktree root, sorted', async () => {
    const out = await discoverStacks(root, [])
    assert.deepEqual(out.map((s) => s.id), ['f:compose.yaml', 'f:docker-compose.dev.yml'])
    assert.deepEqual(out[0], { id: 'f:compose.yaml', project: null, files: [join(root, 'compose.yaml')], workdir: root, running: 0, total: 0 })
  })

  test('builds a project stack and does not list its file twice', async () => {
    const out = await discoverStacks(root, [container(), container({ state: 'exited' })])
    assert.deepEqual(out.map((s) => s.id), ['p:web', 'f:docker-compose.dev.yml'])
    assert.deepEqual([out[0].running, out[0].total, out[0].files], [1, 2, [join(root, 'compose.yaml')]])
  })

  test('accepts a project in a nested directory of the worktree', async () => {
    const dir = join(root, 'sub')
    const [stack] = await discoverStacks(root, [container({ workdir: dir, configFiles: [join(dir, 'compose.yml')] })])
    assert.deepEqual([stack.id, stack.workdir], ['p:web', dir])
  })

  test('drops containers whose working dir is outside the worktree', async () => {
    for (const workdir of [base, `${root}-two`, `${root}/../elsewhere`, '/', null]) {
      const out = await discoverStacks(root, [container({ workdir })])
      assert.equal(out.some((s) => s.project), false, `workdir ${workdir}`)
    }
  })

  test('drops hostile project names', async () => {
    const out = await discoverStacks(root, BAD_PROJECTS.map((project) => container({ project })))
    assert.equal(out.some((s) => s.project !== null), false)
  })

  test('discards the whole file list when any config file is unsafe', async () => {
    const good = join(root, 'compose.yaml')
    for (const bad of [join(base, 'outside.yml'), `${root}/../outside.yml`, '/etc/passwd', join(root, 'compose.txt'), `${root}-two/compose.yml`]) {
      const [stack] = await discoverStacks(root, [container({ configFiles: [good, bad] })])
      assert.deepEqual(stack.files, [], `file ${bad}`)
    }
    const [none] = await discoverStacks(root, [container({ configFiles: undefined })])
    assert.deepEqual(none.files, [])
  })

  test('returns no file stacks for an unreadable root', async () => {
    assert.deepEqual(await discoverStacks(join(base, 'missing'), []), [])
  })
})
