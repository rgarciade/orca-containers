// Pure helpers over Docker contexts: parsing, choosing, validating and adapter detection.

// Pure. Resolves the saved choice against a successfully read context list.
// A saved context that is gone is kept (missing: true): another engine is never picked silently.
export function chooseEngine(saved, list) {
  if (typeof saved === 'string' && saved) {
    return validateContext(saved, list) ? { name: saved, missing: false } : { name: saved, missing: true }
  }
  const current = (list ?? []).find((c) => c.current)
  return current ? { name: current.name, missing: false } : { name: null, missing: false, probe: true }
}

// Pure. `docker context ls --format '{{json .}}'` output (one JSON object per line) -> context entries.
export function parseContexts(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    try {
      const c = JSON.parse(line)
      if (typeof c?.Name !== 'string' || !c.Name) continue
      out.push({ name: c.Name, endpoint: String(c.DockerEndpoint ?? ''), current: c.Current === true, description: String(c.Description ?? ''), error: String(c.Error ?? '') })
    } catch { /* skip a malformed line */ }
  }
  return out
}

// Pure. The listed context called `name`, or null: the only way a name reaches a docker command line.
export const validateContext = (name, list) => (typeof name === 'string' ? (list ?? []).find((c) => c.name === name) ?? null : null)

const PROFILE_RE = /^[A-Za-z0-9][\w.-]*$/

// Pure. Which engine a context belongs to, from its name and endpoint: { kind, label, profile?, machine? }.
export function detectAdapter(ctx) {
  const name = String(ctx?.name ?? '')
  const endpoint = String(ctx?.endpoint ?? '').replace(/^unix:\/\//, '')
  const lower = `${name} ${endpoint}`.toLowerCase()
  const colima = /\/\.?colima\/([^/]+)\/docker\.sock$/.exec(endpoint)
  if (colima || name === 'colima' || name.startsWith('colima-')) {
    const profile = colima ? colima[1] : name === 'colima' ? 'default' : name.slice('colima-'.length)
    if (PROFILE_RE.test(profile)) return { kind: 'colima', profile, label: profile === 'default' ? 'Colima' : `Colima (${profile})` }
  }
  if (name === 'orbstack' || endpoint.includes('/.orbstack/run/docker.sock')) return { kind: 'orbstack', label: 'OrbStack' }
  if (name === 'rancher-desktop' || endpoint.endsWith('/.rd/docker.sock')) return { kind: 'rancher', label: 'Rancher Desktop' }
  if (name === 'desktop-linux' || name === 'desktop-windows' || endpoint.endsWith('/.docker/run/docker.sock') || endpoint.endsWith('/.docker/desktop/docker.sock')) {
    return { kind: 'desktop', label: 'Docker Desktop' }
  }
  if (lower.includes('podman')) {
    const m = /(podman-machine-[\w.-]*?)(?:-api)?\.sock$/.exec(endpoint)
    return { kind: 'podman', label: 'Podman', machine: m && PROFILE_RE.test(m[1]) ? m[1] : null }
  }
  return { kind: 'generic', label: `Docker (context ${name})` }
}
