// Containers panel worker (manifest id stays `colima`, so handler and event names keep that prefix).
// The panel polls `colima.state`; all process execution happens in this worker (modules in lib/).
import { unlinkSync } from 'node:fs'
import { composeRun, stateForScope } from './lib/compose.mjs'
import { listContainers } from './lib/containers.mjs'
import { activeContext, contexts, dockerArgs, ENGINE_KEY, ensureEngine, EngineError, engineScope, loadContexts, selectEngine } from './lib/docker.mjs'
import { validateContext } from './lib/engines/context.mjs'
import { otherEngines, resetOthersCache } from './lib/engines/others.mjs'
import { engineInfo, hostLimits, loadPrefs, startVm, vmOp, vmOpName, vmStatus } from './lib/engines/vm.mjs'
import { DOCKER, run } from './lib/exec.mjs'
import { followers, followLogs, killFollower, stopLogs, sweepFollowers, touchPanel } from './lib/logs/follow.mjs'
import { contextLogs, olderLogs } from './lib/logs/history.mjs'
import { cleanupStaleDocker, PID_FILE } from './lib/logs/process.mjs'
import { killSearch, searches, searchLogs } from './lib/logs/search.mjs'
import { buildOverview } from './lib/overview.mjs'
import { NOT_OWNED, orcaLists, ownedContainer, resetListsCache } from './lib/scope.mjs'
import { logsHeightPref } from './lib/prefs.mjs'
import { statsForScope } from './lib/stats.mjs'
import { logsTerminal, shellTerminal } from './lib/terminal.mjs'
import { resetPathCache } from './lib/worktree.mjs'

const SWEEP_MS = 5000
const VIEW_KEY = 'view'
const VIEWS = ['worktree', 'all']
const CONTAINER_ACTIONS = ['start', 'stop', 'restart']
const CONTAINER_ACTION_TIMEOUT_MS = 120000 // slow containers take a while to stop

export default async function activate(orca) {
  cleanupStaleDocker()
  // Every handler call proves the panel is alive; followers of silent panels are swept.
  // The engine is captured once per request; results are tagged with it so the panel can drop answers
  // that belong to a previous engine. engine.set is exempt: it is the one handler that changes the engine.
  const handle = (name, fn) => orca.panels.handle(name, async (input, ctx) => {
    if (ctx?.panel?.id) touchPanel(ctx.panel.id)
    await ensureEngine(orca)
    if (name === 'engine.set') return fn(input, ctx)
    const engine = activeContext
    try {
      const store = { engine }
      const out = await engineScope.run(store, () => fn(input, ctx))
      return out && typeof out === 'object' && !Array.isArray(out) ? { ...out, engineName: engine, engineCounts: store.counts ?? null } : out
    } catch (e) {
      if (!(e instanceof EngineError)) throw e
      // Shaped so every panel consumer (state, overview, actions, VM calls) can read it as a failure.
      return {
        ok: false, started: false, error: e.message, message: e.message, engineName: engine, worktree: null, containers: [], stacks: [], projects: [],
        other: { running: 0, total: 0, projects: [] }, individual: { running: 0, total: 0, containers: [] }
      }
    }
  })
  const sweeper = setInterval(() => { sweepFollowers(orca).catch(() => {}) }, SWEEP_MS)
  sweeper.unref?.()
  const killAll = () => {
    for (const panelId of [...followers.keys()]) killFollower(panelId, null, null, orca)
    for (const panelId of [...searches.keys()]) killSearch(panelId)
  }
  process.once('exit', () => { killAll(); try { unlinkSync(PID_FILE) } catch { /* none */ } })
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { killAll(); process.exit(0) })

  handle('colima.state', async (input) => stateForScope(orca, input?.scope))
  handle('colima.stats', async (input) => statsForScope(orca, input?.scope))

  // One docker ps + the cached orca lists build the whole "All" tree.
  handle('colima.overview', async () => {
    const [{ error, containers }, lists] = await Promise.all([listContainers(), orcaLists()])
    if (error) return { error, projects: [], other: { running: 0, total: 0, projects: [] }, individual: { running: 0, total: 0, containers: [] } }
    return { error: null, orcaError: lists.error, ...buildOverview(containers, lists.worktrees, lists.repos) }
  })

  // The remembered container view; with `view` in the input it is saved first.
  handle('colima.view', async (input) => {
    if (VIEWS.includes(input?.view)) {
      try { await orca.host.call('storage.set', { key: VIEW_KEY, value: input.view }) } catch { /* best-effort */ }
      return { view: input.view }
    }
    try {
      const { value } = await orca.host.call('storage.get', { key: VIEW_KEY })
      if (VIEWS.includes(value)) return { view: value }
    } catch { /* default */ }
    return { view: 'worktree' }
  })

  // The log box height chosen in the panel, remembered like the view.
  handle('colima.logs.height', async (input) => logsHeightPref(orca, input))

  handle('colima.vm', async () => {
    // Contexts come and go (docker context create/rm): re-read them, and re-pick if the chosen one vanished.
    await loadContexts()
    const [status, prefs] = await Promise.all([vmStatus(), loadPrefs(orca)])
    return { ...status, ...engineInfo(), prefs, limits: hostLimits() }
  })

  // Separate from colima.vm so that a hung engine never delays the panel's normal state.
  handle('colima.others', async () => {
    await loadContexts()
    return { engines: await otherEngines() }
  })

  // Switches the engine. Only a context from the live list is accepted; everything bound to the old engine is dropped.
  handle('engine.set', async (input) => {
    await loadContexts(true)
    const entry = validateContext(input?.name, contexts)
    if (!entry) return { ok: false, message: 'Unknown engine.' }
    if (vmOpName) return { ok: false, message: `The engine is ${vmOpName}.` }
    killAll()
    resetListsCache()
    resetPathCache()
    selectEngine(entry)
    resetOthersCache()
    try { await orca.host.call('storage.set', { key: ENGINE_KEY, value: entry.name }) } catch { /* best-effort */ }
    return { ok: true, name: entry.name }
  })
  handle('colima.start', async (input) => startVm(orca, input))
  handle('colima.vmOp', async (input) => vmOp(orca, input))

  handle('colima.compose', async (input) => composeRun(orca, input))

  handle('colima.logs.follow', async (input, ctx) => followLogs(orca, ctx.panel.id, input))
  handle('colima.logs.stop', async (input, ctx) => stopLogs(orca, ctx.panel.id, input))

  handle('colima.logs.older', async (input) => olderLogs(orca, input))
  handle('colima.logs.search', async (input, ctx) => searchLogs(orca, ctx.panel.id, input, ctx.signal))
  handle('colima.logs.context', async (input) => contextLogs(orca, input))

  handle('colima.action', async (input) => {
    const action = input?.action
    if (!CONTAINER_ACTIONS.includes(action)) return { ok: false, message: 'Unknown action.' }
    const { target } = await ownedContainer(orca, String(input?.id ?? ''), input?.scope, true)
    if (!target) return NOT_OWNED
    const res = await run(DOCKER, dockerArgs([action, target.id]), CONTAINER_ACTION_TIMEOUT_MS)
    return res.ok ? { ok: true } : { ok: false, message: res.stderr.slice(0, 300) }
  })

  handle('colima.shell', async (input) => shellTerminal(orca, input))
  handle('colima.logs.terminal', async (input) => logsTerminal(orca, input))

  orca.commands.register('colima.refresh', async () => {
    orca.panels.post('colima.refresh', {})
    await orca.host.call('notifications.show', { title: 'Containers', body: 'Refresh requested.' })
  })
}
