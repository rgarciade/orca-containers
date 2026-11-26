// New Orca terminal tabs on one container: a shell, or its logs. The terminal belongs to the user afterwards.
import { CONTAINER_ID_RE } from './containers.mjs'
import { dockerArgs } from './docker.mjs'
import { DOCKER, orcaJson } from './exec.mjs'
import { LOG_TAIL_LINES } from './logs/follow.mjs'
import { NOT_OWNED, ownedContainer } from './scope.mjs'
import { buildLogsCommand, buildShellCommand } from './shell.mjs'
import { resolveActiveWorktree } from './worktree.mjs'

const FOLLOWABLE = ['running', 'paused', 'restarting']

// The container must belong to the scope (fresh lists). `plan(target, context)` returns { title, command }
// or { refuse }.
async function openTerminal(orca, input, what, plan) {
  const { worktree, kind, target } = await ownedContainer(orca, String(input?.id ?? ''), input?.scope, true)
  if (!target) return NOT_OWNED
  if (!CONTAINER_ID_RE.test(target.id)) return { ok: false, message: 'Unexpected container id.' }
  // A terminal tab must belong to a worktree: containers outside one open in the focused workspace.
  // Not `--worktree active`: the CLI resolves that from its cwd, which for the worker is no worktree.
  const where = kind === 'worktree' && worktree ? { path: worktree } : await resolveActiveWorktree(orca)
  // dockerArgs refuses if the engine changed meanwhile; its `--context <name>` is the one put in the command.
  const [, context = null] = dockerArgs([])
  const { refuse, title, command } = plan(target, context)
  if (refuse) return { ok: false, message: refuse }
  if (!where.path) return { ok: false, message: `${what} opens in the focused workspace: ${where.error}` }
  const res = await orcaJson(['terminal', 'create', '--worktree', `path:${where.path}`, '--title', title, '--command', command, '--focus'])
  return res.ok ? { ok: true } : { ok: false, message: `orca CLI failed: ${String(res.error?.message ?? '').slice(0, 200)}` }
}

export const shellTerminal = (orca, input) => openTerminal(orca, input, 'A shell', (target, context) =>
  target.state === 'running'
    ? { title: `sh ${target.name}`, command: buildShellCommand(DOCKER, context, target.id) }
    : { refuse: 'A shell needs a running container.' })

// Stopped containers work too: their log is printed once, without following.
export const logsTerminal = (orca, input) => openTerminal(orca, input, 'A log terminal', (target, context) =>
  ({ title: `logs ${target.name}`, command: buildLogsCommand(DOCKER, context, target.id, { tail: LOG_TAIL_LINES, follow: FOLLOWABLE.includes(target.state) }) }))
