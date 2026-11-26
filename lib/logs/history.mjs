// Older log pages and the context around a timestamp.
import { execFile } from 'node:child_process'
import { dockerArgs } from '../docker.mjs'
import { CHILD_ENV, DOCKER } from '../exec.mjs'
import { NOT_OWNED, ownedContainer } from '../scope.mjs'
import { mergeByTs } from './merge.mjs'
import { spawnDocker, stopDocker } from './process.mjs'
import { compareTs, filterOlder, isRfc3339, LINE_TS_RE, lineSplitter, selectOlder } from './text.mjs'

const LOG_OLDER_LINES = 500
const CONTEXT_LINES = 100
const CONTEXT_TIMEOUT_MS = 25000 // for the whole context request: the panel gives up at 30 s
const CONTEXT_PARTIAL = 'Context may be incomplete: the logs could not be read again in full.'

// On failure docker's stderr carries container log lines, and the execFile error repeats them: use neither.
const dockerFailed = (error) => `docker logs failed (${error.killed ? 'timed out' : `exit ${error.code}`}).`

// Verified against Docker (Colima, nanosecond timestamps): `docker logs --until T` is INCLUSIVE of a line
// stamped exactly T (until=T-1ns drops it, until=T keeps it). Paging therefore requests until = the first
// displayed timestamp and removes the boundary lines the panel already shows (`skip`), so lines sharing
// that timestamp are never lost.
const LOG_OLDER_MAX_TAIL = 20000
const LOG_OLDER_MAX_SKIP = 5000

export async function olderLogs(orca, input) {
  const until = String(input?.until ?? '')
  if (!isRfc3339(until)) return { ok: false, message: 'Invalid timestamp.' }
  const skip = input?.skip ?? 0
  if (!Number.isInteger(skip) || skip < 0 || skip > LOG_OLDER_MAX_SKIP) return { ok: false, message: 'Invalid skip count.' }
  const { target } = await ownedContainer(orca, String(input?.id ?? ''), input?.scope)
  if (!target) return NOT_OWNED
  // Ask for enough extra lines to cover the already displayed boundary lines; if a page still yields
  // nothing new (a huge run of identical timestamps), grow the tail instead of looping on the same page.
  let tail = LOG_OLDER_LINES + skip
  for (;;) {
    const res = await new Promise((resolve) => {
      execFile(DOCKER, dockerArgs(['logs', '--timestamps', '--until', until, '--tail', String(tail), target.id]),
        { cwd: '/', env: CHILD_ENV, maxBuffer: 64 * 1024 * 1024, timeout: 20000 },
        (error, stdout, stderr) => resolve({ error, stdout, stderr }))
    })
    if (res.error) return { ok: false, message: dockerFailed(res.error) }
    // The container's stdout and stderr arrive separately: merge them back by timestamp.
    const streams = [res.stdout, res.stderr].map(toLines)
    const raw = mergeByTs(streams)
    const lines = selectOlder(raw, until, skip)
    const exhausted = raw.length < tail
    if (lines.length || exhausted) return { ok: true, text: lines.length ? `${lines.join('\n')}\n` : '', done: exhausted }
    if (tail >= LOG_OLDER_MAX_TAIL) {
      return { ok: true, text: '', done: true, message: 'Too many log lines share one timestamp; older history is unreachable from here.' }
    }
    tail = Math.min(tail * 2, LOG_OLDER_MAX_TAIL)
  }
}

