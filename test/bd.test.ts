import assert from "node:assert/strict"
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"
import { createBdClient, isValidBeadID } from "../src/bd.ts"

describe("isValidBeadID", () => {
  it("accepts ordinary bead ids", () => {
    assert.ok(isValidBeadID("beadmanager-3hr"))
    assert.ok(isValidBeadID("bt-avj.1"))
    assert.ok(isValidBeadID("a"))
    assert.ok(isValidBeadID("A1_b.2-c"))
  })

  it("rejects flag-shaped and malformed ids", () => {
    assert.ok(!isValidBeadID("-x"))
    assert.ok(!isValidBeadID("--force"))
    assert.ok(!isValidBeadID(""))
    assert.ok(!isValidBeadID(" "))
    assert.ok(!isValidBeadID("two words"))
    assert.ok(!isValidBeadID("a;b"))
    assert.ok(!isValidBeadID("$(id)"))
    assert.ok(!isValidBeadID("a|b"))
  })
})

describe("signature and change detection", () => {
  async function makeWorktree(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "bd-sig-"))
    mkdirSync(join(dir, ".beads"))
    return dir
  }

  it("reports disabled and signature 0:0 without a .beads directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bd-nodb-"))
    try {
      const client = createBdClient(dir)
      assert.equal(client.enabled(), false)
      assert.equal(client.signature(), "0:0")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("changes when a file is added under .beads", async () => {
    const dir = await makeWorktree()
    try {
      const client = createBdClient(dir)
      assert.equal(client.enabled(), true)
      const before = client.signature()
      await writeFile(join(dir, ".beads", "a.txt"), "one")
      assert.notEqual(client.signature(), before)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("changes when a file directly under .beads is deleted", async () => {
    const dir = await makeWorktree()
    try {
      await writeFile(join(dir, ".beads", "a.txt"), "one")
      await writeFile(join(dir, ".beads", "b.txt"), "two")
      const client = createBdClient(dir)
      const before = client.signature()
      await unlink(join(dir, ".beads", "b.txt"))
      // Deletion only bumps the root's mtime and drops the entry count; either
      // is enough to move the signature.
      assert.notEqual(client.signature(), before)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("pins the signature from beginRefresh until snapshot", async () => {
    const dir = await makeWorktree()
    try {
      const client = createBdClient(dir)
      client.beginRefresh()
      const pinned = client.signature()
      await writeFile(join(dir, ".beads", "new.txt"), "surprise")
      assert.equal(client.signature(), pinned)
      const fresh = client.snapshot()
      assert.notEqual(fresh, pinned)
      assert.equal(client.signature(), fresh)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("lastTouchedID", () => {
  it("returns a valid id trimmed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bd-lt-"))
    try {
      mkdirSync(join(dir, ".beads"))
      await writeFile(join(dir, ".beads", "last-touched"), "  bt-avj.1\n")
      assert.equal(createBdClient(dir).lastTouchedID(), "bt-avj.1")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("treats garbage or absence as undefined", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bd-lt-"))
    try {
      mkdirSync(join(dir, ".beads"))
      const client = createBdClient(dir)
      assert.equal(client.lastTouchedID(), undefined)
      await writeFile(join(dir, ".beads", "last-touched"), "--flag")
      assert.equal(client.lastTouchedID(), undefined)
      await writeFile(join(dir, ".beads", "last-touched"), "")
      assert.equal(client.lastTouchedID(), undefined)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("query caching and mutate, against a fake bd on PATH", () => {
  let binDir: string
  let worktree: string
  let logFile: string
  let outFile: string
  let failFile: string
  let originalPath: string | undefined

  before(async () => {
    binDir = await mkdtemp(join(tmpdir(), "bd-bin-"))
    worktree = await mkdtemp(join(tmpdir(), "bd-wt-"))
    mkdirSync(join(worktree, ".beads"))

    logFile = join(binDir, "argv.log")
    outFile = join(binDir, "stdout.json")
    failFile = join(binDir, "fail.marker")

    const script = [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" >> "$BDFAKE_LOG"',
      'if [ -n "$BDFAKE_FAIL" ] && [ -f "$BDFAKE_FAIL" ]; then',
      '  echo "boom: something broke" >&2',
      '  echo "more detail on a later line" >&2',
      "  exit 1",
      "fi",
      'if [ -n "$BDFAKE_OUT" ] && [ -f "$BDFAKE_OUT" ]; then',
      '  cat "$BDFAKE_OUT"',
      "fi",
      "exit 0",
      "",
    ].join("\n")
    writeFileSync(join(binDir, "bd"), script)
    chmodSync(join(binDir, "bd"), 0o755)

    originalPath = process.env.PATH
    process.env.PATH = `${binDir}:${originalPath ?? ""}`
    process.env.BDFAKE_LOG = logFile
    process.env.BDFAKE_OUT = outFile
    process.env.BDFAKE_FAIL = failFile
  })

  after(async () => {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    delete process.env.BDFAKE_LOG
    delete process.env.BDFAKE_OUT
    delete process.env.BDFAKE_FAIL
    await rm(binDir, { recursive: true, force: true })
    await rm(worktree, { recursive: true, force: true })
  })

  async function argvLines(): Promise<string[]> {
    try {
      const text = await readFile(logFile, "utf8")
      return text.split("\n").filter((line) => line.length > 0)
    } catch {
      return []
    }
  }

  function resetLog() {
    rmSync(logFile, { force: true })
  }

  it("caches query results against an unchanged signature", async () => {
    resetLog()
    writeFileSync(outFile, '[{"id":"x-1","status":"open"}]')
    const client = createBdClient(worktree)

    const first = await client.list()
    const second = await client.list()
    assert.deepEqual(first, [{ id: "x-1", status: "open" }])
    assert.deepEqual(second, first)

    const lines = await argvLines()
    assert.equal(lines.length, 1, `fake bd should run once, ran: ${JSON.stringify(lines)}`)
  })

  it("places --readonly first and --json last in query argv", async () => {
    resetLog()
    writeFileSync(outFile, "[]")
    const client = createBdClient(worktree)
    await client.ready()

    const lines = await argvLines()
    assert.deepEqual(lines, ["--readonly ready --json"])
  })

  it("invalidates the cache after a mutate", async () => {
    resetLog()
    writeFileSync(outFile, '[{"id":"x-1","status":"open"}]')
    const client = createBdClient(worktree)

    await client.list()
    const result = await client.mutate("x-1", ["close", "x-1"])
    assert.deepEqual(result, { ok: true })
    await client.list()

    const lines = await argvLines()
    assert.deepEqual(lines, ["--readonly list --json", "close x-1", "--readonly list --json"])
  })

  it("rejects an invalid id in mutate without invoking bd", async () => {
    resetLog()
    const client = createBdClient(worktree)

    const result = await client.mutate("--force", ["close", "--force"])
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.message.includes("invalid bead id"))
    assert.deepEqual(await argvLines(), [])
  })

  it("returns the first stderr line when mutate fails", async () => {
    resetLog()
    writeFileSync(failFile, "")
    try {
      const client = createBdClient(worktree)
      const result = await client.mutate("x-1", ["close", "x-1"])
      assert.equal(result.ok, false)
      assert.ok(!result.ok && result.message === "boom: something broke")
      assert.deepEqual(await argvLines(), ["close x-1"])
    } finally {
      rmSync(failFile, { force: true })
    }
  })
})
