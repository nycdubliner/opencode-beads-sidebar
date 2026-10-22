import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Plugin } from "@opencode/plugin/tui"
import type { BdClient } from "../src/bd.ts"
import { focusKey } from "../src/scope.ts"
import { createSessionController } from "../src/session.ts"

type Location = NonNullable<Plugin.Context["location"]>
type LocationInfo = Awaited<ReturnType<Plugin.Context["client"]["location"]["get"]>>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function info(directory: string, worktree = directory, canonical = worktree): LocationInfo {
  return { directory, project: { id: "project-1", directory: worktree, canonical } }
}

function fakeApi(
  lookup: (location: Location) => Promise<LocationInfo> = async (location) => info(location.directory),
  focus: Record<string, string> = {},
) {
  const requests: Location[] = []
  const stores: string[] = []
  const toasts: { message: string; variant?: string }[] = []
  let writes = 0
  let write: ((mutation: (draft: Record<string, string>) => void) => Promise<void>) | undefined
  const api = {
    client: {
      location: {
        get: async ({ location }: { location: Location }) => {
          requests.push(location)
          return lookup(location)
        },
      },
    },
    storage: {
      store: (key: string, _options: { initial: Record<string, string> }) => {
        stores.push(key)
        return [
          focus,
          async (mutation: (draft: Record<string, string>) => void) => {
            writes++
            if (write) await write(mutation)
            else mutation(focus)
          },
        ] as const
      },
    },
    ui: { toast: { show: (toast: { message: string; variant?: string }) => toasts.push(toast) } },
  }
  return {
    api: api as unknown as Plugin.Context,
    requests,
    stores,
    focus,
    toasts,
    writes: () => writes,
    setWrite: (next: typeof write) => {
      write = next
    },
  }
}

function clients() {
  const roots: string[] = []
  const polls = new Map<string, number>()
  const create = (root: string): BdClient => {
    roots.push(root)
    return {
      enabled: () => false,
      signature: () => {
        polls.set(root, (polls.get(root) ?? 0) + 1)
        return "0:0"
      },
      beginRefresh: () => {},
      snapshot: () => "0:0",
      lastTouchedID: () => undefined,
      invalidate: () => {},
      mutate: async () => ({ ok: true }),
      children: async () => undefined,
      get: async () => undefined,
      ready: async () => [],
      list: async () => undefined,
      epics: async () => undefined,
    }
  }
  return { create, roots, polls }
}

