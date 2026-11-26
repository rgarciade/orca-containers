// stdout and stderr of `docker logs` arrive on separate pipes: they must come out in timestamp order.
// `docker` is a stand-in shell script put first on PATH; no engine is contacted.
import { after, afterEach, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'containers-test-order-')))
after(() => rmSync(base, { recursive: true, force: true }))
const [PS, LOGS] = [join(base, 'ps'), join(base, 'logs.sh')]
const ID = '0123456789ab'
writeFileSync(PS, `${JSON.stringify({ ID, Names: 'web-1', State: 'running', Status: 'running', Labels: '' })}\n`)
writeFileSync(join(base, 'docker'), `#!/bin/sh\ncase " $* " in *" logs "*) . '${LOGS}';; *) /bin/cat '${PS}';; esac\n`)
chmodSync(join(base, 'docker'), 0o755)
process.env.PATH = [base, process.env.PATH].join(delimiter)
const { followLogs } = await import('../lib/logs/follow.mjs')
const { contextLogs, olderLogs } = await import('../lib/logs/history.mjs')
const { createMerger, mergeByTs } = await import('../lib/logs/merge.mjs')
const { createChunker } = await import('../lib/logs/text.mjs')
const { selectEngine } = await import('../lib/docker.mjs')
selectEngine({ name: 'colima', endpoint: '' })

const ts = (ms) => `2024-05-01T10:00:00.${String(ms).padStart(3, '0')}000000Z`
const line = (ms, text) => `${ts(ms)} ${text}`
const input = { id: ID, scope: { kind: 'container', id: ID } }
const fakeLogs = (body) => writeFileSync(LOGS, `${body}\n`)
const out = (text) => `printf '%s' '${text}'`
const err = (text) => `${out(text)} >&2`

// Follows until the fake `docker logs` exits; returns everything posted to the panel.
async function follow() {
  let text = ''
  let ended
  const end = new Promise((resolve) => { ended = resolve })
  const orca = { panels: { post: (name, data) => { if (name === 'colima.logs.chunk') text += data.text; else ended() } } }
  assert.equal((await followLogs(orca, 'p1', input)).ok, true)
  await end
  return text
}

// Timers are mocked and never advanced here: no hold window can race the stand-in process, whose pauses only
// shape the arrival order. Everything held goes out, sorted, when it exits.
describe('live follow', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }))
  afterEach(() => mock.timers.reset())

  test('orders the two pipes by timestamp', async () => {
    fakeLogs([err(`${line(396, '[error] c')}\n`), 'sleep 0.03', out(`${line(381, 'GET a')}\n${line(390, 'GET b')}\n`)].join('\n'))
    assert.equal(await follow(), `${line(381, 'GET a')}\n${line(390, 'GET b')}\n${line(396, '[error] c')}\n`)
  })

  test('never splices a partial line of one pipe into the other', async () => {
    fakeLogs([out(`${line(1, 'half')}`), 'sleep 0.03', err(`${line(2, 'whole')}\n`), 'sleep 0.03', out(' done\n')].join('\n'))
    assert.equal(await follow(), `${line(1, 'half done')}\n${line(2, 'whole')}\n`)
  })

  test('joins a UTF-8 character split across chunks', async () => {
    // The two bytes of U+00E9, written apart.
    fakeLogs([out(`${line(1, 'caf')}`), "printf '\\303'", 'sleep 0.03', "printf '\\251\\n'"].join('\n'))
    assert.equal(await follow(), `${line(1, 'caf\u00e9')}\n`)
  })
})

describe('history and context', () => {
  test('older pages stay ordered when a line has no timestamp', async () => {
    fakeLogs([out(`${line(3, 'c')}\n`), err(`${line(1, 'a')}\n  detail\n${line(2, 'b')}\n`)].join('\n'))
    const r = await olderLogs({}, { ...input, until: ts(9) })
    assert.equal(r.text, `${line(1, 'a')}\n  detail\n${line(2, 'b')}\n${line(3, 'c')}\n`)
  })

  // The first read never delivers stdout: only a second read bounded by --until has both pipes.
  test('context keeps the lines of a pipe still unread when the other one filled the page', async () => {
    const noisy = Array.from({ length: 130 }, (_, i) => line(200 + i, `e${i}`)).join('\n')
    fakeLogs(`case " $* " in
*" --tail "*) ;;
*" --until "*) ${err(`${noisy}\n`)}; ${out(`${line(100, 'first')}\n`)};;
*) ${err(`${noisy}\n`)}; sleep 5;;
esac`)
    const r = await contextLogs({}, { ...input, ts: ts(100) })
    assert.equal(r.lines[0], line(100, 'first'))
    assert.equal(r.lines[1], line(200, 'e0'))
    assert.equal(r.lines.length, 101)
  })
})

