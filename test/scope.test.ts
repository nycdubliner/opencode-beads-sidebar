import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { BdClient, Bead } from "../src/bd.ts"
import { resolveScope, stateOf } from "../src/scope.ts"

/**
 * Hand-rolled BdClient. Every method has a do-nothing default so a test only
 * spells out the parts of the surface it actually exercises.
 */
function createFakeBd(overrides: Partial<BdClient> = {}): BdClient {
  const base: BdClient = {
    enabled: () => true,
    signature: () => "1:1",
    beginRefresh: () => {},
    snapshot: () => "1:1",
    lastTouchedID: () => undefined,
    invalidate: () => {},
    mutate: () => Promise.resolve({ ok: true as const }),
    children: () => Promise.resolve(undefined),
    get: () => Promise.resolve(undefined),
    ready: () => Promise.resolve([]),
    list: () => Promise.resolve(undefined),
    epics: () => Promise.resolve(undefined),
  }
  return { ...base, ...overrides }
}

describe("stateOf", () => {
  const ready = new Set(["r-1"])

  it("maps stored statuses straight through", () => {
    assert.equal(stateOf({ id: "x", status: "closed" }, ready), "closed")
    assert.equal(stateOf({ id: "x", status: "in_progress" }, ready), "in_progress")
    assert.equal(stateOf({ id: "x", status: "blocked" }, ready), "blocked")
    assert.equal(stateOf({ id: "x", status: "deferred" }, ready), "deferred")
    assert.equal(stateOf({ id: "x", status: "pinned" }, ready), "pinned")
    assert.equal(stateOf({ id: "x", status: "hooked" }, ready), "hooked")
  })

  it("treats open beads in the ready set as ready", () => {
    assert.equal(stateOf({ id: "r-1", status: "open" }, ready), "ready")
  })

  it("treats open beads absent from the ready set as blocked", () => {
    assert.equal(stateOf({ id: "b-1", status: "open" }, ready), "blocked")
  })

  it("treats unknown statuses like open: ready set decides", () => {
    assert.equal(stateOf({ id: "r-1", status: "wibble" }, ready), "ready")
    assert.equal(stateOf({ id: "b-1", status: "wibble" }, ready), "blocked")
  })

  it("treats a missing status as open", () => {
    assert.equal(stateOf({ id: "r-1" }, ready), "ready")
    assert.equal(stateOf({ id: "b-1" }, ready), "blocked")
  })
})

