import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Plugin } from "@opencode/plugin/tui"
import type { BdClient, Bead } from "../src/bd.ts"
import { registerCommands, showBead } from "../src/commands.ts"
import type { PanelItem } from "../src/scope.ts"
import type { Store } from "../src/store.ts"

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

type Layer = ReturnType<Parameters<Plugin.Context["keymap"]["layer"]>[0]>
type Command = NonNullable<Layer["commands"]>[number]
type SelectOption<Value = unknown> = { title: string; description?: string; value: Value }
type SelectProps<Value = unknown> = { title: string; options: readonly SelectOption<Value>[] }
type AlertProps = { title: string; message: string }
type DialogMarker =
  | { kind: "select"; props: SelectProps; resolve: (value: unknown) => void }
  | { kind: "alert"; props: AlertProps }
type Toast = Parameters<Plugin.Context["ui"]["toast"]["show"]>[0]
type Target = { bd: BdClient; store: Store }

function createFakeApi() {
  const toasts: Toast[] = []
  const dialogs: DialogMarker[] = []
  const layers: Layer[] = []
  const factories: (() => Layer)[] = []
  const api = {
    ui: {
      toast: {
        show: (input: Toast) => {
          toasts.push(input)
        },
      },
      dialog: {
        // Intentionally no clear/replace methods: the host closes an async
        // select before returning its selected value (or undefined on cancel).
        select: <Value>(props: SelectProps<Value>): Promise<Value | undefined> => {
          const selection = deferred<Value | undefined>()
          dialogs.push({
            kind: "select",
            props,
            resolve: (value) => selection.resolve(value as Value | undefined),
          })
          return selection.promise
        },
        alert: (props: AlertProps): Promise<void> => {
          dialogs.push({ kind: "alert", props })
          return Promise.resolve()
        },
      },
    },
    keymap: {
      layer: (factory: () => Layer): void => {
        factories.push(factory)
        layers.push(factory())
      },
    },
  }

  function lastSelect() {
    const last = dialogs[dialogs.length - 1]
    assert.ok(last && last.kind === "select", "expected a select dialog on top")
    return last
  }

  return {
    api: api as unknown as Plugin.Context,
    toasts,
    dialogs,
    layers,
    factories,
    command: (id: string): Command => {
      const found = layers.flatMap((layer) => layer.commands ?? []).find((command) => command.id === id)
      assert.ok(found, `command ${id} should be registered`)
      return found
    },
    lastSelect: (): SelectProps => lastSelect().props,
    choose: (index = 0) => {
      const select = lastSelect()
      const option = select.props.options[index]
      assert.ok(option, `expected select option ${index}`)
      select.resolve(option.value)
    },
    cancel: () => lastSelect().resolve(undefined),
    lastAlert: (): AlertProps => {
      const last = dialogs[dialogs.length - 1]
      assert.ok(last && last.kind === "alert", "expected an alert dialog on top")
      return last.props
    },
  }
}

function createFakeStore(items: PanelItem[] | undefined) {
  const refreshCalls: boolean[] = []
  const pins: (string | undefined)[] = []
  const store = {
    data: () => (items ? { items, done: 0, total: items.length, fallback: false } : undefined),
    refresh: (force = false) => {
      refreshCalls.push(force)
      return Promise.resolve()
    },
    pin: (epicID: string | undefined) => {
      pins.push(epicID)
      return Promise.resolve()
    },
  }
  return { store: store as unknown as Store, refreshCalls, pins }
}

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

const commandIDs = ["beads.focus", "beads.unfocus", "beads.start", "beads.close", "beads.reopen", "beads.refresh"]
const closedItem: PanelItem = { bead: { id: "x-1", title: "Done thing", status: "closed" }, state: "closed" }
const openItem: PanelItem = { bead: { id: "x-2", title: "Open thing", status: "open" }, state: "ready" }
const activeItem: PanelItem = {
  bead: { id: "x-3", title: "Active thing", status: "in_progress" },
  state: "in_progress",
}
const blockedItem: PanelItem = { bead: { id: "x-4", status: "open" }, state: "blocked" }

const mutationCases = [
  {
    id: "beads.start",
    title: "Start work",
    items: [closedItem, openItem, activeItem, blockedItem],
    options: [openItem, blockedItem],
    args: ["update", "x-2", "--status", "in_progress"],
    message: "started x-2",
  },
  {
    id: "beads.close",
    title: "Close bead",
    items: [closedItem, openItem, activeItem],
    options: [openItem, activeItem],
    args: ["close", "x-2"],
    message: "closed x-2",
  },
  {
    id: "beads.reopen",
    title: "Reopen bead",
    items: [openItem, closedItem, activeItem],
    options: [closedItem],
    args: ["reopen", "x-1"],
    message: "reopened x-1",
  },
]

