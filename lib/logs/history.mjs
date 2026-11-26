// Older log pages and the context around a timestamp.
import { execFile } from 'node:child_process'
import { dockerArgs } from '../docker.mjs'
import { CHILD_ENV, DOCKER } from '../exec.mjs'
import { NOT_OWNED, ownedContainer } from '../scope.mjs'
import { spawnDocker, stopDocker } from './process.mjs'
import { compareTs, filterOlder, isRfc3339, LINE_TS_RE, lineSplitter, selectOlder } from './text.mjs'

const LOG_OLDER_LINES = 500
const CONTEXT_LINES = 100
const CONTEXT_TIMEOUT_MS = 20000

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
    if (res.error) return { ok: false, message: (res.stderr || String(res.error)).slice(0, 300) }
    // The container's stdout and stderr arrive separately: merge them back by timestamp.
    const raw = [res.stdout, res.stderr].flatMap((s) => s.split('\n').filter((l) => l !== ''))
    const stamped = raw.map((line, i) => ({ line, i, ts: LINE_TS_RE.exec(line)?.[1] ?? null }))
    const sorted = stamped.every((l) => l.ts) && res.stderr
      ? stamped.sort((a, b) => compareTs(a.ts, b.ts) || a.i - b.i).map((l) => l.line)
      : raw
    const lines = selectOlder(sorted, until, skip)
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
  const { target } = await ownedContainer(orca, String(input?.id ?? ''), input?.scope)
  if (!target) return NOT_OWNED
  const before = await new Promise((resolve) => {
    execFile(DOCKER, dockerArgs(['logs', '--timestamps', '--until', ts, '--tail', String(CONTEXT_LINES + 10), target.id]),
      { cwd: '/', env: CHILD_ENV, maxBuffer: 16 * 1024 * 1024, timeout: CONTEXT_TIMEOUT_MS },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }))
  })
  if (before.error) return { ok: false, message: (before.stderr || String(before.error)).slice(0, 300) }
  // --until is inclusive: lines stamped exactly ts come back here, so the strict filter drops them; they are
  // returned once, by the --since read below (which keeps everything >= ts), so the clicked line is never doubled.
  const older = filterOlder(sortByTs([before.stdout, before.stderr]), ts).slice(-CONTEXT_LINES)
  // --since is read a second early so the clicked line is never lost to boundary rules, then trimmed exactly.
  const sinceMs = Date.parse(ts.replace(/\.\d+/, '')) - 1000
  const after = await collectFrom(target.id, new Date(sinceMs).toISOString(), ts, CONTEXT_LINES + 1)
  if (after.error) return { ok: false, message: after.error }
  return { ok: true, lines: [...older, ...after.lines] }
}

// Merges stdout/stderr text blocks back into one chronological list (input order when unstamped).
function sortByTs(blocks) {
  const raw = blocks.flatMap((s) => s.split('\n').filter((l) => l !== ''))
  const stamped = raw.map((line, i) => ({ line, i, ts: LINE_TS_RE.exec(line)?.[1] ?? null }))
  return stamped.every((l) => l.ts) ? stamped.sort((a, b) => compareTs(a.ts, b.ts) || a.i - b.i).map((l) => l.line) : raw
}

// Reads `docker logs --since` and keeps the first `limit` lines at or after `from`, then stops the process.
function collectFrom(id, since, from, limit) {
  return new Promise((resolve) => {
    const proc = spawnDocker(['logs', '--timestamps', '--since', since, id])
    const lines = []
    let keep = false
    let done = false
    const finish = (error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      stopDocker(proc)
      resolve(error ? { error } : { lines: sortByTs([lines.join('\n')]).slice(0, limit) })
    }
    const timer = setTimeout(() => finish('Context request timed out.'), CONTEXT_TIMEOUT_MS)
    const onLine = (line) => {
      if (done) return
      const m = LINE_TS_RE.exec(line)
      if (m) keep = compareTs(m[1], from) >= 0
      if (!keep) return
      lines.push(line)
      if (lines.length >= limit + 10) finish(null)
    }
    const splitters = [proc.stdout, proc.stderr].map((stream) => {
      const splitter = lineSplitter(onLine)
      stream.setEncoding('utf8')
      stream.on('data', (d) => splitter.write(d))
      return splitter
    })
    proc.on('error', (err) => finish(String(err.message ?? err).slice(0, 300)))
    proc.on('close', () => { for (const s of splitters) s.end(); finish(null) })
  })
}
