// The log viewers of the panel's inline script, on a stand-in DOM with a real tree, working classes, focus,
// events and timers. Like a browser, it resets scroll and focus when a node is detached or moved. No browser
// is involved, so layout itself is not checked.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8')
const script = html.match(/<script>([\s\S]*)<\/script>/)[1]
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)) }
const ID = '0123456789ab'
const [B, C, D] = ['bbbbbbbbbbbb', 'cccccccccccc', 'dddddddddddd']
const SCOPE = { kind: 'worktree', path: '/w' }

// ---- Stand-in DOM ----
function dom() {
  const document = { hidden: false, listeners: {}, revealed: [] }
  const matches = (el, selector) => {
    if (/\s/.test(selector)) return false
    const parts = selector.match(/:not\([^)]*\)|\[[^\]]*\]|[.#]?[\w-]+/g) ?? []
    return parts.every((p) => {
      if (p.startsWith(':not(')) return !matches(el, p.slice(5, -1))
      if (p[0] === '.') return el.classList.contains(p.slice(1))
      if (p[0] === '#') return el.id === p.slice(1)
      if (p[0] === '[') {
        const [, name, value] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(p)
        const actual = name.startsWith('data-') ? el.dataset[name.slice(5)] : el.attributes[name]
        return value === undefined ? actual !== undefined : actual === value
      }
      return el.tagName === p.toUpperCase()
    })
  }
  const walk = (el, out = []) => { for (const c of el.children) { out.push(c); walk(c, out) } return out }
  const reset = (el) => {
    if (document.activeElement === el) document.activeElement = document.body
    el.scrollTop = 0
    for (const c of el.childNodes) if (c.nodeType === 1) reset(c)
  }
  const detach = (node) => {
    const parent = node.parentNode
    if (!parent) return
    parent.childNodes.splice(parent.childNodes.indexOf(node), 1)
    node.parentNode = null
    if (node.nodeType === 1) reset(node)
  }
  const textNode = (text) => ({ nodeType: 3, textContent: String(text), parentNode: null })
  const element = (tag = 'div') => {
    const classes = new Set()
    let markup = ''
    const el = {
      nodeType: 1, tagName: tag.toUpperCase(), id: '', value: '', hidden: false, disabled: false, title: '', dataset: {}, style: {}, attributes: {},
      childNodes: [], parentNode: null, scrollTop: 0, scrollHeight: 0, clientHeight: 0, offsetHeight: 0, selectionStart: 0, selectionEnd: 0, attached: 0,
      classList: {
        add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
        toggle: (c, on = !classes.has(c)) => (on ? classes.add(c) : classes.delete(c))
      },
      get className() { return [...classes].join(' ') },
      set className(v) { classes.clear(); for (const c of String(v).split(' ').filter(Boolean)) classes.add(c) },
      get children() { return el.childNodes.filter((c) => c.nodeType === 1) },
      get firstChild() { return el.childNodes[0] ?? null },
      get firstElementChild() { return el.children[0] ?? null },
      get nextSibling() { return el.parentNode ? el.parentNode.childNodes[el.parentNode.childNodes.indexOf(el) + 1] ?? null : null },
      get textContent() { return markup || el.childNodes.map((c) => c.textContent).join('') },
      set textContent(v) { el.innerHTML = ''; if (v !== '') el.appendChild(textNode(v)) },
      get innerHTML() { return markup },
      set innerHTML(v) { for (const c of [...el.childNodes]) detach(c); markup = String(v) },
      insertBefore(node, ref) {
        if (node.fragment) { for (const c of [...node.childNodes]) el.insertBefore(c, ref); return node }
        detach(node)
        el.childNodes.splice(ref ? el.childNodes.indexOf(ref) : el.childNodes.length, 0, node)
        node.parentNode = el
        node.attached++
        return node
      },
      appendChild: (node) => el.insertBefore(node, null),
      append: (...nodes) => { for (const n of nodes) el.appendChild(typeof n === 'string' ? textNode(n) : n) },
      prepend: (...nodes) => { const first = el.firstChild; for (const n of nodes) el.insertBefore(n, first) },
      remove: () => detach(el),
      matches: (s) => matches(el, s),
      closest: (s) => { for (let n = el; n; n = n.parentNode) if (matches(n, s)) return n; return null },
      contains: (other) => { for (let n = other; n; n = n.parentNode) if (n === el) return true; return false },
      querySelectorAll: (s) => walk(el).filter((n) => matches(n, s)),
      querySelector: (s) => walk(el).find((n) => matches(n, s)) ?? null,
      addEventListener() {}, setAttribute: (k, v) => { el.attributes[k] = String(v) },
      focus: () => { document.activeElement = el },
      scrollIntoView: (options) => { document.revealed.push({ el, options: { ...options } }) }
    }
    return el
  }
  const body = element('body')
  const fixed = new Map()
  Object.assign(document, {
    body, activeElement: body,
    createElement: element,
    createTextNode: textNode,
    createDocumentFragment: () => Object.assign(element('fragment'), { fragment: true }),
    getElementById: (id) => {
      if (!fixed.has(id)) { const el = element(); el.id = id; body.appendChild(el); fixed.set(id, el) }
      return fixed.get(id)
    },
    querySelectorAll: (s) => body.querySelectorAll(s),
    querySelector: (s) => body.querySelector(s),
    addEventListener: (type, fn) => (document.listeners[type] ||= []).push(fn)
  })
  return document
}

