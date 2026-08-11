// Bundles src/tui.tsx into dist/tui.js with the Solid *universal* JSX
// transform baked in. This is load-bearing for published installs: opencode's
// runtime Solid transform explicitly skips files under node_modules, so raw
// .tsx shipped to npm renders once with the plain jsx-runtime and never
// reacts. Precompiled output sidesteps that; the bare solid-js/@opentui
// imports are left external so the host rewrites them to its own runtime
// instances at load.
import { build } from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"

await build({
  entryPoints: ["src/tui.tsx"],
  outfile: "dist/tui.js",
  bundle: true,
  format: "esm",
  platform: "node",
  // Bundle only our own modules; every bare specifier (solid-js, @opentui/*,
  // node builtins) stays an import for the host to resolve.
  packages: "external",
  plugins: [
    solidPlugin({
      solid: {
        moduleName: "@opentui/solid",
        generate: "universal",
      },
    }),
  ],
})
