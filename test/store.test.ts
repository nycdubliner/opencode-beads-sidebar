import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { BdClient, Bead } from "../src/bd.ts"
import { createStore, type Focus } from "../src/store.ts"

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

function fakeBd(overrides: Partial<BdClient> = {}) {
  const calls = { begin: 0, snapshots: 0, invalidate: 0, polls: 0 }
  let signature = "1:1"
  const bd: BdClient = {
    enabled: () => true,
    signature: () => {
      calls.polls++
      return signature
    },
    beginRefresh: () => {
      calls.begin++
    },
    snapshot: () => {
      calls.snapshots++
      return signature
    },
    lastTouchedID: () => undefined,
    invalidate: () => {
      calls.invalidate++
    },
    mutate: async () => ({ ok: true }),
    children: async () => undefined,
    get: async () => undefined,
    ready: async () => [{ id: "task-1" }],
    list: async () => [{ id: "task-1", title: "Current task", status: "open" }],
    epics: async () => undefined,
    ...overrides,
  }
  return {
    bd,
    calls,
    signature: (next: string) => {
      signature = next
    },
  }
}

function focus(initial?: string): Focus {
  let value = initial
  return {
    get: () => value,
    set: async (next) => {
      value = next
    },
  }
}

describe("beads store", () => {
  it("refreshes the current pinned epic and exposes durable focus changes", async () => {
    const pins = focus("epic-one")
    const lookups: string[] = []
    const fake = fakeBd({
      get: async (id) => {
        lookups.push(id)
        return [{ id, title: id, issue_type: "epic" }]
      },
      children: async (id) => [{ id: `${id}.1`, status: "closed" }],
    })
    const store = createStore(fake.bd, pins)

    await store.refresh()
    assert.equal(store.data()?.epic?.id, "epic-one")
    assert.equal(store.data()?.done, 1)
    await store.pin("epic-two")
    assert.equal(store.pinned(), "epic-two")
    assert.equal(store.data()?.epic?.id, "epic-two")
    assert.deepEqual(lookups, ["epic-one", "epic-two"])
    assert.equal(fake.calls.invalidate, 1)

    await pins.set("epic-external")
    assert.equal(store.pinned(), "epic-external")
    await store.refresh()
    assert.equal(store.data()?.epic?.id, "epic-external")
  })

  it("waits for focus persistence before starting its forced refresh", async () => {
    const pending = deferred<void>()
    let value: string | undefined
    const fake = fakeBd()
    const store = createStore(fake.bd, {
      get: () => value,
      set: async (next) => {
        await pending.promise
        value = next
      },
    })

    const pin = store.pin("epic-one")
    assert.equal(fake.calls.begin, 0)
    assert.equal(store.pinned(), undefined)
    pending.resolve()
    await pin
    assert.equal(store.pinned(), "epic-one")
    assert.equal(fake.calls.begin, 1)
    assert.equal(fake.calls.invalidate, 1)
  })

  it("does not refresh when its persistence adapter rejects", async () => {
    const fake = fakeBd()
    const store = createStore(fake.bd, {
      get: () => "old",
      set: async () => {
        throw new Error("cannot persist")
      },
    })

    await assert.rejects(store.pin("new"), /cannot persist/)
    assert.equal(store.pinned(), "old")
    assert.equal(fake.calls.begin, 0)
  })

  it("coalesces overlapping refreshes into one extra pass and preserves a forced request", async () => {
    const first = deferred<Bead[] | undefined>()
    let readyCalls = 0
    const fake = fakeBd({ ready: () => (++readyCalls === 1 ? first.promise : Promise.resolve([])) })
    const store = createStore(fake.bd, focus())

    const initial = store.refresh()
    await store.refresh()
    await store.refresh(true)
    await store.refresh()
    assert.equal(fake.calls.begin, 1)
    first.resolve([])
    await initial
    await settle()

    assert.equal(fake.calls.begin, 2)
    assert.equal(fake.calls.snapshots, 2)
    assert.equal(fake.calls.invalidate, 1)
    assert.equal(store.data()?.items[0]?.bead.id, "task-1")
    await settle()
    assert.equal(fake.calls.begin, 2, "refresh completion must not schedule itself indefinitely")
  })

  it("runs the queued refresh after a failed in-flight query", async () => {
    const first = deferred<Bead[] | undefined>()
    let readyCalls = 0
    const fake = fakeBd({ ready: () => (++readyCalls === 1 ? first.promise : Promise.resolve([])) })
    const store = createStore(fake.bd, focus())

    const initial = store.refresh()
    await store.refresh(true)
    first.reject(new Error("read failed"))
    await initial
    await settle()

    assert.equal(fake.calls.begin, 2)
    assert.equal(fake.calls.snapshots, 2)
    assert.equal(store.data()?.items[0]?.bead.id, "task-1")
  })

  it("polls signatures without querying unchanged data and stops polling on cleanup", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] })
    const fake = fakeBd()
    const store = createStore(fake.bd, focus())
    const stop = store.start()
    t.after(stop)
    await settle()
    assert.equal(fake.calls.begin, 1)

    t.mock.timers.tick(4_500)
    await settle()
    assert.equal(fake.calls.polls, 3)
    assert.equal(fake.calls.begin, 1)

    fake.signature("2:1")
    t.mock.timers.tick(1_500)
    await settle()
    assert.equal(fake.calls.begin, 2)
    stop()
    stop()
    t.mock.timers.tick(4_500)
    await store.refresh(true)
    assert.equal(fake.calls.polls, 4)
    assert.equal(fake.calls.begin, 2)
  })

  it("drops an in-flight result and any queued rerun after disposal", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] })
    const pending = deferred<Bead[] | undefined>()
    const fake = fakeBd({ ready: () => pending.promise })
    const store = createStore(fake.bd, focus())
    const stop = store.start()
    t.after(stop)
    await store.refresh(true)
    stop()
    pending.resolve([{ id: "task-1" }])
    await settle()
    t.mock.timers.tick(3_000)

    assert.equal(store.data(), undefined)
    assert.equal(fake.calls.begin, 1)
    assert.equal(fake.calls.snapshots, 1)
    assert.equal(fake.calls.polls, 0)
  })

  it("does not replace the last committed data when a later refresh resolves after disposal", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] })
    const pending = deferred<Bead[] | undefined>()
    let listCalls = 0
    const fake = fakeBd({
      list: () => (++listCalls === 1 ? Promise.resolve([{ id: "old-task" }]) : pending.promise),
    })
    const store = createStore(fake.bd, focus())
    const stop = store.start()
    t.after(stop)
    await settle()
    const previous = store.data()
    assert.equal(previous?.items[0]?.bead.id, "old-task")

    const refresh = store.refresh(true)
    await settle()
    stop()
    pending.resolve([{ id: "new-task" }])
    await refresh
    assert.equal(store.data(), previous)
    assert.equal(store.data()?.items[0]?.bead.id, "old-task")
  })

  it("does not restart polling work when persistence finishes after disposal", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] })
    const pending = deferred<void>()
    const fake = fakeBd()
    const store = createStore(fake.bd, { get: () => undefined, set: () => pending.promise })
    const stop = store.start()
    t.after(stop)
    await settle()
    const pin = store.pin("epic-one")
    stop()
    pending.resolve()
    await pin
    t.mock.timers.tick(3_000)
    assert.equal(fake.calls.begin, 1)
    assert.equal(fake.calls.polls, 0)
  })
})
