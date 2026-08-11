import { execFile } from "node:child_process"
import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

/** How long a single bd invocation may take before we give up on it. */
const TIMEOUT_MS = 10_000

/** Bounds on the `.beads` walk used for change detection. */
const MAX_DEPTH = 5
const MAX_ENTRIES = 400

/**
 * A bead, as it comes back from `bd ... --json`.
 *
 * Every field is optional on purpose. bd's JSON is the part of its surface most
 * likely to drift between releases, and a missing field should degrade one row
 * of the panel rather than throw inside a render.
 */
export type Bead = {
  id: string
  title?: string
  description?: string
  status?: string
  priority?: number
  issue_type?: string
  parent?: string
  assignee?: string
  created_at?: string
  updated_at?: string
  closed_at?: string
  close_reason?: string
  [key: string]: unknown
}

export type BdClient = ReturnType<typeof createBdClient>

/**
 * Bead ids that are safe to pass to bd as argv elements.
 *
 * Ids come from `.beads/last-touched` and from bd's own JSON output — both
 * attacker-influenced in a cloned untrusted repo. execFile rules out shell
 * injection, but bd still parses each argv element itself, so a value
 * starting with `-` would be read as a flag rather than an id (option
 * injection). Anchored, and the leading character is restricted so a bare
 * `-` (or `--foo`) can never pass.
 */
const VALID_BEAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function isValidBeadID(id: string): boolean {
  return VALID_BEAD_ID.test(id)
}

/**
 * Reads bd for a single worktree.
 *
 * Results are cached against a cheap "signature" of the `.beads` directory (see
 * `signature`) so that a render never pays for a subprocess. A bd invocation
 * costs 0.3-0.6s, which is far too slow to sit on the render path.
 */