const container = (id, over = {}) => ({ id, name: `web-${id.slice(0, 2)}`, state: 'running', status: 'Up', ports: '', ...over })
const stateOf = (containers) => ({ engineName: 'colima', worktree: '/w', containers, stacks: [], error: null })
const vmAnswer = (name = 'colima') => ({ engineName: name, engine: { name, label: name, kind: 'generic', missing: false }, engines: [], controls: {}, running: true, installed: true, prefs: { cpu: 4, memory: 8 }, limits: { maxCpu: 8, maxMemory: 16 } })

async function boot(handlers = {}, ids = [ID], workspace = {}) {
  const document = dom()
  const calls = []
  const pushed = {}
  const timers = new Map()
  let timerId = 0
  let list = ids.map((id) => container(id))
  const answers = {
    'colima.state': () => stateOf(list),
    'colima.vm': () => vmAnswer(),
    'colima.logs.follow': () => ({ ok: true }),
    ...handlers
  }
  const host = {
    call: async (method, params) => {
      if (method === 'workspace.readContext') return structuredClone(workspace)
      if (method !== 'plugin.request') return {}
      calls.push({ name: params.name, input: params.input })
      return { output: await (answers[params.name] ?? (() => ({})))(params.input) }
    }
  }
  const window = {
    scrollY: 0, scrolledTo: null, scrollTo: (_x, y) => { window.scrolledTo = y }, getSelection: () => '',
    orca: { host, plugin: { on: (name, fn) => { pushed[name] = fn } }, on() {} }, addEventListener() {}
  }
  const context = createContext({
    window, document, setInterval: () => 0, clearInterval() {},
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId },
    clearTimeout: (id) => { timers.delete(id) }
  })
  runInContext(script, context)
  await settle()
  const $ = document.getElementById
  const body = document.body
  const run = async (code) => { const out = runInContext(code, context); await settle(); return out }
  const emit = async (type, target, extra = {}) => {
    const event = { type, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, ...extra }
    for (const fn of document.listeners[type] ?? []) fn(event)
    await settle()
    return event
  }
  const push = async (name, data) => { pushed[name](data); await settle() }
  const card = (id = ID) => $('content').querySelector(`.item[data-cid="${id}"]`)
  const viewer = (id = ID) => card(id)?.querySelector('.logv') ?? null
  const open = (id = ID) => run(`openLogs('${id}')`)
  const part = (name, id = ID) => viewer(id).querySelector(`[data-lv="${name}"]`)
  const find = (cls, id = ID) => viewer(id).querySelector(`.${cls}`)
  const click = (name, id = ID) => emit('click', part(name, id))
  const key = (name, target = body, extra = {}) => emit('keydown', target, { key: name, ...extra })
  // A click on one of the card's own buttons (its markup is only text here).
  const press = (a, id = ID) => {
    const button = { id: '', dataset: { a, t: id }, disabled: false }
    return emit('click', { id: '', closest: (sel) => (sel === 'button[data-a]' ? button : null) })
  }
  // Runs the pending timers of one delay.
  const fire = async (ms) => {
    for (const [id, t] of [...timers]) if (t.ms === ms) { timers.delete(id); t.fn() }
    await settle()
  }
  const sent = (name) => calls.filter((c) => c.name === name).map((c) => ({ ...c.input }))
  const stops = () => sent('colima.logs.stop').map((i) => i.id ?? '*')
  const openIds = () => $('content').querySelectorAll('.logv').map((v) => v.dataset.logs)
  const poll = (containers) => { if (containers) list = containers; return run('refresh()') }
  const chunk = (text, id = ID) => push('colima.logs.chunk', { id, text })
  const lines = (id = ID) => find('logv-lines', id).children.map((l) => l.textContent)
  return { $, window, document, body, run, emit, push, card, viewer, part, find, open, click, press, key, fire, sent, stops, openIds, poll, chunk, lines }
}