describe("session controller", () => {
  it("uses the returned worktree root, not the session subdirectory or main checkout", async (t) => {
    const fake = fakeApi(async () => info("/linked/src", "/linked", "/main"))
    const bd = clients()
    const controller = createSessionController(fake.api, bd.create)
    t.after(controller.dispose)

    const location = { directory: "/linked/src", workspaceID: "workspace-1" }
    await controller.activate("session-1", location)

    assert.deepEqual(fake.requests, [location])
    assert.deepEqual(bd.roots, ["/linked"])
    assert.equal(controller.target()?.sessionID, "session-1")
    assert.deepEqual(fake.stores, ["focus"])
  })

  it("does not create a client without both a session and a location", async (t) => {
    const fake = fakeApi()
    const bd = clients()
    const controller = createSessionController(fake.api, bd.create)
    t.after(controller.dispose)

    await controller.activate(undefined, { directory: "/repo" })
    await controller.activate("session-1")

    assert.deepEqual(fake.requests, [])
    assert.deepEqual(bd.roots, [])
    assert.equal(controller.target(), undefined)
  })

  it("ignores an older lookup that completes after a newer session", async (t) => {
    const older = deferred<LocationInfo>()
    const fake = fakeApi((location) => (location.directory === "/old" ? older.promise : Promise.resolve(info("/new"))))
    const bd = clients()
    const controller = createSessionController(fake.api, bd.create)
    t.after(controller.dispose)

    const pending = controller.activate("old", { directory: "/old" })
    await controller.activate("new", { directory: "/new" })
    older.resolve(info("/old"))
    await pending

    assert.equal(controller.target()?.sessionID, "new")
    assert.deepEqual(bd.roots, ["/new"])
  })

  it("does not clear the new target when an older lookup fails", async (t) => {
    const older = deferred<LocationInfo>()
    const fake = fakeApi((location) => (location.directory === "/old" ? older.promise : Promise.resolve(info("/new"))))
    const bd = clients()
    const controller = createSessionController(fake.api, bd.create)
    t.after(controller.dispose)

    const pending = controller.activate("old", { directory: "/old" })
    await controller.activate("new", { directory: "/new" })
    older.reject(new Error("old location disappeared"))
    await pending

    assert.equal(controller.target()?.sessionID, "new")
    assert.deepEqual(bd.roots, ["/new"])
  })

  it("cancels a lookup when navigating away from a session", async (t) => {
    const pending = deferred<LocationInfo>()
    const fake = fakeApi(() => pending.promise)
    const bd = clients()
    const controller = createSessionController(fake.api, bd.create)
    t.after(controller.dispose)

    const activation = controller.activate("session-1", { directory: "/repo" })
    await controller.activate(undefined)
    pending.resolve(info("/repo"))
    await activation

    assert.equal(controller.target(), undefined)
    assert.deepEqual(bd.roots, [])
  })

  it("never creates clients after disposal, including from an in-flight lookup", async () => {
    const pending = deferred<LocationInfo>()
    const fake = fakeApi(() => pending.promise)
    const bd = clients()
    const controller = createSessionController(fake.api, bd.create)

    const activation = controller.activate("session-1", { directory: "/repo" })
    controller.dispose()
    controller.dispose()
    pending.resolve(info("/repo"))
    await activation
    await controller.activate("session-2", { directory: "/other" })

    assert.equal(controller.target(), undefined)
    assert.equal(fake.requests.length, 1)
    assert.deepEqual(bd.roots, [])
  })

  it("stops old polling immediately while resolving a new location, then stops everything on disposal", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] })
    const pending = deferred<LocationInfo>()
    const fake = fakeApi((location) =>
      location.directory === "/new" ? pending.promise : Promise.resolve(info("/old")),
    )
    const bd = clients()
    const controller = createSessionController(fake.api, bd.create)
    t.after(controller.dispose)
    await controller.activate("old", { directory: "/old" })
    await settle()
    t.mock.timers.tick(1_500)
    assert.equal(bd.polls.get("/old"), 1)

    const activation = controller.activate("new", { directory: "/new" })
    assert.equal(controller.target(), undefined)
    t.mock.timers.tick(3_000)
    assert.equal(bd.polls.get("/old"), 1)

    pending.resolve(info("/new"))
    await activation
    await settle()
    t.mock.timers.tick(1_500)
    assert.equal(bd.polls.get("/new"), 1)
    controller.dispose()
    t.mock.timers.tick(3_000)
    assert.equal(bd.polls.get("/new"), 1)
    assert.equal(controller.target(), undefined)
  })

  it("fails closed instead of falling back to the previous worktree", async (t) => {
    const fake = fakeApi(async (location) => {
      if (location.directory === "/missing") throw new Error("not found")
      return info(location.directory)
    })
    const bd = clients()
    const controller = createSessionController(fake.api, bd.create)
    t.after(controller.dispose)
    await controller.activate("old", { directory: "/old" })
    await controller.activate("new", { directory: "/missing" })

    assert.equal(controller.target(), undefined)
    assert.deepEqual(bd.roots, ["/old"])
  })

  it("keeps focus separate per session and restores it across controller reloads", async (t) => {
    const fake = fakeApi()
    const bd = clients()
    const controller = createSessionController(fake.api, bd.create)
    t.after(controller.dispose)
    await controller.activate("one", { directory: "/repo" })
    await controller.target()?.store.pin("epic-one")
    await controller.activate("two", { directory: "/repo" })
    assert.equal(controller.target()?.store.pinned(), undefined)
    await controller.target()?.store.pin("epic-two")
    await controller.activate("one", { directory: "/repo" })
    assert.equal(controller.target()?.store.pinned(), "epic-one")
    controller.dispose()

    const reloaded = createSessionController(fake.api, bd.create)
    t.after(reloaded.dispose)
    await reloaded.activate("two", { directory: "/repo" })
    assert.equal(reloaded.target()?.store.pinned(), "epic-two")
    assert.deepEqual(fake.focus, { [focusKey("one")]: "epic-one", [focusKey("two")]: "epic-two" })
  })

  it("clears a pin by deleting only the current session key", async (t) => {
    const fake = fakeApi(undefined, { [focusKey("one")]: "epic-one", [focusKey("two")]: "epic-two" })
    const controller = createSessionController(fake.api, clients().create)
    t.after(controller.dispose)
    await controller.activate("one", { directory: "/repo" })
    await controller.target()?.store.pin(undefined)

    assert.equal(controller.target()?.store.pinned(), undefined)
    assert.equal(Object.hasOwn(fake.focus, focusKey("one")), false)
    assert.deepEqual(fake.focus, { [focusKey("two")]: "epic-two" })
    assert.equal(fake.writes(), 1)
  })

  it("awaits durable persistence and reports a failed write without losing the old pin", async (t) => {
    const fake = fakeApi(undefined, { [focusKey("one")]: "epic-old" })
    const pending = deferred<void>()
    fake.setWrite(async (mutation) => {
      await pending.promise
      mutation(fake.focus)
    })
    const controller = createSessionController(fake.api, clients().create)
    t.after(controller.dispose)
    await controller.activate("one", { directory: "/repo" })
    const store = controller.target()?.store
    assert.ok(store)

    const pin = store.pin("epic-new")
    assert.equal(store.pinned(), "epic-old")
    pending.resolve()
    await pin
    assert.equal(store.pinned(), "epic-new")

    fake.setWrite(async () => {
      throw new Error("disk full")
    })
    await store.pin("epic-unsaved")
    assert.equal(store.pinned(), "epic-new")
    assert.deepEqual(fake.toasts, [{ variant: "error", title: "beads", message: "Could not save the focus pin" }])
  })
})

it("retries a transient location failure without requiring navigation", async (t) => {
  let attempts = 0
  const fake = fakeApi(async (location) => {
    if (++attempts === 1) throw new Error("temporarily unavailable")
    return info(location.directory)
  })
  const controller = createSessionController(fake.api, clients().create)
  t.after(controller.dispose)
  await controller.activate("one", { directory: "/repo" })
  assert.equal(controller.target(), undefined)
  await controller.retry()
  assert.equal(controller.target()?.sessionID, "one")
  assert.equal(attempts, 2)
})

it("never retries a departed session or restarts a disposed controller", async () => {
  const fake = fakeApi(async () => {
    throw new Error("offline")
  })
  const controller = createSessionController(fake.api, clients().create)
  await controller.activate("one", { directory: "/old" })
  await controller.activate(undefined)
  await controller.retry()
  assert.equal(fake.requests.length, 1)
  await controller.activate("two", { directory: "/new" })
  controller.dispose()
  await controller.retry()
  assert.equal(fake.requests.length, 2)
})
