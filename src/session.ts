import type { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { type BdClient, createBdClient } from "./bd.ts"
import { debug } from "./debug.ts"
import { focusKey } from "./scope.ts"
import { createStore, type Store } from "./store.ts"

export type Target = { sessionID: string; bd: BdClient; store: Store }

/** One active worktree at a time; delayed lookups can never select an old session. */
export function createSessionController(api: Plugin.Context, client = createBdClient) {
  const [target, setTarget] = createSignal<Target>()
  const [focus, updateFocus] = api.storage.store<Record<string, string>>("focus", { initial: {} })
  let generation = 0
  let stop: (() => void) | undefined
  let disposed = false

  function clear() {
    generation += 1
    stop?.()
    stop = undefined
    setTarget(undefined)
  }

  async function activate(sessionID: string | undefined, location?: Plugin.Context["location"]) {
    clear()
    if (disposed || !sessionID || !location) return
    const current = generation
    try {
      // Location.directory may be a subdirectory. The public client returns
      // the actual worktree root, unlike project.canonical (the main checkout).
      const info = await api.client.location.get({ location })
      if (disposed || generation !== current) return
      const bd = client(info.project.directory)
      const key = focusKey(sessionID)
      const store = createStore(bd, {
        get: () => focus[key],
        set: async (value) => {
          try {
            await updateFocus((draft) => {
              if (value === undefined) delete draft[key]
              else draft[key] = value
            })
          } catch (error) {
            debug(`focus persistence failed: ${String(error)}`)
            api.ui.toast.show({ variant: "error", title: "beads", message: "Could not save the focus pin" })
          }
        },
      })
      stop = store.start()
      setTarget({ sessionID, bd, store })
    } catch (error) {
      // Never guess a different worktree after a failed lookup.
      debug(`worktree resolution failed: ${String(error)}`)
    }
  }

  function dispose() {
    disposed = true
    clear()
  }

  return { target, activate, dispose }
}
