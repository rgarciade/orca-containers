// `docker stats` parsing and the log output chunker (with mocked timers).
import { afterEach, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { createChunker, parseBytes, parseStatsLine } from '../worker.mjs'

describe('parseBytes', () => {
  test('reads decimal and binary units', () => {
    assert.equal(parseBytes('512B'), 512)
    assert.equal(parseBytes('1.5kB'), 1500)
    assert.equal(parseBytes(' 2 MB '), 2e6)
    assert.equal(parseBytes('1KiB'), 1024)
    assert.equal(parseBytes('123.4MiB'), Math.round(123.4 * 1024 ** 2))
    assert.equal(parseBytes('7.6GiB'), Math.round(7.6 * 1024 ** 3))
    assert.equal(parseBytes('1TiB'), 1024 ** 4)
    assert.equal(parseBytes('42'), 42)
  })

  test('returns null for unreadable text', () => {
    for (const text of ['', '--', 'MiB', '1.2.3MB', '.', '-1MB', '1e3B', '5 XB', '1MB extra', null, undefined]) {
      assert.equal(parseBytes(text), null, JSON.stringify(text))
    }
  })

  test('returns null for a unit that names an Object prototype member', { todo: 'bug: parseBytes("1constructor") returns NaN (UNITS lookup reaches the prototype)' }, () => {
    assert.equal(parseBytes('1constructor'), null)
  })
})

describe('parseStatsLine', () => {
  test('splits memory usage and parses percentages', () => {
    assert.deepEqual(parseStatsLine({ CPUPerc: '12.50%', MemUsage: '1MiB / 2GiB', MemPerc: '0.05%', NetIO: '1kB / 0B', BlockIO: '0B / 0B' }), {
      cpuPercent: 12.5, memUsage: 1024 ** 2, memLimit: 2 * 1024 ** 3, memPercent: 0.05, netIO: '1kB / 0B', blockIO: '0B / 0B'
    })
  })

  test('falls back to zeros and empty strings', () => {
    const zero = { cpuPercent: 0, memUsage: 0, memLimit: 0, memPercent: 0, netIO: '', blockIO: '' }
    assert.deepEqual(parseStatsLine({}), zero)
    assert.deepEqual(parseStatsLine({ CPUPerc: '--', MemUsage: '-- / --', MemPerc: '--' }), zero)
  })
})

describe('createChunker', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }))
  afterEach(() => mock.timers.reset())

  const make = (options) => {
    const posts = []
    return { posts, chunker: createChunker((t) => posts.push(t), { intervalMs: 100, maxChars: 4, maxPending: 10, ...options }) }
  }

  test('batches pushes into one post per interval', () => {
    const { posts, chunker } = make()
    chunker.push('a')
    chunker.push('b')
    mock.timers.tick(99)
    assert.deepEqual(posts, [])
    mock.timers.tick(1)
    assert.deepEqual(posts, ['ab'])
  })

  test('splits long output across intervals', () => {
    const { posts, chunker } = make()
    chunker.push('abcdefghij')
    mock.timers.tick(100)
    assert.deepEqual(posts, ['abcd'])
    mock.timers.tick(100)
    mock.timers.tick(100)
    assert.deepEqual(posts, ['abcd', 'efgh', 'ij'])
  })

  test('drops the oldest output beyond maxPending', () => {
    const { posts, chunker } = make({ maxChars: 100 })
    chunker.push('0123456789')
    chunker.push('ABC')
    chunker.drain()
    assert.deepEqual(posts, ['3456789ABC'])
  })

  test('drain flushes everything at once, within maxChars, and cancels the timer', () => {
    const { posts, chunker } = make()
    chunker.push('abcdefghi')
    chunker.drain()
    assert.deepEqual(posts, ['abcd', 'efgh', 'i'])
    mock.timers.tick(1000)
    assert.equal(posts.length, 3)
  })

  test('stop discards pending output and ignores later pushes', () => {
    const { posts, chunker } = make()
    chunker.push('abc')
    chunker.stop()
    chunker.push('def')
    mock.timers.tick(1000)
    chunker.drain()
    assert.deepEqual(posts, [])
  })

  test('ignores empty input and survives a post that throws', () => {
    let calls = 0
    const chunker = createChunker(() => { calls++; throw new Error('panel gone') }, { intervalMs: 100, maxChars: 2, maxPending: 10 })
    chunker.push('')
    chunker.push(undefined)
    mock.timers.tick(100)
    assert.equal(calls, 0)
    chunker.push('abcd')
    assert.doesNotThrow(() => chunker.drain())
    assert.equal(calls, 2)
  })
})
