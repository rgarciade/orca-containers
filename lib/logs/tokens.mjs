// Ordering of follow, search and stop requests, per panel and container, by the panel's counter: a follow or a
// search older than the latest request of its container, or the latest stop of everything, is dropped (a stop
// can overtake a slow one).
const tokens = new Map() // panelId -> { all, ids: Map(containerId -> token) }; `all` from stops of everything

export const tokenOf = (input) => (Number.isInteger(input?.token) ? input.token : null)

export const latestToken = (panelId, id) => {
  const t = tokens.get(panelId)
  return t ? Math.max(t.all, t.ids.get(id) ?? -1) : -1
}

// False when `token` is already outdated. `id` null: a stop of everything.
export function noteToken(panelId, id, token) {
  if (token === null) return true
  if (!tokens.has(panelId)) tokens.set(panelId, { all: -1, ids: new Map() })
  const t = tokens.get(panelId)
  if (id === null) {
    if (token < t.all) return false
    t.all = token
    for (const [key, value] of t.ids) if (value <= token) t.ids.delete(key)
    return true
  }
  if (token < latestToken(panelId, id)) return false
  t.ids.set(id, token)
  return true
}

export const forgetTokens = (panelId) => tokens.delete(panelId)
