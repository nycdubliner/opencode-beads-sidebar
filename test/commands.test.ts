import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BdClient, Bead } from "../src/bd.ts"
import { registerCommands, showBead } from "../src/commands.ts"
import type { PanelItem } from "../src/scope.ts"
import type { Store } from "../src/store.tsx"

/** Let a `void apply(...)` chain of already-resolved promises run to completion. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

type SelectOption = { title: string; description?: string; value: unknown }
type SelectProps = { title: string; options: SelectOption[]; onSelect?: (option: SelectOption) => void }
type AlertProps = { title: string; message: string }
type DialogMarker = { kind: "select"; props: SelectProps } | { kind: "alert"; props: AlertProps }
type Toast = { variant?: string; title?: string; message?: string }
type Command = { name: string; run: () => void | Promise<void> }

function createFakeApi() {
  const toasts: Toast[] = []
  const dialogs: DialogMarker[] = []
  let clearCount = 0
  let commands: Command[] = []

  const api = {
    ui: {
      toast: (input: Toast) => {
        toasts.push(input)
      },
      dialog: {
        replace: (render: () => DialogMarker) => {
          dialogs.push(render())
        },
        clear: () => {
          clearCount += 1
        },
      },
      DialogSelect: (props: SelectProps): DialogMarker => ({ kind: "select", props }),
      DialogAlert: (props: AlertProps): DialogMarker => ({ kind: "alert", props }),
    },
    keymap: {
      registerLayer: (layer: { commands: Command[] }) => {
        commands = layer.commands
        return () => {}
      },
    },
    tuiConfig: {
      keybinds: {
        gather: () => [],
      },
    },
  }

  return {
    api: api as unknown as TuiPluginApi,
    toasts,
    dialogs,
    command: (name: string): Command => {
      const found = commands.find((it) => it.name === name)
      assert.ok(found, `command ${name} should be registered`)
      return found
    },
    lastSelect: (): SelectProps => {
      const last = dialogs[dialogs.length - 1]
      assert.ok(last && last.kind === "select", "expected a DialogSelect on top")
      return last.props
    },
    lastAlert: (): AlertProps => {
      const last = dialogs[dialogs.length - 1]
      assert.ok(last && last.kind === "alert", "expected a DialogAlert on top")
      return last.props
    },
    clears: () => clearCount,
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

const closedItem: PanelItem = { bead: { id: "x-1", title: "Done thing", status: "closed" }, state: "closed" }
const openItem: PanelItem = { bead: { id: "x-2", title: "Open thing", status: "open" }, state: "ready" }

describe("beads.reopen", () => {
  it("picks from the store's closed items without asking bd", async () => {
    const fake = createFakeApi()
    const listCalls: string[][] = []
    const bd = createFakeBd({
      list: (args: string[] = []) => {
        listCalls.push(args)
        return Promise.resolve([])
      },
    })
    const { store } = createFakeStore([closedItem, openItem])
    registerCommands(fake.api, bd, store)

    await fake.command("beads.reopen").run()

    assert.equal(listCalls.length, 0)
    const select = fake.lastSelect()
    assert.equal(select.title, "Reopen bead")
    assert.deepEqual(
      select.options.map((it) => it.title),
      ["Done thing"],
    )
  })

  it("asks bd for closed beads when the store has none", async () => {
    const fake = createFakeApi()
    const listCalls: string[][] = []
    const bd = createFakeBd({
      list: (args: string[] = []) => {
        listCalls.push(args)
        return Promise.resolve([{ id: "old-1", title: "From bd", status: "closed" }])
      },
    })
    const { store } = createFakeStore([openItem])
    registerCommands(fake.api, bd, store)

    await fake.command("beads.reopen").run()

    assert.deepEqual(listCalls, [["--status", "closed"]])
    const select = fake.lastSelect()
    assert.deepEqual(
      select.options.map((it) => it.title),
      ["From bd"],
    )
    assert.deepEqual(
      select.options.map((it) => it.description),
      ["old-1 · closed"],
    )
  })

  it("shows a nothing-to-pick toast when store and bd are both empty", async () => {
    const fake = createFakeApi()
    const bd = createFakeBd({ list: () => Promise.resolve([]) })
    const { store } = createFakeStore([openItem])
    registerCommands(fake.api, bd, store)

    await fake.command("beads.reopen").run()

    assert.equal(fake.dialogs.length, 0)
    assert.deepEqual(fake.toasts, [{ variant: "info", title: "beads", message: "nothing to pick" }])
  })

  it("surfaces a mutate failure as an error toast and still refreshes", async () => {
    const fake = createFakeApi()
    const bd = createFakeBd({
      mutate: () => Promise.resolve({ ok: false as const, message: "reopen exploded" }),
    })
    const { store, refreshCalls } = createFakeStore([closedItem])
    registerCommands(fake.api, bd, store)

    await fake.command("beads.reopen").run()
    const select = fake.lastSelect()
    const option = select.options[0]
    assert.ok(option)
    select.onSelect?.(option)
    await settle()

    assert.deepEqual(fake.toasts, [{ variant: "error", title: "beads", message: "reopen exploded" }])
    assert.deepEqual(refreshCalls, [true])
  })

  it("shows a success toast and refreshes when the mutate lands", async () => {
    const fake = createFakeApi()
    const mutateCalls: string[][] = []
    const bd = createFakeBd({
      mutate: (id: string, args: string[]) => {
        mutateCalls.push([id, ...args])
        return Promise.resolve({ ok: true as const })
      },
    })
    const { store, refreshCalls } = createFakeStore([closedItem])
    registerCommands(fake.api, bd, store)

    await fake.command("beads.reopen").run()
    const select = fake.lastSelect()
    const option = select.options[0]
    assert.ok(option)
    select.onSelect?.(option)
    await settle()

    assert.deepEqual(mutateCalls, [["x-1", "reopen", "x-1"]])
    assert.deepEqual(fake.toasts, [{ variant: "success", title: "beads", message: "reopened x-1" }])
    assert.deepEqual(refreshCalls, [true])
    assert.equal(fake.clears(), 1)
  })
})

describe("showBead", () => {
  it("fetches through get and renders the full bead", async () => {
    const fake = createFakeApi()
    const getCalls: string[] = []
    const full: Bead = {
      id: "x-2",
      title: "Open thing",
      status: "in_progress",
      issue_type: "task",
      description: "the long form",
      acceptance_criteria: "it works",
    }
    const bd = createFakeBd({
      get: (id: string) => {
        getCalls.push(id)
        return Promise.resolve([full])
      },
    })

    await showBead(fake.api, bd, openItem)

    assert.deepEqual(getCalls, ["x-2"])
    const alert = fake.lastAlert()
    assert.equal(alert.title, "Open thing")
    assert.ok(alert.message.includes("x-2  in_progress · task"))
    assert.ok(alert.message.includes("the long form"))
    assert.ok(alert.message.includes("Acceptance:"))
    assert.ok(alert.message.includes("it works"))
  })

  it("falls back to the panel item when get returns nothing", async () => {
    const fake = createFakeApi()
    const bd = createFakeBd({ get: () => Promise.resolve(undefined) })

    await showBead(fake.api, bd, openItem)

    const alert = fake.lastAlert()
    assert.equal(alert.title, "Open thing")
    assert.ok(alert.message.includes("x-2  open"))
  })

  it("renders (no description) when the description is missing", async () => {
    const fake = createFakeApi()
    const bd = createFakeBd({ get: (id: string) => Promise.resolve([{ id, title: "Bare" }]) })

    await showBead(fake.api, bd, openItem)

    const alert = fake.lastAlert()
    assert.ok(alert.message.includes("(no description)"))
    assert.ok(!alert.message.includes("Acceptance:"))
  })
})
