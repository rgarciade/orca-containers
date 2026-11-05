# Orca plugin API (Orca 1.4.245) - research notes

Sources: app.asar (src/shared/plugins/*, plugin-host-entry.js, renderer chunks), Resources/plugins/launch, upstream doc
https://github.com/stablyai/orca/blob/main/docs/reference/plugin-authoring.md (plus examples/plugins/hello-orca, orca-gleam-syntax).
No public SDK npm package found; the API is injected (`orca` arg in worker, `window.orca` in panels).

## Manifest `orca-plugin.json` (format 2, strict; v1 still loads)
Required: `manifestVersion: 2`, `execution` (data | declarative | sandboxed-ui | trusted-worker), `id` (kebab-case), `name`, `version` (semver), `engines: { orca: ">=1.4.245" }` (only `>=x.y.z` grammar; format 2 needs >=1.4.245).
Optional: `$schema`, `publisher` (deprecated; derived from repo owner, local dev = `local.<id>`), `description`, `author {name,url}`, `repository`, `icon` (relative path), `main` (Node entry for worker; required by trusted-worker, events, and commands without `action`), `pluginApi` (major, 1; only for sandboxed-ui/trusted-worker), `contributes`, `capabilities: [{kind}]` (max 32), plus catalog detail/image fields.
`contributes` keys: panels (max 64), commands (256), events, languagePacks, keybindings, vmRecipes, themes, terminalThemes, iconThemes, syntaxes, customEditors, newFiles. Reserved/must be empty: agentHarnesses, skills, mcpServers, hooks, taskSources, connections, settings, statusBarItems, sidebarCards.
Panel: `{ id, title, icon?, entry }` - icon from fixed lucide list: activity bar-chart-3 bell blocks book bot bug calendar cloud code database file-text flag folder gauge globe hammer layers lightbulb package plug puzzle rocket star terminal wrench zap. entry = HTML file.
Command: `{ id, title, when?: global|workspace, action? }` - `action` aliases a built-in action (worker-less); without it, needs `main` and `orca.commands.register`.
Event: `{ on: workspace.created | workspace.removed | agent.status.changed }` (needs workspace:read / agent:read).
Capabilities: workspace:read, agent:read, terminal:send (worker only), notifications:show, storage:own, secrets:own, settings:own.

Minimal valid (panel + worker):
```json
{
  "$schema": "https://onorca.dev/schemas/orca-plugin.schema.json",
  "manifestVersion": 2,
  "execution": "trusted-worker",
  "id": "colima-manager",
  "name": "Colima Manager",
  "version": "0.1.0",
  "description": "Manage Colima and Docker from Orca.",
  "repository": "https://github.com/<owner>/orca-colima",
  "engines": { "orca": ">=1.4.245" },
  "pluginApi": 1,
  "main": "dist/main.mjs",
  "contributes": {
    "panels": [{ "id": "colima", "title": "Colima", "icon": "package", "entry": "dist/panel.html" }],
    "commands": [{ "id": "colima.refresh", "title": "Colima: Refresh" }]
  },
  "capabilities": [{ "kind": "terminal:send" }, { "kind": "workspace:read" }, { "kind": "notifications:show" }, { "kind": "storage:own" }]
}
```
($schema URL is illustrative; omit if unsure.) Omit `publisher`. Reserved: publishers stablyai/official/anthropic/openai/github/orca*, ids `orca-*`.

## Worker (trusted-worker)
- Forked as plain Node via `child_process.fork` (ELECTRON_RUN_AS_NODE=1, `execArgv: []`, sanitized env, no Node permission model). So full Node: `child_process`, fs, net. Spawning `colima`/`docker` needs NO capability, only the user approving the trusted-worker profile. PATH is a sanitized env allowlist (nOr) - may lack Homebrew paths; use absolute paths or set PATH when spawning.
- ESM module: `export default async function activate(orca)` and optional `export function deactivate()`. Timeouts: ready 10s, command invoke 30s.
- `orca` object: `orca.api {major,minor}`, `orca.commands.register(id, (args,{signal}) => ...)`, `orca.events.on(event, handler)` (both return `{dispose}`), `orca.host.call(method, params, {signal})`, `orca.host.has(method)`, `orca.grantedCapabilities`, `orca.log(msg)`.

## Host API 1 (methods)
workspace.readContext (workspace:read; all surfaces) -> `{branch, displayName, terminals:[{id}]} | null`;
terminal.sendText (terminal:send; WORKER ONLY) `{terminalId, text<=4096, enter?}`;
notifications.show (all surfaces) `{title<=120, body?}`;
storage.get/set/delete/keys (worker only; 256KB/value, 5MB total, 1024 keys); secrets.get/set/delete (worker only); settings.get/set (worker only).
Errors: invalid_request, invalid_params, unknown_method, capability_denied, consent_required, not_permitted, rate_limited, unavailable, action_failed, cancelled, timeout, conflict, too_large.

## Terminals
No API to create/open an Orca terminal. Only `terminal.sendText` into an EXISTING terminal id (from workspace.readContext of the focused workspace); no read-back of output. A plugin cannot spawn `docker exec -it` in a new Orca terminal. Options: (a) type `docker exec -it ...` into an existing terminal (user must have one open), (b) worker spawns processes itself and shows output in the panel, (c) embedding xterm in the panel (no pty bridge exists; CSP blocks network).

## Panels
- Rendered in a right-sidebar tab (activity bar, icon from the list) as a sandboxed iframe (`sandbox="allow-scripts"`, opaque origin), srcdoc wrapped with a shell. Plain HTML/JS (bundle React yourself, inline or same-file). CSP: `default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:` -> scripts/styles must be inlined, no fetch/XHR, no external resources, no links, window.open, forms, WebRTC.
- Frame name prefix `orca-plugin-panel:`. Envelope `{orca:1, kind:'req'|'res'|'evt'|'cancel', ...}` over postMessage; internal - plugins use `window.orca` (frozen): `orca.host.call/has`, `orca.on(event, fn)` (`'theme'` -> `{colorScheme}`), `orca.api`. Lifecycle: frame posts `ready`, host replies `hello` {api, methods, theme}; host `ping` every 10s, frame must `pong` within 5s (shell does it automatically; a busy loop gets demoted). Limits: 64KB/message, 30 msgs per 10s per plugin.
- Theming: `--orca-background`, `--orca-foreground`, `--orca-card`, `-popover`, `-primary`, `-secondary`, `-muted`, `-accent`, `-destructive`, `-border`, `-input`, `-ring`, `-radius` (+ `-foreground` variants); `html.light`/`html.dark` class.
- Panel <-> worker: NO direct messaging channel in Host API 1.0 (panel can call only workspace.readContext and notifications.show; storage/settings are worker-only). So a panel cannot ask the worker to run `colima status` today. Workarounds are weak: commands (palette) drive the worker, worker can post notifications or type into terminals. Verify against examples/plugins/hello-orca before relying on this; a panel that needs live data is the main blocker for a Colima UI.

## Placements / top-left menu question
- Plugin panels only go to the RIGHT sidebar activity bar (tab). No placement option (no left sidebar, editor tab or pane). `sidebarCards` and `statusBarItems` are RESERVED (must be empty) - planned future points.
- The left-sidebar nav (Search / Tasks / Automations / Orca Mobile, with "Hide from sidebar") is the renderer `SidebarNav` component in renderer/assets/App-DC4S-gZy.js; items are hardcoded (button list with i18n keys `auto.components.sidebar.SidebarNav.*`), no plugin hook. The "New" menu of the same area gets plugin `newFiles` entries only (untitled file templates). The command palette gets `commands`. Settings/Help menu (SidebarSettingsHelpMenu) is hardcoded.
- Therefore a plugin CANNOT add an item to the top-left list. Closest: right-sidebar panel with icon + a command palette entry (+ keybinding contributing `keybindings`, and a command with `action: "sidebar.right.toggle"` aliases like view.tasks / sidebar.*.toggle to open panels).

## Dev loading, packaging, release
- Settings -> Plugins -> "Turn on plugins" -> "Development folders..." (setting `devPluginPaths`, stored in the Orca settings; loads as `local.<id>`, overrides installed copy, hot reload on file change; click Restart after worker change). Code-running plugins require approval (consent shown on enable).
- CLI (per upstream docs; NOT present in the installed `orca` 1.4.245 here - `orca plugin` returned "Unknown command"): `orca plugin dev load <dir>` (`--approve <fingerprint>`), `plugin logs <publisher.id>`, `plugin dev unload`, `plugin validate`, `plugin create <dir> --template panel|theme|...`, `plugin inspect`. Upstream repo has `pnpm validate:plugin`.
- Install dir: pluginsDir under userData (`~/Library/Application Support/orca/plugins`), `<publisher>.<id>`. Bundled: Resources/plugins/launch (bundled-plugins.json empty; orca-marketplace.json lists stablyai.orca-multipass-recipes pinned git ref v1.0.0).
- Release: push to GitHub, tag `vX.Y.Z`, add topic `orca-plugin` (listed at onorca.dev/plugins/<owner>/<repo>); or catalogs (`orca-catalog.json` pinned to 40-char commit + contentHash; users add via Settings -> Plugins -> Catalog sources). Updates auto-checked every 6h; new capabilities/panels/commands need re-approval.
- Version gating: `engines.orca` (`>=x.y.z`) vs host version; `pluginApi` major must be implemented by host (currently 1, additive-only, check `orca.host.has`). Manifest v2 / newer capabilities need >=1.4.245; v1 baseline 1.4.160.

## CORRECTION (2026-11-04): panel<->worker bridge EXISTS
Host API minor 2: panel calls `window.orca.host.call("plugin.request", {name, input, timeoutMs})`; worker answers with `orca.panels.handle(name, fn)` and pushes `orca.panels.post(event, payload, panelId?)`; panel listens with `orca.on(event)`. Limits: input 64KiB, result 1MiB, post 256KiB, 200 posts/10s. Source: .../out/shared/plugins/workers/plugin-host-api-panel-methods.js and plugin-panel-bridge-protocol.js. Reference plugin: ~/Library/Application Support/orca/plugins/thailoc-dev.dev-toolbox (panel icon "wrench", right sidebar). Supersedes "no panel<->worker channel" above.

## GOTCHA (2026-11-05): listening to worker posts
Worker `orca.panels.post(event, payload)` reaches the panel ONLY through `window.orca.plugin.on(event, fn)`. `window.orca.on(event)` is for Orca domain events (workspace.changed, agent.status.changed, ...). Source: out/shared/plugins/frames/plugin-panel-shell-facades.js (`receivePush`: kind "message" fires pluginListeners).
