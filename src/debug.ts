import { appendFileSync } from "node:fs"

const SINK = process.env.BEADS_SIDEBAR_DEBUG

/** Opt-in tracing. Set BEADS_SIDEBAR_DEBUG to a file path to enable. */
export function debug(line: string) {
  if (!SINK) return
  try {
    appendFileSync(SINK, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}
