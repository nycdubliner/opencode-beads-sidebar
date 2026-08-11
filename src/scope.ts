import type { BdClient, Bead } from "./bd"

/** Beads' own status vocabulary, from `bd statuses`. */
export type BeadState = "closed" | "in_progress" | "blocked" | "ready" | "open" | "deferred" | "pinned" | "hooked"

export type PanelItem = {
  bead: Bead
  state: BeadState
}

export type PanelData = {
  /** The epic the plan hangs off, when there is one. */
  epic?: Bead
  items: PanelItem[]
  done: number
  total: number
  /** True when we fell back to workspace-wide work rather than a real plan. */
  fallback: boolean
}

export function focusKey(sessionID: string): string {
  return `beads.focus.${sessionID}`
}

/**
 * Work out which beads make up "the current plan", in priority order:
 *
 *   1. an epic pinned for this session via `/bd-focus`
 *   2. the epic owning the bead bd last touched (or that bead, if it is itself
 *      an epic) — this is what makes the panel follow the agent automatically
 *   3. workspace-wide in-progress + ready work, when there is no epic to hang
 *      the view off
 *
 * Returns undefined when there is nothing worth drawing, so the caller can omit
 * the section entirely rather than render an empty box.
 */
export async function resolveScope(bd: BdClient, pinned: string | undefined): Promise<PanelData | undefined> {
  if (!bd.enabled()) return undefined

  const ready = new Set(((await bd.ready()) ?? []).map((it) => it.id))

  if (pinned) {
    const scoped = await epicScope(bd, pinned, ready)
    // A pin that no longer resolves (bead deleted, wrong worktree) falls
    // through to auto-follow rather than leaving the panel stuck empty.
    if (scoped) return scoped
  }

  const touched = bd.lastTouchedID()
  if (touched) {
    const bead = (await bd.get(touched))?.[0]
    if (bead) {
      const epicID = bead.issue_type === "epic" ? bead.id : bead.parent
      if (typeof epicID === "string" && epicID.length > 0) {
        const scoped = await epicScope(bd, epicID, ready)
        if (scoped) return scoped
      }
    }
  }

  return workspaceScope(bd, ready)
}

async function epicScope(bd: BdClient, epicID: string, ready: Set<string>): Promise<PanelData | undefined> {
  const epic = (await bd.get(epicID))?.[0]
  if (!epic) return undefined

  const children = (await bd.children(epicID)) ?? []
  if (children.length === 0) return undefined

  const items = children
    .filter((it) => it.id !== epicID)
    .sort(byID)
    .map((bead) => ({ bead, state: stateOf(bead, ready) }))

  return {
    epic,
    items,
    done: items.filter((it) => it.state === "closed").length,
    total: items.length,
    fallback: false,
  }
}

async function workspaceScope(bd: BdClient, ready: Set<string>): Promise<PanelData | undefined> {
  const open = (await bd.list()) ?? []
  const items = open
    .filter((it) => it.issue_type !== "epic")
    .map((bead) => ({ bead, state: stateOf(bead, ready) }))
    .sort(byUrgency)

  if (items.length === 0) return undefined

  return {
    items,
    // Without an epic there is no meaningful denominator, so the header shows a
    // count rather than a percentage.
    done: items.filter((it) => it.state === "closed").length,
    total: items.length,
    fallback: true,
  }
}

/**
 * Beads stores `open` for work that is blocked by a dependency — blockedness is
 * derived from the dependency graph, not written to the row. An open bead that
 * `bd ready` did not return is therefore blocked by something.
 */
export function stateOf(bead: Bead, ready: Set<string>): BeadState {
  const status = typeof bead.status === "string" ? bead.status : "open"

  switch (status) {
    case "closed":
      return "closed"
    case "in_progress":
      return "in_progress"
    case "blocked":
      return "blocked"
    case "deferred":
      return "deferred"
    case "pinned":
      return "pinned"
    case "hooked":
      return "hooked"
    default:
      return ready.has(bead.id) ? "ready" : "blocked"
  }
}

/**
 * Plan order. Children of an epic get sequential ids (`bt-avj.1`, `bt-avj.2`),
 * so id order is the order the plan was written in — which is what makes the
 * panel read as progress moving down a list. Deliberately does not sink closed
 * items to the bottom: that would destroy the very reading we want.
 */
function byID(a: Bead, b: Bead): number {
  return a.id.localeCompare(b.id, undefined, { numeric: true })
}

/** Workspace fallback has no plan order, so surface the most actionable first. */
function byUrgency(a: PanelItem, b: PanelItem): number {
  const rank = (item: PanelItem) =>
    item.state === "in_progress" ? 0 : item.state === "ready" ? 1 : item.state === "blocked" ? 2 : 3
  const byRank = rank(a) - rank(b)
  if (byRank !== 0) return byRank
  return byID(a.bead, b.bead)
}
