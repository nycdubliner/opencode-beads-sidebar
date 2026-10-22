import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { it } from "node:test"
import { fileURLToPath } from "node:url"
import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createRoot } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { BdClient, Bead } from "../src/bd.ts"
import { focusKey } from "../src/scope.ts"
import { createSessionController } from "../src/session.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

it("deduplicates reactive focus refreshes while preserving completion and cleanup", async (t) => {
  // Node normally loads Solid's inert server runtime, which cannot exercise
  // the effect used by the TUI. Run this regression with its reactive runtime.
  if (!process.execArgv.includes("--conditions=browser")) {
    const child = spawnSync(process.execPath, ["--conditions=browser", "--test", fileURLToPath(import.meta.url)], {
      encoding: "utf8",
      timeout: 15_000,
    })
    assert.equal(child.status, 0, child.error?.message ?? child.stdout + child.stderr)
    return
  }

  const [focus, updateFocus] = createStore<Record<string, string>>({})
  let persistence: Promise<void> | undefined
  let query: Promise<Bead[] | undefined> | undefined
  let refreshes = 0
  const api = {
    storage: {
      store: () => [
        focus,
        async (mutation: (draft: Record<string, string>) => void) => {
          await persistence
          const draft = { ...focus }
          mutation(draft)
          updateFocus(reconcile(draft))
        },
      ],
    },
    client: { location: { get: async () => ({ project: { directory: "/repo" } }) } },
    ui: { toast: { show: () => assert.fail("unexpected persistence failure") } },
  } as unknown as Plugin.Context
  const bd: BdClient = {
    enabled: () => true,
    signature: () => "1:1",
    snapshot: () => "1:1",
    beginRefresh: () => {
      refreshes++
    },
    invalidate: () => {},
    lastTouchedID: () => undefined,
    ready: () => query ?? Promise.resolve([]),
    list: async () => [{ id: "task-1" }],
    get: async (id) => [{ id, issue_type: "epic" }],
    children: async () => [{ id: "task-1" }],
    epics: async () => [],
    mutate: async () => ({ ok: true }),
  }
  const sessions = createSessionController(api, () => bd)
  createRoot((dispose) => {
    t.after(dispose)
    createEffect(() => void sessions.target()?.store.refreshFocus())
  })
  t.after(sessions.dispose)
  await sessions.activate("one", { directory: "/repo" })
  await settle()
  assert.equal(refreshes, 1, "startup must query only once")
  const store = sessions.target()?.store
  assert.ok(store)

  const saved = deferred<void>()
  const result = deferred<Bead[]>()
  persistence = saved.promise
  query = result.promise
  let finished = false
  const pin = store.pin("epic-one").then(() => {
    finished = true
  })
  await settle()
  assert.equal(refreshes, 1, "wait for persistence before querying")
  saved.resolve()
  await settle()
  assert.equal(refreshes, 2, "the observer and pin share one refresh")
  assert.equal(finished, false, "pin must await the observer's refresh")
  result.resolve([])
  await pin
  await settle()
  assert.equal(store.data()?.epic?.id, "epic-one")
  assert.equal(refreshes, 2)
  persistence = undefined
  query = undefined

  await store.pin(undefined)
  await settle()
  assert.equal(refreshes, 3, "unfocus must query only once")
  updateFocus(focusKey("one"), "epic-external")
  await settle()
  assert.equal(refreshes, 4, "external focus updates must still refresh")
  assert.equal(store.data()?.epic?.id, "epic-external")
  await sessions.activate("two", { directory: "/other" })
  await settle()
  assert.equal(refreshes, 5, "a new session starts one refresh")
  updateFocus(focusKey("one"), "epic-old-session")
  await settle()
  assert.equal(refreshes, 5, "old session pins cannot refresh the active session")
  sessions.dispose()
  updateFocus(focusKey("two"), "epic-after-disposal")
  await settle()
  assert.equal(refreshes, 5, "disposal must detach the reactive observer")
})
