import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Host } from "@opencode/plugin/host"
import { transformSync } from "esbuild"

const root = fileURLToPath(new URL("../", import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string
  exports: { "./tui": { import: string } }
  files: string[]
}
const exported = manifest.exports["./tui"].import
const bundle = join(root, exported)

describe("V2 package entrypoints", () => {
  it("resolves a path-loaded checkout through its root shim using the actual host resolver", () => {
    const entrypoints = Host.resolve({ directory: root })
    assert.equal(entrypoints.tui, pathToFileURL(join(root, "tui.js")).href)
    assert.equal(entrypoints.server, undefined)
    assert.equal(entrypoints.rpc, undefined)
  })

  it("routes both entrypoints to the compiled bundle and includes them in the published files", () => {
    assert.equal(exported, "./dist/tui.js")
    const shim = readFileSync(join(root, "tui.js"), "utf8")
    assert.match(shim, /export\s*\{\s*default\s*\}\s*from\s*["']\.\/dist\/tui\.js["']/)
    assert.doesNotMatch(shim, /["'][^"']*\.tsx?["']/)
    assert.ok(manifest.files.includes("tui.js"))
    assert.ok(manifest.files.includes("dist"))
  })

  it("resolves the package-name subpath to its compiled export", (t) => {
    if (!existsSync(bundle)) return t.skip("Run npm run build to validate the compiled package export")
    const entrypoints = Host.resolve({ directory: root, name: manifest.name })
    assert.equal(entrypoints.tui, pathToFileURL(bundle).href)
    assert.equal(dirname(fileURLToPath(entrypoints.tui)), join(root, "dist"))
  })

  it("ships plain JavaScript with the Solid universal transform and external host runtimes", (t) => {
    if (!existsSync(bundle)) return t.skip("Run npm run build to validate the compiled bundle")
    const source = readFileSync(bundle, "utf8")
    // Parsing as JavaScript rejects raw JSX and TypeScript. Universal createElement
    // and effect imports establish that this is reactive OpenTUI output, rather
    // than a plain JSX-runtime build that would freeze after its first render.
    assert.doesNotThrow(() => transformSync(source, { loader: "js", format: "esm" }))
    assert.match(source, /import\s*\{[^}]*\bcreateElement\b[^}]*\}\s*from\s*["']@opentui\/solid["']/)
    assert.match(source, /import\s*\{[^}]*\beffect\b[^}]*\}\s*from\s*["']@opentui\/solid["']/)
    assert.match(source, /from\s*["']solid-js["']/)
    assert.match(source, /from\s*["']@opencode\/plugin\/tui["']/)
    assert.doesNotMatch(source, /from\s*["'][^"']*jsx-runtime["']/)
    assert.doesNotMatch(source, /(?:from\s*|import\s*\()["'][^"']*\.tsx?["']/)
  })
})
