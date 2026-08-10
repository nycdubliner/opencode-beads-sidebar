# opencode-beads-sidebar

Shows the current [beads](https://github.com/gastownhall/beads) plan — and how far
through it you are — in the opencode sidebar, the way the built-in Todo panel
shows opencode's own ephemeral todos.

```
▼ Beads bt-avj 75% (3/4)
[✓] Extract dice geometry
[✓] Add face normals
[✓] Numerals flush with surface
[○] Update smoke test
```

It sits alongside the built-in Todo panel rather than replacing it: todos stay
useful for within-turn steps, while beads carries the durable plan the agent and
you both work from.

This is a TUI plugin only. It composes with
[`opencode-beads`](https://github.com/joshuadavidthomas/opencode-beads), which
handles the server side (context injection, `/bd-*` commands, task agent) and
renders nothing.

## Install

Requires `bd` on `PATH` and opencode ≥ 1.18.

```bash
git clone <this repo> ~/git/beadmanager
cd ~/git/beadmanager && npm install
```

Add the path to `~/.config/opencode/tui.json` (**not** `opencode.json` — TUI
plugins are configured separately):

```json
{
  "plugin": ["/Users/you/git/beadmanager"]
}
```

## What it shows

The panel picks a scope in this order:

1. an epic pinned for the session with **Beads: focus an epic**
2. the epic owning the bead `bd` last touched — this is what makes the panel
   follow the agent as it works
3. otherwise, workspace-wide in-progress and ready work

If the repo has no `.beads` directory the section renders nothing at all.

Glyphs follow `bd statuses`, so the panel reads like the CLI:

| glyph | meaning |
|---|---|
| `✓` | closed |
| `◐` | in progress |
| `○` | ready — open with no active blocker |
| `●` | blocked |
| `❄` | deferred |

Blockedness is derived, not stored: beads leaves a blocked issue's status as
`open`, so anything open that `bd ready` does not return is treated as blocked.

## Commands

All available from the command palette (`ctrl+p`) and as slash commands.

| command | slash | what it does |
|---|---|---|
| Beads: focus an epic | `/bd-focus` | pin the panel to one epic for this session |
| Beads: clear focus | `/bd-unfocus` | go back to following the last-touched bead |
| Beads: start work | `/bd-start` | `bd update <id> --status in_progress` |
| Beads: close | `/bd-close` | `bd close <id>` |
| Beads: reopen | `/bd-reopen` | `bd reopen <id>` |
| Beads: refresh | `/bd-refresh` | drop the cache and re-read |

Clicking a row opens that bead's detail. Actions go through a picker rather than
a selection cursor because no sidebar section in opencode takes keyboard focus.

Bindings are user-overridable from `tui.json` under `keybinds`, gathered from the
`beads` group.

## Notes for anyone editing this

Three things here are load-bearing and non-obvious. All three were found the
hard way; each produces a silently empty panel rather than an error.

**`store.tsx` must stay `.tsx`, with its `@jsxImportSource` pragma.** opencode
only routes files through the `@opentui/solid` transform when they look like
JSX. A signal created in a plain `.ts` module belongs to a *different* Solid
instance than the panel's memos, so it updates and nothing re-renders.

**Background refreshes must run under the panel's reactive owner.** The store
captures `getOwner()` from inside the component body — not from the slot
callback, which runs outside the tracking scope — and wraps updates in
`runWithOwner`. Without it, re-rendering throws `No renderer found`.

**`@opentui/*` versions must match what opencode itself runs** (0.4.1 for
opencode 1.18.x; compare against `~/.cache/opencode/packages/*/node_modules`).
A mismatch means the host rejects this plugin's nodes and the slot stays blank.
Because opencode does not install dependencies for path-loaded plugins, the
local `node_modules` is what actually gets used at runtime.

Set `BEADS_SIDEBAR_DEBUG=/path/to/log` to trace refreshes, scope resolution and
pinning.

## Change detection

The panel polls a signature of the `.beads` directory (newest mtime, depth- and
count-capped) rather than shelling out to `bd`, which costs ~0.4s per call.

`.beads/last-touched` looks like the obvious signal but is not one: it records
the bead you last *viewed*, so `bd show` rewrites it while `bd close` does not.
It is still used to decide which epic to follow, just not to detect change. One
consequence: closing a bead from the CLI updates progress immediately, but does
not by itself move the panel's attention to a different epic.