const expanded = (p) => p.body.classList.contains('logs-max')
const box = (p, scrollTop, id = ID) => Object.assign(p.find('logv-box', id), { scrollHeight: 1000, clientHeight: 200, scrollTop })

describe('viewers inside the cards', () => {
  test('the Log button opens the viewer below the card actions and scrolls to it', async () => {
    const p = await boot()
    await p.press('logs')
    const card = p.card()
    assert.equal(card.children.length, 2)
    assert.match(card.children[0].innerHTML, /data-a="logs"/)
    assert.equal(card.children[1], p.viewer())
    assert.deepEqual(p.sent('colima.logs.follow').map((i) => i.id), [ID])
    const revealed = () => p.document.revealed.filter((r) => r.el === p.viewer())
    assert.deepEqual(revealed().map((r) => r.options), [{ block: 'nearest' }])
    // Again once there is content, which makes the viewer taller; never after that.
    await p.chunk('one\n')
    await p.chunk('two\n')
    assert.equal(revealed().length, 2)
    assert.deepEqual(p.lines(), ['one', 'two'])
  })

  test('a first chunk that comes late, or after the user scrolled, does not pull the page', async () => {
    for (const leave of [(p) => p.fire(1500), (p) => { p.window.scrollY = 80 }]) {
      const p = await boot()
      await p.open()
      await leave(p)
      await p.chunk('one\n')
      assert.equal(p.document.revealed.filter((r) => r.el === p.viewer()).length, 1)
    }
  })

  test('the Log button of an open viewer closes it', async () => {
    const p = await boot()
    await p.press('logs')
    await p.press('logs')
    assert.equal(p.viewer(), null)
    assert.deepEqual(p.stops(), [ID])
  })

  test('opens three independent viewers; a fourth closes the oldest and says so briefly', async () => {
    const p = await boot({}, [ID, B, C, D])
    for (const id of [ID, B, C]) await p.press('logs', id)
    assert.deepEqual(p.openIds(), [ID, B, C])
    await p.chunk('only b\n', B)
    assert.deepEqual([p.lines(ID), p.lines(B), p.lines(C)], [[], ['only b'], []])
    await p.push('colima.logs.end', { id: C, reason: 'exited' })
    assert.match(p.find('logv-state', C).textContent, /exited/)
    assert.match(p.find('logv-state', B).innerHTML, /Live/)
    await p.press('logs', D)
    assert.deepEqual(p.openIds(), [B, C, D])
    assert.deepEqual(p.stops(), [ID])
    const note = p.find('logv-note', D)
    assert.equal(note.hidden, false)
    assert.match(note.textContent, /web-01.*3/)
    await p.fire(4000)
    assert.equal(note.hidden, true)
  })

  test('closing one leaves the others', async () => {
    const p = await boot({}, [ID, B])
    await p.open(ID)
    await p.open(B)
    await p.click('close', ID)
    assert.deepEqual(p.openIds(), [B])
    assert.deepEqual(p.stops(), [ID])
  })

  test('container names are shown as text, never as markup', async () => {
    const p = await boot()
    await p.poll([container(ID, { name: '<img src=x>' })])
    await p.open()
    assert.equal(p.find('logv-title').innerHTML, '')
    assert.equal(p.find('logv-title').textContent, 'Logs: <img src=x>')
    assert.match(p.card().children[0].innerHTML, /&lt;img src=x&gt;/)
  })

  test('Logs from the All view opens the viewer in that scope', async () => {
    const p = await boot({ 'colima.view': () => ({ view: 'worktree' }) })
    await p.run(`openScope({ open: 'worktree', v: '/w', n: 'w', cid: '${ID}', logs: true })`)
    assert.ok(p.viewer())
    assert.deepEqual(JSON.parse(JSON.stringify(p.sent('colima.logs.follow').map((i) => i.scope))), [SCOPE])
  })
})

