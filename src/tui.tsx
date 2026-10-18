/** @jsxImportSource @opentui/solid */
//
// This file is never shipped to npm as-is: `npm run build` compiles it (and
// everything it imports) into dist/tui.js with the Solid *universal* JSX
// transform baked in, and that is load-bearing. opencode's runtime Solid
// transform explicitly skips files under node_modules, so raw .tsx in a
// published install falls back to the plain jsx-runtime: the panel renders
// once with current values and never reacts again — no error, just a frozen
// panel. A path-loaded dev checkout also loads dist/tui.js through the root
// tui.js shim, so rebuild after editing.

import { Plugin } from "@opencode/plugin/tui"
import {
  type Accessor,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  For,
  getOwner,
  type Owner,
  onCleanup,
  Show,
} from "solid-js"
import type { Bead } from "./bd"
import { registerCommands, showBead } from "./commands"
import type { BeadState, PanelData, PanelItem } from "./scope"
import { createSessionController, type Target } from "./session"

/** Beads' own glyphs, from `bd statuses`, so the panel reads like the CLI. */
const GLYPH: Record<BeadState, string> = {
  closed: "✓",
  in_progress: "◐",
  blocked: "●",
  ready: "○",
  open: "○",
  deferred: "❄",
  // `bd` prints 📌 for pinned, but a double-width emoji breaks column alignment
  // in a narrow sidebar, so we use a single-width stand-in.
  pinned: "◆",
  hooked: "◇",
}

/** Rows longer than a couple of items collapse, matching the built-in panels. */
const COLLAPSE_THRESHOLD = 2

export function BeadsPanel(props: {
  api: Plugin.Context
  data: () => PanelData | undefined
  adopt: (owner: Owner | null) => void
  onSelect: (item: PanelItem) => void
}) {
  const [expanded, setExpanded] = createSignal(true)
  const theme = () => props.api.theme

  // The component body runs inside the renderer's reactive context; the slot
  // callback that created it does not. Capturing the owner here is what lets a
  // background refresh re-render the panel without "No renderer found".
  props.adopt(getOwner())
  onCleanup(() => props.adopt(null))

  const items = createMemo(() => props.data()?.items ?? [])
  const collapsible = createMemo(() => items().length > COLLAPSE_THRESHOLD)
  const visible = createMemo(() => (collapsible() && !expanded() ? [] : items()))

  const heading = createMemo(() => {
    const data = props.data()
    if (!data) return ""
    if (data.fallback) return `${data.items.length} open`
    const pct = data.total > 0 ? Math.round((data.done / data.total) * 100) : 0
    return `${pct}% (${data.done}/${data.total})`
  })

  return (
    <Show when={props.data()}>
      {(data: Accessor<PanelData>) => (
        <box>
          <box flexDirection="row" gap={1} onMouseDown={() => collapsible() && setExpanded((it) => !it)}>
            <Show when={collapsible()}>
              <text fg={theme().text.base}>{expanded() ? "▼" : "▶"}</text>
            </Show>
            <text fg={theme().text.base}>
              <b>Beads</b>
            </text>
            <Show when={data().epic}>
              {(epic: Accessor<Bead>) => (
                <text fg={theme().text.muted} wrapMode="none">
                  {epic().id}
                </text>
              )}
            </Show>
            <text fg={theme().text.muted}>{heading()}</text>
          </box>

          <For each={visible()}>{(item) => <Row api={props.api} item={item} onSelect={props.onSelect} />}</For>
        </box>
      )}
    </Show>
  )
}

function Row(props: { api: Plugin.Context; item: PanelItem; onSelect: (item: PanelItem) => void }) {
  const theme = () => props.api.theme

  // Muted by default, warning for the row
  // actually being worked on, so the eye lands on it first.
  const color = () => {
    switch (props.item.state) {
      case "in_progress":
        return theme().text.feedback.warning.base
      case "blocked":
        return theme().text.feedback.error.base
      case "ready":
        return theme().text.base
      default:
        return theme().text.muted
    }
  }

  return (
    <box flexDirection="row" gap={0} onMouseDown={() => props.onSelect(props.item)}>
      <text flexShrink={0} style={{ fg: color() }}>
        [{GLYPH[props.item.state] ?? " "}]{" "}
      </text>
      <text flexGrow={1} wrapMode="word" style={{ fg: color() }}>
        {props.item.bead.title ?? props.item.bead.id}
      </text>
    </box>
  )
}

/** V2 owns the registrations; our cleanup stops work that outlives the UI. */
export default Plugin.define({
  id: "beads-sidebar",
  setup(api) {
    const sessions = createSessionController(api)
    // Register without a detached owner so V2 can supply its Keymap provider.
    // The host owns and disposes this layer; our private root owns only effects.
    registerCommands(api, sessions.target, sessions.retry)
    return createRoot((dispose) => {
      createEffect(() => {
        const route = api.ui.router.current()
        const sessionID = route.type === "session" ? route.sessionID : undefined
        // Wait for this session's metadata rather than borrowing a stale location
        // while the host is switching routes.
        const location = sessionID ? api.data.session.get(sessionID)?.location : undefined
        void sessions.activate(sessionID, location ? { directory: location.directory } : undefined)
      })

      // Durable state is reactive and synced across TUI instances. Re-read when
      // another instance changes this session's focus, without tracking data().
      createEffect(() => {
        const target = sessions.target()
        target?.store.pinned()
        if (target) void target.store.refresh(true)
      })

      const removeSlot = api.ui.slot({
        append: "sidebar.content",
        render: (props) => (
          <Show when={sessions.target()?.sessionID === props.sessionID && sessions.target()} keyed>
            {(target: Target) => (
              <BeadsPanel
                api={api}
                data={target.store.data}
                adopt={target.store.adopt}
                onSelect={(item) => void showBead(api, target.bd, item)}
              />
            )}
          </Show>
        ),
      })
      return () => {
        removeSlot()
        sessions.dispose()
        dispose()
      }
    })
  },
})