describe("resolveScope", () => {
  it("returns undefined when bd is disabled", async () => {
    const bd = createFakeBd({ enabled: () => false })
    assert.equal(await resolveScope(bd, undefined), undefined)
  })

  it("prefers the pinned epic over last-touched", async () => {
    const epic: Bead = { id: "e-1", issue_type: "epic", title: "Pinned epic" }
    const kids: Bead[] = [
      { id: "e-1.1", status: "closed" },
      { id: "e-1.2", status: "in_progress" },
    ]
    const bd = createFakeBd({
      lastTouchedID: () => "other-1",
      get: (id) => Promise.resolve(id === "e-1" ? [epic] : undefined),
      children: (id) => Promise.resolve(id === "e-1" ? kids : undefined),
    })

    const data = await resolveScope(bd, "e-1")
    assert.ok(data)
    assert.equal(data.epic?.id, "e-1")
    assert.equal(data.fallback, false)
    assert.equal(data.done, 1)
    assert.equal(data.total, 2)
  })

  it("falls through a pin whose epic no longer resolves", async () => {
    const epic: Bead = { id: "e-2", issue_type: "epic" }
    const bd = createFakeBd({
      lastTouchedID: () => "e-2.1",
      get: (id) => {
        if (id === "e-2.1") return Promise.resolve([{ id: "e-2.1", parent: "e-2" }])
        if (id === "e-2") return Promise.resolve([epic])
        return Promise.resolve(undefined)
      },
      children: (id) => Promise.resolve(id === "e-2" ? [{ id: "e-2.1", status: "open" }] : undefined),
    })

    const data = await resolveScope(bd, "gone-9")
    assert.ok(data)
    assert.equal(data.epic?.id, "e-2")
  })

  it("falls through a pin whose epic has no children", async () => {
    const bd = createFakeBd({
      get: (id) => Promise.resolve(id === "e-3" ? [{ id: "e-3", issue_type: "epic" }] : undefined),
      children: () => Promise.resolve([]),
      list: () => Promise.resolve([{ id: "w-1", status: "in_progress" }]),
    })

    const data = await resolveScope(bd, "e-3")
    assert.ok(data)
    assert.equal(data.fallback, true)
    assert.equal(data.epic, undefined)
  })

  it("resolves the last-touched bead to its parent epic", async () => {
    const bd = createFakeBd({
      lastTouchedID: () => "e-4.2",
      get: (id) => {
        if (id === "e-4.2") return Promise.resolve([{ id: "e-4.2", parent: "e-4" }])
        if (id === "e-4") return Promise.resolve([{ id: "e-4", issue_type: "epic" }])
        return Promise.resolve(undefined)
      },
      children: (id) =>
        Promise.resolve(
          id === "e-4"
            ? [
                { id: "e-4.1", status: "closed" },
                { id: "e-4.2", status: "open" },
              ]
            : undefined,
        ),
    })

    const data = await resolveScope(bd, undefined)
    assert.ok(data)
    assert.equal(data.epic?.id, "e-4")
    assert.equal(data.fallback, false)
  })

  it("uses the last-touched bead itself when it is an epic", async () => {
    const bd = createFakeBd({
      lastTouchedID: () => "e-5",
      get: (id) => Promise.resolve(id === "e-5" ? [{ id: "e-5", issue_type: "epic" }] : undefined),
      children: (id) => Promise.resolve(id === "e-5" ? [{ id: "e-5.1", status: "open" }] : undefined),
    })

    const data = await resolveScope(bd, undefined)
    assert.ok(data)
    assert.equal(data.epic?.id, "e-5")
  })

  it("falls back to workspace scope when there is no epic anywhere", async () => {
    const bd = createFakeBd({
      lastTouchedID: () => "solo-1",
      get: (id) => Promise.resolve(id === "solo-1" ? [{ id: "solo-1", status: "open" }] : undefined),
      list: () => Promise.resolve([{ id: "solo-1", status: "open" }]),
      ready: () => Promise.resolve([{ id: "solo-1" }]),
    })

    const data = await resolveScope(bd, undefined)
    assert.ok(data)
    assert.equal(data.fallback, true)
    assert.equal(data.items.length, 1)
    assert.equal(data.items[0]?.state, "ready")
  })

  it("returns undefined for an empty workspace", async () => {
    const bd = createFakeBd({ list: () => Promise.resolve([]) })
    assert.equal(await resolveScope(bd, undefined), undefined)
  })

  it("sorts epic children numerically by id and does not sink closed items", async () => {
    const kids: Bead[] = [
      { id: "bt-a.10", status: "open" },
      { id: "bt-a.2", status: "open" },
      { id: "bt-a.1", status: "closed" },
    ]
    const bd = createFakeBd({
      get: (id) => Promise.resolve(id === "bt-a" ? [{ id: "bt-a", issue_type: "epic" }] : undefined),
      children: (id) => Promise.resolve(id === "bt-a" ? kids : undefined),
      ready: () => Promise.resolve([{ id: "bt-a.2" }]),
    })

    const data = await resolveScope(bd, "bt-a")
    assert.ok(data)
    assert.deepEqual(
      data.items.map((it) => it.bead.id),
      ["bt-a.1", "bt-a.2", "bt-a.10"],
    )
    // The closed child keeps its plan position at the top rather than sinking.
    assert.equal(data.items[0]?.state, "closed")
    assert.equal(data.items[1]?.state, "ready")
    assert.equal(data.items[2]?.state, "blocked")
    assert.equal(data.done, 1)
    assert.equal(data.total, 3)
  })

  it("excludes the epic from its own children list", async () => {
    const bd = createFakeBd({
      get: (id) => Promise.resolve(id === "e-6" ? [{ id: "e-6", issue_type: "epic" }] : undefined),
      children: (id) =>
        Promise.resolve(
          id === "e-6"
            ? [
                { id: "e-6", issue_type: "epic" },
                { id: "e-6.1", status: "open" },
              ]
            : undefined,
        ),
    })

    const data = await resolveScope(bd, "e-6")
    assert.ok(data)
    assert.deepEqual(
      data.items.map((it) => it.bead.id),
      ["e-6.1"],
    )
    assert.equal(data.total, 1)
  })

  it("sorts the workspace fallback by urgency: in_progress, ready, blocked, rest", async () => {
    const bd = createFakeBd({
      list: () =>
        Promise.resolve([
          { id: "w-1", status: "deferred" },
          { id: "w-2", status: "open" },
          { id: "w-3", status: "in_progress" },
          { id: "w-4", status: "open" },
          { id: "w-5", issue_type: "epic", status: "open" },
        ]),
      ready: () => Promise.resolve([{ id: "w-4" }]),
    })

    const data = await resolveScope(bd, undefined)
    assert.ok(data)
    // w-5 is an epic and never shows as a workspace row.
    assert.deepEqual(
      data.items.map((it) => it.bead.id),
      ["w-3", "w-4", "w-2", "w-1"],
    )
    assert.deepEqual(
      data.items.map((it) => it.state),
      ["in_progress", "ready", "blocked", "deferred"],
    )
    assert.equal(data.fallback, true)
    assert.equal(data.done, 0)
    assert.equal(data.total, 4)
  })
})
