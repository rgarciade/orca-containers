// The log viewer of the panel's inline script (full panel, height, terminal), on a stand-in DOM with
// working classes, focus, events and timers. No browser is involved, so layout itself is not checked.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8')
const script = html.match(/<script>([\s\S]*)<\/script>/)[1]
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)) }
const ID = '0123456789ab'
const SCOPE = { kind: 'worktree', path: '/w' }

async function boot(handlers = {}) {
  const listeners = {}
  const calls = []
  const elements = new Map()
  const timers = new Map()
  let timerId = 0
  const document = { hidden: false, querySelector: () => null, querySelectorAll: () => [], addEventListener: (type, fn) => (listeners[type] ||= []).push(fn) }
  const element = (id = '') => {
    const classes = new Set()
    const el = {
      id, innerHTML: '', textContent: '', value: '', hidden: false, disabled: false, dataset: {}, style: {}, attributes: {},
      scrollTop: 0, scrollHeight: 0, clientHeight: 0, offsetHeight: 0,
      classList: {
        add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
        toggle: (c, on = !classes.has(c)) => (on ? classes.add(c) : classes.delete(c))
      },
      closest: () => null, contains: (other) => other === el, querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, setAttribute: (k, v) => { el.attributes[k] = String(v) }, appendChild() {}, append() {}, prepend() {},
      focus: () => { document.activeElement = el }
    }
    return el
  }
  const $ = (id) => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id) }
  const body = element()
  Object.assign(document, { body, activeElement: body, getElementById: $, createElement: () => element() })
  const answers = {
    'colima.state': () => ({ engineName: 'colima', worktree: '/w', containers: [{ id: ID, name: 'web-1', state: 'running', status: '', ports: '' }], stacks: [], error: null }),
    'colima.logs.follow': () => ({ ok: true }),
    ...handlers
  }
  const host = {
    call: async (method, params) => {
      if (method !== 'plugin.request') return {}
      calls.push({ name: params.name, input: params.input })
      return { output: await (answers[params.name] ?? (() => ({})))(params.input) }
    }
  }
  const window = { scrollY: 0, scrolledTo: null, scrollTo: (_x, y) => { window.scrolledTo = y }, orca: { host, plugin: { on() {} }, on() {} }, addEventListener() {} }
  const context = createContext({
    window, document, setInterval: () => 0, clearInterval() {},
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId },
    clearTimeout: (id) => { timers.delete(id) }
  })
  runInContext(script, context)
  await settle()
  const run = async (code) => { const out = runInContext(code, context); await settle(); return out }
  const emit = async (type, target, extra = {}) => {
    const event = { type, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, ...extra }
    for (const fn of listeners[type] ?? []) fn(event)
    await settle()
    return event
  }
  const click = (id) => emit('click', $(id))
  const key = (name, target = body) => emit('keydown', target, { key: name })
  // Runs the pending timers of one delay.
  const fire = async (ms) => {
    for (const [id, t] of [...timers]) if (t.ms === ms) { timers.delete(id); t.fn() }
    await settle()
  }
  const sent = (name) => calls.filter((c) => c.name === name).map((c) => ({ ...c.input }))
  const open = () => run(`openLogs('${ID}')`)
  return { $, window, document, body, run, emit, click, key, fire, sent, open }
}

const expanded = (p) => p.body.classList.contains('logs-max')
const box = (p, scrollTop) => Object.assign(p.$('logs'), { scrollHeight: 1000, clientHeight: 200, scrollTop })

describe('full-panel log viewer', () => {
  const opened = async () => {
    const p = await boot()
    await p.open()
    return p
  }

  test('Expand and Collapse toggle it, keeping the follower and the focus', async () => {
    const p = await opened()
    p.window.scrollY = 300
    await p.click('logs-expand')
    assert.ok(expanded(p))
    assert.equal(p.$('logs-expand').textContent, 'Collapse')
    assert.equal(p.document.activeElement, p.$('logs-expand'))
    await p.click('logs-expand')
    assert.ok(!expanded(p))
    assert.equal(p.$('logs-expand').textContent, 'Expand')
    assert.equal(p.window.scrolledTo, 300)
    assert.equal(p.sent('colima.logs.follow').length, 1)
    assert.equal(p.sent('colima.logs.stop').length, 0)
  })

  test('Escape collapses and focuses the button', async () => {
    const p = await opened()
    await p.click('logs-expand')
    p.document.activeElement = p.body
    await p.key('Escape')
    assert.ok(!expanded(p))
    assert.equal(p.document.activeElement, p.$('logs-expand'))
  })

  test('Escape in the search box clears the query first, then collapses', async () => {
    const p = await opened()
    await p.click('logs-expand')
    await p.click('logs-mode')
    assert.ok(expanded(p), 'history keeps it expanded')
    p.$('logs-q').value = 'boom'
    await p.key('Escape', p.$('logs-q'))
    assert.equal(p.$('logs-q').value, '')
    assert.ok(expanded(p))
    await p.key('Escape', p.$('logs-q'))
    assert.ok(!expanded(p))
  })

  test('never stays expanded after close, view, workspace or engine changes', async () => {
    for (const leave of ['closeLogs()', "setView('all')", 'resetForWorkspaceSwitch()', "switchEngine('orbstack')", "openScope({ open: 'worktree', v: '/w' })"]) {
      const p = await opened()
      await p.click('logs-expand')
      await p.run(leave)
      assert.ok(!expanded(p), leave)
      assert.equal(p.$('logs-expand').textContent, 'Expand', leave)
    }
  })

  test('keeps following the tail, or else the same position', async () => {
    const p = await opened()
    const pre = box(p, 800)
    await p.click('logs-expand')
    assert.equal(pre.scrollTop, 1000)
    pre.scrollTop = 800
    await p.click('logs-expand')
    assert.equal(pre.scrollTop, 1000)
    pre.scrollTop = 100
    await p.click('logs-expand')
    assert.equal(pre.scrollTop, 100)
    pre.scrollTop = 60 // scrolled while expanded: that is the position kept
    await p.click('logs-expand')
    assert.equal(pre.scrollTop, 60)
  })

  test('restores a position the taller box could not hold', async () => {
    const p = await opened()
    // A box that clamps like a browser: 200px tall, or 700px when expanded.
    let top = 0
    const pre = Object.assign(p.$('logs'), { scrollHeight: 1000 })
    Object.defineProperty(pre, 'clientHeight', { get: () => (expanded(p) ? 700 : 200) })
    Object.defineProperty(pre, 'scrollTop', { get: () => Math.min(top, 1000 - pre.clientHeight), set: (v) => { top = Math.min(v, 1000 - pre.clientHeight) } })
    pre.scrollTop = 600
    await p.click('logs-expand')
    assert.equal(pre.scrollTop, 300)
    await p.click('logs-expand')
    assert.equal(pre.scrollTop, 600)
  })
})

