import { spawnSync } from "node:child_process"
import { renameSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const entry = path.join(root, "dist", "preload", "preload.cjs")
const output = path.join(root, "dist", "preload", "preload.bundle.cjs")
const finalOutput = path.join(root, "dist", "preload", "preload.cjs")

const result = spawnSync("bun", [
  "build",
  entry,
  "--target=node",
  "--format=cjs",
  "--external",
  "electron",
  "--outfile",
  output,
], { stdio: "inherit" })

if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)

renameSync(output, finalOutput)