describe("registerCommands", () => {
  it("registers six discoverable commands and configured bindings in a pure global layer", () => {
    const fake = createFakeApi()
    let targetCalls = 0
    const result = registerCommands(fake.api, () => {
      targetCalls += 1
      return undefined
    })

    assert.equal(result, undefined, "the host owns disposal")
    assert.equal(fake.layers.length, 1)
    const layer = fake.layers[0]
    assert.ok(layer)
    assert.equal(layer.mode, "global")
    assert.deepEqual(layer.bindings, commandIDs)
    assert.deepEqual(
      layer.commands?.map((command) => command.id),
      commandIDs,
    )
    for (const command of layer.commands ?? []) {
      assert.equal(command.group, "Beads")
      assert.equal(command.palette, true)
      assert.ok(command.title?.startsWith("Beads: "))
      assert.ok(command.description)
      assert.deepEqual(command.slash, { name: command.id?.replace("beads.", "bd-") })
    }
    fake.factories[0]?.()
    assert.equal(targetCalls, 0, "a reactive layer factory must not read or act on the current target")
    assert.deepEqual(fake.dialogs, [])
    assert.deepEqual(fake.toasts, [])
  })

  for (const id of commandIDs) {
    it(`${id} is a no-op when there is no active target`, async () => {
      const fake = createFakeApi()
      let targetCalls = 0
      registerCommands(fake.api, () => {
        targetCalls += 1
        return undefined
      })

      await fake.command(id).run()

      assert.equal(targetCalls, 1)
      assert.deepEqual(fake.dialogs, [])
      assert.deepEqual(fake.toasts, [])
    })
  }

  for (const id of ["beads.focus", "beads.unfocus"]) {
    it(`${id} waits for the pin to persist and refresh`, async () => {
      const fake = createFakeApi()
      const pinned = deferred<void>()
      const { store } = createFakeStore([])
      const bd = createFakeBd({ epics: async () => [{ id: "epic-1" }] })
      registerCommands(fake.api, () => ({ bd, store: { ...store, pin: () => pinned.promise } }))
      let finished = false
      const running = Promise.resolve(fake.command(id).run()).then(() => {
        finished = true
      })
      await settle()
      if (id === "beads.focus") {
        fake.choose()
        await settle()
      }
      assert.equal(finished, false)
      pinned.resolve()
      await running
      assert.equal(finished, true)
    })
  }

  it("resolves the current session anew for later unfocus and refresh invocations", async () => {
    const fake = createFakeApi()
    const first = createFakeStore([])
    const second = createFakeStore([])
    let target: Target = { bd: createFakeBd(), store: first.store }
    let targetCalls = 0
    registerCommands(fake.api, () => {
      targetCalls += 1
      return target
    })

    await fake.command("beads.unfocus").run()
    await fake.command("beads.refresh").run()
    target = { bd: createFakeBd(), store: second.store }
    await fake.command("beads.unfocus").run()
    await fake.command("beads.refresh").run()

    assert.equal(targetCalls, 4)
    assert.deepEqual(first.pins, [undefined])
    assert.deepEqual(second.pins, [undefined])
    assert.deepEqual(first.refreshCalls, [true])
    assert.deepEqual(second.refreshCalls, [true])
    assert.deepEqual(fake.dialogs, [])
    assert.deepEqual(fake.toasts, [])
  })
})