describe('polling', () => {
  // An open history viewer with content, a scrolled box and a half-typed search.
  async function busy(ids = [ID, B, C]) {
    const p = await boot({}, ids)
    await p.open(ID)
    await p.chunk('one\ntwo\n')
    const pre = box(p, 120)
    const q = p.part('q')
    q.value = 'needle'
    q.selectionStart = q.selectionEnd = 3
    q.focus()
    const kept = () => {
      assert.equal(p.card().attached, 1, 'the card was moved')
      assert.equal(p.viewer().attached, 1, 'the viewer was moved')
      assert.equal(p.find('logv-box'), pre)
      assert.deepEqual(p.lines(), ['one', 'two'])
      assert.equal(pre.scrollTop, 120)
      assert.equal(p.part('q'), q)
      assert.deepEqual([q.value, q.selectionStart, q.selectionEnd], ['needle', 3, 3])
      assert.equal(p.document.activeElement, q)
    }
    return { p, pre, q, kept }
  }
  const order = (p) => p.$('content').querySelectorAll('.item').map((el) => el.dataset.cid)

  test('keeps content, scroll, search text, caret and focus', async () => {
    const { p, kept } = await busy()
    await p.poll()
    await p.poll([container(ID, { status: 'Up 2 minutes' }), container(B), container(C)])
    assert.match(p.card().children[0].innerHTML, /Up 2 minutes/)
    kept()
  })

  test('never moves a card with a viewer when others appear, go, regroup or reorder', async () => {
    const { p, kept } = await busy()
    await p.poll([container(D), container(ID), container(C)])
    assert.deepEqual(order(p), [D, ID, C])
    kept()
    await p.poll([container(C), container(D), container(ID)])
    assert.deepEqual(order(p), [C, D, ID])
    kept()
    await p.poll([container(ID), container(C, { service: 'db' }), container(D)])
    assert.deepEqual(order(p), [ID, D, C])
    kept()
  })

  test('keeps scroll and focus when two cards with viewers swap places', async () => {
    const { p, pre, q } = await busy()
    await p.open(B)
    pre.scrollTop = 120
    const other = box(p, 800, B)
    q.focus()
    await p.poll([container(B), container(ID), container(C)])
    assert.deepEqual(order(p), [B, ID, C])
    assert.equal(pre.scrollTop, 120)
    assert.equal(other.scrollTop, 1000, 'tail-follow')
    assert.equal(p.document.activeElement, q)
    assert.deepEqual([q.selectionStart, q.selectionEnd], [3, 3])
  })

  test('a container that disappears closes its viewer only', async () => {
    const p = await boot({}, [ID, B])
    await p.open(ID)
    await p.open(B)
    await p.poll([container(B)])
    assert.deepEqual(p.openIds(), [B])
    assert.deepEqual(p.stops(), [ID])
    await p.poll([])
    assert.deepEqual(p.openIds(), [])
    assert.deepEqual(p.stops(), [ID, '*'])
  })

  test('a failed poll keeps the viewers and shows the error', async () => {
    let fail = false
    const p = await boot({ 'colima.state': () => (fail ? Promise.reject(new Error('timed out')) : stateOf([container(ID)])) })
    await p.open()
    await p.chunk('one\n')
    const pre = box(p, 120)
    fail = true
    await p.poll()
    assert.match(p.$('content').children[0].innerHTML, /timed out/)
    await p.run('render()')
    assert.equal(pre.scrollTop, 120)
    assert.equal(p.viewer().attached, 1)
    await p.click('close')
    await p.open()
    assert.equal(p.find('logv-title').textContent, 'Logs: web-01')
    box(p, 120)
    fail = false
    await p.poll()
    assert.doesNotMatch(p.$('content').children[0].innerHTML, /timed out/)
    assert.equal(p.find('logv-box').scrollTop, 120)
    assert.deepEqual(p.stops(), [ID])
  })
})