// ~CONTEXT_LINES lines before and after a timestamp, plus the line itself.
export async function contextLogs(orca, input) {
  const ts = String(input?.ts ?? '')
  if (!isRfc3339(ts)) return { ok: false, message: 'Invalid timestamp.' }
  const deadline = Date.now() + CONTEXT_TIMEOUT_MS
  const remaining = () => Math.max(deadline - Date.now(), 1) // 0 would mean "no timeout" to execFile
  const { target } = await ownedContainer(orca, String(input?.id ?? ''), input?.scope)
  if (!target) return NOT_OWNED
  const before = await new Promise((resolve) => {
    execFile(DOCKER, dockerArgs(['logs', '--timestamps', '--until', ts, '--tail', String(CONTEXT_LINES + 10), target.id]),
      { cwd: '/', env: CHILD_ENV, maxBuffer: 16 * 1024 * 1024, timeout: remaining() },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }))
  })
  if (before.error) return { ok: false, message: dockerFailed(before.error) }
  // --until is inclusive: lines stamped exactly ts come back here, so the strict filter drops them; they are
  // returned once, by the --since read below (which keeps everything >= ts), so the clicked line is never doubled.
  const older = filterOlder(mergeByTs([before.stdout, before.stderr].map(toLines)), ts).slice(-CONTEXT_LINES)
  // --since is read a second early so the clicked line is never lost to boundary rules, then trimmed exactly.
  const sinceMs = Date.parse(ts.replace(/\.\d+/, '')) - 1000
  const after = await collectFrom(target.id, new Date(sinceMs).toISOString(), ts, CONTEXT_LINES + 1, remaining())
  if (after.error) return { ok: false, message: after.error }
  return { ok: true, lines: [...older, ...after.lines], message: after.message }
}

const toLines = (text) => text.split('\n').filter((l) => l !== '')

// The first `limit` lines at or after `from`. One pipe can be far ahead of the other, so when one fills up
// its last timestamp bounds a second read, which has both pipes complete up to there. Both reads stream and
// keep a bounded number of lines; if the second one fails, the lines of the first are returned with a notice.
function collectFrom(id, since, from, limit, timeoutMs) {
  return new Promise((resolve) => {
    let proc = null // the read in progress
    let fallback = null // set once the first read filled a page
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      stopDocker(proc)
      resolve(result)
    }
    const fail = (error) => finish(fallback ? { lines: fallback, message: CONTEXT_PARTIAL } : { error })
    const timer = setTimeout(() => fail('Context request timed out.'), timeoutMs)
    const page = (streams) => mergeByTs(streams).slice(0, limit)
    // Each pipe keeps its first `max` lines at or after `from`.
    const read = (range, max, onKept, onClose) => {
      const child = spawnDocker(['logs', '--timestamps', ...range, id])
      proc = child
      const current = () => !done && proc === child
      const streams = [[], []]
      const splitters = [child.stdout, child.stderr].map((stream, i) => {
        let keep = false
        let last = null
        const splitter = lineSplitter((line) => {
          if (!current() || streams[i].length >= max) return
          const m = LINE_TS_RE.exec(line)
          if (m) { last = m[1]; keep = compareTs(last, from) >= 0 }
          if (!keep) return
          streams[i].push(line)
          onKept(streams, i, last)
        })
        stream.setEncoding('utf8')
        stream.on('data', (d) => splitter.write(d))
        return splitter
      })
      child.on('error', (err) => { if (current()) fail(String(err.message ?? err).slice(0, 300)) })
      child.on('close', (code) => {
        if (!current()) return
        for (const s of splitters) s.end()
        if (current()) onClose(streams, code)
      })
    }
    const readBounded = (until) => read(['--since', since, '--until', until], limit,
      (streams) => { if (streams.every((lines) => lines.length >= limit)) finish({ lines: page(streams) }) },
      (streams, code) => (code === 0 ? finish({ lines: page(streams) }) : fail()))
    const full = limit + 10
    read(['--since', since], full,
      (streams, i, last) => {
        if (streams[i].length < full) return
        fallback = page(streams)
        stopDocker(proc)
        readBounded(last)
      },
      // Our own early kill switches `proc` first, so a non-zero code here is docker's.
      (streams, code) => finish({ lines: page(streams), message: code === 0 ? undefined : CONTEXT_PARTIAL }))
  })
}
