// The command lines typed into the new Orca terminals: a container shell and a container's logs.
// `--context` is explicit, so the user's own DOCKER_HOST/DOCKER_CONTEXT cannot redirect them to another engine.
import { CONTAINER_ID_RE } from './containers.mjs'

// POSIX single-quote quoting: safe for any text, including quotes, spaces and $.
export const shellQuote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`

// `docker [--context <name>]`, quoted. Throws on an id that is not a hex container id.
function dockerFor(dockerBin, context, id) {
  if (!CONTAINER_ID_RE.test(id)) throw new Error('Invalid container id.')
  return `${shellQuote(dockerBin)}${context ? ` --context ${shellQuote(context)}` : ''}`
}

export function buildShellCommand(dockerBin, context, id) {
  // bash when the image has it, else sh (images like alpine ship only sh).
  return `${dockerFor(dockerBin, context, id)} exec -it ${shellQuote(id)} sh -c ${shellQuote('command -v bash >/dev/null && exec bash || exec sh')}`
}

export function buildLogsCommand(dockerBin, context, id, { tail, follow = false }) {
  const docker = dockerFor(dockerBin, context, id)
  if (!Number.isInteger(tail) || tail < 1) throw new Error('Invalid tail.')
  return `${docker} logs${follow ? ' -f' : ''} --tail ${shellQuote(tail)} --timestamps ${shellQuote(id)}`
}