export function createBdClient(worktree: string) {
  const beadsDir = join(worktree, ".beads")
  const lastTouched = join(beadsDir, "last-touched")

  const cache = new Map<string, { signature: string; value: unknown }>()

  /** Signature pinned for the span of one refresh cycle; see `beginRefresh`. */
  let pinnedSignature: string | undefined

  /** True when this worktree has a beads database at all. */
  function enabled(): boolean {
    return existsSync(beadsDir)
  }

  /**
   * Cheap change signal: the newest mtime anywhere under `.beads`, plus the
   * number of entries seen.
   *
   * The obvious candidate, `.beads/last-touched`, is a trap — it records the
   * bead you last *viewed*, so `bd show` rewrites it while `bd close` leaves it
   * alone. Walking the directory instead catches the backing store itself
   * (Dolt's `noms/manifest`, or a SQLite file) and so works for any bd
   * subcommand and either backend.
   *
   * Max-mtime alone misses two cases: a deletion directly under `.beads` only
   * bumps the root directory's mtime (so the root itself must be statted), and
   * a replacement that reuses older mtimes (rename, compaction) moves no mtime
   * forward at all — the entry count catches those.
   *
   * The tree is a couple of dozen entries, so this stays far cheaper than the
   * ~0.4s subprocess it exists to avoid. Depth and count are capped anyway, in
   * case a backend grows a deep working set.
   */
  function computeSignature(): string {
    let newest = 0
    let seen = 0

    try {
      newest = statSync(beadsDir).mtimeMs
    } catch {
      // No database (or it vanished): the walk below yields nothing either,
      // and "0:0" is as good a signature for that as any.
    }

    const walk = (dir: string, depth: number) => {
      if (depth > MAX_DEPTH || seen >= MAX_ENTRIES) return

      let entries: Dirent[]
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of entries) {
        if (seen++ >= MAX_ENTRIES) return
        const full = join(dir, entry.name)
        try {
          const mtime = statSync(full).mtimeMs
          if (mtime > newest) newest = mtime
        } catch {
          continue
        }
        if (entry.isDirectory()) walk(full, depth + 1)
      }
    }

    walk(beadsDir, 0)
    return `${newest}:${seen}`
  }

  function signature(): string {
    return pinnedSignature ?? computeSignature()
  }

  /**
   * Pin the signature for one refresh cycle. A resolveScope pass issues up to
   * four queries back to back; without the pin each would pay for its own stat
   * walk. The pin holds until `snapshot`, which the store calls at the end of
   * every refresh.
   */
  function beginRefresh() {
    pinnedSignature = computeSignature()
  }

  /**
   * End the cycle and return a *fresh* signature. This must re-walk rather
   * than reuse the pin: some bd reads rewrite `.beads/last-touched` even under
   * `--readonly`, so a pre-query value would make our own reads look like an
   * external change and refresh in a loop.
   */
  function snapshot(): string {
    pinnedSignature = undefined
    return computeSignature()
  }

  /** The bead id bd last touched, if any. Invalid content is treated as absent. */
  function lastTouchedID(): string | undefined {
    try {
      const id = readFileSync(lastTouched, "utf8").trim()
      return isValidBeadID(id) ? id : undefined
    } catch {
      return undefined
    }
  }

  async function exec(args: string[]): Promise<string> {
    const { stdout } = await run("bd", args, {
      cwd: worktree,
      timeout: TIMEOUT_MS,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    })
    return stdout
  }

  /**
   * Run a read-only bd query and parse its JSON, memoised against the current
   * signature. Returns undefined rather than throwing: bd exits non-zero for
   * ordinary conditions (no database, unknown id) and the panel treats all of
   * them the same way — render nothing.
   */
  async function query<T>(args: string[]): Promise<T | undefined> {
    if (!enabled()) return undefined

    const key = args.join("\x00")
    const sig = signature()
    const hit = cache.get(key)
    if (hit) {
      if (hit.signature === sig) return hit.value as T
      // Stale for the current signature and about to be re-queried (or, on
      // failure below, just dropped) — either way it must not linger.
      cache.delete(key)
    }

    try {
      const stdout = await exec(["--readonly", ...args, "--json"])
      const trimmed = stdout.trim()
      const value = trimmed.length > 0 ? (JSON.parse(trimmed) as T) : undefined
      // Entries from a prior signature are dead weight once this one lands:
      // nothing will ever match their signature again, so sweep them here
      // rather than letting the map grow one slot per id ever queried.
      for (const [k, v] of cache) if (v.signature !== sig) cache.delete(k)
      cache.set(key, { signature: sig, value })
      return value
    } catch {
      return undefined
    }
  }

  /**
   * Run a mutating bd command. Unlike `query` this reports failure, because a
   * write the user explicitly asked for should surface an error rather than
   * silently do nothing. `id` is checked against `isValidBeadID` before `args`
   * ever reaches `bd` — callers all target one bead, and this is the one place
   * that write path narrows to reject an id bd would otherwise parse as a flag.
   */
  async function mutate(id: string, args: string[]): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!isValidBeadID(id)) return { ok: false, message: `invalid bead id: ${id}` }
    try {
      await exec(args)
      cache.clear()
      return { ok: true }
    } catch (err) {
      cache.clear()
      return { ok: false, message: messageFor(err) }
    }
  }

  function invalidate() {
    cache.clear()
  }

  return {
    enabled,
    signature,
    beginRefresh,
    snapshot,
    lastTouchedID,
    invalidate,
    mutate,

    /** All beads under a parent, closed ones included — the progress denominator. */
    children: (id: string) => (isValidBeadID(id) ? query<Bead[]>(["children", id]) : Promise.resolve(undefined)),

    /**
     * Fetch one bead.
     *
     * Deliberately `list --id` rather than `show`: `bd show` rewrites
     * `.beads/last-touched` even under `--readonly`, which would make our own
     * polling look like a change and refresh forever in a loop, and the panel
     * never needed the expanded-dependency data `show` adds.
     */
    get: (id: string) =>
      isValidBeadID(id) ? query<Bead[]>(["list", "--id", id, "--all"]) : Promise.resolve(undefined),

    /** Claimable work: open, unblocked, not deferred. */
    ready: () => query<Bead[]>(["ready"]),
    list: (args: string[] = []) => query<Bead[]>(["list", ...args]),
    epics: () => query<Bead[]>(["list", "--type", "epic", "--all"]),
  }
}

function messageFor(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { stderr?: unknown; message?: unknown; code?: unknown }
    const stderr = typeof e.stderr === "string" ? e.stderr.trim() : ""
    if (stderr) return firstLine(stderr)
    if (e.code === "ENOENT") return "bd not found on PATH"
    if (typeof e.message === "string") return firstLine(e.message)
  }
  return String(err)
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((it) => it.trim().length > 0)
  return (line ?? text).trim()
}