describe("beads.focus", () => {
  it("shows epics with title/status fallbacks and pins the returned id", async () => {
    const fake = createFakeApi()
    const { store, pins } = createFakeStore([])
    let epicCalls = 0
    const bd = createFakeBd({
      epics: async () => {
        epicCalls += 1
        return [{ id: "epic-1", title: "The plan", status: "closed" }, { id: "epic-2" }]
      },
    })
    registerCommands(fake.api, () => ({ bd, store }))

    const running = fake.command("beads.focus").run()
    await settle()

    assert.equal(epicCalls, 1)
    assert.deepEqual(fake.lastSelect(), {
      title: "Focus epic",
      options: [
        { title: "The plan", description: "epic-1 · closed", value: "epic-1" },
        { title: "epic-2", description: "epic-2 · open", value: "epic-2" },
      ],
    })
    assert.deepEqual(pins, [])
    fake.choose(1)
    await running
    assert.deepEqual(pins, ["epic-2"])
    assert.deepEqual(fake.toasts, [])
  })

  for (const epics of [[], undefined]) {
    it(`reports no epics for ${epics === undefined ? "a failed" : "an empty"} query`, async () => {
      const fake = createFakeApi()
      const { store, pins } = createFakeStore([])
      const bd = createFakeBd({ epics: async () => epics })
      registerCommands(fake.api, () => ({ bd, store }))

      await fake.command("beads.focus").run()

      assert.deepEqual(pins, [])
      assert.deepEqual(fake.dialogs, [])
      assert.deepEqual(fake.toasts, [{ variant: "info", title: "beads", message: "no epics in this workspace" }])
    })
  }

  it("does not clear or change the pin when the picker is cancelled", async () => {
    const fake = createFakeApi()
    const { store, pins, refreshCalls } = createFakeStore([])
    const bd = createFakeBd({ epics: async () => [{ id: "epic-1" }] })
    registerCommands(fake.api, () => ({ bd, store }))

    const running = fake.command("beads.focus").run()
    await settle()
    fake.cancel()
    await running

    assert.deepEqual(pins, [])
    assert.deepEqual(refreshCalls, [])
    assert.deepEqual(fake.toasts, [])
  })

  it("pins the original session after a switch during the epic query and picker", async () => {
    const fake = createFakeApi()
    const epics = deferred<Bead[]>()
    const first = createFakeStore([])
    const second = createFakeStore([])
    const third = createFakeStore([])
    let target: Target | undefined = { bd: createFakeBd({ epics: () => epics.promise }), store: first.store }
    let targetCalls = 0
    registerCommands(fake.api, () => {
      targetCalls += 1
      return target
    })

    const running = fake.command("beads.focus").run()
    target = { bd: createFakeBd(), store: second.store }
    epics.resolve([{ id: "first-epic" }])
    await settle()
    target = { bd: createFakeBd(), store: third.store }
    fake.choose()
    target = undefined
    await running

    assert.equal(targetCalls, 1)
    assert.deepEqual(first.pins, ["first-epic"])
    assert.deepEqual(second.pins, [])
    assert.deepEqual(third.pins, [])
  })
})

for (const scenario of mutationCases) {
  describe(scenario.id, () => {
    it("filters the picker, awaits selection, mutates the chosen bead and forces refresh", async () => {
      const fake = createFakeApi()
      const mutateCalls: { id: string; args: string[] }[] = []
      const bd = createFakeBd({
        mutate: async (id, args) => {
          mutateCalls.push({ id, args })
          return { ok: true }
        },
      })
      const { store, refreshCalls } = createFakeStore(scenario.items)
      registerCommands(fake.api, () => ({ bd, store }))

      const running = fake.command(scenario.id).run()
      await settle()
      assert.deepEqual(fake.lastSelect(), {
        title: scenario.title,
        options: scenario.options.map((item) => ({
          title: item.bead.title ?? item.bead.id,
          description: `${item.bead.id} · ${item.state}`,
          value: item,
        })),
      })
      assert.deepEqual(mutateCalls, [])
      assert.deepEqual(refreshCalls, [])
      fake.choose()
      await running

      assert.deepEqual(mutateCalls, [{ id: scenario.options[0]?.bead.id, args: scenario.args }])
      assert.deepEqual(fake.toasts, [{ variant: "success", title: "beads", message: scenario.message }])
      assert.deepEqual(refreshCalls, [true])
    })

    it("does not mutate or refresh when the picker is cancelled", async () => {
      const fake = createFakeApi()
      const bd = createFakeBd({ mutate: async () => assert.fail("cancelled selection must not mutate") })
      const { store, refreshCalls } = createFakeStore(scenario.items)
      registerCommands(fake.api, () => ({ bd, store }))

      const running = fake.command(scenario.id).run()
      await settle()
      fake.cancel()
      await running

      assert.deepEqual(refreshCalls, [])
      assert.deepEqual(fake.toasts, [])
    })

    it("surfaces a mutation failure and still forces refresh", async () => {
      const fake = createFakeApi()
      const bd = createFakeBd({ mutate: async () => ({ ok: false, message: "bd failed" }) })
      const { store, refreshCalls } = createFakeStore(scenario.items)
      registerCommands(fake.api, () => ({ bd, store }))

      const running = fake.command(scenario.id).run()
      await settle()
      fake.choose()
      await running

      assert.deepEqual(fake.toasts, [{ variant: "error", title: "beads", message: "bd failed" }])
      assert.deepEqual(refreshCalls, [true])
    })

    it("keeps the original client and store when the session changes during the picker", async () => {
      const fake = createFakeApi()
      const mutateCalls: string[][] = []
      const first = createFakeStore(scenario.items)
      const second = createFakeStore(scenario.items)
      const target: Target = {
        bd: createFakeBd({
          mutate: async (id, args) => {
            mutateCalls.push([id, ...args])
            return { ok: true }
          },
        }),
        store: first.store,
      }
      let targetCalls = 0
      registerCommands(fake.api, () => {
        targetCalls += 1
        return target
      })

      const running = fake.command(scenario.id).run()
      await settle()
      // Even if a resolver reuses and mutates its target object, the invocation
      // must retain the client/store pair captured before opening the picker.
      target.bd = createFakeBd({ mutate: async () => assert.fail("must not mutate the new workspace") })
      target.store = second.store
      fake.choose()
      await running

      assert.equal(targetCalls, 1)
      assert.deepEqual(mutateCalls, [[scenario.options[0]?.bead.id, ...scenario.args]])
      assert.deepEqual(first.refreshCalls, [true])
      assert.deepEqual(second.refreshCalls, [])
    })
  })
}

