// `docker logs` replays stdout and stderr on separate pipes: this puts them back in timestamp order.
// A line without a timestamp stays with the previous line of its own pipe.
import { compareTs, LINE_TS_RE } from './text.mjs'

const LOG_HOLD_MS = 150 // how long a live line waits for an earlier one from the other pipe
const LOG_HOLD_CHARS = 64 * 1024 // more than this is never held back; far below the chunker's drop limit

const stampOf = (line) => LINE_TS_RE.exec(line)?.[1] ?? null
const compareStamps = (a, b) => (a === null || b === null ? (a !== null) - (b !== null) : compareTs(a, b))
// Equal instants: the earlier pipe (stdout) first, then arrival, so live view and history pages agree.
const compareEntries = (a, b) => compareStamps(a.ts, b.ts) || a.src - b.src || a.seq - b.seq

// Whole outputs, one list of lines per pipe, as one chronological list.
export function mergeByTs(streams) {
  const entries = []
  streams.forEach((lines, src) => {
    let last = null
    for (const line of lines) {
      const ts = stampOf(line)
      if (ts === null && last) last.lines.push(line)
      else {
        const entry = { ts, src, seq: entries.length, lines: [line] }
        entries.push(entry)
        if (ts !== null) last = entry
      }
    }
  })
  return entries.sort(compareEntries).flatMap((e) => e.lines)
}

// Live version. Call stream() once per pipe (stdout first) and write() its chunks; `emit(text)` receives
// the output. A line is held at most holdMs; every held line not later than it goes out with it.
// Text without a newline (prompts, CR progress) goes out after the same wait and stays "open": what its pipe
// writes next is appended at once, until output of the other pipe breaks the line.
export function createMerger(emit, { holdMs = LOG_HOLD_MS, maxChars = LOG_HOLD_CHARS } = {}) {
  const pipes = []
  let pending = []
  let chars = 0
  let seq = 0
  let open = null // pipe whose unfinished line is the last thing sent
  let timer = null

  // Sends text of one pipe, or of whole lines (src null), ending another pipe's open line first.
  const send = (text, src = null) => {
    let head = ''
    if (open !== null && open !== src) {
      head = '\n'
      pipes[open].broken = true
      open = null
    }
    emit(head + text)
  }
  const release = (due) => {
    const out = pending.filter(due).sort(compareEntries)
    if (!out.length) return
    pending = pending.filter((e) => !due(e))
    const text = out.map((e) => `${e.line}\n`).join('')
    chars -= text.length
    send(text)
  }
  const add = (pipe, raw) => {
    const line = raw.replace(/\r$/, '')
    pipe.ts = stampOf(line) ?? pipe.ts
    pending.push({ ts: pipe.ts, src: pipe.src, seq: seq++, at: Date.now(), line })
    chars += line.length + 1
  }
  const sendPartial = (pipe) => {
    pipe.ts = stampOf(pipe.rest) ?? pipe.ts
    release((e) => e.src === pipe.src || compareStamps(e.ts, pipe.ts) <= 0)
    send(pipe.rest, pipe.src)
    open = pipe.src
    pipe.rest = ''
    pipe.broken = false
  }
  const schedule = () => {
    const since = [...pending.map((e) => e.at), ...pipes.filter((p) => p.rest).map((p) => p.restAt)]
    if (timer || !since.length) return
    timer = setTimeout(() => {
      timer = null
      const now = Date.now()
      const aged = pending.filter((e) => now - e.at >= holdMs)
      if (aged.length) {
        const cutoff = aged.reduce((a, b) => (compareStamps(a.ts, b.ts) >= 0 ? a : b)).ts
        release((e) => compareStamps(e.ts, cutoff) <= 0)
      }
      for (const pipe of pipes) if (pipe.rest && now - pipe.restAt >= holdMs) sendPartial(pipe)
      schedule()
    }, Math.max(Math.min(...since) + holdMs - Date.now(), 0))
  }
  const write = (pipe, chunk) => {
    let text = chunk
    if (open === pipe.src) {
      const end = text.indexOf('\n') + 1
      send(end ? text.slice(0, end) : text, pipe.src)
      if (!end) return
      open = null
      text = text.slice(end)
    } else if (pipe.broken && text) {
      text = text.replace(/^\r?\n/, '') // the line was already ended for it
      if (text === '\r') text = '' // maybe half of a CRLF: still waiting for the rest
      else pipe.broken = false
    }
    const waiting = pipe.rest !== ''
    const parts = (pipe.rest + text).split('\n')
    pipe.rest = parts.pop()
    for (const line of parts) add(pipe, line)
    if (!waiting || parts.length) pipe.restAt = Date.now()
    if (pipe.rest.length >= maxChars) sendPartial(pipe)
    if (chars >= maxChars) release(() => true)
    schedule()
  }
  const halt = () => {
    clearTimeout(timer)
    timer = null
  }

  return {
    stream() {
      const pipe = { src: pipes.length, rest: '', restAt: 0, ts: null, broken: false }
      pipes.push(pipe)
      return { write: (text) => write(pipe, text) }
    },
    // The process is gone: sends everything, unfinished lines included.
    end() {
      halt()
      for (const pipe of pipes) {
        if (pipe.rest) add(pipe, pipe.rest)
        pipe.rest = ''
      }
      release(() => true)
    },
    stop() {
      halt()
      pending = []
      chars = 0
      for (const pipe of pipes) pipe.rest = ''
    }
  }
}
