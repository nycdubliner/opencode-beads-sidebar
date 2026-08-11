/** @jsxImportSource @opentui/solid */
//
// This file is `.tsx` with a jsxImportSource pragma even though it renders
// nothing, and that is load-bearing. opencode only routes files through the
// @opentui/solid transform when they look like JSX, and files that miss it
// resolve `solid-js` to a *different* instance. A signal created in a plain
// `.ts` module is invisible to memos in the panel: it updates, and nothing
// re-renders, silently. Keep the extension and the pragma.
import { createSignal, runWithOwner, type Owner } from "solid-js"
import type { BdClient } from "./bd"
import { debug } from "./debug"
import { focusKey, resolveScope, type PanelData } from "./scope"

/** How often we stat `.beads/last-touched` looking for changes. */
const POLL_MS = 1_500

export type Store = ReturnType<typeof createStore>

type Kv = {
  get: <Value = unknown>(key: string, fallback?: Value) => Value
  set: (key: string, value: unknown) => void
}

/**
 * Holds the panel's view of beads and keeps it fresh.
 *
 * Refreshes are driven by the mtime of `.beads/last-touched` rather than by a
 * timer alone, so an idle repo costs one `stat` per tick and no subprocesses.
 */
export function createStore(bd: BdClient, kv: Kv) {
  const [data, setData] = createSignal<PanelData | undefined>(undefined)
  const [sessionID, setSessionID] = createSignal<string | undefined>(undefined)

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
    if (next) owner = next
  }

  function commit(next: PanelData | undefined) {
    if (owner) runWithOwner(owner, () => setData(next))
    else setData(next)
  }

  function pinned(): string | undefined {
    const id = sessionID()
    if (!id) return undefined
    const value = kv.get<string>(focusKey(id), "")
    return typeof value === "string" && value.length > 0 ? value : undefined
  }

  function pin(epicID: string | undefined) {
    const id = sessionID()
    if (!id) return
    debug(`pin epic=${epicID ?? "-"} session=${id}`)
    // TuiKV (see @opencode-ai/plugin's tui.d.ts) exposes only get/set, no
    // delete — unfocus can't remove the key, so a dead session's entry
    // lingers in the host's persistent kv for good. Writing "" is the closest
    // available approximation of "unset".
    kv.set(focusKey(id), epicID ?? "")
    void refresh(true)
  }

  async function refresh(force = false) {
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
      if (pending) {
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
    return () => clearInterval(timer)
  }

  return { data, refresh, start, pin, pinned, sessionID, setSessionID, adopt }
}