describe('closing all', () => {
  test('on view, workspace, scope, engine and VM changes', async () => {
    const leaves = ['resetForWorkspaceSwitch()', "setView('all')", "switchEngine('orbstack')", "openScope({ open: 'worktree', v: '/w' })", "leavePinned()", "(vmConfirm = 'stop', vmConfirmAt = 0, vmAction('stop'))"]
    for (const leave of leaves) {
      const p = await boot({}, [ID, B])
      await p.open(ID)
      await p.open(B)
      await p.click('expand', ID)
      await p.run(leave)
      assert.deepEqual(p.openIds(), [], leave)
      assert.ok(!expanded(p), leave)
      assert.deepEqual(p.stops(), ['*'], leave)
    }
  })

  test('when the engine changed elsewhere', async () => {
    let engine = 'colima'
    const p = await boot({ 'colima.state': () => ({ ...stateOf([container(ID)]), engineName: engine }), 'colima.vm': () => vmAnswer(engine) })
    await p.open()
    engine = 'orbstack'
    await p.poll() // dropped as stale
    await p.poll()
    assert.deepEqual(p.openIds(), [])
  })

  test('pauses while hidden and follows every live viewer again', async () => {
    const p = await boot({}, [ID, B, C])
    for (const id of [ID, B, C]) await p.open(id)
    await p.click('mode', C)
    p.document.hidden = true
    await p.emit('visibilitychange', p.body)
    assert.equal(p.find('logv-state', ID).textContent, 'Paused')
    p.document.hidden = false
    await p.emit('visibilitychange', p.body)
    assert.deepEqual(p.sent('colima.logs.follow').map((i) => i.id), [ID, B, C, ID, B])
  })
})

describe('workspace and terminals', () => {
  const ctx = (ids, over = {}) => ({ branch: 'dev', displayName: 'dev', terminals: ids.map((id) => ({ id })), ...over })
  const opened = async (ids) => {
    const workspace = ctx(ids)
    const worker = { worktree: '/w' }
    const p = await boot({ 'colima.state': () => ({ ...stateOf([container(ID)]), worktree: worker.worktree }) }, [ID], workspace)
    await p.open()
    // The focused workspace changes; both the watcher and the next poll see it.
    const change = async (next) => {
      Object.assign(workspace, next)
      await p.run('watchContext()')
      await p.poll()
    }
    return { p, worker, change }
  }

  test('opening or closing a terminal in the same workspace keeps the viewers', async () => {
    const { p, change } = await opened(['t1'])
    const viewer = p.viewer()
    for (const ids of [['t1', 't2'], ['t2'], [], ['t3']]) await change(ctx(ids))
    assert.equal(p.viewer(), viewer)
    assert.equal(viewer.attached, 1)
    assert.deepEqual(p.stops(), [])
    assert.equal(p.sent('colima.logs.follow').length, 1)
  })

  test('opening the first terminal keeps the viewers', async () => {
    const { p, change } = await opened([])
    await change(ctx(['t1']))
    assert.ok(p.viewer())
    assert.deepEqual(p.stops(), [])
  })

  test('a switch closes them, also between worktrees with the same branch and name', async () => {
    for (const next of [ctx(['t9']), ctx(['t1'], { branch: 'main' }), ctx(['t1'], { displayName: 'other' })]) {
      const { p, change } = await opened(['t1'])
      await change(next)
      assert.deepEqual(p.stops(), ['*'], JSON.stringify(next))
    }
  })

  test('closes them when the worker resolves another worktree, or none', async () => {
    for (const path of ['/other', null]) {
      const { p, worker, change } = await opened(['t1'])
      worker.worktree = path
      await change(ctx([]))
      assert.deepEqual(p.openIds(), [], String(path))
      assert.deepEqual(p.stops(), ['*'], String(path))
    }
  })
})

