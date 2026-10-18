// V2 resolves directory-installed plugins as <directory>/tui; npm installs
// resolve the ./tui package export. Both must load the precompiled Solid JSX.
export { default } from "./dist/tui.js"
