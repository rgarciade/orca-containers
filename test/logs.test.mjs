// Log timestamps, history paging and search.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { compareTs, createSearchCollector, filterOlder, isRfc3339, lineMatcher, selectOlder } from '../lib/logs/text.mjs'

const ts = (s) => `2024-05-01T10:00:0${s}Z`
const line = (s, text) => `${ts(s)} ${text}`

describe('isRfc3339', () => {
  test('accepts UTC and offset timestamps up to nanoseconds', () => {
    for (const t of [ts(1), '2024-05-01T10:00:01.123456789Z', '2024-05-01T10:00:01.5+02:00', '2024-05-01T10:00:01-07:30']) {
      assert.equal(isRfc3339(t), true, t)
    }
  })

  test('rejects anything else, including injection attempts', () => {
    for (const t of [
      '', '2024-05-01', '2024-05-01T10:00:01', '2024-05-01 10:00:01Z', '10m', '--help', `${ts(1)} --follow`, `${ts(1)}\n`, ` ${ts(1)}`,
      '2024-13-01T10:00:00Z', '2024-05-01T25:00:00Z', '2024-05-01T10:00:01.1234567890Z', 'x'.repeat(1000), null, undefined, 1714557600, new Date(0)
    ]) {
      assert.equal(isRfc3339(t), false, String(t))
    }
  })
})

describe('compareTs', () => {
  test('orders by second, then nanoseconds', () => {
    assert.ok(compareTs(ts(1), ts(2)) < 0)
    assert.ok(compareTs(ts(2), ts(1)) > 0)
    assert.ok(compareTs('2024-05-01T10:00:01.000000001Z', '2024-05-01T10:00:01.000000002Z') < 0)
    assert.ok(compareTs('2024-05-01T10:00:01.9Z', '2024-05-01T10:00:01.10Z') > 0)
  })

  test('treats equal instants as equal across precision and offsets', () => {
    assert.equal(compareTs('2024-05-01T10:00:01.5Z', '2024-05-01T10:00:01.500000000Z'), 0)
    assert.equal(compareTs(ts(1), '2024-05-01T12:00:01+02:00'), 0)
  })
})

describe('filterOlder', () => {
  test('keeps strictly older lines with their continuation lines', () => {
    const lines = [line(1, 'a'), '  at one', line(2, 'boundary'), '  at two', line(3, 'late')]
    assert.deepEqual(filterOlder(lines, ts(2)), [line(1, 'a'), '  at one'])
  })

  test('keeps leading continuation lines and handles unordered input', () => {
    assert.deepEqual(filterOlder(['orphan', line(3, 'late'), 'tail', line(1, 'early')], ts(2)), ['orphan', line(1, 'early')])
  })

  test('does not treat a timestamp inside a message as a line timestamp', () => {
    const lines = [line(1, `saw ${ts(9)}`), `  ${ts(9)} indented`]
    assert.deepEqual(filterOlder(lines, ts(2)), lines)
  })
})

describe('selectOlder', () => {
  const lines = [line(1, 'old'), line(2, 'first'), 'first detail', line(2, 'second'), line(2, 'third'), line(3, 'newer')]

  test('returns older lines plus every boundary line when none is shown', () => {
    assert.deepEqual(selectOlder(lines, ts(2)), lines.slice(0, 5))
  })

  test('drops the last `skip` boundary entries with their continuations', () => {
    assert.deepEqual(selectOlder(lines, ts(2), 2), [line(1, 'old'), line(2, 'first'), 'first detail'])
    assert.deepEqual(selectOlder(lines, ts(2), 3), [line(1, 'old')])
    assert.deepEqual(selectOlder(lines, ts(2), 99), [line(1, 'old')])
  })

  test('keeps leading continuation lines and handles empty input', () => {
    assert.deepEqual(selectOlder(['orphan', line(3, 'newer')], ts(2)), ['orphan'])
    assert.deepEqual(selectOlder([], ts(2), 1), [])
  })
})

describe('lineMatcher', () => {
  test('is case-insensitive by default', () => {
    assert.equal(lineMatcher('ErRoR')('an error here'), true)
    assert.equal(lineMatcher('error', true)('ERROR'), false)
    assert.equal(lineMatcher('ERROR', true)('ERROR'), true)
  })

  test('treats the query as plain text, not a pattern', () => {
    assert.equal(lineMatcher('a.c')('abc'), false)
    assert.equal(lineMatcher('(.*)+$')('x (.*)+$ y'), true)
    assert.equal(lineMatcher('[')('no bracket'), false)
  })
})

describe('createSearchCollector', () => {
  const collect = (lines, ...args) => {
    const c = createSearchCollector(...args)
    for (const l of lines) c.push(l)
    return c.result()
  }

  test('searches the message but not the timestamp prefix', () => {
    const out = collect([line(1, 'nothing'), line(2, 'year 2024'), 'unstamped 2024'], '2024')
    assert.deepEqual(out, { lines: [line(2, 'year 2024'), 'unstamped 2024'], total: 2, truncated: false })
  })

  test('keeps the last `max` matches and counts them all', () => {
    const out = collect([1, 2, 3, 4, 5].map((n) => line(n, 'hit')), 'hit', false, 2)
    assert.deepEqual(out, { lines: [line(4, 'hit'), line(5, 'hit')], total: 5, truncated: true })
  })

  test('restores chronological order, stably, when every line is stamped', () => {
    const out = collect([line(3, 'x c'), line(1, 'x a'), line(2, 'x b1'), line(2, 'x b2')], 'x')
    assert.deepEqual(out.lines, [line(1, 'x a'), line(2, 'x b1'), line(2, 'x b2'), line(3, 'x c')])
  })

  test('keeps arrival order when a line is unstamped', () => {
    const input = [line(3, 'x'), 'x raw', line(1, 'x')]
    assert.deepEqual(collect(input, 'x').lines, input)
  })

  test('returns an empty result without matches', () => {
    assert.deepEqual(collect([line(1, 'a')], 'zzz'), { lines: [], total: 0, truncated: false })
  })
})