describe('history and search per viewer', () => {
  const hit = '2024-05-01T10:00:00Z boom <b>'
  const handlers = {
    'colima.logs.older': () => ({ ok: true, text: `${hit}\n`, done: true }),
    'colima.logs.search': () => ({ ok: true, lines: [hit, hit], total: 2, truncated: false }),
    'colima.logs.context': () => ({ ok: true, lines: [hit] })
  }

  test('only the viewer switched to History stops following and searches', async () => {
    const p = await boot(handlers, [ID, B])
    await p.open(ID)
    await p.open(B)
    await p.click('mode', ID)
    assert.deepEqual(p.stops(), [ID])
    assert.equal(p.find('logv-state', ID).textContent, 'History')
    assert.equal(p.part('mode', ID).textContent, 'Live')
    assert.equal(p.part('mode', B).textContent, 'History')
    assert.equal(p.find('logv-search', B).hidden, true)
    assert.equal(p.document.activeElement, p.part('q'))
    await p.chunk('ignored\n', ID)
    assert.equal(p.lines(ID).length, 1)
    assert.match(p.lines(ID)[0], /boom <b>$/)

    await p.click('case', ID)
    p.part('q').value = 'boom'
    await p.emit('input', p.part('q'))
    await p.fire(300)
    assert.deepEqual(p.sent('colima.logs.search').map(({ token, ...i }) => i), [{ id: ID, query: 'boom', caseSensitive: true }])
    assert.ok(p.sent('colima.logs.search')[0].token > p.sent('colima.logs.stop')[0].token)
    assert.equal(p.part('case', B).attributes['aria-pressed'], 'false')
    const results = p.find('logv-results')
    assert.equal(results.children.length, 2)
    assert.match(results.children[0].innerHTML, /<mark>boom<\/mark> &lt;b&gt;/)
    assert.match(p.find('logv-count').textContent, /2 matches \(2\/2\)/)
    await p.click('prev')
    assert.match(p.find('logv-count').textContent, /\(1\/2\)/)
    await p.key('Enter', p.part('q'))
    assert.match(p.find('logv-count').textContent, /\(2\/2\)/)

    await p.emit('click', results.children[0])
    assert.deepEqual(p.sent('colima.logs.context').map((i) => i.id), [ID])
    assert.equal(p.find('logv-context').hidden, false)
    await p.click('back')
    assert.equal(results.hidden, false)
    await p.key('Escape', p.part('q'))
    assert.equal(p.part('q').value, '')
    assert.deepEqual(p.stops(), [ID, ID])
    await p.chunk('still live\n', B)
    assert.deepEqual(p.lines(B), ['still live'])
  })

  test('a cancelled search does not stay on Searching', async () => {
    for (const message of ['Search cancelled.', '']) {
      const p = await boot({ ...handlers, 'colima.logs.search': () => ({ ok: false, cancelled: true, message }) })
      await p.open()
      await p.click('mode')
      p.part('q').value = 'boom'
      await p.key('Enter', p.part('q'))
      assert.equal(p.find('logv-count').innerHTML, '')
      assert.equal(p.find('logv-count').textContent, 'Search cancelled.')
    }
  })

  test('Load older asks for that container', async () => {
    const p = await boot({ 'colima.logs.older': () => ({ ok: true, text: '2024-05-01T10:00:00Z old\n', done: false }) }, [ID, B])
    await p.open(ID)
    await p.open(B)
    await p.chunk('2024-05-01T10:00:01Z new\n', B)
    await p.click('older', B)
    assert.deepEqual(p.sent('colima.logs.older'), [{ id: B, until: '2024-05-01T10:00:01Z', skip: 1 }])
    assert.equal(p.lines(B).length, 2)
  })

  test('an answer for a closed viewer is dropped, even if it was opened again', async () => {
    const answers = []
    const p = await boot({ 'colima.logs.follow': () => new Promise((resolve) => answers.push(resolve)) })
    await p.press('logs')
    await p.click('close')
    await p.press('logs')
    answers[0]({ ok: false, message: 'Superseded.' })
    await settle()
    assert.ok(p.viewer())
    assert.equal(p.$('status').textContent, '')
  })
})

