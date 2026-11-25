import * as fs from "node:fs"
import { generateWithReport } from "usage-spec-effect"
import { version } from "../../package.json"
import { spyOn } from "bun:test"

// Deny the real side-effect boundaries in a fresh process before importing the
// command tree. Count attempts even if a handler catches the thrown exception.
const attempts: string[] = []
const deny = (name: string) => (): never => {
  attempts.push(name)
  throw new Error(`Offline export attempted ${name}`)
}
spyOn(fs, "readFileSync").mockImplementation(deny("credential read"))
spyOn(fs, "writeFileSync").mockImplementation(deny("credential write"))
spyOn(Bun, "spawn").mockImplementation(deny("browser/process launch"))
spyOn(Bun, "serve").mockImplementation(deny("listener"))
spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(deny("network"), { preconnect: deny("network preconnect") }),
)

const { pforgCommand } = await import("../../src/main")
const report = generateWithReport(pforgCommand, { version })
if (attempts.length || report.unsupported.length) {
  throw new Error(JSON.stringify({ attempts, unsupported: report.unsupported }))
}
process.stdout.write(report.kdl)
