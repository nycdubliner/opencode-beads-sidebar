import { createSignal, type Owner, runWithOwner } from "solid-js"
import type { BdClient } from "./bd.ts"
import { debug } from "./debug.ts"
import { type PanelData, resolveScope } from "./scope.ts"

const POLL_MS = 1_500

export type Store = ReturnType<typeof createStore>

export type Focus = {
  get: () => string | undefined
  set: (value: string | undefined) => Promise<void>
}

/**
 * Holds the panel's view of beads and keeps it fresh.
 *
 * Refreshes are driven by the bounded `.beads` directory signature rather than
 * by a timer alone, so an idle repo does not run subprocesses.
 */
export function createStore(bd: BdClient, focus: Focus) {
  const [data, setData] = createSignal<PanelData | undefined>(undefined)
  let disposed = false

  let lastSignature: string | undefined
  let inFlight = false
  /** A refresh requested while one was in flight; any number coalesce to one. */
  let pending: { force: boolean } | undefined

  /**
   * The reactive owner the sidebar slot renders under.
   *
   * Updating the signal from a timer or a promise callback would otherwise run
   * outside that owner, and @opentui/solid needs it to find the live renderer —
   * without it, re-rendering the panel throws "No renderer found" and the
   * section silently stays empty.
   */
  let owner: Owner | null = null

  function adopt(next: Owner | null) {
    owner = next
  }

  function commit(next: PanelData | undefined) {
    if (disposed) return
    if (owner) runWithOwner(owner, () => setData(next))
    else setData(next)
  }

  const pinned = () => focus.get()
  let observedFocus = pinned()
  let focusRefresh: Promise<void> | undefined

  // Both the reactive observer and a completed local write can see the same
  // change. Claim it before refreshing and share the work both callers await.
  function refreshFocus() {
    const next = pinned()
    if (next !== observedFocus) {
      observedFocus = next
      focusRefresh = refresh(true)
    }
    return focusRefresh
  }

  async function pin(epicID: string | undefined) {
    await focus.set(epicID)
    await refreshFocus()
  }

  async function refresh(force = false) {
    if (disposed) return
    // Overlapping refreshes would race to set the signal out of order, and a bd
    // call outlives a poll tick often enough for that to happen in practice.
    // A request that arrives mid-flight can't just be dropped, though: the
    // in-flight refresh holds pre-mutation data, and its final snapshot would
    // mask the change from the poll loop. Record it and re-run once instead.
    if (inFlight) {
      pending = { force: pending?.force || force }
      return
    }
    inFlight = true
    try {
      if (force) bd.invalidate()
      bd.beginRefresh()
      const next = await resolveScope(bd, pinned())
      debug(`refresh items=${next?.items.length ?? "none"} epic=${next?.epic?.id ?? "-"}`)
      commit(next)
    } catch (err) {
      debug(`refresh threw ${String(err)}`)
      commit(undefined)
    } finally {
      // Snapshot *after* querying, not before: some bd reads rewrite
      // `.beads/last-touched` themselves, and sampling first would make our own
      // queries look like an external change and refresh in a loop.
      lastSignature = bd.snapshot()
      inFlight = false
      // A rerun happens only when a request actually arrived mid-flight, so
      // this settles as soon as requests stop — no self-sustaining loop.
      if (pending && !disposed) {
        const { force: pendingForce } = pending
        pending = undefined
        void refresh(pendingForce)
      }
    }
  }

  function start(): () => void {
    void refresh(true)
    const timer = setInterval(() => {
      if (bd.signature() !== lastSignature) void refresh()
    }, POLL_MS)
    return () => {
      disposed = true
      pending = undefined
      owner = null
      clearInterval(timer)
    }
  }

  return { data, refresh, refreshFocus, start, pin, pinned, adopt }
}
