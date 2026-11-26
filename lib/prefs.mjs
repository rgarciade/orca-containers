// Panel preferences kept in the plugin's storage (the panel itself has none).
const LOGS_HEIGHT_KEY = 'logsHeight'
const LOGS_HEIGHT_MIN = 120 // keep in step with the panel's limits
const LOGS_HEIGHT_MAX = 4000
const isHeight = (h) => Number.isInteger(h) && h >= LOGS_HEIGHT_MIN && h <= LOGS_HEIGHT_MAX

// The chosen log box height in px, null for automatic. A valid `height` (or null) in the input is saved first.
export async function logsHeightPref(orca, input) {
  const next = input?.height
  if (next === null || isHeight(next)) {
    try {
      if (next === null) await orca.host.call('storage.delete', { key: LOGS_HEIGHT_KEY })
      else await orca.host.call('storage.set', { key: LOGS_HEIGHT_KEY, value: next })
    } catch { /* best-effort */ }
    return { height: next }
  }
  try {
    const { value } = await orca.host.call('storage.get', { key: LOGS_HEIGHT_KEY })
    if (isHeight(value)) return { height: value }
  } catch { /* automatic */ }
  return { height: null }
}