describe('context when the bounded second read goes wrong', () => {
  const noisy = Array.from({ length: 130 }, (_, i) => line(200 + i, `e${i}`)).join('\n')
  // The first read fills the page from stderr alone; `again` is what the --since/--until read does.
  const reread = (again) => fakeLogs(`case " $* " in
*" --tail "*) ;;
*" --until "*) ${again};;
*) ${err(`${noisy}\n`)}; sleep 5;;
esac`)
  const context = () => contextLogs({}, { ...input, ts: ts(100) })
  const degraded = (r) => {
    assert.equal(r.ok, true)
    assert.deepEqual([r.lines.length, r.lines[0]], [101, line(200, 'e0')])
    assert.match(r.message, /incomplete/i)
    assert.doesNotMatch(r.message, /secret/)
  }

  test('reads a window far larger than any buffer, keeping only the page', async () => {
    const big = join(base, 'big')
    writeFileSync(big, Array.from({ length: 120 }, (_, i) => `${line(100 + i, 'x'.repeat(200000))}\n`).join(''))
    reread(`/bin/cat '${big}'`)
    const r = await context()
    assert.deepEqual([r.ok, r.message, r.lines.length], [true, undefined, 101])
    assert.equal(r.lines[0], line(100, 'x'.repeat(200000)))
  })

  test('falls back to the lines already read on a non-zero exit', async () => {
    reread(`${err(`${line(100, 'secret')}\n`)}; exit 1`)
    degraded(await context())
  })

  test('falls back to the lines already read on a timeout', async () => {
    const started = join(base, 'started')
    reread(`: > '${started}'; sleep 5`)
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const answer = context()
      while (!existsSync(started)) await new Promise((resolve) => setImmediate(resolve))
      mock.timers.tick(25000)
      degraded(await answer)
    } finally { mock.timers.reset() }
  })
})

describe('context limits', () => {
  const waitFor = async (file) => { while (!existsSync(file)) await new Promise((resolve) => setImmediate(resolve)) }

  test('says it may be incomplete when the first --since read fails', async () => {
    fakeLogs(`case " $* " in
*" --tail "*) ;;
*) ${out(`${line(100, 'only')}\n`)}; exit 1;;
esac`)
    const r = await contextLogs({}, { ...input, ts: ts(100) })
    assert.deepEqual([r.ok, r.lines], [true, [line(100, 'only')]])
    assert.match(r.message, /incomplete/i)
  })

  test('has one 25 s deadline for all its reads', async () => {
    const [before, go, again] = ['before', 'go', 'again'].map((name) => join(base, `deadline-${name}`))
    const noisy = Array.from({ length: 130 }, (_, i) => line(200 + i, `e${i}`)).join('\n')
    fakeLogs(`case " $* " in
*" --tail "*) : > '${before}'; while [ ! -e '${go}' ]; do sleep 0.01; done;;
*" --until "*) : > '${again}'; sleep 5;;
*) ${err(`${noisy}\n`)}; sleep 5;;
esac`)
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    try {
      const answer = contextLogs({}, { ...input, ts: ts(100) })
      await waitFor(before)
      mock.timers.tick(20000) // the "before" read took this long
      writeFileSync(go, '')
      await waitFor(again)
      mock.timers.tick(5000)
      const r = await answer
      assert.deepEqual([r.ok, r.lines.length], [true, 101])
      assert.match(r.message, /incomplete/i)
    } finally { mock.timers.reset() }
  })
})

describe('docker failures', () => {
  test('never put log content in the error message', async () => {
    fakeLogs(`${err(`${line(1, 'secret')}\n`)}; exit 1`)
    for (const r of [await olderLogs({}, { ...input, until: ts(9) }), await contextLogs({}, { ...input, ts: ts(1) })]) {
      assert.equal(r.ok, false)
      assert.match(r.message, /docker logs failed/)
      assert.doesNotMatch(r.message, /secret/)
    }
  })
})

describe('mergeByTs', () => {
  test('merges by nanoseconds, keeps continuation lines with their parent, stdout first on ties', () => {
    const a = '2024-05-01T10:00:00.000000002Z'
    const b = '2024-05-01T10:00:00.00000001Z'
    assert.deepEqual(mergeByTs([['orphan', `${b} out`], [`${a} err`, '  at x', `${b} tie`]]),
      ['orphan', `${a} err`, '  at x', `${b} out`, `${b} tie`])
  })
})

