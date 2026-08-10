/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createBdClient } from "./bd"
import { registerCommands, showBead } from "./commands"
import { BeadsPanel } from "./panel"
import { createStore } from "./store"

/**
 * Sits between the built-in Todo panel (400) and Modified Files (500). The host
 * renders `sidebar_content` without a slot mode, which defaults to "append", so
 * this section coexists with the built-ins rather than replacing them.
 */
const SIDEBAR_ORDER = 450

const tui: TuiPlugin = async (api) => {
  const bd = createBdClient(api.state.path.worktree)
  const store = createStore(bd, api.kv)

  const stopPolling = store.start()
  const disposeCommands = registerCommands(api, bd, store)

  api.lifecycle.onDispose(() => {
    stopPolling()
    disposeCommands()
  })

  api.slots.register({
    order: SIDEBAR_ORDER,
    slots: {
      sidebar_content(_ctx, value) {
        // The panel is per-session only insofar as the focus pin is; keeping
        // the id current lets `/bd-focus` scope itself to the open session.
        store.setSessionID(value.session_id)
        return (
          <BeadsPanel
            api={api}
            data={store.data}
            adopt={store.adopt}
            onSelect={(item) => void showBead(api, bd, item)}
          />
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "beads-sidebar",
  tui,
}

export default plugin
