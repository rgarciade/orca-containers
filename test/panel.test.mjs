// The panel's inline script, run against a minimal stand-in for the DOM and the Orca host. Markup is only
// inspected as text; no browser is involved.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8')
const script = html.match(/<script>([\s\S]*)<\/script>/)[1]

const element = () => ({
  innerHTML: '', textContent: '', value: '', hidden: false, dataset: {}, style: {},
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  contains: () => false, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, setAttribute() {}, appendChild() {}, focus() {}
})

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)) }
const never = () => new Promise(() => {})
const fail = () => Promise.reject(new Error('timed out'))

const engines = [{ name: 'orbstack', label: 'OrbStack', state: null }, { name: 'remote', label: 'Docker (context remote)', state: 'remote' }]
const vmFor = (name, label, others = engines) => ({ engineName: name, engine: { name, label, kind: 'generic', missing: false }, engines: others, controls: { installed: true }, running: true, installed: true, prefs: { cpu: 4, memory: 8 }, limits: { maxCpu: 8, maxMemory: 16 } })
const colima = () => Promise.resolve(vmFor('colima', 'Colima'))
const goodState = () => Promise.resolve({ engineName: 'colima', worktree: '/w', containers: [], stacks: [], error: null })

// Boots the panel; `handlers[name](input)` answers each plugin request and may be replaced at any time.
async function boot(handlers) {
  const elements = new Map()
  const listeners = {}
  const calls = []
  const $ = (id) => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id) }
  const body = element()
  const document = { body, activeElement: body, hidden: false, getElementById: $, querySelector: () => null, querySelectorAll: () => [], createElement: element, addEventListener: (type, fn) => (listeners[type] ||= []).push(fn) }
  const intervals = {}
  let immediate = 0 // zero-delay timers run so far; capped so that a retry loop cannot hang the test
  const setTimeout = (fn, ms) => { if (ms === 0 && immediate++ < 20) setImmediate(fn); return 0 }
  const host = {
    call: async (method, params) => {
      if (method !== 'plugin.request') return {}
      calls.push(params.name)
      return { output: await (handlers[params.name] ?? (() => ({})))(params.input) }
    }
  }
  const window = { orca: { host, plugin: { on() {} }, on() {} }, addEventListener() {} }
  const context = createContext({ window, document, setTimeout, clearTimeout() {}, setInterval: (fn, ms) => { intervals[ms] = fn; return 0 }, clearInterval() {} })
  runInContext(script, context)
  await settle()
  const run = async (code) => { const out = runInContext(code, context); await settle(); return out }
  const pick = async (t) => {
    const button = { dataset: { a: 'engine', t } }
    const target = { id: '', closest: (sel) => (sel === 'button[data-a]' ? button : null) }
    for (const fn of listeners.click) fn({ target })
    await settle()
  }
  const tick = async (ms) => { intervals[ms](); await settle() }
  return { $, run, pick, tick, calls }
}

const offers = (panel, name) => !panel.$('vm').hidden && panel.$('vm-others').innerHTML.includes(`data-t="${name}"`)

describe('engine card when the selected engine fails or hangs', () => {
  test('keeps the switch list when the state request fails on first load', async () => {
    const panel = await boot({ 'colima.state': fail, 'colima.vm': colima })
    assert.ok(offers(panel, 'orbstack'))
    assert.match(panel.$('content').innerHTML, /timed out/)
  })

  test('shows the switch list while the state request hangs', async () => {
    const panel = await boot({ 'colima.state': never, 'colima.vm': colima })
    assert.ok(offers(panel, 'orbstack'))
  })

  test('offers the other engines, with the error, when the engine status fails on first load', async () => {
    const panel = await boot({ 'colima.state': fail, 'colima.vm': fail, 'colima.others': () => ({ engineName: 'colima', engines: [{ name: 'orbstack', state: 'running', running: 1, stopped: 0 }] }) })
    assert.ok(offers(panel, 'orbstack'))
    assert.match(panel.$('vm-main').innerHTML, /Could not read the engine status.*timed out/)
  })

  test('offers the other engines while the engine status hangs on first load', async () => {
    const panel = await boot({ 'colima.state': never, 'colima.vm': never, 'colima.others': () => ({ engineName: 'colima', engines: [{ name: 'orbstack', state: 'stopped' }] }) })
    assert.ok(offers(panel, 'orbstack'))
    assert.match(panel.$('vm-main').innerHTML, /Checking/)
  })

  test('keeps the way back while switching, and a second pick wins', async () => {
    const handlers = { 'colima.state': goodState, 'colima.vm': colima }
    const panel = await boot(handlers)
    const sets = []
    handlers['engine.set'] = (input) => new Promise((resolve) => sets.push({ name: input.name, resolve }))
    await panel.pick('orbstack')
    assert.ok(offers(panel, 'colima'))
    assert.ok(offers(panel, 'remote'))
    assert.ok(!offers(panel, 'orbstack'))
    assert.match(panel.$('vm-main').innerHTML, /OrbStack[\s\S]*Switching/)
    await panel.pick('colima')
    assert.deepEqual(sets.map((s) => s.name), ['orbstack', 'colima'])
    sets[0].resolve({ ok: true })
    await settle()
    assert.match(panel.$('vm-main').innerHTML, /Switching/)
    sets[1].resolve({ ok: true })
    await settle()
    assert.match(panel.$('vm-main').innerHTML, /Colima[\s\S]*Running/)
  })

  test('keeps the switch list when the new engine fails right after a switch', async () => {
    const handlers = { 'colima.state': goodState, 'colima.vm': colima }
    const panel = await boot(handlers)
    Object.assign(handlers, { 'engine.set': () => ({ ok: true }), 'colima.state': fail, 'colima.vm': fail })
    await panel.pick('orbstack')
    assert.ok(offers(panel, 'colima'))
    assert.match(panel.$('vm-main').innerHTML, /OrbStack[\s\S]*Could not read the engine status.*timed out/)
  })

  test('does not keep a status that can no longer be read', async () => {
    const handlers = { 'colima.state': goodState, 'colima.vm': colima }
    const panel = await boot(handlers)
    Object.assign(handlers, { 'colima.state': fail, 'colima.vm': fail })
    await panel.run('refresh()')
    assert.ok(offers(panel, 'orbstack'))
    assert.doesNotMatch(panel.$('vm-main').innerHTML, /Running/)
    assert.match(panel.$('vm-main').innerHTML, /Could not read the engine status/)
  })
})

