import assert from "node:assert/strict"
import { execFile as execFileCb, spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"
import { promisify } from "node:util"
import { type BdClient, type Bead, createBdClient } from "../src/bd.ts"
import { stateOf } from "../src/scope.ts"

const execFile = promisify(execFileCb)

/** One bd call costs ~0.5s; init spins up an embedded Dolt engine and costs a few. */
const BD_TIMEOUT_MS = 30_000

const probe = spawnSync("bd", ["--version"], { encoding: "utf8" })
const hasBd = probe.status === 0
if (!hasBd) {
  console.log("skipping bd integration suite: bd not found on PATH (spawn of `bd --version` failed)")
}

describe("integration against real bd", { skip: hasBd ? false : "bd not found on PATH", timeout: 120_000 }, () => {
  let worktree: string
  let client: BdClient
  let epicID: string
  let childOne: string
  let childTwo: string

  async function bd(args: string[]): Promise<string> {
    const { stdout } = await execFile("bd", args, { cwd: worktree, timeout: BD_TIMEOUT_MS, encoding: "utf8" })
    return stdout
  }

  async function bdCreate(args: string[]): Promise<string> {
    const created = JSON.parse(await bd(["create", ...args, "--json"])) as Bead
    assert.ok(typeof created.id === "string" && created.id.length > 0)
    return created.id
  }

  before(
    async () => {
      worktree = await mkdtemp(join(tmpdir(), "bd-int-"))
      await execFile("git", ["init", "-q", "."], { cwd: worktree, timeout: BD_TIMEOUT_MS })
      await bd(["init", "--prefix", "it", "--non-interactive", "--quiet", "--skip-agents", "--skip-hooks"])

      epicID = await bdCreate(["Integration epic", "--type", "epic"])
      childOne = await bdCreate(["Child one", "--parent", epicID])
      childTwo = await bdCreate(["Child two", "--parent", epicID])
      // childTwo depends on childOne (blocks), so childTwo is not ready.
      await bd(["dep", "add", childTwo, childOne, "--type", "blocks"])

      client = createBdClient(worktree)
    },
    { timeout: 120_000 },
  )

  after(async () => {
    if (worktree) await rm(worktree, { recursive: true, force: true })
  })

  it("is enabled and finds the epic", async () => {
    assert.equal(client.enabled(), true)
    const epics = (await client.epics()) ?? []
    assert.ok(
      epics.some((it) => it.id === epicID),
      `epics() should include ${epicID}`,
    )
  })

  it("excludes the blocked child from ready, and stateOf agrees", async () => {
    const ready = (await client.ready()) ?? []
    const readyIDs = new Set(ready.map((it) => it.id))
    assert.ok(readyIDs.has(childOne), `${childOne} should be ready`)
    assert.ok(!readyIDs.has(childTwo), `${childTwo} is blocked and must not be ready`)

    const blocked = (await client.get(childTwo))?.[0]
    assert.ok(blocked)
    assert.notEqual(blocked.status, "closed")
    assert.equal(stateOf(blocked, readyIDs), "blocked")
  })

  it("lists both children under the epic", async () => {
    const children = (await client.children(epicID)) ?? []
    const ids = new Set(children.map((it) => it.id))
    assert.ok(ids.has(childOne))
    assert.ok(ids.has(childTwo))
  })

  it("fetches a single bead through get", async () => {
    const beads = (await client.get(childOne)) ?? []
    assert.equal(beads.length, 1)
    assert.equal(beads[0]?.id, childOne)
    assert.equal(beads[0]?.status, "open")
  })

  it("records the last-touched bead after a bd show", async () => {
    await bd(["show", childTwo])
    assert.equal(client.lastTouchedID(), childTwo)
  })

  it("round-trips a close through mutate and moves the signature", async () => {
    const sigBefore = client.signature()

    const result = await client.mutate(childOne, ["close", childOne])
    assert.deepEqual(result, { ok: true })

    const sigAfter = client.signature()
    assert.notEqual(sigAfter, sigBefore, "a bd write must move the .beads signature")

    const closed = (await client.get(childOne))?.[0]
    assert.ok(closed)
    assert.equal(closed.status, "closed")
  })
})
