// The command line of a container shell.
import { CONTAINER_ID_RE } from './containers.mjs'

// POSIX single-quote quoting: safe for any text, including quotes, spaces and $.
export const shellQuote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`

// The command line typed into the new Orca terminal. Throws on an id that is not a hex container id.
// `--context` is explicit, so the user's own DOCKER_HOST/DOCKER_CONTEXT cannot redirect the shell to another engine.
export function buildShellCommand(dockerBin, context, id) {
  if (!CONTAINER_ID_RE.test(id)) throw new Error('Invalid container id.')
  // bash when the image has it, else sh (images like alpine ship only sh).
  return `${shellQuote(dockerBin)}${context ? ` --context ${shellQuote(context)}` : ''} exec -it ${shellQuote(id)} sh -c ${shellQuote('command -v bash >/dev/null && exec bash || exec sh')}`
}