describe('log height', () => {
  const heights = (p) => p.sent('colima.logs.height').filter((i) => 'height' in i).map((i) => i.height)
  const saved = (height) => ({ 'colima.logs.height': (input) => ('height' in input ? { height: input.height } : { height }) })

  test('applies the saved height, except while expanded', async () => {
    const p = await boot(saved(300))
    const style = p.$('logs').style
    assert.deepEqual([style.height, style.maxHeight], ['300px', 'none'])
    await p.open()
    await p.click('logs-expand')
    assert.deepEqual([style.height, style.maxHeight], ['', ''])
    await p.click('logs-expand')
    assert.equal(style.height, '300px')
  })

  test('resizes with the keyboard, saving once, and Enter returns to automatic', async () => {
    const p = await boot(saved(null))
    await p.open()
    const handle = p.$('logs-resize')
    p.$('logs').offsetHeight = 200
    assert.ok((await p.key('ArrowDown', handle)).defaultPrevented)
    await p.key('ArrowDown', handle)
    assert.equal(p.$('logs').style.height, '280px')
    assert.equal(handle.attributes['aria-valuenow'], '280')
    await p.key('ArrowUp', handle)
    await p.fire(400)
    assert.deepEqual(heights(p), [240])
    await p.key('Home', handle)
    await p.key('ArrowUp', handle)
    assert.equal(p.$('logs').style.height, '120px')
    await p.key('Enter', handle)
    await p.fire(400)
    assert.equal(p.$('logs').style.height, '')
    assert.deepEqual(heights(p), [240, null])
  })

  test('drags taller, keeps following the tail and saves on release', async () => {
    const p = await boot(saved(null))
    await p.open()
    const pre = box(p, 800)
    pre.offsetHeight = 200
    await p.emit('pointerdown', p.$('logs-resize'), { button: 0, clientY: 500, pointerId: 1 })
    await p.emit('pointermove', p.body, { buttons: 1, clientY: 650 })
    assert.equal(pre.style.height, '350px')
    assert.equal(pre.scrollTop, 1000)
    assert.deepEqual(heights(p), [])
    await p.emit('pointerup', p.body)
    await p.fire(400)
    await p.emit('pointermove', p.body, { buttons: 1, clientY: 900 })
    assert.equal(pre.style.height, '350px')
    assert.deepEqual(heights(p), [350])
  })

  test('a late saved value does not override a height just chosen', async () => {
    let answer
    const p = await boot({ 'colima.logs.height': (input) => ('height' in input ? {} : new Promise((resolve) => { answer = resolve })) })
    p.$('logs').offsetHeight = 200
    await p.key('ArrowDown', p.$('logs-resize'))
    answer({ height: 900 })
    await settle()
    assert.equal(p.$('logs').style.height, '240px')
  })
})

describe('Open in terminal', () => {
  test('asks for the shown container, with the pinned scope, and reports the result', async () => {
    const p = await boot({ 'colima.logs.terminal': () => ({ ok: true }) })
    await p.open()
    await p.click('logs-terminal')
    assert.deepEqual(p.sent('colima.logs.terminal'), [{ id: ID }])
    assert.match(p.$('status').textContent, /terminal/i)
    assert.equal(p.$('logs-terminal').disabled, false)
    await p.run(`pinned = { scope: ${JSON.stringify(SCOPE)} }`)
    await p.click('logs-terminal')
    assert.equal(p.sent('colima.logs.terminal')[1].scope.path, '/w')
  })

  test('shows why it failed', async () => {
    const p = await boot({ 'colima.logs.terminal': () => ({ ok: false, message: 'Container is not in the shown scope.' }) })
    await p.open()
    await p.click('logs-terminal')
    assert.match(p.$('status').textContent, /not in the shown scope/)
  })
})