describe("empty mutation pickers", () => {
  for (const id of ["beads.start", "beads.close", "beads.reopen"]) {
    for (const items of [[], undefined]) {
      it(`${id} reports nothing to pick for ${items === undefined ? "missing" : "empty"} store data`, async () => {
        const fake = createFakeApi()
        const bd = createFakeBd({ mutate: async () => assert.fail("empty picker must not mutate") })
        const { store, refreshCalls } = createFakeStore(items)
        registerCommands(fake.api, () => ({ bd, store }))

        await fake.command(id).run()

        assert.deepEqual(fake.dialogs, [])
        assert.deepEqual(fake.toasts, [{ variant: "info", title: "beads", message: "nothing to pick" }])
        assert.deepEqual(refreshCalls, [])
      })
    }
  }

  it("does not offer closed or already-started beads for start", async () => {
    const fake = createFakeApi()
    const { store } = createFakeStore([closedItem, activeItem])
    registerCommands(fake.api, () => ({ bd: createFakeBd(), store }))
    await fake.command("beads.start").run()
    assert.deepEqual(fake.dialogs, [])
    assert.equal(fake.toasts[0]?.message, "nothing to pick")
  })

  it("does not offer closed beads for close", async () => {
    const fake = createFakeApi()
    const { store } = createFakeStore([closedItem])
    registerCommands(fake.api, () => ({ bd: createFakeBd(), store }))
    await fake.command("beads.close").run()
    assert.deepEqual(fake.dialogs, [])
    assert.equal(fake.toasts[0]?.message, "nothing to pick")
  })
})

describe("beads.reopen fallback", () => {
  it("picks from the store's closed items without asking bd", async () => {
    const fake = createFakeApi()
    const bd = createFakeBd({ list: async () => assert.fail("closed store items avoid a list query") })
    const { store } = createFakeStore([closedItem, openItem])
    registerCommands(fake.api, () => ({ bd, store }))

    const running = fake.command("beads.reopen").run()
    await settle()
    assert.deepEqual(
      fake.lastSelect().options.map((option) => option.title),
      ["Done thing"],
    )
    fake.cancel()
    await running
  })

  it("asks bd for closed beads and reopens the returned selection", async () => {
    const fake = createFakeApi()
    const listCalls: string[][] = []
    const mutateCalls: string[][] = []
    const bd = createFakeBd({
      list: async (args = []) => {
        listCalls.push(args)
        return [{ id: "old-1", title: "From bd", status: "closed" }]
      },
      mutate: async (id, args) => {
        mutateCalls.push([id, ...args])
        return { ok: true }
      },
    })
    const { store, refreshCalls } = createFakeStore([openItem])
    registerCommands(fake.api, () => ({ bd, store }))

    const running = fake.command("beads.reopen").run()
    await settle()
    assert.deepEqual(listCalls, [["--status", "closed"]])
    assert.deepEqual(
      fake.lastSelect().options.map(({ title, description }) => ({ title, description })),
      [{ title: "From bd", description: "old-1 · closed" }],
    )
    fake.choose()
    await running

    assert.deepEqual(mutateCalls, [["old-1", "reopen", "old-1"]])
    assert.deepEqual(refreshCalls, [true])
    assert.deepEqual(fake.toasts, [{ variant: "success", title: "beads", message: "reopened old-1" }])
  })

  for (const listed of [[], undefined]) {
    it(`handles ${listed === undefined ? "a failed" : "an empty"} closed-bead query`, async () => {
      const fake = createFakeApi()
      const bd = createFakeBd({ list: async () => listed })
      const { store } = createFakeStore([openItem])
      registerCommands(fake.api, () => ({ bd, store }))

      await fake.command("beads.reopen").run()

      assert.deepEqual(fake.dialogs, [])
      assert.deepEqual(fake.toasts, [{ variant: "info", title: "beads", message: "nothing to pick" }])
    })
  }

  it("keeps the original workspace across a delayed fallback query, picker and mutation", async () => {
    const fake = createFakeApi()
    const listed = deferred<Bead[]>()
    const mutation = deferred<{ ok: true }>()
    const mutateCalls: string[][] = []
    const first = createFakeStore([openItem])
    const second = createFakeStore([closedItem])
    let target: Target | undefined = {
      bd: createFakeBd({
        list: () => listed.promise,
        mutate: (id, args) => {
          mutateCalls.push([id, ...args])
          return mutation.promise
        },
      }),
      store: first.store,
    }
    let targetCalls = 0
    registerCommands(fake.api, () => {
      targetCalls += 1
      return target
    })

    const running = fake.command("beads.reopen").run()
    target = { bd: createFakeBd(), store: second.store }
    listed.resolve([{ id: "old-1", status: "closed" }])
    await settle()
    assert.equal(fake.lastSelect().options[0]?.title, "old-1")
    fake.choose()
    await settle()
    assert.deepEqual(mutateCalls, [["old-1", "reopen", "old-1"]])
    assert.deepEqual(first.refreshCalls, [], "refresh waits for mutation completion")
    target = undefined
    mutation.resolve({ ok: true })
    await running

    assert.equal(targetCalls, 1)
    assert.deepEqual(first.refreshCalls, [true])
    assert.deepEqual(second.refreshCalls, [])
  })
})

