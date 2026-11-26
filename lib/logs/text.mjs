// Log output handling without processes: batching, timestamps, line splitting and search.

const SEARCH_MAX_RESULTS = 1000
const LOG_FLUSH_MS = 300 // plugin post limit is 200 posts / 10s: stay far below it
const LOG_CHUNK_CHARS = 64 * 1024 // post limit is 256 KiB
const LOG_PENDING_MAX = 1024 * 1024 // unsent output kept under a flood; the oldest is dropped

// Batches log output: at most one post per interval, each <= maxChars. `post(text)` does the sending.
// Under a flood the unsent backlog is capped at maxPending (oldest dropped).
export function createChunker(post, { intervalMs = LOG_FLUSH_MS, maxChars = LOG_CHUNK_CHARS, maxPending = LOG_PENDING_MAX } = {}) {
  let pending = ''
  let timer = null
  let stopped = false
  const flush = () => {
    timer = null
    if (stopped || !pending) return
    const text = pending.slice(0, maxChars)
    pending = pending.slice(text.length)
    try { post(text) } catch { /* the panel may be gone */ }
    if (pending) timer = setTimeout(flush, intervalMs)
  }
  return {
    push(text) {
      if (stopped || !text) return
      pending += text
      if (pending.length > maxPending) pending = pending.slice(-maxPending)
      if (!timer) timer = setTimeout(flush, intervalMs)
    },
    // Sends everything left right now (process exit), still respecting maxChars per post.
    drain() {
      clearTimeout(timer)
      timer = null
      while (!stopped && pending) {
        const text = pending.slice(0, maxChars)
        pending = pending.slice(text.length)
        try { post(text) } catch { /* the panel may be gone */ }
      }
    },
    stop() { stopped = true; clearTimeout(timer); timer = null; pending = '' }
  }
}

// ---- Log history paging ----
const RFC3339_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/
export const LINE_TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))(?: |$)/

export function isRfc3339(text) {
  if (typeof text !== 'string' || text.length > 40) return false
  const m = RFC3339_RE.exec(text)
  return Boolean(m) && !Number.isNaN(Date.parse(`${m[1]}${m[3]}`))
}

// Compares two RFC3339 timestamps with nanosecond precision: negative, 0 or positive.
export function compareTs(a, b) {
  const parse = (t) => {
    const m = RFC3339_RE.exec(t)
    return { sec: Date.parse(`${m[1]}${m[3]}`), ns: (m[2] ?? '').padEnd(9, '0') }
  }
  const x = parse(a)
  const y = parse(b)
  if (x.sec !== y.sec) return x.sec - y.sec
  return x.ns < y.ns ? -1 : x.ns > y.ns ? 1 : 0
}

// Keeps only the lines strictly older than `until`; continuation lines follow their parent line.
export function filterOlder(lines, until) {
  const out = []
  let keep = true
  for (const line of lines) {
    const m = LINE_TS_RE.exec(line)
    if (m) keep = compareTs(m[1], until) < 0
    if (keep) out.push(line)
  }
  return out
}

// Lines strictly older than `until`, plus the lines stamped exactly `until` that are NOT displayed yet.
// The panel shows the last `skip` entries of the boundary timestamp, so those are dropped from the end of
// the group. Continuation lines (no timestamp) stay attached to their parent entry.
export function selectOlder(lines, until, skip = 0) {
  const entries = []
  for (const line of lines) {
    const m = LINE_TS_RE.exec(line)
    if (m || !entries.length) entries.push({ cmp: m ? compareTs(m[1], until) : -1, lines: [line] })
    else entries[entries.length - 1].lines.push(line)
  }
  const boundary = entries.filter((e) => e.cmp === 0)
  const shown = new Set(boundary.slice(Math.max(boundary.length - skip, 0)))
  return entries.filter((e) => e.cmp < 0 || (e.cmp === 0 && !shown.has(e))).flatMap((e) => e.lines)
}

// ---- Log search and context ----
// Splits a stream into lines (one splitter per stream, so partial lines never mix).
export function lineSplitter(onLine) {
  let rest = ''
  return {
    write(text) {
      const parts = (rest + text).split('\n')
      rest = parts.pop()
      for (const line of parts) onLine(line.replace(/\r$/, ''))
    },
    end() { if (rest) onLine(rest.replace(/\r$/, '')); rest = '' }
  }
}

// Plain-text line test (no regex). Case-insensitive unless asked otherwise.
export function lineMatcher(query, caseSensitive = false) {
  const needle = caseSensitive ? query : query.toLowerCase()
  return (text) => (caseSensitive ? text : text.toLowerCase()).includes(needle)
}

// Streaming collector: counts every match but keeps only the last `max` (ring buffer).
// The timestamp prefix is not searched, only the message.
export function createSearchCollector(query, caseSensitive = false, max = SEARCH_MAX_RESULTS) {
  const test = lineMatcher(query, caseSensitive)
  const ring = []
  let head = 0
  let total = 0
  return {
    push(line) {
      const m = LINE_TS_RE.exec(line)
      if (!test(m ? line.slice(m[0].length) : line)) return
      total++
      if (ring.length < max) ring.push(line)
      else { ring[head] = line; head = (head + 1) % max }
    },
    result() {
      let lines = ring.slice(head).concat(ring.slice(0, head))
      // stdout and stderr arrive separately: restore chronological order when every line is stamped.
      const stamped = lines.map((line, i) => ({ line, i, ts: LINE_TS_RE.exec(line)?.[1] ?? null }))
      if (stamped.every((l) => l.ts)) lines = stamped.sort((a, b) => compareTs(a.ts, b.ts) || a.i - b.i).map((l) => l.line)
      return { lines, total, truncated: total > lines.length }
    }
  }
}