describe('full-panel log viewer', () => {
  const opened = async () => {
    const p = await boot({}, [ID, B])
    await p.open()
    return p
  }

  test('Expand and Collapse toggle it, keeping the follower and the focus', async () => {
    const p = await opened()
    p.window.scrollY = 300
    await p.click('expand')
    assert.ok(expanded(p))
    assert.ok(p.viewer().classList.contains('max'))
    assert.equal(p.viewer().attached, 1)
    assert.equal(p.part('expand').textContent, 'Collapse')
    assert.equal(p.document.activeElement, p.part('expand'))
    await p.click('expand')
    assert.ok(!expanded(p))
    assert.ok(!p.viewer().classList.contains('max'))
    assert.equal(p.part('expand').textContent, 'Expand')
    assert.equal(p.window.scrolledTo, 300)
    assert.equal(p.sent('colima.logs.follow').length, 1)
    assert.deepEqual(p.stops(), [])
  })

  test('Escape collapses and focuses the button', async () => {
    const p = await opened()
    await p.click('expand')
    p.document.activeElement = p.body
    await p.key('Escape')
    assert.ok(!expanded(p))
    assert.equal(p.document.activeElement, p.part('expand'))
  })

  test('Escape in the search box clears the query first, then collapses', async () => {
    const p = await opened()
    await p.click('expand')
    await p.click('mode')
    assert.ok(expanded(p), 'history keeps it expanded')
    p.part('q').value = 'boom'
    await p.key('Escape', p.part('q'))
    assert.equal(p.part('q').value, '')
    assert.ok(expanded(p))
    await p.key('Escape', p.part('q'))
    assert.ok(!expanded(p))
  })

  test('closing the expanded viewer, or losing its container, leaves full panel', async () => {
    const p = await opened()
    await p.click('expand')
    await p.click('close')
    assert.ok(!expanded(p))
    await p.open()
    await p.click('expand')
    await p.poll([container(B)])
    assert.ok(!expanded(p))
  })

  test('keeps following the tail, or else the same position', async () => {
    const p = await opened()
    const pre = box(p, 800)
    await p.click('expand')
    assert.equal(pre.scrollTop, 1000)
    pre.scrollTop = 800
    await p.click('expand')
    assert.equal(pre.scrollTop, 1000)
    pre.scrollTop = 100
    await p.click('expand')
    assert.equal(pre.scrollTop, 100)
    pre.scrollTop = 60 // scrolled while expanded: that is the position kept
    await p.click('expand')
    assert.equal(pre.scrollTop, 60)
  })

  test('restores a position the taller box could not hold', async () => {
    const p = await opened()
    // A box that clamps like a browser: 200px tall, or 700px when expanded.
    let top = 0
    const pre = Object.assign(p.find('logv-box'), { scrollHeight: 1000 })
    Object.defineProperty(pre, 'clientHeight', { get: () => (expanded(p) ? 700 : 200) })
    Object.defineProperty(pre, 'scrollTop', { get: () => Math.min(top, 1000 - pre.clientHeight), set: (v) => { top = Math.min(v, 1000 - pre.clientHeight) } })
    pre.scrollTop = 600
    await p.click('expand')
    assert.equal(pre.scrollTop, 300)
    await p.click('expand')
    assert.equal(pre.scrollTop, 600)
  })
})