describe("showBead", () => {
  it("fetches through get and renders the full bead via the async alert", async () => {
    const fake = createFakeApi()
    const getCalls: string[] = []
    const full: Bead = {
      id: "x-2",
      title: "Open thing",
      status: "in_progress",
      issue_type: "task",
      description: "the long form\nwith multiple lines",
      acceptance_criteria: "it works\nand stays fixed",
    }
    const bd = createFakeBd({
      get: async (id) => {
        getCalls.push(id)
        return [full]
      },
      mutate: async () => assert.fail("detail must remain read-only"),
    })

    await showBead(fake.api, bd, openItem)

    assert.deepEqual(getCalls, ["x-2"])
    assert.deepEqual(fake.lastAlert(), {
      title: "Open thing",
      message:
        "x-2  in_progress · task\n\nOpen thing\n\nthe long form\nwith multiple lines\n\nAcceptance:\nit works\nand stays fixed",
    })
  })

  for (const fetched of [undefined, []]) {
    it(`falls back to the panel item when get returns ${fetched === undefined ? "undefined" : "no records"}`, async () => {
      const fake = createFakeApi()
      const bd = createFakeBd({ get: async () => fetched })

      await showBead(fake.api, bd, openItem)

      assert.deepEqual(fake.lastAlert(), {
        title: "Open thing",
        message: "x-2  open\n\nOpen thing\n\n(no description)",
      })
    })
  }

  it("uses id and open status defaults when detail fields are missing", async () => {
    const fake = createFakeApi()
    const bd = createFakeBd({ get: async (id) => [{ id }] })

    await showBead(fake.api, bd, openItem)

    assert.deepEqual(fake.lastAlert(), { title: "x-2", message: "x-2  open\n\n\n\n(no description)" })
  })

  for (const acceptance of [undefined, "", 42, {}]) {
    it(`omits non-string or empty acceptance criteria (${JSON.stringify(acceptance)})`, async () => {
      const fake = createFakeApi()
      const bd = createFakeBd({
        get: async (id) => [{ id, title: "Bare", description: "", acceptance_criteria: acceptance }],
      })

      await showBead(fake.api, bd, openItem)

      assert.equal(fake.lastAlert().message, "x-2  open\n\nBare\n\n(no description)")
    })
  }

  it("waits for the host alert to close", async () => {
    const fake = createFakeApi()
    const closed = deferred<void>()
    const api = {
      ...fake.api,
      ui: { ...fake.api.ui, dialog: { ...fake.api.ui.dialog, alert: () => closed.promise } },
    }
    let finished = false
    const running = showBead(api, createFakeBd(), openItem).then(() => {
      finished = true
    })
    await settle()
    assert.equal(finished, false)
    closed.resolve()
    await running
    assert.equal(finished, true)
  })
})