describe('retrying a failed state request', () => {
  const asked = (panel) => panel.calls.filter((name) => name === 'colima.state').length

  // Neither the zero-delay follow-up nor the 700ms workspace watcher may retry; the 3s poll does.
  async function retriesAtPollPace(panel, before) {
    assert.equal(asked(panel), before + 1)
    await panel.tick(700)
    await panel.tick(700)
    assert.equal(asked(panel), before + 1)
    await panel.tick(3000)
    assert.equal(asked(panel), before + 2)
  }

  test('on first load', async () => {
    await retriesAtPollPace(await boot({ 'colima.state': fail, 'colima.vm': colima }), 0)
  })

  test('right after an engine switch', async () => {
    const handlers = { 'colima.state': goodState, 'colima.vm': colima }
    const panel = await boot(handlers)
    const before = asked(panel)
    Object.assign(handlers, { 'engine.set': () => ({ ok: true }), 'colima.state': fail, 'colima.vm': fail })
    await panel.pick('orbstack')
    await retriesAtPollPace(panel, before)
  })
})

describe('collapsed group summary', () => {
  const c = (id, marker) => ({ id, name: id, image: 'img', state: 'running', status: '', ports: '', marker })
  const sick = [c('a', { kind: 'unhealthy' }), c('b', { kind: 'restarting' }), c('c', { kind: 'exit', code: 1 }), c('d', { kind: 'exit', code: 2 })]
  const fine = [c('e', { kind: 'starting' }), c('f', { kind: 'exit', code: 137 }), c('g', null)]
  const group = (containers) => ({ running: containers.length, total: containers.length, containers })
  const overview = (containers) => ({
    projects: [{ id: 'r', name: 'proj', running: 1, total: 1, worktrees: [{ path: '/w', name: 'wt', branch: 'main', ...group(containers) }] }],
    other: { running: 1, total: 1, projects: [{ key: 'k', name: 'cmp', workdir: '/c', ...group(containers) }] },
    individual: group(containers)
  })
  const KEYS = ['p:r', 'w:/w', 'other', 'o:k', 'individual']

  // The header markup of one group, with only that group collapsed.
  async function head(panel, key, containers) {
    return panel.run(`collapsed.clear(); collapsed.add(${JSON.stringify(key)}); renderTree(${JSON.stringify(overview(containers))}).split('<div class="tg-head').find((h) => h.includes('&#9656;'))`)
  }
  const flags = (markup) => [...markup.matchAll(/class="flag (\w+)"[^>]*>([^<]*)</g)].map((m) => `${m[1]}:${m[2]}`)

  test('counts the problems of every kind of collapsed group', async () => {
    const panel = await boot({})
    for (const key of KEYS) {
      assert.deepEqual(flags(await head(panel, key, [...sick, ...fine])), ['bad:1 unhealthy', 'warn:1 restarting', 'bad:2 exited'], key)
    }
  })

  test('says nothing for healthy, starting or exit 137 containers', async () => {
    const panel = await boot({})
    for (const key of KEYS) assert.deepEqual(flags(await head(panel, key, fine)), [], key)
  })

  test('adds no summary to an expanded group', async () => {
    const panel = await boot({})
    const out = await panel.run(`collapsed.clear(); renderTree(${JSON.stringify(overview(sick))})`)
    assert.doesNotMatch(out, /tg-flags/)
  })
})
