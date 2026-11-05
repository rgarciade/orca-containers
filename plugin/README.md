# Colima for Orca

Manage the [Colima](https://github.com/abiosoft/colima) VM and the Docker containers of the
worktree you are working in, from a panel in [Orca](https://www.onorca.dev)'s right sidebar.

## Features

| Area | What you get |
| --- | --- |
| **Colima VM** | Status (CPU, memory, disk, runtime, arch). Start with a chosen number of CPUs and GB of memory, remembered for next time. Stop and restart, each with a confirmation click. |
| **Compose** | The Compose stacks of the active worktree, found from container labels and from compose files in the worktree root. Up, Restart and Down (never removes volumes; Down asks for confirmation). Long operations run in the background. |
| **Containers** | Only the containers whose Compose working directory is inside the active worktree. Status, CPU and memory usage, start/stop, and a shell in a new Orca terminal. |
| **Ports** | Published ports as chips (`host port → container port`); internal-only ports are shown dashed. Click a chip to copy `host:port`. |
| **Logs** | *Live* mode follows the container's output with timestamps. *History* mode pages back through older lines and searches the whole log (plain text, optional case sensitivity), with a jump to the context around any match. |

The panel follows workspace switches: when you move to another worktree it shows that
worktree's stacks and containers.

## Requirements

- macOS with [Colima](https://github.com/abiosoft/colima) and the Docker CLI with the Compose plugin
  (`brew install colima docker docker-compose`).
- Orca 1.4.246 or later.

`colima`, `docker` and `orca` are looked up on `PATH`, then in `/opt/homebrew/bin` and
`/usr/local/bin`. Docker is reached through the Colima socket
(`~/.colima/default/docker.sock`).

## Install

Settings → Plugins → **Development folders…** → add this `plugin/` folder, then approve the
plugin. Open the **Colima** panel (package icon) in the right sidebar.

## How the active worktree is found

Orca tells plugins the focused workspace's branch, name and terminals, but not its path. The
plugin maps an open terminal to its worktree, which always works. Without a terminal it matches
the branch and name against Orca's worktree list; when several worktrees share them (for
example, many repositories on `dev` with the automatic name `dev`), the panel asks you to open a
terminal. Giving the worktree a unique name in Orca also resolves it.

## Permissions

| Capability | Why |
| --- | --- |
| `workspace:read` | Know which worktree is focused. |
| `storage:own` | Remember the CPU and memory chosen for the VM. |
| `notifications:show` | Confirm the **Colima: refresh** palette command. |

The worker runs `colima`, `docker` and the `orca` CLI as child processes without a shell, except
for the terminal commands (shell and log watchdog), which only receive validated container ids
and quoted paths. Actions are limited to containers of the active worktree. Log processes are
stopped when you close the log view, about 15 seconds after the panel closes, and when the
worker exits, even if it is killed abruptly.

## Files

- `orca-plugin.json`: manifest.
- `worker.mjs`: runs Colima, Docker and Orca CLI commands and answers the panel.
- `panel/index.html`: the sidebar panel.

## Licence

MIT. See [LICENSE](LICENSE).
