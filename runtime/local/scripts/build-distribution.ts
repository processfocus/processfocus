import { cpSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { packageDashboardSource } from "./package-dashboard-source"

const projectRoot = resolve(import.meta.dir, "..")
const dist = resolve(projectRoot, "dist")
rmSync(dist, { force: true, recursive: true })
cpSync(resolve(projectRoot, "out-tsc/runtime"), dist, { recursive: true })
await packageDashboardSource({ workspace: resolve(projectRoot, "../.."), dist })
