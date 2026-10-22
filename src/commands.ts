import type { Plugin } from "@opencode/plugin/tui"
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
 * Registers the palette and slash commands in a host-owned global keymap layer.
 * Each invocation captures its session's client and store before awaiting a
 * picker, so changing sessions cannot redirect an in-flight action.
 */
export function registerCommands(
  api: Plugin.Context,
  target: () => { bd: BdClient; store: Store } | undefined,
  retryLocation?: () => Promise<void>,
): void {
  /** Run a bd write, then re-read so the panel can't linger on stale state. */
  async function apply(bd: BdClient, store: Store, id: string, args: string[], describe: string) {
    const result = await bd.mutate(id, args)
    if (!result.ok) {
      api.ui.toast.show({ variant: "error", title: "beads", message: result.message })
    } else {
      api.ui.toast.show({ variant: "success", title: "beads", message: describe })
    }
    await store.refresh(true)
  }

  async function pick(title: string, items: PanelItem[]): Promise<PanelItem | undefined> {
    if (items.length === 0) {
      api.ui.toast.show({ variant: "info", title: "beads", message: "nothing to pick" })
      return
    }

    return api.ui.dialog.select({
      title,
      options: items.map((item) => ({
        title: item.bead.title ?? item.bead.id,
        description: `${item.bead.id} · ${item.state}`,
        value: item,
      })),
    })
  }

  api.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "beads.focus",
        title: "Beads: focus an epic",
        description: "Pin the sidebar to a specific epic for this session",
        group: "Beads",
        palette: true,
        slash: { name: "bd-focus" },
        async run() {
          const current = target()
          if (!current) return
          const { bd, store } = current
          const epics = (await bd.epics()) ?? []
          if (epics.length === 0) {
            api.ui.toast.show({ variant: "info", title: "beads", message: "no epics in this workspace" })
            return
          }
          const id = await api.ui.dialog.select({
            title: "Focus epic",
            options: epics.map((epic) => ({
              title: epic.title ?? epic.id,
              description: `${epic.id} · ${epic.status ?? "open"}`,
              value: epic.id,
            })),
          })
          if (id !== undefined) await store.pin(id)
        },
      },
      {
        id: "beads.unfocus",
        title: "Beads: clear focus",
        description: "Go back to following whichever bead was last touched",
        group: "Beads",
        palette: true,
        slash: { name: "bd-unfocus" },
        async run() {
          const current = target()
          if (!current) return
          await current.store.pin(undefined)
        },
      },
      {
        id: "beads.start",
        title: "Beads: start work",
        description: "Mark a bead in progress",
        group: "Beads",
        palette: true,
        slash: { name: "bd-start" },
        async run() {
          const current = target()
          if (!current) return
          const { bd, store } = current
          const items = (store.data()?.items ?? []).filter(
            (item) => item.state !== "closed" && item.state !== "in_progress",
          )
          const item = await pick("Start work", items)
          if (item) {
            await apply(
              bd,
              store,
              item.bead.id,
              ["update", item.bead.id, "--status", "in_progress"],
              `started ${item.bead.id}`,
            )
          }
        },
      },
      {
        id: "beads.close",
        title: "Beads: close",
        description: "Close a bead in the current plan",
        group: "Beads",
        palette: true,
        slash: { name: "bd-close" },
        async run() {
          const current = target()
          if (!current) return
          const { bd, store } = current
          const items = (store.data()?.items ?? []).filter((item) => item.state !== "closed")
          const item = await pick("Close bead", items)
          if (item) await apply(bd, store, item.bead.id, ["close", item.bead.id], `closed ${item.bead.id}`)
        },
      },
      {
        id: "beads.reopen",
        title: "Beads: reopen",
        description: "Reopen a closed bead",
        group: "Beads",
        palette: true,
        slash: { name: "bd-reopen" },
        async run() {
          const current = target()
          if (!current) return
          const { bd, store } = current
          // Workspace fallback's items come from an unfiltered `bd list`, which
          // only returns open issues — so there is usually nothing closed to
          // pick from without asking bd directly. Epic scope already includes
          // closed children, so this only fires when it has to.
          const closed = (store.data()?.items ?? []).filter((item) => item.state === "closed")
          const items =
            closed.length > 0
              ? closed
              : ((await bd.list(["--status", "closed"])) ?? []).map((bead) => ({ bead, state: "closed" as const }))
          const item = await pick("Reopen bead", items)
          if (item) await apply(bd, store, item.bead.id, ["reopen", item.bead.id], `reopened ${item.bead.id}`)
        },
      },
      {
        id: "beads.refresh",
        title: "Beads: refresh",
        description: "Re-read beads now",
        group: "Beads",
        palette: true,
        slash: { name: "bd-refresh" },
        async run() {
          const current = target()
          if (current) await current.store.refresh(true)
          else await retryLocation?.()
        },
      },
    ],
    bindings: COMMANDS,
  }))
}

/**
 * Detail view for a bead, shown when a panel row is clicked. Read-only: the
 * mutations all live behind the palette commands above.
 */
export async function showBead(api: Plugin.Context, bd: BdClient, item: PanelItem) {
  const bead = (await bd.get(item.bead.id))?.[0] ?? item.bead
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

  await api.ui.dialog.alert({
    title: bead.title ?? bead.id,
    message: lines.join("\n"),
  })
}