describe('createMerger', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'] }))
  afterEach(() => mock.timers.reset())

  const make = (options) => {
    const got = []
    const merger = createMerger((t) => got.push(t), { holdMs: 100, maxChars: 1000, ...options })
    return { got, merger, a: merger.stream(), b: merger.stream() }
  }

  test('holds a line for one window only, also under a steady flow', () => {
    const { got, a, b } = make()
    b.write(`${line(5, 'late')}\n`)
    mock.timers.tick(60)
    a.write(`${line(1, 'early')}\n${line(9, 'newest')}\n`)
    mock.timers.tick(39)
    assert.deepEqual(got, [])
    mock.timers.tick(1)
    assert.deepEqual(got, [`${line(1, 'early')}\n${line(5, 'late')}\n`])
    mock.timers.tick(60)
    assert.equal(got[1], `${line(9, 'newest')}\n`)
  })

  test('keeps unstamped lines behind their parent, across windows too', () => {
    const { got, a, b } = make()
    a.write(`${line(5, 'x')}\n  more\n`)
    b.write(`${line(7, 'y')}\n`)
    mock.timers.tick(100)
    a.write('  tail\n')
    mock.timers.tick(100)
    assert.deepEqual(got, [`${line(5, 'x')}\n  more\n${line(7, 'y')}\n`, '  tail\n'])
  })

  test('flushes early rather than buffering without bound', () => {
    const { got, a } = make({ maxChars: 80 })
    a.write(`${line(1, 'a'.repeat(100))}\n`)
    assert.equal(got.length, 1)
    a.write('z'.repeat(100)) // no newline in sight
    assert.equal(got[1], 'z'.repeat(100))
  })

  test('shows unterminated text after one window, then follows it as it arrives', () => {
    const { got, a } = make()
    a.write('10%')
    mock.timers.tick(50)
    a.write('\r20%') // more output does not restart the wait
    mock.timers.tick(49)
    assert.deepEqual(got, [])
    mock.timers.tick(1)
    a.write('\r30%')
    a.write(' ok\nnext')
    mock.timers.tick(100)
    assert.deepEqual(got, ['10%\r20%', '\r30%', ' ok\n', 'next'])
  })

  test('breaks an unterminated line before output of the other pipe, without leaving blank lines', () => {
    const { got, a, b } = make()
    a.write(line(1, 'prompt> '))
    mock.timers.tick(100)
    b.write(`${line(2, 'other')}\n`)
    mock.timers.tick(100)
    a.write('\n')
    a.write(`${line(3, 'after')}\n`)
    mock.timers.tick(100)
    assert.equal(got.join(''), `${line(1, 'prompt> ')}\n${line(2, 'other')}\n${line(3, 'after')}\n`)
  })

  test('leaves no blank line when the CRLF ending a broken line is split across chunks', () => {
    const { got, a, b } = make()
    a.write(line(1, 'prompt> '))
    mock.timers.tick(100)
    b.write(`${line(2, 'other')}\n`)
    mock.timers.tick(100)
    a.write('\r')
    mock.timers.tick(100)
    a.write('\n')
    a.write(`${line(3, 'after')}\n`)
    mock.timers.tick(100)
    assert.equal(got.join(''), `${line(1, 'prompt> ')}\n${line(2, 'other')}\n${line(3, 'after')}\n`)
  })

  test('sends earlier lines of the other pipe before an unterminated one', () => {
    const { got, a, b } = make()
    a.write(line(5, 'partial'))
    mock.timers.tick(60)
    b.write(`${line(1, 'earlier')}\n`)
    mock.timers.tick(40)
    assert.equal(got.join(''), `${line(1, 'earlier')}\n${line(5, 'partial')}`)
  })

  test('keeps the start of a huge unterminated line through the chunker', () => {
    let text = ''
    const chunker = createChunker((t) => { text += t })
    const pipe = createMerger((t) => chunker.push(t)).stream()
    const pieces = ['START'.padEnd(65536, 'a'), ...Array.from({ length: 15 }, () => 'b'.repeat(65536))]
    for (const piece of pieces) pipe.write(piece)
    chunker.drain()
    assert.equal(text.length, pieces.join('').length)
    assert.ok(text.startsWith('START'))
  })

  test('end() sends what is left, partial lines included; stop() sends nothing', () => {
    const one = make()
    one.a.write(`${line(2, 'cut')}`)
    one.b.write(`${line(1, 'b')}\n`)
    one.merger.end()
    assert.deepEqual(one.got, [`${line(1, 'b')}\n${line(2, 'cut')}\n`])
    const two = make()
    two.a.write(`${line(1, 'a')}\n`)
    two.merger.stop()
    mock.timers.tick(500)
    assert.deepEqual(two.got, [])
  })
})