describe('log height', () => {
  const heights = (p) => p.sent('colima.logs.height').filter((i) => 'height' in i).map((i) => i.height)
  const saved = (height) => ({ 'colima.logs.height': (input) => ('height' in input ? { height: input.height } : { height }) })

  test('applies the saved height to every viewer, except while expanded', async () => {
    const p = await boot(saved(300), [ID, B])
    await p.open(ID)
    await p.open(B)
    const style = p.find('logv-box').style
    assert.deepEqual([style.height, style.maxHeight], ['300px', 'none'])
    assert.equal(p.find('logv-box', B).style.height, '300px')
    await p.click('expand')
    assert.deepEqual([style.height, style.maxHeight], ['', ''])
    assert.equal(p.find('logv-box', B).style.height, '300px')
    await p.click('expand')
    assert.equal(style.height, '300px')
  })

  test('resizes with the keyboard, saving once, and Enter returns to automatic', async () => {
    const p = await boot(saved(null), [ID, B])
    await p.open(ID)
    await p.open(B)
    const handle = p.part('resize')
    p.find('logv-box').offsetHeight = 200
    assert.ok((await p.key('ArrowDown', handle)).defaultPrevented)
    await p.key('ArrowDown', handle)
    assert.equal(p.find('logv-box').style.height, '280px')
    assert.equal(p.find('logv-box', B).style.height, '280px')
    assert.equal(handle.attributes['aria-valuenow'], '280')
    await p.key('ArrowUp', handle)
    await p.fire(400)
    assert.deepEqual(heights(p), [240])
    await p.key('Home', handle)
    await p.key('ArrowUp', handle)
    assert.equal(p.find('logv-box').style.height, '120px')
    await p.key('Enter', handle)
    await p.fire(400)
    assert.equal(p.find('logv-box').style.height, '')
    assert.deepEqual(heights(p), [240, null])
  })

  test('drags taller, keeps following the tail and saves on release', async () => {
    const p = await boot(saved(null))
    await p.open()
    const pre = box(p, 800)
    pre.offsetHeight = 200
    await p.emit('pointerdown', p.part('resize'), { button: 0, clientY: 500, pointerId: 1 })
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
    await p.open()
    p.find('logv-box').offsetHeight = 200
    await p.key('ArrowDown', p.part('resize'))
    answer({ height: 900 })
    await settle()
    assert.equal(p.find('logv-box').style.height, '240px')
  })
})

describe('Open in terminal', () => {
  test('asks for the container of that viewer, with the pinned scope, and reports the result', async () => {
    const p = await boot({ 'colima.logs.terminal': () => ({ ok: true }) }, [ID, B])
    await p.open(ID)
    await p.open(B)
    await p.click('terminal', B)
    assert.deepEqual(p.sent('colima.logs.terminal'), [{ id: B }])
    assert.match(p.$('status').textContent, /terminal/i)
    assert.equal(p.part('terminal', B).disabled, false)
    await p.run(`pinned = { scope: ${JSON.stringify(SCOPE)} }`)
    await p.click('terminal', ID)
    assert.equal(p.sent('colima.logs.terminal')[1].scope.path, '/w')
  })

  test('shows why it failed', async () => {
    const p = await boot({ 'colima.logs.terminal': () => ({ ok: false, message: 'Container is not in the shown scope.' }) })
    await p.open()
    await p.click('terminal')
    assert.match(p.$('status').textContent, /not in the shown scope/)
  })
})

describe('status line', () => {
  test('shows no progress text once the logs are open', async () => {
    const p = await boot()
    await p.press('logs')
    assert.ok(p.viewer())
    assert.equal(p.$('status').textContent, '')
  })

  test('still shows why the logs could not be followed', async () => {
    const p = await boot({ 'colima.logs.follow': () => ({ ok: false, message: 'Container is not in the shown scope.' }) })
    await p.press('logs')
    assert.match(p.$('status').textContent, /not in the shown scope/)
    assert.equal(p.viewer(), null)
  })

  test('says when the context could only be read in part', async () => {
    const p = await boot({ 'colima.logs.context': () => ({ ok: true, lines: [], message: 'Context may be incomplete.' }) })
    await p.open()
    await p.run(`openContext(viewers.get('${ID}'), '2024-05-01T10:00:00Z')`)
    assert.match(p.$('status').textContent, /incomplete/)
  })

  test('drops a success message after a while but keeps a failure', async () => {
    let ok = true
    const p = await boot({ 'colima.action': () => ({ ok, message: 'boom' }) })
    await p.press('restart')
    assert.equal(p.$('status').textContent, 'restart: done')
    await p.fire(3000)
    assert.equal(p.$('status').textContent, '')
    ok = false
    await p.press('restart')
    await p.fire(3000)
    assert.equal(p.$('status').textContent, 'restart failed: boom')
  })

  test('drops the progress of group operations forgotten on an engine switch', async () => {
    const p = await boot({ 'engine.set': () => ({ ok: true }) })
    await p.run("groupOps.set('k', { name: 'web', action: 'stop', pending: new Set(['p:web']), errors: [] }); setStatus('web: stop...')")
    await p.run("switchEngine('orbstack')")
    assert.equal(p.$('status').textContent, '')
  })
})
