import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BdClient } from "./bd"
import type { PanelItem } from "./scope"
import type { Store } from "./store"

const COMMANDS = [
  "beads.focus",
  "beads.unfocus",
  "beads.start",
  "beads.close",
  "beads.reopen",
  "beads.refresh",
] as const

/**
 * Registers the palette commands.
 *
 * Actions go through a picker rather than a selection cursor because no sidebar
 * section in opencode takes keyboard focus — the built-in Todo and Modified
 * Files panels are purely presentational. A DialogSelect sidesteps focus
 * entirely and is the idiom the host's own commands use.
 */
export function registerCommands(api: TuiPluginApi, bd: BdClient, store: Store): () => void {
  /** Run a bd write, then re-read so the panel can't linger on stale state. */
  async function apply(args: string[], describe: string) {
    const result = await bd.mutate(args)
    if (!result.ok) {
      api.ui.toast({ variant: "error", title: "beads", message: result.message })
    } else {
      api.ui.toast({ variant: "success", title: "beads", message: describe })
    }
    await store.refresh(true)
  }

  function pick(title: string, items: PanelItem[], onSelect: (item: PanelItem) => void) {
    if (items.length === 0) {
      api.ui.toast({ variant: "info", title: "beads", message: "nothing to pick" })
      return
    }

    api.ui.dialog.replace(() =>
      api.ui.DialogSelect({
        title,
        options: items.map((item) => ({
          title: item.bead.title ?? item.bead.id,
          description: `${item.bead.id} · ${item.state}`,
          value: item,
        })),
        onSelect: (option) => {
          api.ui.dialog.clear()
          onSelect(option.value as PanelItem)
        },
      }),
    )
  }

  function pickFrom(title: string, filter: (item: PanelItem) => boolean, run: (item: PanelItem) => void) {
    const items = (store.data()?.items ?? []).filter(filter)
    pick(title, items, run)
  }

  const layer = api.keymap.registerLayer({
    commands: [
      {
        name: "beads.focus",
        title: "Beads: focus an epic",
        desc: "Pin the sidebar to a specific epic for this session",
        category: "Beads",
        namespace: "palette",
        slashName: "bd-focus",
        async run() {
          const epics = (await bd.epics()) ?? []
          if (epics.length === 0) {
            api.ui.toast({ variant: "info", title: "beads", message: "no epics in this workspace" })
            return
          }
          api.ui.dialog.replace(() =>
            api.ui.DialogSelect({
              title: "Focus epic",
              options: epics.map((epic) => ({
                title: epic.title ?? epic.id,
                description: `${epic.id} · ${epic.status ?? "open"}`,
                value: epic.id,
              })),
              onSelect: (option) => {
                api.ui.dialog.clear()
                store.pin(String(option.value))
              },
            }),
          )
        },
      },
      {
        name: "beads.unfocus",
        title: "Beads: clear focus",
        desc: "Go back to following whichever bead was last touched",
        category: "Beads",
        namespace: "palette",
        slashName: "bd-unfocus",
        run() {
          store.pin(undefined)
        },
      },
      {
        name: "beads.start",
        title: "Beads: start work",
        desc: "Mark a bead in progress",
        category: "Beads",
        namespace: "palette",
        slashName: "bd-start",
        run() {
          pickFrom(
            "Start work",
            (item) => item.state !== "closed" && item.state !== "in_progress",
            (item) => void apply(["update", item.bead.id, "--status", "in_progress"], `started ${item.bead.id}`),
          )
        },
      },
      {
        name: "beads.close",
        title: "Beads: close",
        desc: "Close a bead in the current plan",
        category: "Beads",
        namespace: "palette",
        slashName: "bd-close",
        run() {
          pickFrom(
            "Close bead",
            (item) => item.state !== "closed",
            (item) => void apply(["close", item.bead.id], `closed ${item.bead.id}`),
          )
        },
      },
      {
        name: "beads.reopen",
        title: "Beads: reopen",
        desc: "Reopen a closed bead",
        category: "Beads",
        namespace: "palette",
        slashName: "bd-reopen",
        run() {
          pickFrom(
            "Reopen bead",
            (item) => item.state === "closed",
            (item) => void apply(["reopen", item.bead.id], `reopened ${item.bead.id}`),
          )
        },
      },
      {
        name: "beads.refresh",
        title: "Beads: refresh",
        desc: "Re-read beads now",
        category: "Beads",
        namespace: "palette",
        slashName: "bd-refresh",
        run() {
          void store.refresh(true)
        },
      },
    ],
    bindings: api.tuiConfig.keybinds.gather("beads", [...COMMANDS]),
  })

  return typeof layer === "function" ? layer : () => {}
}

/**
 * Detail view for a bead, shown when a panel row is clicked. Read-only: the
 * mutations all live behind the palette commands above.
 */
export async function showBead(api: TuiPluginApi, bd: BdClient, item: PanelItem) {
  const bead = (await bd.show(item.bead.id))?.[0] ?? item.bead
  const lines = [
    `${bead.id}  ${bead.status ?? "open"}${bead.issue_type ? ` · ${bead.issue_type}` : ""}`,
    "",
    bead.title ?? "",
    "",
    typeof bead.description === "string" && bead.description.length > 0 ? bead.description : "(no description)",
  ]
  if (typeof bead.acceptance_criteria === "string" && bead.acceptance_criteria.length > 0) {
    lines.push("", "Acceptance:", bead.acceptance_criteria)
  }

  api.ui.dialog.replace(() =>
    api.ui.DialogAlert({
      title: bead.title ?? bead.id,
      message: lines.join("\n"),
    }),
  )
}
