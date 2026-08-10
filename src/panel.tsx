/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, For, getOwner, Show, type Accessor, type Owner } from "solid-js"
import type { Bead } from "./bd"
import type { BeadState, PanelData, PanelItem } from "./scope"

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
  api: TuiPluginApi
  data: () => PanelData | undefined
  adopt: (owner: Owner | null) => void
  onSelect: (item: PanelItem) => void
}) {
  const [expanded, setExpanded] = createSignal(true)
  const theme = () => props.api.theme.current

  // The component body runs inside the renderer's reactive context; the slot
  // callback that created it does not. Capturing the owner here is what lets a
  // background refresh re-render the panel without "No renderer found".
  props.adopt(getOwner())

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
          <box
            flexDirection="row"
            gap={1}
            onMouseDown={() => collapsible() && setExpanded((it) => !it)}
          >
            <Show when={collapsible()}>
              <text fg={theme().text}>{expanded() ? "▼" : "▶"}</text>
            </Show>
            <text fg={theme().text}>
              <b>Beads</b>
            </text>
            <Show when={data().epic}>
              {(epic: Accessor<Bead>) => (
                <text fg={theme().textMuted} wrapMode="none">
                  {epic().id}
                </text>
              )}
            </Show>
            <text fg={theme().textMuted}>{heading()}</text>
          </box>

          <For each={visible()}>
            {(item) => <Row api={props.api} item={item} onSelect={props.onSelect} />}
          </For>
        </box>
      )}
    </Show>
  )
}

function Row(props: { api: TuiPluginApi; item: PanelItem; onSelect: (item: PanelItem) => void }) {
  const theme = () => props.api.theme.current

  // Mirrors the built-in Todo panel: muted by default, warning for the row
  // actually being worked on, so the eye lands on it first.
  const color = () => {
    switch (props.item.state) {
      case "in_progress":
        return theme().warning
      case "blocked":
        return theme().error
      case "ready":
        return theme().text
      default:
        return theme().textMuted
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
